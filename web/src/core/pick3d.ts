/*
 * Pick3D — the depth-correct GPU pick pass for the Cytolume 3D renderer
 * (reflection-3 §PICK). It reuses the SAME instanced billboard geometry + the
 * SAME analytic sphere-impostor gl_FragDepth as the main impostor program, but
 * runs a stripped vertex/fragment pair that writes the per-cell uint `a_id`
 * (RGBA8-encoded) into an offscreen RGBA8 + DEPTH24 framebuffer.
 *
 * Why this is correct by construction: because the pick pass depth-tests with
 * the exact same hand-written gl_FragDepth the visible pass uses, the FRONT
 * sphere along the cursor ray wins the z-fight — so reading the 1×1 pixel under
 * the cursor decodes the id of the nearest cell, never an occluded one. No CPU
 * ray-vs-sphere math, no sort: the z-buffer already did it.
 *
 * Encoding: the shader writes (a_id + 1) so the cleared background (0,0,0,0)
 * decodes to 0 → "no hit" (cell_id 0 is a legitimate id, so the +1 bias is what
 * makes empty space distinguishable). pick() subtracts the bias and returns the
 * raw cell_id, or -1 for a miss.
 *
 * This module owns only its program + VAO; the buffers are SHARED with the
 * renderer (the same a_center / a_posTo / a_id instance buffers), so picking
 * costs one extra VAO and one offscreen draw, not a second copy of the cloud.
 */

import { Device3D, decodePickId, type AttribPointer } from "./device3d.ts";
import type { Camera3DUniforms } from "./camera3d.ts";

// ---------------------------------------------------------------------------
// Shaders (GLSL ES 3.00). The vertex stage mirrors the impostor billboard +
// morph + min-px-floor math EXACTLY so the pick silhouette lines up pixel-for-
// pixel with what is drawn; the fragment stage reconstructs the same surface
// point + gl_FragDepth, then encodes the id instead of shading.
// ---------------------------------------------------------------------------

const PICK_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2  a_corner;   // per-vertex quad corner in [-1,1]^2
in vec3  a_center;   // per-instance morph SOURCE position
in vec3  a_posTo;    // per-instance morph TARGET position
in vec3  a_centroid; // per-instance centroid of the cell's CATEGORY (idle spin pivot)
in uint  a_id;       // per-instance stable cell_id

uniform mat4  u_viewProj;
uniform vec3  u_cameraRight;
uniform vec3  u_cameraUp;
uniform vec3  u_viewDir;
uniform float u_radius;
uniform float u_focalPx;
uniform float u_minPx;
uniform float u_refW;
uniform float u_depthSizeExp;
uniform float u_morphFactor;
uniform float u_spinAngle;   // per-cluster idle spin angle (radians) — MUST match the impostor
uniform vec3  u_spinAxis;    // per-cluster idle spin axis (unit)

out vec2  v_local;
out vec3  v_center;
out vec3  v_right;
out vec3  v_up;
out vec3  v_viewDir;
out float v_radius;
flat out uint v_id;

