# Cytolume — Reflection 2: P0 (The Data Spine), 3D-Aware From the Start

> **Status:** Scoping / actionable · **Date:** 2026-06-26 · **Series:** `reflection-N-*.md`
> **Supersedes/revises:** `reflection-0` §5 (data spine), §7 (roadmap), §8.2 (2D-first). The owner's new direction — the web interface must support **3D + Helios-style interaction** (orbit/trackball, GPU-picking hover, selection halos/lasso, smooth transitions, depth) — pulls 3D forward. This reflection makes the spine 3D-aware and interaction-ready from day one, and says so explicitly where it diverges from reflection-0.

---

## 0. Why this document exists

Reflection-0 budgeted P0 as a quiet "convert to Arrow, quadtree-tile, done" prelude to the P1 renderer, with 3D deferred to P3. That assumption is now wrong on two counts: (a) the predecessor **has nothing to convert** — it ships no 3D and no on-disk embedding artifact at all — and (b) 3D and interaction are now first-class. P0 must therefore **regenerate** coordinates (including new 3D layouts) and lay down a spine whose schema, tiling, and id strategy serve a 3D orbit renderer and GPU picking, not just a 2D scatter. This doc is the concrete, opinionated scope for that.

---

## 1. Reality check — what the predecessor actually ships

Grounded against the repo and the probe findings, not assumed:

- **It is notebook-only.** 14 Jupyter notebooks + a Visualization Handbook PDF + a 408-line `requirements.txt`. The deliverable is static matplotlib/scanpy PNGs (`vis-example-*.png`). There is **no exported embedding artifact** in the repo — no `.parquet`, no coords CSV, no committed `X_umap`.
- **The source data is external and not in the repo.** Everything derives from an `.h5ad` held outside this repository (10 lung datasets concatenated; base `expr_853.h5ad`). `453,251` cells × `60,286` genes; a `100,921`-cell single-dataset variant exists too.
- **Every embedding is 2D.** `any3D = false`, confirmed across all 14 notebooks — PCA(50/200/1000), scanpy-tSNE, openTSNE (p20, exag 1.5 / 2.8), UMAP, plus UCE / Harmony / scPoli experiments. All final visualization outputs are `n_components=2`.
- **Metadata is almost nothing.** The only `obs` column that survives into every AnnData is **`CL_label`** (cell type, **43–48** distinct lung types depending on the ≥1000-cells filter). The per-cell id is the **16-char cell barcode** (DataFrame index). **No confidence column.** The source CSV reportedly had organ IDs / ontology refs / confidence, but those were dropped before the AnnData used in the figures.

**Implication (load-bearing): P0 cannot be a converter. It must be a regeneration + extraction pipeline.** We re-run the offline pipeline from the source `h5ad`, *add* the 3D layouts that never existed, and emit a clean on-disk contract. The notebook PNGs are reference targets, not inputs.

> **Safest assumption where uncertain:** treat the source `h5ad` as *obtainable but not yet in hand* (see §8.1). Until it is, P0's schema, tiler, manifest, loader, and verifier are all built and tested against a **synthetic 453k stand-in that already carries a `z` axis and a barcode column**, so the swap to real data is a data change, not a code change.

---

## 2. The P0 data contract — exact on-disk schema

The contract is the deliverable of P0. Two hard principles:

1. **Identity is decoupled from layout.** One canonical, contiguous `cell_id` defines render/buffer order *once*; every layout (tSNE-2D, UMAP-3D, …) is just a coordinate table keyed by that id. This is what makes GPU position-morph between embeddings legal (`mix(from,to,t)` keyed by id — reflection-0 §5) and what makes picking stable.
2. **Strings never reach the GPU and never repeat on disk.** Categorical columns are **dictionary-encoded**; the 60k-gene matrix never ships.

### 2.1 Files

```
spine/
  manifest.json                     # tree, bounds, layouts, dict, lod (see §4)
  meta.parquet                      # one row per cell, canonical order
  dict/CL_label.json                # category names + Core-24 color slot
  layouts/
    tsne_p20_e1.5_pca200.2d.parquet # x,y           (canonical 2D)
    umap.3d.parquet                 # x,y,z         (canonical 3D)
    tsne_p20_e2.8_pca200.2d.parquet # alt
    pca.3d.parquet                  # x,y,z cheap honest baseline
  tiles/<layout>/<lod>/<mortonId>.bin   # binary point tiles (§4)
```

