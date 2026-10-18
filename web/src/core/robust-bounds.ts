/*
 * robust-bounds.ts — framing bounds that a handful of outliers cannot dictate.
 *
 * `PointData.bounds` is the FULL axis-aligned extent, so a single stray cell 20 units
 * from the manifold pushes the fit radius out and the cloud renders small in a mostly
 * empty frame. UMAP in particular produces these: a few points land far from every
 * cluster and carry no structure worth framing for.
 *
 * This computes per-axis QUANTILES instead, so the framing follows the bulk of the
 * data. Outliers still render — they are data, and cropping them out of the picture
 * would be a misrepresentation — they simply stop deciding the zoom.
 */

/** Per-axis quantile bounds, in the same layout as `PointData.bounds`. */
export function robustBounds(
  positions: Float32Array,
  count: number,
  dims: 2 | 3,
  /** Tail fraction trimmed from EACH end per axis. 0.005 => 0.5th–99.5th percentile. */
  tail = 0.005,
  /** Cap on points examined; above this a deterministic stride is used. */
  maxSamples = 60000,
): number[] {
  if (count <= 0) return dims === 3 ? [0, 0, 0, 1, 1, 1] : [0, 0, 1, 1];

  // Deterministic stride, never a random sample: the framing of a figure must not
  // change between two runs over identical data.
  const stride = Math.max(1, Math.floor(count / maxSamples));
  const n = Math.floor((count - 1) / stride) + 1;

  const out: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  const buf = new Float32Array(n);

  for (let d = 0; d < dims; d++) {
    let k = 0;
    for (let i = 0; i < count; i += stride) buf[k++] = positions[i * dims + d];
    const slice = buf.subarray(0, k);
    // Sorting a typed array copy is O(n log n) on ≤60k values — negligible next to a
    // frame, and this runs once per layout change rather than per frame.
    const sorted = slice.slice().sort();
    const a = sorted[Math.floor((k - 1) * tail)];
    const b = sorted[Math.ceil((k - 1) * (1 - tail))];
    // Degenerate axis (every value equal) would give a zero extent; keep it non-zero
    // so the caller's radius maths cannot divide by it.
    lo.push(a);
    hi.push(b === a ? a + 1e-6 : b);
  }

  for (let d = 0; d < dims; d++) out.push(lo[d]);
  for (let d = 0; d < dims; d++) out.push(hi[d]);
  return out;
}

/** Centre + radius that frames the bulk of the cloud. */
export interface RobustSphere {
  center: [number, number, number];
  radius: number;
}

/**
 * A framing sphere derived from the POINTS, not from their bounding box.
 *
 * `camera.fit` takes the box's bounding-sphere radius (`0.5 * hypot(dx,dy,dz)`), which
 * is correct-but-conservative: for a roughly isotropic cloud that is ~sqrt(3) times the
 * radius actually needed, so the cloud sits small in the frame. Measuring the radius as
 * a high quantile of |p - centre| frames what is really there.
 */
export function robustSphere(
  positions: Float32Array,
  count: number,
  dims: 2 | 3,
  /** Fraction of the FURTHEST points allowed outside the framing sphere. */
  tail = 0.01,
  maxSamples = 60000,
): RobustSphere {
  if (count <= 0) return { center: [0, 0, 0], radius: 1 };
  const stride = Math.max(1, Math.floor(count / maxSamples));

  // Centre on the MEDIAN, not the mean: a mean is itself dragged by outliers, which
  // is the failure this function exists to avoid.
  const b = robustBounds(positions, count, dims, 0.5 - 1e-9, maxSamples);
  const center: [number, number, number] = [
    b[0],
    b[1],
    dims === 3 ? b[2] : 0,
  ];

  const d: number[] = [];
  for (let i = 0; i < count; i += stride) {
    const x = positions[i * dims] - center[0];
    const y = positions[i * dims + 1] - center[1];
    const z = dims === 3 ? positions[i * dims + 2] - center[2] : 0;
    d.push(Math.hypot(x, y, z));
  }
  d.sort((p, q) => p - q);
  const idx = Math.min(d.length - 1, Math.max(0, Math.ceil((d.length - 1) * (1 - tail))));
  return { center, radius: Math.max(1e-6, d[idx]) };
}

