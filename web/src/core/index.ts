/**
 * Cytolume core — public library surface.
 *
 * This is the deliverable (reflection-0 §8.3: "library core + a thin showcase
 * app"). The showcase in `src/main.ts` is just the first consumer of it.
 *
 * Architecture follows reflection-1 §14 — a renderer that understands numeric
 * attributes and hierarchical groups, kept separate from the biology layer:
 *   core    → GPU buffers, camera, picking, density, LOD   (this package)
 *   data    → Arrow / Parquet / AnnData adapters           (src/data)
 *   biology → cell ontology, HRA hierarchy, biomarkers     (src/biology)
 *   ui      → legends, taxonomy browser, selection panels  (src/ui)
 */
export { PointRenderer } from "./renderer.ts";
export { Camera2D } from "./camera.ts";
export { Renderer3D, Device3DUnavailable } from "./renderer3d.ts";
export { Camera3D } from "./camera3d.ts";
export {
  buildContinuousLUT,
  buildCategoricalLUT,
  CORE_24,
} from "./colormaps.ts";
export type {
  CellRecord,
  PointData,
  EncodingMode,
  ContinuousColormap,
  RenderState,
} from "./types.ts";