### 2.2 `meta.parquet` — shared, layout-independent (one row per cell, **row index == `cell_id`**)

| column | Arrow type | notes |
|---|---|---|
| `cell_id` | `uint32` | canonical contiguous index `0..N-1`; **equals global buffer index** in untiled order. The join key for every layout + every tile. |
| `barcode` | `large_utf8` | 16-char HuBMAP barcode; the *human/stable* id. Not sent to GPU. |
| `CL_label` | `dictionary<int16, utf8>` | cell type. ≤48 values → `int16` index; dictionary in `dict/CL_label.json`. |
| `dataset_id` | `dictionary<int8, utf8>` | **reserved/derivable** — which of the 10 datasets (recover from concat order). Carry it now; it's the donor/batch lens (reflection-1 §9) for free. |
| `confidence` | `float32` (nullable) | **all-null in P0** (source dropped it). Column exists so the lens/opacity-by-confidence path compiles; populated only if §8.5 recovers it. |

### 2.3 `layouts/<name>.{2d,3d}.parquet` — one per embedding, joined on `cell_id`

| column | type | notes |
|---|---|---|
| `cell_id` | `uint32` | join key (also lets a layout be a subset, e.g. the 24-type filtered tSNE). |
| `x`,`y` | `float32` | data space, **un-normalized** raw embedding coords. |
| `z` | `float32` | **3D layouts only.** |

Storage budget: 453k × (x,y,z f32) ≈ **5.4 MB raw per 3D layout**, ~3.6 MB per 2D — trivially parquet-compressible to ~2–4 MB. The whole spine for 4 layouts + meta is **well under 50 MB**, comfortably static-hostable.

### 2.4 Value transforms — be honest about what we don't have

The source AnnData carries **no per-cell continuous metadatum** (no confidence, no pseudotime). So in P0 the "continuous encoding" the renderer expects (`PointData.values ∈ [0,1]`) has **no honest biological source yet**. Decision:

- **P0 default continuous channel = a single chosen marker-gene expression**, extracted from the source matrix at export time (e.g. one canonical lung marker), transformed exactly per reflection-0 §4: `log1p` (data is already `normalize_total(1e6)+log1p`, so `arcsinh` is the safer re-transform) → **1st–99th percentile clamp** → min-max to `[0,1]`. Stored as an extra `float32` column `expr_<gene>` in `meta.parquet`.
- If even that is out of scope for P0 timing, ship `values` as **local-density (KDE) per cell** computed offline — an honest, always-available scalar that the density-glow view wants anyway. **Recommend shipping density now and one marker gene as a fast follow.** Never ship a fabricated gradient to GPU and call it expression.

---

## 3. Offline export pipeline

Source `h5ad` → spine, as a single reproducible Python package (`spine/export/`, **not** notebooks). It **must emit both 2D and 3D** coordinate sets in one run.

**Stages:**

1. **Load** `all-with_annotation-pca_200.h5ad`. Pull `X_pca` (200) if present; if not, recompute from the `spliced_unspliced_sum` layer via `normalize_total(target_sum=1e6) → log1p → pca(n_comps=200)`. Capture `obs['CL_label']` and reconstruct `dataset_id` from concat boundaries.
2. **Canonical id assignment.** Sort cells into a stable canonical order **once** (recommend: stable sort by `(dataset_id, barcode)` — deterministic and reproducible across re-runs), assign `cell_id = 0..N-1`. *Everything downstream is keyed to this.* Emit `meta.parquet`.
3. **2D layouts (regen).** `openTSNE(perplexity=20, exaggeration=1.5)` from `X_pca(200)` → canonical 2D (this is the best-looking variant in the findings; UMAP "significantly underperformed"). Also export the `e2.8` variant as alt.
4. **3D layouts (NEW — the whole point of this revision).** This is the `n_components=3` work the findings flag as absent:
   - `umap-learn`: `UMAP(n_components=3)` → `umap.3d` — **the canonical 3D layout** (UMAP's continuity reads better in volume than 3D-tSNE and it's far cheaper).
   - `pca.3d` = first 3 PCs — a cheap, honest, instantly-available 3D baseline to unblock the 3D renderer track before UMAP-3D finishes.
   - *(stretch)* 3D openTSNE for parity, gated on time — it's the expensive one.
