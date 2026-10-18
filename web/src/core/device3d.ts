/*
 * Device3D — a thin raw-WebGL2 device wrapper for the Cytolume 3D renderer
 * (reflection-3). It sits BESIDE the regl-based 2D PointRenderer and owns the
 * low-level GPU surface that Renderer3D / Camera3D build on:
 *
 *   - context creation with the SPEC attributes + a capability probe that the
 *     renderer reads to choose honest fallbacks (HDR float path vs LDR),
 *   - program compile/link with active-uniform / active-attribute introspection,
 *   - buffer create/update + instanced VAO setup (vertexAttribDivisor, and
 *     vertexAttribIPointer for the integer `a_id` channel used by picking),
 *   - a RenderTargetPool for the two FBOs this build needs: an HDR RGBA16F
 *     accumulation buffer (continuous/density additive pass) and an
 *     RGBA8 + DEPTH24 pick buffer (id readback),
 *   - clear + drawArraysInstanced helpers.
 *
 * Why raw WebGL2 (not regl): gl_FragDepth — written by the sphere-impostor
 * fragment shader so depth is honest under perspective — is core in WebGL2 but
 * unavailable through the regl/WebGL1 path the 2D renderer uses. We keep the two
 * substrates fully separate; main.ts swaps implementations behind a common
 * interface.
 *
 * This module deliberately knows nothing about cameras, colormaps or point
 * data. It is the device, not the renderer.
 */

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

/**
 * Result of the one-time capability probe. Renderer3D reads this to decide which
 * path is honest on the current GPU. Each field documents its fallback.
 */
export interface Device3DCapabilities {
  /** WebGL2 context obtained. If false, the whole 3D path is unavailable and
   *  the caller MUST fall back to the 2D regl renderer. */
  webgl2: boolean;
  /** Backing depth buffer on the default framebuffer (from context attribs).
   *  Categorical (opaque, depth-tested) rendering to screen needs this; if
   *  absent we still depth-test inside offscreen FBOs that carry DEPTH24. */
  depth: boolean;
  /** EXT_color_buffer_float — RGBA16F/RGBA32F are color-renderable. */
  colorBufferFloat: boolean;
  /** EXT_color_buffer_half_float — RGBA16F color-renderable (weaker fallback
   *  when EXT_color_buffer_float is missing). */
  colorBufferHalfFloat: boolean;
  /** EXT_float_blend — required to BLEND into 32-bit float targets. Half-float
   *  (RGBA16F) additive blending does NOT require it, so the HDR pass works
   *  without this; it is probed for completeness / future RGBA32F use. */
  floatBlend: boolean;
  /** Derived: RGBA16F is usable as a color attachment → the HDR additive pass
   *  is available. Fallback when false: render the additive pass directly to an
   *  LDR RGBA8 screen target (clamped; loses HDR headroom but stays correct). */
  hdrSupported: boolean;
  /** Derived: we can additively blend into the RGBA16F target (true whenever
   *  hdrSupported, since 16F blend is core given a renderable 16F buffer). */
  hdrBlendable: boolean;
  /** GL_MAX_COLOR_ATTACHMENTS — headroom for future MRT / OIT (deferred). */
  maxColorAttachments: number;
  /** GL_MAX_SAMPLES — MSAA headroom (not used in this build). */
  maxSamples: number;
  /** GL_MAX_TEXTURE_SIZE — caps LUT / FBO dimensions. */
  maxTextureSize: number;
  /** Unmasked renderer string when WEBGL_debug_renderer_info is present. */
  renderer: string;
  /** Human-readable record of every fallback decision taken during the probe. */
  notes: string[];
}