void main() {
  vec3 fwd   = normalize(u_viewDir);
  vec3 right = normalize(u_cameraRight - fwd * dot(u_cameraRight, fwd));
  vec3 up    = normalize(cross(fwd, right));

  // identical morph + min-px floor to the impostor program so picks register
  // exactly where cells are drawn, even mid-flight.
  vec3 center = mix(a_center, a_posTo, smoothstep(0.0, 1.0, u_morphFactor));

  // SAME per-cluster idle spin as the impostor (Rodrigues about the centroid) so
  // the pick silhouette tracks the SPUN cell — hovering after a spin stays exact.
  if (u_spinAngle != 0.0) {
    vec3 rel = center - a_centroid;
    float s = sin(u_spinAngle), c = cos(u_spinAngle);
    rel = rel * c + cross(u_spinAxis, rel) * s + u_spinAxis * dot(u_spinAxis, rel) * (1.0 - c);
    center = a_centroid + rel;
  }

  vec4 clipC = u_viewProj * vec4(center, 1.0);
  float w = max(abs(clipC.w), 1e-4);
  // Mirrors IMPOSTOR_VERT exactly. If these two drift, the id raster stops matching
  // the screen and hover picks a NEIGHBOUR of the cell under the cursor — silent,
  // and it reads as flakiness rather than as a rendering change.
  float persp = 1.0;
  if (u_depthSizeExp > 0.0) {
    persp = clamp(pow(max(u_refW, 1e-4) / w, u_depthSizeExp), 0.55, 2.20);
  }
  float worldFloor = u_minPx * persp * w / max(u_focalPx, 1e-4);
  float radius = max(u_radius, worldFloor);

  vec3 worldPos = center + (right * a_corner.x + up * a_corner.y) * radius;
  gl_Position = u_viewProj * vec4(worldPos, 1.0);

  v_local   = a_corner;
  v_center  = center;
  v_right   = right;
  v_up      = up;
  v_viewDir = fwd;
  v_radius  = radius;
  v_id      = a_id;
}
`;

const PICK_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2  v_local;
in vec3  v_center;
in vec3  v_right;
in vec3  v_up;
in vec3  v_viewDir;
in float v_radius;
flat in uint v_id;

uniform mat4 u_viewProj;

out vec4 fragColor;

void main() {
  float lensqr = dot(v_local, v_local);
  if (lensqr > 1.0) discard;           // hard silhouette — the pick mask is exact

  float z = sqrt(max(1.0 - lensqr, 0.0));

  // honest depth so the nearest sphere wins the z-test (the whole point of the
  // pass): reconstruct the surface point and write its clip-space depth.
  vec3 toViewer = -v_viewDir;
  vec3 surfaceWorld = v_center + (v_right * v_local.x + v_up * v_local.y + toViewer * z) * v_radius;
  vec4 clip = u_viewProj * vec4(surfaceWorld, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;

  // encode (id + 1): cleared background (0,0,0,0) → 0 → "no hit"; a real cell
  // with cell_id 0 encodes to 1 and stays distinguishable.
  uint id = v_id + 1u;
  float r = float( id        & 0xFFu);
  float g = float((id >>  8) & 0xFFu);
  float b = float((id >> 16) & 0xFFu);
  float a = float((id >> 24) & 0xFFu);
  fragColor = vec4(r, g, b, a) / 255.0;
}
`;

// ---------------------------------------------------------------------------
// Pick pass
// ---------------------------------------------------------------------------

/** The SHARED instance buffers the pick VAO reads (owned by Renderer3D). */
export interface PickBuffers {
  cornerBuffer: WebGLBuffer; // per-vertex quad
  centerBuffer: WebGLBuffer; // a_center (morph source)
  posToBuffer: WebGLBuffer; // a_posTo  (morph target)
  idBuffer: WebGLBuffer; // a_id (uint cell_id)
  centroidBuffer: WebGLBuffer | null; // a_centroid (per-category mean) — idle spin pivot
  count: number;
}

/** Per-pick inputs: the EXACT frame state the visible pass last drew with, so
 *  the pick raster matches the screen. Coordinates are device pixels measured
 *  from the TOP-LEFT (canvas pixel space); pick() flips Y for readPixels. */
export interface PickRequest {
  x: number;
  y: number;
  u: Camera3DUniforms;
  radius: number;
  focalPx: number;
  minPx: number;
  /** Perspective anchor + exponent from the frame being picked — see IMPOSTOR_VERT.
   *  Must match the last VISIBLE frame or the id raster misaligns with the screen. */
  refW: number;
  depthSizeExp: number;
  morphFactor: number;
  spinAngle: number; // per-cluster idle spin angle (radians) — matches the visible frame
  spinAxis: [number, number, number]; // per-cluster idle spin axis (unit)
}