5. **Continuous channel** (§2.4): compute offline density and/or extract the marker gene; transform + clamp; write into `meta.parquet`.
6. **Dictionary-encode** `CL_label` / `dataset_id`; assign each category a stable **Core-24 color slot** (reflection-0 §4) and freeze it in `dict/*.json` so colors never reshuffle between runs.
7. **Tile** (§4) each layout into quadtree (2D) / octree (3D) `.bin` tiles + write `manifest.json`.
8. **Verify** (§9 phase 6) before publishing.

**Curated minimal env** (replacing the 408-line dump; drop the entire CUDA/torch/JAX/transformers/geospatial bloat called out in the findings):

```
anndata==0.10.7   scanpy==1.10.1    pandas==2.2.2     numpy==1.24.2
scipy==1.14.0     h5py==3.11.0      scikit-learn==1.5.0
pyarrow==14.0.2   numba==0.58.1     llvmlite==0.41.1  pynndescent==0.5.11
umap-learn==0.5.5 openTSNE==1.0.1
# optional, only if scVI/UCE layouts are ever added (§8.6): torch + pytorch-lightning + scvi-tools==1.1.2
```

~11 core + 2 embedding libs replaces ~350. `zarr==2.18.1` only if we adopt chunked intermediates (not needed at 453k). **scVI/UCE/Harmony layouts are explicitly out of P0** — they drag torch back in and the lung-tSNE/UMAP set already proves the spine.

---

## 4. Spatial tiling / LOD

One scheme, two dimensionalities. **Quadtree for 2D layouts, octree for 3D layouts.** Same manifest grammar, same `.bin` payload, differing only in child count (4 vs 8) and coord stride (2 vs 3).

