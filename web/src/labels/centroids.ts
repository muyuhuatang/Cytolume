/**
 * centroids.ts — pure, no-DOM cluster-centroid computation for the auto map
 * labels (Cytolume P2 map-legibility, Foundations A2). For each category that
 * is *present* in a `PointData`, compute the mean position of its points; that
 * mean is where a cell-type label is anchored before projection + declutter.
 *
 * "Structure first, labels second": this module only answers *where* a type's
 * mass sits in data space. Projection to screen px, visibility culling, and
 * collision resolution live in the Wiring + `declutter.ts`.
 */
import type { PointData } from "../core/types.ts";

/** A cell-type's visual centroid in data space. `z` is 0 for 2D layouts. */
export interface Centroid {
  /** Category index (CL_label idx) as stored in `PointData.categories`. */
  category: number;
  /** Mean position [x, y, z] in data space (z===0 when `pd.dims===2`). */
  centroid: [number, number, number];
  /** Number of points of this category (population, drives semantic zoom). */
  count: number;
}

/**
 * Mean position per present category, O(count). Categories with zero points are
 * omitted (only *present* categories are returned). Result order is ascending
 * by category index (deterministic). For `dims===2`, `centroid[2]` is 0.
 */
export function computeCentroids(pd: PointData): Centroid[] {
  const { count, dims, positions, categories } = pd;
  // Accumulate sums in dense maps keyed by category index. Categories are
  // 0..65535 (Uint16) but in practice a small flat set; Map keeps it sparse.
  const sumX = new Map<number, number>();
  const sumY = new Map<number, number>();
  const sumZ = new Map<number, number>();
  const counts = new Map<number, number>();

  for (let i = 0; i < count; i++) {
    const cat = categories[i];
    const base = i * dims;
    const x = positions[base];
    const y = positions[base + 1];
    const z = dims === 3 ? positions[base + 2] : 0;
    sumX.set(cat, (sumX.get(cat) ?? 0) + x);
    sumY.set(cat, (sumY.get(cat) ?? 0) + y);
    sumZ.set(cat, (sumZ.get(cat) ?? 0) + z);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }

  const out: Centroid[] = [];
  for (const [cat, n] of counts) {
    out.push({
      category: cat,
      centroid: [sumX.get(cat)! / n, sumY.get(cat)! / n, sumZ.get(cat)! / n],
      count: n,
    });
  }
  out.sort((a, b) => a.category - b.category);
  return out;
}
