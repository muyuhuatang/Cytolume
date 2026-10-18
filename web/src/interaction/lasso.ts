/**
 * lasso.ts — freeform lasso selection over resident points (pure logic).
 *
 * Given a closed polygon in CSS-px screen space and the active `PointData`, this
 * projects every point (via {@link projectToScreen}) and returns the `cell_id`s
 * whose *visible* screen point falls inside the polygon. Inside-ness is a classic
 * even-odd ray-cast (point-in-polygon); brute force over `count` is fine at the
 * ~450k scale this targets.
 *
 * Returns stable `cell_id`s (not indices) so the selection survives a layout
 * morph — the renderer maps ids→instances itself.
 *
 * No DOM, no GL.
 */
import type { PointData } from "../core/types.ts";
import type { Camera3D } from "../core/camera3d.ts";
import { projectToScreen } from "./projection.ts";

export type Point2 = [number, number];

/**
 * Even-odd ray-cast point-in-polygon. `poly` is a list of [x,y] vertices; the
 * edge from the last vertex back to the first is implicit (polygon auto-closes).
 * Returns true when (x,y) is strictly inside (boundary cases are not relied on).
 */
export function pointInPolygon(
  x: number,
  y: number,
  poly: ReadonlyArray<Point2>,
): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    // Does the horizontal ray at height y cross edge (j→i)?
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Select all visible points of `pd` whose projected screen position lies inside
 * `polygonCssPx`. Polygon must be in the SAME CSS-px space as the projection
 * (pass the live `dpr` so device-px camera output is normalised to match).
 *
 * @returns Uint32Array of selected `cell_id`s (possibly empty). A polygon with
 *          fewer than 3 vertices selects nothing.
 */
export function lassoSelect(
  polygonCssPx: ReadonlyArray<Point2>,
  pd: PointData,
  camera: Camera3D,
  dpr = 1,
): Uint32Array {
  if (polygonCssPx.length < 3) return new Uint32Array(0);

  const { sx, sy, vis } = projectToScreen(pd, camera, dpr);
  const ids = pd.ids;
  const hits: number[] = [];
  for (let i = 0; i < pd.count; i++) {
    if (vis[i] === 0) continue;
    if (pointInPolygon(sx[i], sy[i], polygonCssPx)) hits.push(ids[i]);
  }
  return Uint32Array.from(hits);
}