function probeCapabilities(gl: WebGL2RenderingContext): Device3DCapabilities {
  const notes: string[] = [];

  const attribs = gl.getContextAttributes();
  const depth = attribs ? attribs.depth !== false : false;
  if (!depth) {
    notes.push(
      "default framebuffer has no depth — categorical screen pass relies on offscreen DEPTH24 FBOs",
    );
  }

  const extFloat = gl.getExtension("EXT_color_buffer_float");
  const extHalf = gl.getExtension("EXT_color_buffer_half_float");
  const extFloatBlend = gl.getExtension("EXT_float_blend");

  const colorBufferFloat = !!extFloat;
  const colorBufferHalfFloat = !!extHalf;
  const floatBlend = !!extFloatBlend;

  const hdrSupported = colorBufferFloat || colorBufferHalfFloat;
  if (!hdrSupported) {
    notes.push(
      "no EXT_color_buffer_float / _half_float — RGBA16F not color-renderable; HDR additive pass falls back to LDR RGBA8 screen accumulation",
    );
  } else if (!colorBufferFloat) {
    notes.push(
      "EXT_color_buffer_float absent, using EXT_color_buffer_half_float — RGBA16F only (no RGBA32F render targets)",
    );
  }
  if (!floatBlend) {
    notes.push(
      "EXT_float_blend absent — RGBA16F additive blend is still valid (16F blend is core); only RGBA32F blending would be blocked",
    );
  }

  let renderer = "(unknown)";
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  if (dbg) {
    const r = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    if (typeof r === "string") renderer = r;
  } else {
    renderer = "(masked)";
  }

  return {
    webgl2: true,
    depth,
    colorBufferFloat,
    colorBufferHalfFloat,
    floatBlend,
    hdrSupported,
    hdrBlendable: hdrSupported,
    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer,
    notes,
  };
}

