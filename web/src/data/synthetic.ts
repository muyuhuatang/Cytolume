/*
 * Synthetic embedding — a placeholder proving set for the P1 showcase.
 *
 * The real P0 data spine (offline scanpy/scVI/UCE → Arrow/Parquet → quadtree
 * tiles, starting from the predecessor's ~453k cells) is not wired yet. Until
 * it is, this generator stands in: clustered 2-D Gaussian blobs with a
 * power-law population spread, so the scene has both dense cores that glow and
 * rare populations that must survive as legible sparks — exactly the honest-
 * density behaviour the renderer is meant to prove.
 *
 * Deterministic (seeded) so the demo looks identical on every load.
 */
import type { PointData } from "../core/types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller standard normal, rejection-sampled to within ±3σ. Bounding the
 * tail matters: untruncated Box-Muller occasionally emits ±6σ points, and raw
 * min/max bounds over those outliers inflate the viewport asymmetrically — the
 * dense cloud then fits-to-frame as a tiny off-centre speck. (Real data gets
 * the same treatment via percentile clamping — reflection-0 §5.)
 *
 * We *reject and redraw* rather than clamp: clamping piles every out-of-range
 * sample onto exactly ±3σ, leaving a faint hard shell around each cluster.
 */
function gaussian(rng: () => number): number {
  for (let tries = 0; tries < 16; tries++) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    if (g >= -3 && g <= 3) return g;
  }
  return 0; // degenerate fallback — vanishingly unlikely
}

export interface SyntheticOptions {
  count?: number;
  clusters?: number;
  seed?: number;
}

export function makeSyntheticEmbedding(opts: SyntheticOptions = {}): PointData {
  const count = opts.count ?? 250_000;
  const clusters = opts.clusters ?? 14;
  const rng = mulberry32(opts.seed ?? 0xc7701);

  // cluster centres on a loose ring + jitter, with varied spread & weight
  const cx: number[] = [];
  const cy: number[] = [];
  const spread: number[] = [];
  const weight: number[] = [];
  let weightSum = 0;
  for (let c = 0; c < clusters; c++) {
    const ang = (c / clusters) * Math.PI * 2 + (rng() - 0.5) * 0.6;
    const rad = 4 + rng() * 6;
    cx.push(Math.cos(ang) * rad + gaussian(rng) * 0.8);
    cy.push(Math.sin(ang) * rad + gaussian(rng) * 0.8);
    spread.push(0.6 + rng() * 1.8);
    // power-law-ish weights → a few big populations, several rare ones
    const w = Math.pow(rng(), 2.2) + 0.02;
    weight.push(w);
    weightSum += w;
  }

  const positions = new Float32Array(count * 2);
  const values = new Float32Array(count);
  const categories = new Uint16Array(count);
  const ids = new Uint32Array(count); // contiguous 0..count-1 stand-in cell_ids

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < count; i++) {
    // pick a cluster by weight
    let r = rng() * weightSum;
    let c = 0;
    while (c < clusters - 1 && (r -= weight[c]) > 0) c++;

    const x = cx[c] + gaussian(rng) * spread[c];
    const y = cy[c] + gaussian(rng) * spread[c];
    positions[i * 2] = x;
    positions[i * 2 + 1] = y;
    categories[i] = c;
    ids[i] = i;

    // continuous "expression": bright in cluster cores, smooth radial falloff,
    // plus a little noise so the field isn't perfectly flat.
    const dx = x - cx[c];
    const dy = y - cy[c];
    const d = Math.sqrt(dx * dx + dy * dy) / (spread[c] * 2.5);
    values[i] = Math.max(0, Math.min(1, 1 - d + (rng() - 0.5) * 0.15));

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return {
    count,
    dims: 2,
    positions,
    values,
    categories,
    ids,
    bounds: [minX, minY, maxX, maxY],
  };
}