export class PickPass {
  private device: Device3D;
  private gl: WebGL2RenderingContext;
  private program: ReturnType<Device3D["createProgram"]>;
  private vao: WebGLVertexArrayObject | null = null;
  private count = 0;
  private readBuf = new Uint8Array(4);

  constructor(device: Device3D) {
    this.device = device;
    this.gl = device.gl;
    this.program = device.createProgram(PICK_VERT, PICK_FRAG);
  }

  /** (Re)build the pick VAO over the renderer's shared instance buffers. Call
   *  whenever Renderer3D.setData rebuilds those buffers. */
  setData(b: PickBuffers): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    const a = this.program.attribs;
    this.count = b.count;
    const pointers: AttribPointer[] = [
      { location: a.a_corner, buffer: b.cornerBuffer, size: 2, divisor: 0 },
      { location: a.a_center, buffer: b.centerBuffer, size: 3, divisor: 1 },
      { location: a.a_posTo, buffer: b.posToBuffer, size: 3, divisor: 1 },
      {
        location: a.a_id,
        buffer: b.idBuffer,
        size: 1,
        type: gl.UNSIGNED_INT,
        integer: true,
        divisor: 1,
      },
    ];
    // a_centroid (idle spin pivot) shares the renderer's centroid buffer.
    if (b.centroidBuffer) {
      pointers.push({ location: a.a_centroid, buffer: b.centroidBuffer, size: 3, divisor: 1 });
    }
    this.vao = this.device.createVAO(pointers);
  }

  /**
   * Render the id pass into the offscreen RGBA8 + DEPTH24 buffer and read back
   * the 1×1 pixel under (x,y). Returns the decoded cell_id, or -1 for a miss
   * (empty space, or before any data is uploaded).
   */
  pick(req: PickRequest): number {
    const gl = this.gl;
    if (this.count === 0 || !this.vao) return -1;

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const px = Math.round(req.x);
    // readPixels is bottom-left origin; the request is top-left.
    const py = Math.round(height - 1 - req.y);
    if (px < 0 || px >= width || py < 0 || py >= height) return -1;

    const target = this.device.targets.acquire("pick", width, height, "rgba8-depth24");
    this.device.bindTarget(target);

    // depth-tested, opaque, no blend: the front sphere's gl_FragDepth wins.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    gl.clearColor(0, 0, 0, 0); // → decodes to 0 → "no hit"
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const P = this.program;
    gl.useProgram(P.program);
    gl.uniformMatrix4fv(P.uniforms.u_viewProj, false, req.u.u_viewProj);
    gl.uniform3fv(P.uniforms.u_cameraRight, req.u.u_cameraRight);
    gl.uniform3fv(P.uniforms.u_cameraUp, req.u.u_cameraUp);
    gl.uniform3fv(P.uniforms.u_viewDir, req.u.u_viewDir);
    gl.uniform1f(P.uniforms.u_radius, req.radius);
    gl.uniform1f(P.uniforms.u_focalPx, req.focalPx);
    gl.uniform1f(P.uniforms.u_minPx, req.minPx);
    gl.uniform1f(P.uniforms.u_refW, req.refW);
    gl.uniform1f(P.uniforms.u_depthSizeExp, req.depthSizeExp);
    gl.uniform1f(P.uniforms.u_morphFactor, req.morphFactor);
    gl.uniform1f(P.uniforms.u_spinAngle, req.spinAngle);
    gl.uniform3f(P.uniforms.u_spinAxis, req.spinAxis[0], req.spinAxis[1], req.spinAxis[2]);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);

    this.device.readPixels(px, py, 1, 1, this.readBuf);
    this.device.bindTarget(null);

    const encoded = decodePickId(this.readBuf); // = cell_id + 1, or 0 for empty
    return encoded === 0 ? -1 : encoded - 1;
  }

  destroy(): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program.program);
  }
}