/** The capability shape returned when no WebGL2 context could be created. */
function noWebgl2Caps(reason: string): Device3DCapabilities {
  return {
    webgl2: false,
    depth: false,
    colorBufferFloat: false,
    colorBufferHalfFloat: false,
    floatBlend: false,
    hdrSupported: false,
    hdrBlendable: false,
    maxColorAttachments: 0,
    maxSamples: 0,
    maxTextureSize: 0,
    renderer: "(none)",
    notes: [reason],
  };
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** A linked program with its active uniform locations + attribute slots cached
 *  by name, so call sites use names and never re-query the driver. */
export interface Program3D {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  attribs: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Buffers + instanced attributes
// ---------------------------------------------------------------------------

/**
 * One attribute binding for a VAO. `divisor` of 1 makes the attribute advance
 * per-instance (the billboard's per-cell channels); 0 (default) is per-vertex
 * (the quad corner). `integer: true` routes through vertexAttribIPointer for
 * integer attributes such as the uint `a_id` picking channel.
 */
export interface AttribPointer {
  location: number;
  buffer: WebGLBuffer;
  /** Components per element, 1..4. */
  size: number;
  /** GL type; defaults to FLOAT (or for integer attribs, UNSIGNED_INT). */
  type?: number;
  normalized?: boolean;
  /** Byte stride between consecutive elements; 0 = tightly packed. */
  stride?: number;
  /** Byte offset of the first element within the buffer. */
  offset?: number;
  /** 0 per-vertex, 1 per-instance. */
  divisor?: number;
  /** Use vertexAttribIPointer (keep integer values exact, no float coercion). */
  integer?: boolean;
}

// ---------------------------------------------------------------------------
// Render targets
// ---------------------------------------------------------------------------

/**
 * The two render-target shapes this build needs:
 *   - `rgba16f`         : HDR accumulation, no depth (the additive pass must not
 *                         self-depth-test — that would lie about density).
 *   - `rgba16f-depth24` : HDR color WITH depth (kept for completeness).
 *   - `rgba8-depth24`   : pick buffer — id encoded into RGBA8, DEPTH24 so the
 *                         front cell wins by construction.
 */
export type RenderTargetFormat =
  | "rgba16f"
  | "rgba16f-depth24"
  | "rgba8-depth24"
  /** Colour + a SAMPLEABLE depth texture. Needed by screen-space passes that read
   *  scene depth (eye-dome lighting); a depth RENDERBUFFER cannot be sampled. */
  | "rgba8-depthtex";

export interface RenderTarget {
  tag: string;
  framebuffer: WebGLFramebuffer;
  colorTexture: WebGLTexture;
  /** Sampleable depth, when the format asked for a depth TEXTURE. */
  depthTexture: WebGLTexture | null;
  depthRenderbuffer: WebGLRenderbuffer | null;
  width: number;
  height: number;
  format: RenderTargetFormat;
}

function hasDepth(format: RenderTargetFormat): boolean {
  return (
    format === "rgba16f-depth24" ||
    format === "rgba8-depth24" ||
    format === "rgba8-depthtex"
  );
}
/** True when depth must be a TEXTURE (sampleable) rather than a renderbuffer. */
function depthIsTexture(format: RenderTargetFormat): boolean {
  return format === "rgba8-depthtex";
}

/**
 * A small named-slot pool of render targets keyed on (tag, w, h, format). A tag
 * names a logical buffer ("hdr", "pick"); re-acquiring the same tag at the same
 * size + format returns the SAME GPU object (no per-frame allocation), and a
 * size/format change disposes the stale target and rebuilds it — the WebGL2
 * analogue of regl's `framebuffer.resize`.
 */
export class RenderTargetPool {
  private gl: WebGL2RenderingContext;
  private slots = new Map<string, RenderTarget>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  acquire(tag: string, width: number, height: number, format: RenderTargetFormat): RenderTarget {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const existing = this.slots.get(tag);
    if (existing && existing.width === w && existing.height === h && existing.format === format) {
      return existing;
    }
    if (existing) this.dispose(existing);
    const created = this.create(tag, w, h, format);
    this.slots.set(tag, created);
    return created;
  }

  private create(tag: string, w: number, h: number, format: RenderTargetFormat): RenderTarget {
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    const colorTexture = gl.createTexture();
    if (!framebuffer || !colorTexture) throw new Error("device3d: failed to allocate FBO/texture");

    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    const linear = format === "rgba16f" || format === "rgba16f-depth24";
    const filter = linear ? gl.LINEAR : gl.NEAREST; // pick buffer must stay exact
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (linear) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);

    let depthTexture: WebGLTexture | null = null;
    let depthRenderbuffer: WebGLRenderbuffer | null = null;
    if (depthIsTexture(format)) {
      depthTexture = gl.createTexture();
      if (!depthTexture) throw new Error("device3d: failed to allocate depth texture");
      gl.bindTexture(gl.TEXTURE_2D, depthTexture);
      // NEAREST: depth must not be interpolated — a filtered sample is not a depth.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
      );
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    } else if (hasDepth(format)) {
      depthRenderbuffer = gl.createRenderbuffer();
      if (!depthRenderbuffer) throw new Error("device3d: failed to allocate depth renderbuffer");
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        depthRenderbuffer,
      );
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`device3d: incomplete FBO '${tag}' (${format}) status=0x${status.toString(16)}`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    return { tag, framebuffer, colorTexture, depthTexture, depthRenderbuffer, width: w, height: h, format };
  }

  private dispose(rt: RenderTarget): void {
    const gl = this.gl;
    gl.deleteFramebuffer(rt.framebuffer);
    gl.deleteTexture(rt.colorTexture);
    if (rt.depthTexture) gl.deleteTexture(rt.depthTexture);
    if (rt.depthRenderbuffer) gl.deleteRenderbuffer(rt.depthRenderbuffer);
  }

  destroy(): void {
    for (const rt of this.slots.values()) this.dispose(rt);
    this.slots.clear();
  }
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

/** Options for {@link Device3D.clear}. */
export interface ClearOptions {
  color?: [number, number, number, number];
  depth?: number;
  /** Target FBO, or null/undefined for the default framebuffer (screen). */
  target?: RenderTarget | null;
}

/** The error thrown when no WebGL2 context can be created. Carries the probe so
 *  callers can branch to the 2D renderer with a logged reason. */
export class Device3DUnavailable extends Error {
  readonly caps: Device3DCapabilities;
  constructor(caps: Device3DCapabilities) {
    super(`device3d: WebGL2 unavailable — ${caps.notes.join("; ")}`);
    this.name = "Device3DUnavailable";
    this.caps = caps;
  }
}

/**
 * The raw-WebGL2 device. Construct once per canvas; throws
 * {@link Device3DUnavailable} (carrying the capability probe) when WebGL2 is not
 * available so the caller can fall back to the 2D path.
 */
export class Device3D {
  readonly gl: WebGL2RenderingContext;
  readonly caps: Device3DCapabilities;
  readonly canvas: HTMLCanvasElement;
  readonly targets: RenderTargetPool;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: true,
      premultipliedAlpha: false,
      // honest gl_FragDepth wants a stable buffer; never auto-clear it for us.
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;

    if (!gl) {
      throw new Device3DUnavailable(noWebgl2Caps("getContext('webgl2') returned null"));
    }
    this.gl = gl;
    this.caps = probeCapabilities(gl);
    this.targets = new RenderTargetPool(gl);
  }

  /** Static, side-effect-light probe: create a throwaway WebGL2 context and read
   *  capabilities WITHOUT retaining the device. Lets main.ts decide between the
   *  2D and 3D renderers before committing the real canvas. */
  static probe(canvas?: HTMLCanvasElement): Device3DCapabilities {
    const c = canvas ?? document.createElement("canvas");
    const gl = c.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: true,
      premultipliedAlpha: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) return noWebgl2Caps("getContext('webgl2') returned null");
    return probeCapabilities(gl);
  }

  // --- programs ----------------------------------------------------------

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("device3d: createShader failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "(no log)";
      gl.deleteShader(shader);
      const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
      throw new Error(`device3d: ${kind} shader compile error:\n${log}`);
    }
    return shader;
  }

  /** Compile + link a program and introspect every active uniform/attribute so
   *  call sites address them by name. */
  createProgram(vertexSource: string, fragmentSource: string): Program3D {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error("device3d: createProgram failed");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // shaders can be detached/deleted once linked
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "(no log)";
      gl.deleteProgram(program);
      throw new Error(`device3d: program link error:\n${log}`);
    }

    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const nUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < nUniforms; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, ""); // normalize array uniforms
      uniforms[name] = gl.getUniformLocation(program, info.name);
    }

    const attribs: Record<string, number> = {};
    const nAttribs = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
    for (let i = 0; i < nAttribs; i++) {
      const info = gl.getActiveAttrib(program, i);
      if (!info) continue;
      attribs[info.name] = gl.getAttribLocation(program, info.name);
    }

    return { program, uniforms, attribs };
  }

  useProgram(p: Program3D): void {
    this.gl.useProgram(p.program);
  }

  // --- buffers -----------------------------------------------------------

  /** Create a buffer and optionally upload initial data. `target` defaults to
   *  ARRAY_BUFFER, `usage` to STATIC_DRAW. */
  createBuffer(
    data: BufferSource | number | null,
    target?: number,
    usage?: number,
  ): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer();
    if (!buf) throw new Error("device3d: createBuffer failed");
    const tgt = target ?? gl.ARRAY_BUFFER;
    const use = usage ?? gl.STATIC_DRAW;
    gl.bindBuffer(tgt, buf);
    if (typeof data === "number") {
      gl.bufferData(tgt, data, use); // allocate `data` bytes, uninitialized
    } else if (data) {
      gl.bufferData(tgt, data, use);
    }
    gl.bindBuffer(tgt, null);
    return buf;
  }

  /** Upload into an existing buffer (sub-data) at `byteOffset`. */
  updateBuffer(
    buffer: WebGLBuffer,
    data: BufferSource,
    byteOffset = 0,
    target?: number,
  ): void {
    const gl = this.gl;
    const tgt = target ?? gl.ARRAY_BUFFER;
    gl.bindBuffer(tgt, buffer);
    gl.bufferSubData(tgt, byteOffset, data);
    gl.bindBuffer(tgt, null);
  }

  // --- vertex array objects ---------------------------------------------

  /**
   * Build a VAO from a list of attribute bindings, wiring divisors (instancing)
   * and integer pointers (`a_id`) as requested. Returns the VAO; bind it with
   * {@link bindVAO} before drawing.
   */
  createVAO(attribs: AttribPointer[]): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("device3d: createVertexArray failed");
    gl.bindVertexArray(vao);
    for (const a of attribs) {
      if (a.location < 0) continue; // attribute optimized out — skip silently
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
      gl.enableVertexAttribArray(a.location);
      const stride = a.stride ?? 0;
      const offset = a.offset ?? 0;
      if (a.integer) {
        const type = a.type ?? gl.UNSIGNED_INT;
        gl.vertexAttribIPointer(a.location, a.size, type, stride, offset);
      } else {
        const type = a.type ?? gl.FLOAT;
        gl.vertexAttribPointer(a.location, a.size, type, a.normalized ?? false, stride, offset);
      }
      gl.vertexAttribDivisor(a.location, a.divisor ?? 0);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }

  bindVAO(vao: WebGLVertexArrayObject | null): void {
    this.gl.bindVertexArray(vao);
  }

  // --- render targets / framebuffers ------------------------------------

  /** Bind a render target (or the screen when null) and set the viewport to it. */
  bindTarget(target: RenderTarget | null): void {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
  }

  viewport(x: number, y: number, width: number, height: number): void {
    this.gl.viewport(x, y, width, height);
  }

  /** Clear color and/or depth on the chosen target. */
  clear(opts: ClearOptions = {}): void {
    const gl = this.gl;
    this.bindTarget(opts.target ?? null);
    let mask = 0;
    if (opts.color) {
      gl.clearColor(opts.color[0], opts.color[1], opts.color[2], opts.color[3]);
      mask |= gl.COLOR_BUFFER_BIT;
    }
    if (opts.depth !== undefined) {
      gl.clearDepth(opts.depth);
      mask |= gl.DEPTH_BUFFER_BIT;
    }
    if (mask) gl.clear(mask);
  }

  // --- draw --------------------------------------------------------------

  /** Instanced draw — the one geometry primitive this renderer uses: a 4-vertex
   *  TRIANGLE_STRIP quad expanded per cell. */
  drawInstanced(
    vertexCount: number,
    instanceCount: number,
    mode?: number,
    first = 0,
  ): void {
    const gl = this.gl;
    gl.drawArraysInstanced(mode ?? gl.TRIANGLE_STRIP, first, vertexCount, instanceCount);
  }

  /** Read back a 1×1 (or w×h) RGBA8 block — used by the pick pass to decode an
   *  id at the cursor. Must be called with the pick target bound. */
  readPixels(
    x: number,
    y: number,
    width: number,
    height: number,
    out: Uint8Array,
  ): Uint8Array {
    this.gl.readPixels(x, y, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out);
    return out;
  }

  destroy(): void {
    this.targets.destroy();
    const lose = this.gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  }
}

/** Decode a uint32 cell id from the RGBA8 pick encoding
 *  (R=id&255, G=(id>>8)&255, B=(id>>16)&255, A=(id>>24)&255). Mirrors the
 *  encoding the pick fragment shader writes. */
export function decodePickId(rgba: Uint8Array, offset = 0): number {
  return (
    (rgba[offset] |
      (rgba[offset + 1] << 8) |
      (rgba[offset + 2] << 16) |
      (rgba[offset + 3] << 24)) >>>
    0
  );
}
