/**
 * TileSource — the renderer-agnostic data surface (reflection-2 §6). The
 * renderer asks a source for "the points to draw right now" as `PointData` it
 * already knows how to upload; the call site is identical for 2D and 3D layouts
 * (only `dims` / `bounds.length` differ). `setLayout` returning the SAME `ids`
 * in a different `positions` array is exactly the input a GPU position-morph
 * needs, so `main.ts` swaps a *source*, not a pipeline.
 *
 * This v1 surface uses `getActivePointData()` (all resident points of the active
 * layout) rather than the streaming `tilesFor(view)` of the full reflection-2
 * design — streaming/LOD is a later track. Implementations preload their active
 * layout before `getActivePointData()` is read.
 */
import type { CellRecord, PointData } from "../core/types.ts";
import type { SpineManifest } from "./manifest.ts";

export { type TileChunk } from "./bin-tile.ts";

/**
 * Axis-aligned selection region in data space, matching the active layout dims.
 * `bounds` is [minX,minY,maxX,maxY] for 2D or [minX,minY,minZ,maxX,maxY,maxZ]
 * for 3D.
 */
export interface Region {
  bounds: number[];
}

export interface TileSource {
  /** The manifest describing all layouts/channels (a stub for synthetic). */
  readonly manifest: SpineManifest;
  /** Active layout key (e.g. "tsne2d"). */
  readonly layout: string;

  /** Switch active layout (tSNE ⇄ UMAP-3D …); drives cross-layout morph. */
  setLayout(name: string): void;

  /** All resident points of the active layout, as renderer-ready PointData. */
  getActivePointData(): PointData;

  /** Active continuous column (e.g. "expr"), keyed by cell_id, loaded lazily. */
  loadColumn(name: string): Promise<Float32Array>;

  /** Hover/detail: metadata for one cell_id (off the hot path). */
  getCell(id: number): CellRecord;

  /** Lasso/selection over resident points → cell_ids (layout-independent set). */
  query(region: Region): Uint32Array;
}
