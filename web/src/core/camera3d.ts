/*
 * Camera3D — orbit camera for the 3D sphere-impostor renderer (reflection-3).
 *
 * Forked in spirit from Camera2D (do NOT modify that one): same "the camera is
 * where the premium feel lives" philosophy, lifted to 3D. The orientation is a
 * quaternion arcball (renormalized every frame, finite-guarded), the dolly is
 * logarithmic (constant perceived speed at every scale, exactly like the 2D
 * zoom), pan is in the world plane facing the camera, and fit() frames a 6-tuple
 * bounds box. near/far are derived tight from the bounds so gl_FragDepth — which
 * the impostor frag writes by hand — stays honest.
 *
 * Camera model: the camera orbits a `target`. `rotation` maps camera-local axes
 * to world, so:
 *     eye   = target + rotation·(0,0,distance)   (local +Z points back at viewer)
 *     right = rotation·(1,0,0)
 *     up    = rotation·(0,1,0)
 *     fwd   = rotation·(0,0,-1)  (view direction, eye→target)
 * right/up are the billboard basis the vertex shader expands the quad along.
 *
 * It also owns a manual-clock transition controller (SLERP rotation + smoothstep
 * pose + logLerp distance) used by the layout morph; drive it with step(dtMs).
 */

import {
  type Vec3,
  type Quat,
  type Mat4,
  v3,
  v3add,
  v3scale,
  v3lerp,
  v3normalize,
  qIdentity,
  qNormalize,
  qMul,
  qFromAxisAngle,
  qRotateVec3,
  qSlerp,
  qIsFinite,
  m4Perspective,
  m4Ortho,
  m4LookAt,
  m4Multiply,
  m4TransformPoint,
  m4IsFinite,
  clamp,
  smoothstep,
  lerp,
  logLerp,
} from "./math3d.ts";

/** A fully-specified camera pose — the unit a transition interpolates between. */
export interface CameraPose {
  target: Vec3;
  rotation: Quat;
  distance: number;
  fov: number; // radians
  orthographic: boolean;
}

export interface Camera3DUniforms {
  /** Combined projection * view, column-major, ready for uniformMatrix4fv. */
  u_viewProj: Mat4;
  u_cameraRight: Vec3;
  u_cameraUp: Vec3;
  /** World-space view direction (eye → target). */
  u_viewDir: Vec3;
}

const DEG2RAD = Math.PI / 180;

export class Camera3D {
  /** Point the camera orbits / looks at. */
  target: Vec3 = v3(0, 0, 0);
  /** Orientation: maps camera-local axes into world space. */
  rotation: Quat = qIdentity();
  /** Distance from eye to target (the dolly). */
  distance = 4;
  /** Vertical field of view, radians (~60° default). */
  fov = 60 * DEG2RAD;
  /** Perspective by default; toggle for an orthographic read of the cloud. */
  orthographic = false;

  /** Radius of the framed data sphere — drives tight near/far. */
  private boundsRadius = 1;
  /** Half-extent of the framed cloud ALONG the view axis. 0 = not measured (the
   *  fit()/fitSphere() paths), in which case nearFar falls back to boundsRadius. */
  private viewHalfDepth = 0;
  /** The distance the last fit chose. Callers that scale behaviour with zoom
   *  (label density, density-field semantic zoom) must reference THIS rather than
   *  a hardcoded ratio, or they silently recalibrate every time the fit improves. */
  fitDistance = 4;
  private width = 1;
  private height = 1;
  private dpr = 1;

  // --- rotation feel ---
  private rotateSpeed = 0.008; // radians per CSS pixel

  // --- transition controller (manual clock) ---
  private transition: {
    from: CameraPose;
    to: CameraPose;
    elapsed: number;
    duration: number;
  } | null = null;

  // ------------------------------------------------------------ viewport