**Tile sizing:** target **~60k points/leaf** (reflection-0's 50–65k band). At 453k cells that's a *shallow* tree — ~3 quadtree levels / ~2 octree levels — which is correct: this dataset is small for the architecture; the tree exists mainly so the **same code path** scales to the HRA millions later and so we can stream by region for picking, not because 453k needs aggressive LOD.

**LOD by sampling, not by aggregation, in P0.** Each internal tree level holds a **uniform random subsample** (a stable, id-seeded reservoir so a cell that appears at LOD-2 also appears at LOD-0 — no popping). Zoomed-out = coarse-LOD tiles (a representative sparse cloud → density-glow); zoom in = leaf tiles stream in. The GPU-KDE field / contour aggregation that reflection-1 wants is a **P2 renderer concern**, not baked into P0 tiles — the spine just guarantees a clean multiresolution point sample.

**Binary tile payload** (`<mortonId>.bin`, little-endian, header + columns; positions quantized to `int16` within the tile's bbox for 2× shrink, bbox in the header to dequantize):

```
[u32 magic][u16 version][u8 dims(2|3)][u8 flags]
[u32 pointCount][f32 bbox[min..max] per dim]
positions : int16 × dims × pointCount        # dequant via bbox
cell_id    : uint32 × pointCount             # → picking + metadata join
category   : int16  × pointCount             # CL_label index (baked for instant categorical draw)
```

**Color column streaming:** the *baked* per-tile column is the categorical index (cheap, one column, the common case). Any **continuous** channel (density, marker gene, future genes) is streamed **separately as a column-store keyed by `cell_id`** (`columns/<name>.f32` + an offset index), fetched only when that encoding is active — exactly reflection-0 §5 "stream only the active color column." Switching channel = fetch one column + LUT swap, never a tile refetch.

**`manifest.json`** (the single source of truth the loader reads first):

```jsonc
{
  "version": 1,
  "cellCount": 453251,
  "layouts": {
    "tsne_p20_e1.5_pca200": { "dims": 2, "bounds": [minX,minY,maxX,maxY],
      "tree": "quadtree", "leafTarget": 60000, "lodLevels": 3,
      "tiles": [ { "id": "0", "lod": 0, "bbox": [...], "count": 41233,
                   "children": ["00","01","02","03"], "uri": "tiles/.../0.bin" } ] },
    "umap": { "dims": 3, "bounds": [minX..maxZ], "tree": "octree", "lodLevels": 2, "tiles": [ ... ] }
  },
  "categorical": { "CL_label": { "dict": "dict/CL_label.json", "count": 48 } },
  "continuous": { "density": "columns/density.f32", "expr_<gene>": "columns/expr.f32" },
  "idSpace": { "field": "cell_id", "stable": true, "sharedAcrossLayouts": true }
}
```

---

## 5. Interaction-readiness

The spine must make Helios-style picking/hover/lasso **cheap** — i.e. mostly already done at export time. What it carries for that:

- **Stable, dense, 32-bit `cell_id`.** Directly encodable into an RGBA8 pick texture (`id → vec4` / `vec4 → id`). No hashing, no string compare at pick time. 453k ≪ 2³², headroom to tens of millions.
- **`cell_id` lives inside every tile** (baked column above). So the GPU buffer index → `cell_id` map is just the tile's `cell_id` array; the inverse (`cell_id` → which tile + offset) is a small offline-built index the loader keeps in memory (or derivable from the Morton tree + per-tile id ranges if we keep ids contiguous-per-tile — recommend **contiguous-per-leaf id assignment** so `cell_id` → tile is an O(log n) range lookup, no hashmap).
- **Metadata fetchable by column, by id.** Hover detail = look up `cell_id` in `meta.parquet` (loaded once; it's a few MB) → `barcode`, `CL_label` (via dict), `dataset_id`, `confidence`. No per-cell object graph; column arrays + dict.
- **Spatial index for lasso/radius/kNN.** P0 ships the **tree itself** as the coarse spatial index; the loader lazily builds a **kdbush** (2D) / small KD-tree (3D) over the *currently resident* tiles for the active layout. Because tiles are Morton-ordered, "which tiles intersect this lasso bbox" is a cheap range query — selection only indexes resident points, and the id set it returns is layout-independent (it's `cell_id`s), so a selection **survives an embedding morph**.
- **Shared id space across layouts** (manifest `idSpace.sharedAcrossLayouts: true`) is the contract that makes "select in tSNE, watch them fly to their UMAP-3D positions" work and keeps a pinned cohort (reflection-1 §7) valid across views.

---

## 6. Cytolume-side loader API (`web/src/data`)

Goal: a **renderer-agnostic** TypeScript surface that replaces `makeSyntheticEmbedding`, feeds the current 2D `PointRenderer` unchanged, and is reused verbatim by the upcoming 3D renderer. The current `PointData` is 2D-only (`positions: Float32Array` stride 2); extend it to carry `dims`.

**Type changes (`core/types.ts`):**

```ts
export interface PointData {
  count: number;
  dims: 2 | 3;                 // NEW — stride of positions
  positions: Float32Array;     // length = count * dims
  values: Float32Array;        // continuous channel, [0,1]
  categories: Uint16Array;     // CL_label index
  ids: Uint32Array;            // NEW — cell_id per point (picking + morph join)
  bounds: number[];            // 4 (2D) or 6 (3D)
}
```

(The existing synthetic generator stays as a fallback by setting `dims:2`, `ids = 0..count-1`.)

**New surface (`web/src/data/`):**

```ts
// manifest.ts — parse + validate manifest.json
export interface SpineManifest { /* §4 shape */ }
export async function loadManifest(baseUrl: string): Promise<SpineManifest>;

// tile-source.ts — renderer-agnostic streaming source (2D or 3D)
export interface TileSource {
  readonly manifest: SpineManifest;
  readonly layout: string;                  // active layout key
  setLayout(name: string): void;            // tSNE ⇄ UMAP-3D (drives morph)
  /** Tiles intersecting a view frustum/bbox at a target LOD, as the camera needs them. */
  tilesFor(view: ViewQuery): Promise<TileChunk[]>;
  /** Active continuous column, streamed lazily, keyed by cell_id. */
  loadColumn(name: string): Promise<Float32Array>;
  /** Hover/detail: metadata for one cell. */
  getCell(id: number): CellRecord;
  /** Lasso/selection over resident points → cell_ids (layout-independent). */
  query(region: Region): Uint32Array;
}

export interface TileChunk extends PointData { tileId: string; lod: number; }

// arrow-tile-source.ts — concrete impl over the Arrow/Parquet + .bin spine
export class ArrowTileSource implements TileSource { /* ... */ }

// tile-store.ts — LRU cache of decoded TileChunks + in-flight dedup + column cache
export class TileStore { get(tileId): TileChunk | undefined; put(...); evict(...); }
```

**Why this shape:** the renderer asks for "tiles I can see at this LOD" and gets `PointData`-shaped chunks it already knows how to upload — **identical call site for 2D and 3D** (only `dims` and `bounds.length` differ). `setLayout` returning the same `ids` in a different `positions` array is precisely the input a GPU position-morph needs. `getCell`/`query` keep biology/UI (taxonomy panel, detail card) off the hot path. `makeSyntheticEmbedding` becomes one `TileSource` implementation among others (`SyntheticTileSource`), so `main.ts` swaps a source, not a pipeline.

---

## 7. Roadmap reconciliation

Reflection-0 had a single linear P0→P1→P2→P3 with 3D and interaction parked in P3. The owner's ask splits that into **one spine phase + two parallel tracks** that the spine unblocks simultaneously.

| Was (reflection-0) | Now |
|---|---|
| P0 = convert to Arrow + quadtree, 2D only | **P0 = regenerate (incl. 3D layouts) + Arrow + quad/octree + ids + manifest + loader.** 3D-aware, picking-ready. |
| 3D deferred to P3 | **3D-renderer track starts right after P0** (orbit/trackball camera, depth, sphere-impostor volume), reusing the same `TileSource`. |
| Hover/lasso/picking in P2 | **Interaction track starts in parallel with P1**, because the spine already carries `cell_id` + pick map + spatial index from P0. |
| P1 = 2D honest scatter (MVP) | **Unchanged and still the thesis-prover** — but now fed by `ArrowTileSource`, not synthetic. Still ship 2D first; it's the fastest "whoa." |

**What stays strictly P0 (this doc):** export pipeline, both 2D+3D coordinate sets, the Arrow/`.bin` contract, quad/octree tiling, manifest, `cell_id`/pick/index strategy, the `TileSource`/`TileStore` loader, the verifier. **What is explicitly *not* P0 (parallel tracks, fed by P0):** the 3D orbit renderer, GPU-picking shader + lasso UI, density-KDE/contour aggregation, embedding-morph animation. P0's job is to make all of those *cheap to build* — it carries the data they need and nothing they don't.

> **Net:** 2D-first (reflection-0 §8.2) survives for the *renderer*, but the *spine* is 3D-first. We pay the small extra cost of emitting 3D coords + octree now so the 3D and interaction tracks aren't blocked on a spine rewrite later.

---

## 8. Open decisions & risks

1. **Obtaining the source `h5ad` (highest risk).** It is held outside this repository. **Decision:** request the `all-with_annotation-pca_200.h5ad` (or at minimum the post-PCA `X_pca` + `obs`) from the author. **Mitigation if unavailable:** the synthetic 453k stand-in (now with `z` + barcode) keeps every P0 deliverable buildable and tested; only the final coords swap waits on real data.
2. **Fast path — extract coords from notebook outputs?** If any notebook's `adata` with `X_tsne`/`X_umap` is recoverable (pickled/cached), we could extract 2D coords *without* re-running embeddings. **Decision:** use it **only as a sanity cross-check**, never as the spine source — it gives no 3D, no controlled id order, and no provenance. Regeneration is canonical.
3. **Hosting / static serving.** Whole spine < 50 MB → **plain static files (S3/GitHub Pages/Cloudflare) with HTTP range or per-tile files.** No tile server in P0. Manifest + `.bin` + parquet over a CDN is enough; revisit a server only at HRA-millions scale.
4. **File-size budget.** Comfortable at 453k. The risk is *future* HRA-scale: the `int16`-quantized `.bin` + per-column streaming design is chosen now specifically so the format doesn't have to change at 10M+. Flag: parquet for `meta` is fine at 453k but megabyte-row metadata at 10M will want column-chunked range reads — design accommodates it (column store), don't optimize it yet.
5. **Confidence / richer metadata.** Source dropped it. **Decision:** keep the nullable `confidence` column and `dataset_id` now; chase the original CSV (organ/ontology/confidence) as a P0.5 enrichment, not a P0 blocker. The confidence-lens (reflection-1 §8) degrades gracefully to "no data" until then.
6. **scVI / UCE / Harmony layouts.** They reintroduce torch and didn't beat tSNE in the findings. **Decision: out of P0.** The pipeline is built so adding a layout is "drop a new `layouts/*.parquet` + tile it" — they can arrive later as pure data, no code change.
7. **Canonical-id determinism.** If the source concat order isn't reproducible, `cell_id` could drift between re-runs and break morph/picking across rebuilds. **Mitigation:** id = stable sort on `(dataset_id, barcode)`, frozen, with a checksum in the manifest; the verifier asserts id stability (§9).

---

## 9. The build workflow (ready to script)

A multi-agent Workflow that *builds* P0. Fan-out where layouts/tiling are independent; an **adversarial verifier** gates publication. Phase-by-phase:

**Phase 0 — Acquire & decide (single agent).**
Locate/obtain source `h5ad` (§8.1). Emit a `source_status` decision: `real` vs `synthetic-standin`. Pin the curated env (§3) into `spine/export/requirements.txt`; build & smoke-test the venv. *Gate:* env imports `scanpy, umap, openTSNE, pyarrow` clean.

**Phase 1 — Canonical id + meta (single agent, sequential — everything keys off it).**
Load source (or synthetic), assign canonical `cell_id`, dictionary-encode `CL_label`/`dataset_id`, compute the continuous channel (density + optional marker gene), write `meta.parquet` + `dict/*.json`. *Gate:* row count == manifest `cellCount`; `cell_id` is `0..N-1` dense; dict cardinality 43–48.

**Phase 2 — Embedding regen (FAN-OUT — one agent per layout, parallel).**
Workers: `tsne_p20_e1.5_pca200` (2D), `tsne_p20_e2.8_pca200` (2D alt), `umap` (**3D**), `pca` (**3D** baseline). Each consumes `X_pca` + `cell_id`, writes `layouts/<name>.parquet` joined on `cell_id`. *Per-worker gate:* output rows == N; every `cell_id` present exactly once; finite coords; 3D workers emit a `z` column.

**Phase 3 — Tiling (FAN-OUT — one agent per layout, parallel).**
Each builds quadtree (2D) or octree (3D) at ~60k/leaf with id-seeded LOD subsampling, contiguous-per-leaf id assignment, writes `.bin` tiles + the layout's manifest fragment + the continuous column store. *Per-worker gate:* Σ leaf points == N (no point lost/dupe); every tile bbox ⊆ layout bounds.

**Phase 4 — Manifest assembly (single agent).**
Merge fragments → `manifest.json`; embed id checksum, layout list, dict refs, column refs, `idSpace.sharedAcrossLayouts`.

**Phase 5 — Adversarial verification (single agent, MUST pass to publish).** The whole point — assume the builder is wrong and try to break it:
- **Manifest schema** validates; every `uri` resolves.
- **Round-trip a random sample tile:** decode `.bin`, dequantize `int16`→float via bbox, assert coords match the source `layouts/*.parquet` rows for those `cell_id`s within quantization epsilon.
- **Point-count conservation:** Σ over leaf tiles == `cellCount`, per layout; no duplicate `cell_id` within a layout's leaves; no missing id.
- **ID stability across layouts:** the `cell_id` set is identical across *all* layouts (the morph contract); a fixed sample of `cell_id`s maps to the same `barcode` in every artifact.
- **Pick round-trip:** encode 1k random `cell_id`s → RGBA → decode; bit-exact.
- **Bounds sanity:** declared bounds == actual min/max of coords; 3D layouts have 6-tuple bounds, 2D have 4.
- **Loader integration smoke:** run `ArrowTileSource` headless against the spine, call `tilesFor`, `loadColumn`, `getCell`, `query`; assert `PointData.ids/positions/dims` well-formed for one 2D and one 3D layout.
*Gate:* all checks green → mark spine `published`; any red → bounce to the responsible phase with the failing assertion.

**Phase 6 — Loader wiring (single agent).**
Land the `web/src/data` surface (§6), extend `PointData` with `dims`/`ids`, swap `main.ts` from `makeSyntheticEmbedding` to `ArrowTileSource` (synthetic kept as fallback `TileSource`). *Gate:* existing 2D `PointRenderer` renders the real `tsne_p20_e1.5` tiles; no API break.

**Shape:** Phase 0→1 sequential (identity is the spine); **Phases 2 and 3 fan out per layout**; Phase 5 is the adversarial gate that conserves points, proves id stability, and round-trips a tile before anything is called done — the three checks that, if green, mean the spine is honest.

---

*Diverges from reflection-0 where stated (§7). Aesthetic/blending rules unchanged (reflection-0 §4). Next reflection should record the actual source-`h5ad` acquisition outcome (§8.1) and lock the canonical continuous channel (§2.4).*