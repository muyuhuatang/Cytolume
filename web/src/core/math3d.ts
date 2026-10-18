/*
 * math3d — the minimum vec3 / quat / mat4 kit Camera3D needs, written inline so
 * the library stays dependency-free (no gl-matrix in the bundle). Conventions:
 *   - vec3 is a 3-tuple [x,y,z]; quat is [x,y,z,w] (w last, like gl-matrix).
 *   - mat4 is a Float32Array(16) in COLUMN-MAJOR order (WebGL / OpenGL layout),
 *     so it can be handed straight to gl.uniformMatrix4fv(..., false, m).
 * Functions allocate fresh outputs — the camera runs these a handful of times
 * per frame, never per-point, so clarity beats pooling here.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w
export type Mat4 = Float32Array; // length 16, column-major

// ---------------------------------------------------------------- vec3

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}
export function v3add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function v3sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function v3scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function v3dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function v3cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function v3len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
/** Normalize; on a (near-)zero vector returns `fallback` instead of NaNs. */
export function v3normalize(a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const l = v3len(a);
  if (l < 1e-12 || !Number.isFinite(l)) return [...fallback];
  const inv = 1 / l;
  return [a[0] * inv, a[1] * inv, a[2] * inv];
}
export function v3lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
export function v3isFinite(a: Vec3): boolean {
  return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}

// ---------------------------------------------------------------- quat

export function qIdentity(): Quat {
  return [0, 0, 0, 1];
}
export function qLen(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}
/** Renormalize; on a degenerate quat returns identity (never NaNs). */
export function qNormalize(q: Quat): Quat {
  const l = qLen(q);
  if (l < 1e-12 || !Number.isFinite(l)) return qIdentity();
  const inv = 1 / l;
  return [q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv];
}
export function qIsFinite(q: Quat): boolean {
  return (
    Number.isFinite(q[0]) &&
    Number.isFinite(q[1]) &&
    Number.isFinite(q[2]) &&
    Number.isFinite(q[3])
  );
}
/** Hamilton product a*b (apply b first, then a). */
export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export function qFromAxisAngle(axis: Vec3, rad: number): Quat {
  const n = v3normalize(axis, [0, 1, 0]);
  const h = rad * 0.5;
  const s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}
/** Rotate v by q: v' = v + 2*qw*(qv×v) + 2*qv×(qv×v). */
export function qRotateVec3(q: Quat, v: Vec3): Vec3 {
  const qv: Vec3 = [q[0], q[1], q[2]];
  const t = v3scale(v3cross(qv, v), 2);
  return v3add(v3add(v, v3scale(t, q[3])), v3cross(qv, t));
}
/** Shortest-arc spherical lerp with a linear fallback for near-parallel quats. */
export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b[0],
    by = b[1],
    bz = b[2],
    bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    // take the shorter path
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number, s1: number;
  if (cos > 0.9995) {
    // almost parallel → linear, then renormalize (avoids /sin(0))
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }
  return qNormalize([
    a[0] * s0 + bx * s1,
    a[1] * s0 + by * s1,
    a[2] * s0 + bz * s1,
    a[3] * s0 + bw * s1,
  ]);
}

// ---------------------------------------------------------------- mat4

export function m4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
export function m4IsFinite(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}
/** out = a * b (column-major). */
export function m4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4],
      b1 = b[c * 4 + 1],
      b2 = b[c * 4 + 2],
      b3 = b[c * 4 + 3];
    o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
}
/** Right-handed perspective, clip z in [-1,1] (WebGL default). */
export function m4Perspective(
  fovy: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}
/** Right-handed orthographic, clip z in [-1,1]. */
export function m4Ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = -2 * lr;
  m[5] = -2 * bt;
  m[10] = 2 * nf;
  m[12] = (left + right) * lr;
  m[13] = (top + bottom) * bt;
  m[14] = (far + near) * nf;
  m[15] = 1;
  return m;
}
/** Right-handed look-at view matrix. Falls back to a safe up if eye≈center. */
export function m4LookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const f = v3normalize(v3sub(center, eye), [0, 0, -1]); // forward (view dir)
  let s = v3cross(f, up); // right
  if (v3len(s) < 1e-9) {
    // up parallel to forward → nudge with an alternate axis
    s = v3cross(f, [1, 0, 0]);
    if (v3len(s) < 1e-9) s = v3cross(f, [0, 0, 1]);
  }
  s = v3normalize(s, [1, 0, 0]);
  const u = v3cross(s, f); // true up
  const m = new Float32Array(16);
  m[0] = s[0];
  m[4] = s[1];
  m[8] = s[2];
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[2] = -f[0];
  m[6] = -f[1];
  m[10] = -f[2];
  m[12] = -v3dot(s, eye);
  m[13] = -v3dot(u, eye);
  m[14] = v3dot(f, eye);
  m[15] = 1;
  return m;
}
/** Transform a point (w=1) by a column-major mat4, returning [x,y,z,w]. */
export function m4TransformPoint(
  m: Mat4,
  p: Vec3,
): [number, number, number, number] {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

// ---------------------------------------------------------------- scalars

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
/** Hermite ease-in-out (the classic 3t²−2t³), clamped to [0,1]. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Geometric (log-space) interpolation — the honest way to ease a dolly. */
export function logLerp(a: number, b: number, t: number): number {
  const aa = Math.max(a, 1e-9);
  const bb = Math.max(b, 1e-9);
  return Math.exp(lerp(Math.log(aa), Math.log(bb), t));
}