  setViewport(width: number, height: number, dpr = this.dpr): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.max(0.5, dpr);
  }

  /** Device pixels per CSS pixel for the CURRENT viewport. The renderer must read
   *  this rather than re-deriving it from window.devicePixelRatio: during a
   *  high-resolution figure export the caller deliberately sets a larger value. */
  get devicePixelRatio(): number {
    return this.dpr;
  }

  private get aspect(): number {
    return this.width / this.height;
  }

  // ------------------------------------------------------------ derived basis

  /** World-space camera right axis (billboard X). */
  right(): Vec3 {
    return v3normalize(qRotateVec3(this.rotation, [1, 0, 0]), [1, 0, 0]);
  }
  /** World-space camera up axis (billboard Y). */
  up(): Vec3 {
    return v3normalize(qRotateVec3(this.rotation, [0, 1, 0]), [0, 1, 0]);
  }
  /** World-space view direction, eye → target. */
  viewDir(): Vec3 {
    return v3normalize(qRotateVec3(this.rotation, [0, 0, -1]), [0, 0, -1]);
  }
  /** World-space eye position. */
  eye(): Vec3 {
    const back = qRotateVec3(this.rotation, [0, 0, this.distance]);
    return v3add(this.target, back);
  }

  // ------------------------------------------------------------ framing

  /**
   * Frame a 6-tuple data box [minX,minY,minZ,maxX,maxY,maxZ]. Sets target to the
   * box centre and dollies out far enough that the bounding sphere fits the fov,
   * then records the sphere radius for tight near/far. Orientation is left as-is
   * so a fit during a morph doesn't fight the user's chosen view.
   */
  /**
   * Frame an explicit centre + radius. Prefer this over `fit()` when the caller can
   * measure the cloud: `fit()` derives its radius from the bounding BOX, which for an
   * isotropic cloud is ~sqrt(3) larger than necessary and leaves the data small in
   * frame. See core/robust-bounds.ts.
   */
  fitSphere(center: [number, number, number], radius: number, pad = 1.06): void {
    this.target = [center[0], center[1], center[2]];
    this.boundsRadius = Math.max(1e-6, radius);
    const hFov = 2 * Math.atan(Math.tan(this.fov / 2) * this.aspect);
    const fitFov = Math.min(this.fov, hFov);
    this.distance = (this.boundsRadius / Math.sin(fitFov / 2)) * pad;
    this.viewHalfDepth = 0; // unknown on this path -> nearFar falls back to the sphere
    this.fitDistance = this.distance;
  }

  /**
   * Frame a measured ViewExtent (core/robust-bounds.ts) into a CONTENT rect,
   * given in CSS px relative to the canvas.
   *
   * fitSphere/fit answer "what distance makes a BALL of radius r subtend the
   * smaller of the two fovs?" - which throws away the larger fov entirely and,
   * for an anisotropic cloud, the frame's corners as well. This fits the two
   * screen axes independently, against the rect the reader can actually see.
   *
   * TWO constraints, both enforced, whichever is larger wins:
   *   FILL - the robust core spans the content rect. This is what makes the
   *          cloud big.
   *   HOLD - every point, tails included, still lands on the CANVAS. The tails
   *          do not choose the zoom, but nothing is ever cropped: a plate that
   *          silently drops cells has misstated n. Note the canvas, not the
   *          content rect - the panels FLOAT over the marks, so a faint halo
   *          running under the key is honest and costs nothing, while a cell
   *          past the canvas edge is gone.
   */
  fitExtent(
    e: {
      center: [number, number, number];
      core: [number, number, number];
      full: [number, number, number];
    },
    content: { x: number; y: number; w: number; h: number } = {
      x: 0,
      y: 0,
      w: this.width,
      h: this.height,
    },
    pad = 1.06,
  ): void {
    const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const W = this.width;
    const H = this.height;
    const a = this.aspect;
    const cw = Math.max(1, Math.min(content.w, W));
    const ch = Math.max(1, Math.min(content.h, H));
    const t = Math.tan(this.fov / 2);

    // Where the cloud centre should land, in NDC. Clamped: a content rect jammed
    // against an edge would otherwise divide by ~0 in the HOLD term below.
    const ndcX = cl((2 * (content.x + cw / 2)) / W - 1, -0.9, 0.9);
    const ndcY = cl(1 - (2 * (content.y + ch / 2)) / H, -0.9, 0.9);

    // FILL: the content rect's half-height in world units is d*t*(ch/H) and its
    // half-width is d*t*(cw/H) - so both constraints share one clean form.
    const dFill = (Math.max(e.core[1] * (H / ch), e.core[0] * (H / cw)) * pad) / t;

    // HOLD: an off-centre target eats into the margin on one side, hence 1-|ndc|.
    const dHold =
      Math.max(
        e.full[1] / (t * (1 - Math.abs(ndcY))),
        e.full[0] / (t * a * (1 - Math.abs(ndcX))),
      ) * 1.005;

    this.distance = Math.max(1e-6, dFill, dHold);
    this.fitDistance = this.distance;

    const hh = this.distance * t;
    const r = this.right();
    const u = this.up();
    this.target = [
      e.center[0] - r[0] * ndcX * hh * a - u[0] * ndcY * hh,
      e.center[1] - r[1] * ndcX * hh * a - u[1] * ndcY * hh,
      e.center[2] - r[2] * ndcX * hh * a - u[2] * ndcY * hh,
    ];

    this.viewHalfDepth = Math.max(1e-6, e.full[2]);
    this.boundsRadius = Math.max(1e-6, e.full[0], e.full[1], e.full[2]);
  }

  fit(bounds: number[], pad = 1.1): void {
    const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
    this.target = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    ];
    const dx = Math.max(1e-6, maxX - minX);
    const dy = Math.max(1e-6, maxY - minY);
    const dz = Math.max(1e-6, maxZ - minZ);
    const radius = 0.5 * Math.hypot(dx, dy, dz);
    this.boundsRadius = Math.max(1e-6, radius);
    // distance so the bounding sphere subtends the (smaller of v/h) fov.
    const vFov = this.fov;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.aspect);
    const fitFov = Math.min(vFov, hFov);
    this.distance = (this.boundsRadius / Math.sin(fitFov / 2)) * pad;
    // Legacy path: no view-axis measurement, so nearFar falls back to the sphere.
    this.viewHalfDepth = 0;
    this.fitDistance = this.distance;
  }

  /** Near/far derived tight from the framed sphere, clamped finite & positive. */
  nearFar(): [number, number] {
    // Bracket only what the VIEW axis spans when we measured it. A containing
    // sphere would spend depth precision the impostors' hand-written
    // gl_FragDepth needs.
    const r =
      this.viewHalfDepth > 0
        ? Math.max(this.viewHalfDepth, this.boundsRadius * 0.15) * 1.15
        : this.boundsRadius * 1.25;
    const near = Math.max(this.distance - r, this.distance * 2e-3, 1e-4);
    const far = Math.max(near * 1.001, this.distance + r + 1e-3);
    return [near, far];
  }

  // ------------------------------------------------------------ interaction

  /**
   * Arcball orbit from a pixel drag. Yaw about world-up, pitch about the current
   * camera-right axis, composed as incremental quaternions — this never passes
   * through a degenerate basis, so the poles are NaN-free (unlike a two-point
   * sphere-mapping arcball). Renormalized + finite-guarded every call.
   */
  rotateByPixels(dxPx: number, dyPx: number): void {
    const yaw = -dxPx * this.rotateSpeed;
    const pitch = -dyPx * this.rotateSpeed;
    const rightAxis = this.right();
    const qYaw = qFromAxisAngle([0, 1, 0], yaw);
    const qPitch = qFromAxisAngle(rightAxis, pitch);
    const next = qNormalize(qMul(qPitch, qMul(qYaw, this.rotation)));
    if (qIsFinite(next)) this.rotation = next; // guard: keep last good on NaN
  }

  /** Set orientation directly from a quaternion (renormalized + guarded). */
  setRotation(q: Quat): void {
    const n = qNormalize(q);
    if (qIsFinite(n)) this.rotation = n;
  }

  /**
   * Logarithmic dolly. `delta` is raw wheel deltaY; positive (scroll down) pulls
   * the camera back. Distance is clamped to a sane band around the framed sphere.
   */
  dolly(delta: number): void {
    const next = this.distance * Math.exp(delta * 0.001);
    const lo = this.boundsRadius * 1e-3;
    const hi = this.boundsRadius * 1e4;
    this.distance = clamp(Number.isFinite(next) ? next : this.distance, lo, hi);
  }

  /** World-space pan from a pixel drag — moves target in the camera right/up plane. */
  panByPixels(dxPx: number, dyPx: number): void {
    const worldPerPixel = 1 / this.pixelsPerWorldUnitAt(this.distance);
    const r = this.right();
    const u = this.up();
    // screen-right drag should move the scene left → target moves right; screen
    // up drag moves target up. Net: target -= right*dx ; target += up*dy.
    const move = v3add(v3scale(r, -dxPx * worldPerPixel), v3scale(u, dyPx * worldPerPixel));
    this.target = v3add(this.target, move);
  }

  // ------------------------------------------------------------ matrices / uniforms

  /** Projection matrix for the current mode and viewport. */
  projection(): Mat4 {
    const [near, far] = this.nearFar();
    if (this.orthographic) {
      // match the perspective framing at the target plane so toggling is smooth.
      const halfH = this.distance * Math.tan(this.fov / 2);
      const halfW = halfH * this.aspect;
      return m4Ortho(-halfW, halfW, -halfH, halfH, near, far);
    }
    return m4Perspective(this.fov, this.aspect, near, far);
  }

  /** View matrix (world → camera). */
  view(): Mat4 {
    return m4LookAt(this.eye(), this.target, this.up());
  }

  /** Combined view-projection, column-major. */
  viewProj(): Mat4 {
    return m4Multiply(this.projection(), this.view());
  }

  /** The SPEC uniform block consumed by the impostor program. */
  uniforms(): Camera3DUniforms {
    return {
      u_viewProj: this.viewProj(),
      u_cameraRight: this.right(),
      u_cameraUp: this.up(),
      u_viewDir: this.viewDir(),
    };
  }

  /**
   * Screen pixels per world unit at a given view-space depth (distance from the
   * eye). Drives the world-space radius → screen radius mapping, its min-pixel
   * floor, and the density-aware alpha curve. Returns device pixels (dpr-scaled).
   * In ortho the scale is depth-independent.
   */
  pixelsPerWorldUnitAt(depth: number): number {
    const pxH = this.height * this.dpr;
    if (this.orthographic) {
      const worldH = 2 * this.distance * Math.tan(this.fov / 2);
      return pxH / Math.max(1e-9, worldH);
    }
    const d = Math.max(1e-6, depth);
    const worldH = 2 * d * Math.tan(this.fov / 2);
    return pxH / Math.max(1e-9, worldH);
  }

  // ------------------------------------------------------------ pose / transitions

  getPose(): CameraPose {
    return {
      target: [...this.target] as Vec3,
      rotation: [...this.rotation] as Quat,
      distance: this.distance,
      fov: this.fov,
      orthographic: this.orthographic,
    };
  }

  setPose(p: CameraPose): void {
    this.target = [...p.target] as Vec3;
    this.setRotation(p.rotation);
    this.distance = p.distance;
    this.fov = p.fov;
    this.orthographic = p.orthographic;
  }

  /** Whether a transition is currently animating. */
  get isTransitioning(): boolean {
    return this.transition !== null;
  }

  /**
   * Animate from the current pose to `to` over `durationMs`. Partial poses inherit
   * unspecified fields from the current camera. Drive with step(dtMs).
   */
  transitionTo(to: Partial<CameraPose>, durationMs = 320): void {
    const from = this.getPose();
    const target: CameraPose = {
      target: to.target ? ([...to.target] as Vec3) : from.target,
      rotation: to.rotation ? qNormalize(to.rotation) : from.rotation,
      distance: to.distance ?? from.distance,
      fov: to.fov ?? from.fov,
      orthographic: to.orthographic ?? from.orthographic,
    };
    this.transition = {
      from,
      to: target,
      elapsed: 0,
      duration: Math.max(1, durationMs),
    };
  }

  /** Cancel any in-flight transition, leaving the camera where it is. */
  stopTransition(): void {
    this.transition = null;
  }

  /**
   * Advance the transition clock by `dtMs`. SLERP the rotation, smoothstep the
   * pose (target / fov), logLerp the distance. Returns true while still animating
   * (so the host knows to keep requesting frames). No-op returning false if idle.
   */
  step(dtMs: number): boolean {
    const tr = this.transition;
    if (!tr) return false;
    tr.elapsed += dtMs;
    const raw = clamp(tr.elapsed / tr.duration, 0, 1);
    const s = smoothstep(raw);

    this.target = v3lerp(tr.from.target, tr.to.target, s);
    this.setRotation(qSlerp(tr.from.rotation, tr.to.rotation, s));
    this.distance = logLerp(tr.from.distance, tr.to.distance, s);
    this.fov = lerp(tr.from.fov, tr.to.fov, s);
    // a boolean can't tween; switch the projection mode at the midpoint.
    this.orthographic = s < 0.5 ? tr.from.orthographic : tr.to.orthographic;

    if (raw >= 1) {
      this.setPose(tr.to);
      this.transition = null;
      return false;
    }
    return true;
  }

  /** Project a world point to device pixels (origin top-left). For picking/debug. */
  worldToScreen(p: Vec3): [number, number, number] {
    const clip = m4TransformPoint(this.viewProj(), p);
    const w = clip[3] === 0 ? 1e-9 : clip[3];
    const ndcX = clip[0] / w;
    const ndcY = clip[1] / w;
    const ndcZ = clip[2] / w;
    return [
      (ndcX * 0.5 + 0.5) * this.width * this.dpr,
      (1 - (ndcY * 0.5 + 0.5)) * this.height * this.dpr,
      ndcZ * 0.5 + 0.5,
    ];
  }
}

