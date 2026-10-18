/** Core data + rendering types for Cytolume. */

/**
 * The HRA-aware cell record (reflection-1 §5). The renderer only ever needs
 * `x`/`y` (+ optional `z`) and the numeric encoding columns; the biology
 * fields ride along for hierarchy, labels, filtering and selection.
 *
 * In the hot path these never exist as an array of objects — they are stored
 * column-wise as typed arrays (see {@link PointData}). This interface is the
 * logical shape, used by adapters and the biology layer.
 */
export interface CellRecord {
  id: number;
  x: number;
  y: number;
  z?: number;

  organ?: string;
  anatomicalStructure?: string;
  tissueBlock?: string;

  cellClass?: string;
  cellType?: string;

  donor?: string;
  dataset?: string;
  study?: string;

  confidence?: number;
}

/**
 * GPU-ready, column-wise point data. This is what the renderer consumes.
 *  - `dims`       : 2 or 3 — the embedding's intrinsic dimensionality. The 2D
 *                   `PointRenderer` only reads the first two components; a 3D
 *                   renderer (next track) reads all three.
 *  - `positions`  : interleaved per point in data space. For `dims===2` that is
 *                   [x0,y0, x1,y1, ...] (length = count*2); for `dims===3`,
 *                   [x0,y0,z0, x1,y1,z1, ...] (length = count*3).
 *  - `values`     : per-point scalar in [0,1] for the continuous encoding
 *                   (already log/arcsinh-transformed + percentile-clamped).
 *  - `categories` : per-point category index (0..255) into the categorical LUT.
 *  - `ids`        : per-point stable cell_id (picking + cross-layout morph join).
 *  - `bounds`     : data-space axis-aligned bounds. Length 4 for 2D
 *                   ([minX,minY, maxX,maxY]) or 6 for 3D
 *                   ([minX,minY,minZ, maxX,maxY,maxZ]).
 */
export interface PointData {
  count: number;
  dims: 2 | 3;
  positions: Float32Array; // length = count * dims
  values: Float32Array; // length = count
  categories: Uint16Array; // length = count
  ids: Uint32Array; // length = count
  bounds: number[];
}

/** Blending is an encoding and flips by mode (reflection-0 §4). */
export type EncodingMode = "continuous" | "categorical";

export type ContinuousColormap =
  | "magma"
  | "inferno"
  | "viridis"
  | "cividis"
  | "coolwarm"
  | "ylorrd"
  | "emerald"
  | "plum"
  | "amber"
  | "rose"
  | "azure";

export interface RenderState {
  mode: EncodingMode;
  colormap: ContinuousColormap;
}