/**
 * Cloud extent measured in the CAMERA's own screen basis.
 *
 * `robustSphere` above answers "how big a ball holds this?" — the wrong question.
 * A UMAP cloud is not a ball, and a camera does not project balls: it projects a
 * screen-width and a screen-height. Framing by a sphere radius fitted to
 * min(vFov, hFov) therefore leaves the four corners of the frame permanently
 * empty. On the real umap3d spine the sphere radius is 294.94 while the actual
 * half-extents along the hero pose's right/up axes are 174.7 and 161.7.
 *
 * It also fixes the centre. `robustSphere` centres on the per-axis MEDIAN, which
 * is a statistic about where the MASS is, not about where the EXTENT is. On
 * umap3d the median Y sits 95.9 units — 0.55 of the half-extent — above the
 * midpoint of the quantile interval, which is the 100-odd pixels of "the cloud
 * sits low" visible in the frame. Framing wants the midpoint.
 */
export interface ViewExtent {
  /** World-space midpoint of the robust core (NOT the median — see above). */
  center: [number, number, number];
  /** Half-extent of the robust CORE along camera right / up / view. */
  core: [number, number, number];
  /** Half-extent of EVERY point about the same centre and axes. Nothing is
   *  trimmed here: the tails must not choose the zoom, but a figure that lets a
   *  cell slide off the canvas has misstated n. This is the containment floor. */
  full: [number, number, number];
}

export function robustViewExtent(
  positions: Float32Array,
  count: number,
  dims: 2 | 3,
  right: readonly number[],
  up: readonly number[],
  fwd: readonly number[],
  /** Tail trimmed from EACH end per screen axis. 0.005 => 0.5th-99.5th pct. */
  tail = 0.005,
  maxSamples = 60000,
): ViewExtent {
  const axes: readonly number[][] = [right as number[], up as number[], fwd as number[]];
  if (count <= 0) return { center: [0, 0, 0], core: [1, 1, 1], full: [1, 1, 1] };

  // Deterministic stride, never a random sample - see robustBounds.
  const stride = Math.max(1, Math.floor(count / maxSamples));
  const n = Math.floor((count - 1) / stride) + 1;
  const buf = new Float32Array(n);
  const mid: number[] = [];
  const core: number[] = [];

  for (let a = 0; a < 3; a++) {
    const A = axes[a];
    let k = 0;
    for (let i = 0; i < count; i += stride) {
      const x = positions[i * dims];
      const y = positions[i * dims + 1];
      const z = dims === 3 ? positions[i * dims + 2] : 0;
      buf[k++] = x * A[0] + y * A[1] + z * A[2];
    }
    const s2 = buf.subarray(0, k).slice().sort(); // TypedArray sort is numeric
    const lo = s2[Math.floor((k - 1) * tail)];
    const hi = s2[Math.ceil((k - 1) * (1 - tail))];
    mid.push((lo + hi) / 2);
    core.push(Math.max(1e-6, (hi - lo) / 2));
  }

  // right/up/fwd are orthonormal, so the world centre is just the axis midpoints
  // recombined.
  const center: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const A = axes[a];
    center[0] += mid[a] * A[0];
    center[1] += mid[a] * A[1];
    center[2] += mid[a] * A[2];
  }

  // Full extent about the SAME centre. Every point, no stride, no trim - this is
  // the number that keeps outliers on the canvas.
  const full: [number, number, number] = [1e-6, 1e-6, 1e-6];
  for (let i = 0; i < count; i++) {
    const x = positions[i * dims] - center[0];
    const y = positions[i * dims + 1] - center[1];
    const z = (dims === 3 ? positions[i * dims + 2] : 0) - center[2];
    for (let a = 0; a < 3; a++) {
      const A = axes[a];
      const q = Math.abs(x * A[0] + y * A[1] + z * A[2]);
      if (q > full[a]) full[a] = q;
    }
  }

  return { center, core: core as [number, number, number], full };
}
