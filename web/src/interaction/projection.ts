/**
 * projection.ts — pure CPU projection of resident points to screen space.
 *
 * The 3D interaction layer (lasso, hit-tests) needs every cell's *screen*
 * position, not just the one the GPU pick returns. This brute-forces the same
 * world→screen transform the camera uses (`Camera3D.worldToScreen`) over all
 * `count` points and returns three parallel typed arrays the lasso reads.
 *
 * Coordinate space: `Camera3D.worldToScreen` returns DEVICE pixels (it bakes in
 * the camera's dpr). The interaction contract works in CSS pixels — the same
 * space pointer events report — so this divides x/y by `dpr` (default 1, which
 * is also the headless-test case where device px == CSS px). Wiring on a hi-dpi
 * display passes the live dpr so the projected points line up with a CSS-px
 * lasso polygon.
 *
 * No DOM, no GL — callable from a node/esbuild self-test.
 */
import type { PointData } from "../core/types.ts";
import type { Camera3D } from "../core/camera3d.ts";
import type { Vec3 } from "../core/math3d.ts";

export interface ScreenProjection {
  /** Per-cell screen X in CSS pixels (length = pd.count). */
  sx: Float32Array;
  /** Per-cell screen Y in CSS pixels (length = pd.count). */
  sy: Float32Array;
  /**
   * Per-cell visibility flag (length = pd.count): 1 when the point projects in
   * front of the camera within the near/far clip (depth01 ∈ [0,1]) with finite
   * screen coords, else 0. Lasso/hit-tests must skip cells with vis===0.
   */
  vis: Uint8Array;
}

/**
 * Project all resident points of `pd` to CSS-px screen space through `camera`.
 * Handles dims 2 (z treated as 0) and dims 3.
 *
 * @param dpr device-pixel-ratio to divide the camera's device-px output by so
 *            the result is CSS px. Defaults to 1 (headless / dpr-1 displays).
 */
export function projectToScreen(
  pd: PointData,
  camera: Camera3D,
  dpr = 1,
): ScreenProjection {
  const n = pd.count;
  const dims = pd.dims;
  const pos = pd.positions;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const vis = new Uint8Array(n);
  const invDpr = 1 / (dpr > 0 ? dpr : 1);
  const p: Vec3 = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const base = i * dims;
    p[0] = pos[base];
    p[1] = pos[base + 1];
    p[2] = dims === 3 ? pos[base + 2] : 0;

    const [dx, dy, depth01] = camera.worldToScreen(p);
    const x = dx * invDpr;
    const y = dy * invDpr;
    sx[i] = x;
    sy[i] = y;
    vis[i] =
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(depth01) &&
      depth01 >= 0 &&
      depth01 <= 1
        ? 1
        : 0;
  }

  return { sx, sy, vis };
}