// ================================================================ self-test

/**
 * Headless self-test (no GL). Asserts the two SPEC-critical invariants:
 *   1. No NaN / non-finite outputs through pole rotations (straight up & down).
 *   2. fit() frames a known bounds — target lands on the box centre and the
 *      centre projects to the middle of the screen with finite matrices.
 * Throws on the first failure; returns a short log on success. Callable from a
 * temp driver (`_camera3d_selftest.mjs`) or any harness.
 */
export function camera3DSelfTest(): string[] {
  const log: string[] = [];
  const ok = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error("Camera3D self-test FAILED: " + msg);
    log.push("ok: " + msg);
  };
  const finiteU = (u: Camera3DUniforms): boolean =>
    m4IsFinite(u.u_viewProj) &&
    u.u_cameraRight.every(Number.isFinite) &&
    u.u_cameraUp.every(Number.isFinite) &&
    u.u_viewDir.every(Number.isFinite);

  // ---- 1. pole rotations ----
  const cam = new Camera3D();
  cam.setViewport(800, 600, 1);
  cam.fit([-1, -2, -3, 1, 2, 3]);
  // hammer pitch well past both poles (≈ ±900° total) plus some yaw.
  for (let i = 0; i < 400; i++) {
    cam.rotateByPixels(7, 11); // diagonal drag, accumulates through up & down poles
    ok(qIsFinite(cam.rotation), `rotation finite at pole step ${i}`);
    ok(finiteU(cam.uniforms()), `uniforms finite at pole step ${i}`);
  }
  // explicit straight-up and straight-down singularities
  cam.setRotation(qIdentity());
  cam.rotateByPixels(0, 1e6); // slam to a pole
  ok(qIsFinite(cam.rotation) && finiteU(cam.uniforms()), "straight-down pole finite");
  cam.rotateByPixels(0, -2e6);
  ok(qIsFinite(cam.rotation) && finiteU(cam.uniforms()), "straight-up pole finite");
  // quaternion stays unit-length (renormalized)
  const qmag = Math.hypot(...cam.rotation);
  ok(Math.abs(qmag - 1) < 1e-5, `rotation stays unit-length (|q|=${qmag.toFixed(6)})`);

  // ---- 2. fit() frames a known bounds ----
  const cam2 = new Camera3D();
  cam2.setViewport(1000, 1000, 1);
  const bounds = [10, 20, 30, 14, 26, 38]; // centre (12,23,34)
  cam2.fit(bounds);
  const c: Vec3 = [12, 23, 34];
  ok(
    Math.abs(cam2.target[0] - c[0]) < 1e-6 &&
      Math.abs(cam2.target[1] - c[1]) < 1e-6 &&
      Math.abs(cam2.target[2] - c[2]) < 1e-6,
    "fit() target == bounds centre",
  );
  ok(cam2.distance > 0 && Number.isFinite(cam2.distance), "fit() distance positive & finite");
  const [near, far] = cam2.nearFar();
  ok(near > 0 && far > near && Number.isFinite(far), `fit() near/far valid (${near.toFixed(3)}..${far.toFixed(3)})`);
  ok(finiteU(cam2.uniforms()), "fit() uniforms finite");
  // bounds centre projects to screen centre (within sub-pixel)
  const [sx, sy, sz] = cam2.worldToScreen(c);
  ok(
    Math.abs(sx - 500) < 0.5 && Math.abs(sy - 500) < 0.5,
    `centre projects to screen centre (${sx.toFixed(2)}, ${sy.toFixed(2)})`,
  );
  ok(sz > 0 && sz < 1, `centre depth in (0,1): ${sz.toFixed(4)}`);
  // the 8 corners all land in front of the camera and on-screen (sphere is framed)
  let allFront = true;
  for (const xi of [bounds[0], bounds[3]])
    for (const yi of [bounds[1], bounds[4]])
      for (const zi of [bounds[2], bounds[5]]) {
        const [, , cz] = cam2.worldToScreen([xi, yi, zi]);
        if (!(cz > 0 && cz < 1)) allFront = false;
      }
  ok(allFront, "all 8 bounds corners within near/far clip");

  // ---- 3. ortho toggle + transition controller stay finite ----
  cam2.orthographic = true;
  ok(finiteU(cam2.uniforms()), "orthographic uniforms finite");
  ok(cam2.pixelsPerWorldUnitAt(cam2.distance) > 0, "ortho pixelsPerWorldUnit positive");
  cam2.orthographic = false;

  const cam3 = new Camera3D();
  cam3.setViewport(800, 600, 1);
  cam3.fit([-5, -5, -5, 5, 5, 5]);
  cam3.transitionTo(
    { rotation: qFromAxisAngle([0, 1, 0], Math.PI), distance: cam3.distance * 6, fov: 45 * DEG2RAD },
    320,
  );
  let frames = 0;
  while (cam3.step(16) && frames < 1000) {
    ok(finiteU(cam3.uniforms()), `transition frame ${frames} finite`);
    frames++;
  }
  ok(frames > 0 && frames < 1000, `transition completed in ${frames} frames`);
  ok(!cam3.isTransitioning, "transition cleared after completion");

  log.push(`PASS — ${log.length} assertions`);
  return log;
}
