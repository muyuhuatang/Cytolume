# Cytolume — Reflection 0: General Plan

> **Status:** Foundational / north-star · **Date:** 2026-06-26 · **Author of record:** project owner (with research synthesis)
> **Series:** `reflection-N-*.md` — numbered reflections that record decisions and direction as the project evolves. This is `0`, the general plan everything else hangs off. Later reflections may revise specifics here; when they do, they should say so explicitly rather than silently diverging.

---

## 0. Why this document exists

`initial-idea.md` captures the spark: *build a Helios-level-quality visualization library to extend the [cns-iu/hra-cell-embeddings](https://github.com/cns-iu/hra-cell-embeddings) work, and figure out the aesthetics.* This reflection turns that spark into a directional plan — what Cytolume **is**, what makes it good, how it's built, and the order we build it in. It is deliberately opinionated so future reflections have something concrete to push against.

---

## 1. Vision

**Cytolume is a deployable, GPU-rendered web library that turns millions of single cells into an honest, luminous tissue-map you can fly through.**

A dark, instrument-grade canvas where dense cell populations glow like nebulae and rare populations survive as legible sparks — where **brightness honestly encodes density** and nothing decorative ever glows. The reference feeling is Helios-web's emergent glow crossed with Gaia's billion-star map, made rigorous for biology.

It is the interactive, packaged successor to the static-notebook prototype that came before it.

---

## 2. Where we start from — and the gap

The predecessor, `cns-iu/hra-cell-embeddings` (Prof. Katy Börner / CNS-IU, Human Reference Atlas):

- **Is** a Jupyter-only research repo (~453k cells; PCA/t-SNE/UMAP + scVI/UCE embeddings) producing **static matplotlib/scanpy PNGs**.
- **Lacks** interactivity, GPU rendering, density handling, and any level-of-detail. Its own "troubleshooting" notebooks fought overplotting — the blob problem — by hand.
- **Ships** a notebook + a Visualization Handbook PDF, not a tool anyone can embed.

**The gap is the whole opportunity.** Cytolume is not "nicer notebooks." It is a packaged web library that renders the *same kind of data* interactively, at scale, with a signature look. HRA-scale context (≈2,300 cell types, 73 organs, 6,000+ datasets) means the design target is **millions to tens of millions of points**, not 453k.

---

## 3. What "Helios-level" means here (and what it doesn't)

Reading Helios-web's actual shader source, its premium feel is **a stack of GPU choices, not one bloom filter**: sphere-impostor billboards with analytic circular anti-aliasing, order-independent transparency + additive accumulation tone-mapped over a near-black background (density → glow), logarithmic-zoom camera, GPU position-morph transitions, optional SSAO for depth.

- ✅ **Adopt:** all of the above — the *rendering feel*. It transplants cleanly onto a point cloud.
- ❌ **Do not adopt:** Helios's node-link **graph layout** model. Cytolume's data is embeddings (point clouds), not networks.
- ❓ **Open:** whether edges belong at all — RNA-velocity arrows, kNN graphs, lineage/trajectory overlays. If yes, Helios's billboarded-ribbon edges are the reference. **Decision needed (see §8).**

---

## 4. Aesthetic north star

The full design brief lives in memory (`cytolume-aesthetic-direction`); the load-bearing decisions:

### Visual system

| Element | Decision |
|---|---|
| **Canvas** | `#0B0E14` near-black charcoal — never pure `#000` (halation). Panels `#12161F`; borders `rgba(255,255,255,0.10)`; text `#E6E9EF`. |
| **Accent** | One cool indigo `#5B8DEF`, reserved exclusively for interactive/selection state. No gradients/shadows/glow on UI chrome — only the data layer emits light. |
| **Categorical** | "Cytolume Core 24" = `colorcet.glasbey_light` first 24, first 8 pinned to Okabe-Ito (colorblind-safe). 256-entry GPU LUT, assignment cached per category. |
| **Continuous** | **magma** default (dark low end fuses into the canvas → zero = "off"). viridis/cividis toggles. `log1p`/`arcsinh` + 1st–99th percentile clamp before the LUT. |
| **Diverging** | RdBu / Crameri `berlin`, **only** for signed metrics (logFC, z-score), auto-centered at 0. |
| **Points** | Sphere-impostor billboard quads, analytic circular discard. Soft radial-gaussian sprite for the beauty view; flat squares only in the 10M+ perf regime. |
| **Glow** | Emergent (additive accumulation + Reinhard tone-map), **not** a bloom filter. Optional restrained bloom as a toggle — off in categorical mode. |
| **Type** | Inter / IBM Plex Sans; `tabular-nums` on every number; IBM Plex Mono for IDs/barcodes. Scale 11/13/16/20/28. |

### The one rule specific to cell data

**Blending is an encoding and flips by mode:**

- **Continuous / density → additive** (`ONE, ONE`) on dark bg = density-as-glow.
- **Categorical → alpha-over** (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`). Additive-mixing two categories **invents a false third cell type** (red cluster + green cluster reads "yellow"). Non-negotiable — this is the trap a naive Helios port falls into.

### The honest answer to "too many cell types"

You cannot distinguish 200+ hues (scanpy gives up and greys everything past 103 categories). **Cap hues at ~24; past that, use focus+context** — unselected cells lerp to desaturated gray at ~15–25% opacity, the focal category brightens/enlarges with a `forceMaxAlpha` boost. Plus auto-placed cluster labels so the embedding reads as a *named map*, not confetti.

---

## 5. Technical approach

Aesthetics and tech are inseparable here — each look is a specific GPU choice.

**Rendering**
- **P1 substrate:** regl / WebGL2 — the proven 1–20M-point baseline. WebGPU path (WebGL2 fallback) deferred to P3 for true OIT + 10–100× headroom.
- **Density-aware opacity is the highest-leverage move.** Fixed global alpha is *banned* — it's the exact blob the predecessor fought. Recompute alpha per-viewport on zoom (Matejka CHI'15 / Reusser model).
- **Per-point style lives in GPU textures** (`texelFetch`) — never CPU recolor. Switching cell-type → gene → donor is a LUT swap + crossfade, not a geometry rebuild.
- **Two-regime LOD:** crisp/soft sprites at moderate counts; rasterized GPU-KDE field (histogram-equalized) for over-dense regions so it never becomes mush.
- **Weighted-Blended OIT** (P3) so millions of translucent cells composite with no z-sort, no flicker during pan/zoom.

**Data spine**
- Keep the **offline** scanpy/scVI/UCE pipeline; the browser only renders and filters — never recomputes embeddings.
- Export coords + per-cell metadata to **Apache Arrow/Parquet**; quadtree-tile at ~50–65k points/tile; stream only the *active* color column on demand.
- Replace the predecessor's ~429-package env dump with a curated runtime + a separate web bundle.

**Motion**
- Logarithmic-zoom camera (most of the "premium" feel), smoothstep easing, quaternion SLERP for 3D.
- GPU position-morph between embeddings (`mix(from, to, t)`, keyed by cell id) — cells *travel*, ~300–500ms slow-in/out. Never hard-cut.

---

## 6. Deliberately avoid

Fixed global alpha at scale · additive blending of *categorical* colors · cycling a 12-color palette across 400 cell types · pure `#000`/`#FFF` · rainbow/jet for expression · diverging maps for unsigned data · over-bloom that melts cluster boundaries · storage-order draw bias · CPU per-frame recolor/hit-testing · treating UMAP/t-SNE distances as quantitative (no grids/scale bars/distance readouts) · **shipping notebooks as the deliverable** (that *is* the predecessor's limitation).

---

## 7. Roadmap

Each phase has a "looks like" so progress is judged by what you can *see*, not just what's built.

| Phase | Goal | Key deliverables | Looks like |
|---|---|---|---|
| **P0 — Data spine** | Make the data web-renderable | Offline export to Arrow/Parquet; quadtree tiling (~50–65k/tile); curated minimal bundle | (no UI yet) — tiles load on demand |
| **P1 — Honest dark scatter** *(MVP)* | The biggest perceived-quality jump | regl/WebGL2 renderer on `#0B0E14`; soft gaussian sprites; additive+Reinhard (continuous) / alpha-over (categorical); Core-24 + magma/viridis LUTs; **density-aware opacity**; semantic zoom; log-zoom camera; Inter chrome; draggable colorbar + interactive legend | ~1M cells glowing, pannable, recolorable — already premium |
| **P2 — Map legibility & motion** | From point cloud to *named map* | GPU-KDE underlay + contours; auto cluster labels; GPU position-morph embedding transitions; focus+context dimming; GPU-picking hover + kdbush lasso; channel-swap crossfades; rasterized-KDE LOD | hover/lasso, labeled regions, embeddings that morph |
| **P3 — Signature 3D & depth** | Full Helios-level signature look | WebGPU path (WebGL2 fallback); true Weighted-Blended OIT; sphere-impostor depth + spherical shading + SSAO; restrained bloom; diverging log-ratio A/B density mode; CVD-simulation preview + light "paper" theme | 3D clusters with real volume; the "wow" demo |

**P1 is the milestone that proves the thesis.** It alone is the leap over the source repo.

---

## 8. Open decisions to resolve next

1. **Edges / trajectories in scope?** Pure embeddings only, or also RNA-velocity / kNN / lineage overlays? Changes whether Helios's edge renderer comes along. *(§3)*
2. **2D-first or 3D-first?** 2D embeddings are the common case and cheaper; 3D is where the signature depth (SSAO, sphere shading) shines. Recommend **2D-first through P2, 3D as P3**.
3. **Library vs. app vs. both?** An embeddable library (the stated goal) vs. a hosted demo app for the portfolio. Recommend **library core + a thin showcase app** — the app *is* the portfolio artifact.
4. **Tech-stack lock for P1:** regl directly vs. deck.gl custom layer vs. raw WebGPU. Recommend **regl/WebGL2** for control + proven scale; revisit WebGPU at P3.
5. **First dataset:** start with the predecessor's ~453k cells (fast, familiar, instantly comparable) before scaling to an HRA-scale millions dataset. Recommend **yes — 453k as the P1 proving set.**
6. **Branding depth:** how much identity work (wordmark, site, case-study writeup) is part of "done"? *(§9)*

---

## 9. Success criteria

**Technical bar**
- Renders ≥1M cells interactively at ≥30fps on a mid-range laptop (P1); scales toward 10M (P3).
- Recolor / embedding-switch / filter are GPU operations — no full geometry rebuilds.
- Density is *always* legible: no fixed-alpha blob, no vanished outliers, at any zoom.

**Portfolio bar** (this is a portfolio artifact)
- A hosted demo that produces an immediate "whoa" in the first five seconds.
- A clear before/after against the static-PNG predecessor.
- A short writeup explaining the *honest luminous* thesis and the engineering behind it.

---

## 10. Key references

- **Helios-web** (rendering feel): `filipinascimento/helios-web` — `graphWebGL.js` (impostors, OIT resolve, tone-map), `DensityLayer.js`, `CameraTransitionController.js`.
- **Predecessor:** `cns-iu/hra-cell-embeddings`; HRA context at `humanatlas.io`.
- **Million-point SOTA:** regl-scatterplot (flekschas), Nomic deepscatter + Ben Schmidt's Gaia demo, Apple Embedding Atlas (arXiv 2505.06386), Datashader plotting-pitfalls, WizMap (poloclub), deck.gl / Vitessce / cellxgene.
- **Color & perception:** glasbey (lmcinnes) + colorcet categorical, Okabe-Ito, viridis family, Crameri Scientific Colour Maps, Matejka et al. CHI'15 (opacity), Heer & Robertson DynaVis (transitions).

*Full cited research: workflow run `wf_b1e9a2ea-67b`. Aesthetic decisions mirrored in memory `cytolume-aesthetic-direction`.*
