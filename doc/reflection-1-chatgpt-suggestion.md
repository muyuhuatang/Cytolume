Your strongest opportunity is **not** to build “Helios, but for scatterplots.” Build a visual analytics library specifically for **million-cell embedding spaces**, where scale, biological hierarchy, uncertainty, density, and provenance are first-class concepts.

The current `hra-cell-embeddings` repository is mainly an exploratory visualization record: normalization experiments, PCA followed by t-SNE, and focused views such as the top 24 cell types. That gives you a good historical baseline, but the next project should be designed as a reusable visualization system rather than another collection of notebooks. ([GitHub][1])

## 1. Define a distinct visual identity

Helios feels polished because its visual language matches its subject: dark space, luminous nodes, fluid motion, and large structural patterns. It currently targets one-million-plus-node networks using a WebGPU-first renderer, a WebGL2 fallback, and a WebAssembly-backed data layer. ([GitHub][2])

Your library should adopt a different metaphor:

> **A navigable cellular landscape, not a cloud of colored dots.**

Use three perceptual levels:

| Zoom level | Visual representation                        | User interpretation                   |
| ---------- | -------------------------------------------- | ------------------------------------- |
| Distant    | Smooth density territories                   | Major biological populations          |
| Middle     | Cell-type regions, contours, and transitions | Tissue organization and heterogeneity |
| Close      | Individual cells and local neighborhoods     | Specific observations and metadata    |

The transition between these levels should be continuous. At one million cells, individual points should not always be visible.

### Recommended aesthetic direction

Use a restrained scientific style:

* Warm off-white or very dark neutral background, selectable by theme.
* Low-saturation colors for ordinary populations.
* High chroma only for selections, anomalies, or search results.
* Soft density fields rather than opaque point masses.
* Thin, subtle boundaries around cell territories.
* Minimal shadows and no glossy dashboard effects.
* Typography similar to scientific editorial design rather than a business dashboard.

A useful design principle is:

> **Structure first, labels second, individual cells last.**

## 2. Use semantic zooming as the central innovation

A million-point plot becomes visually meaningless if all cells are rendered identically. Build semantic zooming directly into the rendering pipeline.

### Level 1: Atlas view

Show:

* Density contours
* Major organs or tissue groups
* Cell-class regions
* Labels placed at visual centroids
* Small summary glyphs representing composition

Do not render one million discrete points here.

### Level 2: Population view

As the user zooms:

* Density surfaces dissolve into sampled cells.
* Parent cell classes divide into subtypes.
* Region labels become more specific.
* Local boundaries and transitional populations appear.
* Optional neighborhood graphs become visible.

### Level 3: Cell view

At close range:

* Render individual cells.
* Reveal hover and selection.
* Show donor, dataset, tissue, cell type, biomarkers, and embedding coordinates.
* Permit local nearest-neighbor inspection.

The visual transition should be animated but brief—roughly perceptual continuity rather than decorative motion.

## 3. Treat density as a first-class rendering primitive

Most embedding tools treat density as an optional overlay. For your system, density should be the default representation.

Consider supporting:

* Screen-space density accumulation
* Kernel-density fields
* Hexagonal or adaptive spatial aggregation
* Density contours
* Quantile bands
* Alpha-normalized splatting
* Cluster-aware density rendering

Aesthetically, use a hybrid:

1. Soft density field underneath
2. Sparse representative points above it
3. Contour boundaries for major populations
4. Highlighted individual cells only after interaction

This avoids the common “confetti problem,” where categorical colors produce a noisy, flat picture.

## 4. Design colors around biological hierarchy

A static categorical palette will fail when there are hundreds of cell types.

Instead, create a **hierarchical color system**:

* Broad cell classes receive distinct hue families.
* Subtypes vary mainly by lightness and saturation.
* Selected cells receive an outline or halo rather than a completely different hue.
* Unknown or low-confidence cells use neutral gray.
* Transitional populations use blended or striped encodings only when scientifically justified.

For example:

* Immune populations: blue family
* Epithelial populations: warm orange family
* Endothelial populations: teal family
* Stromal populations: violet family

These assignments should be configurable rather than hard-coded. The library should also include colorblind-safe defaults and perceptual-distance checks.

Avoid giving 80 cell types 80 unrelated colors. That creates visual distinction without semantic meaning.

## 5. Integrate the HRA hierarchy directly

The HRA is inherently multiscale and multimodal: anatomical structures, cells, biomarkers, and spatial relationships are linked across levels. ([Human Atlas][3])

That means your library should understand fields such as:

```ts
interface CellRecord {
  id: number;
  x: number;
  y: number;
  z?: number;

  organ?: string;
  anatomicalStructure?: string;
  tissueBlock?: string;

  cellClass?: string;
  cellType?: string;
  biomarkerProfile?: number[];

  donor?: string;
  dataset?: string;
  study?: string;

  confidence?: number;
}
```

Then users could write:

```ts
viewer
  .groupBy("cellClass")
  .subgroupBy("cellType")
  .colorBy("cellType")
  .filterBy("organ", ["Kidney"])
  .opacityBy("confidence");
```

The hierarchy should influence:

* Color
* Labeling
* Level of detail
* Filtering
* Legend organization
* Aggregation
* Search results

## 6. Replace ordinary legends with an interactive taxonomy panel

A million-cell visualization often has a legend larger than the plot.

Build a collapsible hierarchy:

```text
Immune cells
 ├── T cells
 │   ├── CD4 T cell
 │   └── CD8 T cell
 ├── B cells
 └── Macrophages

Epithelial cells
 ├── Proximal tubule
 └── Distal tubule
```

Interactions should include:

* Hover to softly emphasize a category.
* Click to isolate it.
* Shift-click to compare categories.
* Checkbox to hide it.
* Expand to reveal subtypes.
* Search by ontology name or identifier.
* Display population size and percentage beside each entry.

The plot and taxonomy panel should feel like one coordinated interface.

## 7. Make selection visually beautiful

Selections in scientific tools often become crude yellow rectangles. Give selection a proper visual grammar.

Support:

* Freeform lasso
* Brush
* Polygon selection
* Radius selection
* Density-region selection
* Semantic selection by label
* Nearest-neighbor expansion

When selected:

* Non-selected cells fade smoothly.
* Selected cells gain a crisp halo.
* The region boundary is softly outlined.
* A small anchored summary card appears.
* Comparisons can be pinned as named cohorts.

For example:

```text
Selection A
12,482 cells
Kidney · 4 donors
72% endothelial
Median confidence: 0.91
```

The summary should not block the embedding.

## 8. Show uncertainty rather than hiding it

Cell labels and embeddings are not absolute ground truth.

A visually and scientifically stronger library should support:

* Classification confidence
* Label entropy
* Neighborhood consistency
* Dataset mixing
* Donor mixing
* Embedding stability across runs
* Out-of-distribution scores

Possible encodings:

* Softness or blur for uncertainty
* Thin rings for disagreement
* Contour irregularity for unstable regions
* Neutral desaturation for low confidence
* Optional uncertainty heatmaps

Avoid mapping uncertainty only to opacity when opacity is already needed for density.

A useful interaction would be a **confidence lens**: moving a circular lens over the plot temporarily reveals confidence, donor mixing, or neighborhood purity.

## 9. Add “biological lenses”

This could become your library’s signature interaction.

A lens changes the visual encoding locally without changing the entire visualization.

Examples:

* **Cell-type lens:** reveals subtype labels.
* **Biomarker lens:** colors cells by expression of a selected marker.
* **Confidence lens:** reveals prediction uncertainty.
* **Donor lens:** shows donor composition.
* **Dataset lens:** reveals batch effects.
* **Neighborhood lens:** displays local nearest-neighbor edges.
* **Spatial lens:** links cells back to anatomical coordinates.
* **Comparison lens:** shows differences between two cohorts.

This creates a visually compelling demo while also providing real analytical value.

## 10. Connect embeddings back to anatomy

The embedding should not exist as an isolated abstract plane.

The IU HRA effort supports spatial and semantic search and aims to relate cells to a common anatomical coordinate framework. ([hubmapconsortium.org][4])

A strong interface could use linked views:

```text
┌───────────────────────────────┬──────────────────────┐
│                               │ Anatomical context   │
│       Cell embedding          │ Organ / tissue view  │
│                               │                      │
├───────────────────────────────┼──────────────────────┤
│ Population composition        │ Cell details         │
└───────────────────────────────┴──────────────────────┘
```

Selecting cells in the embedding should highlight their anatomical origins. Selecting an anatomical region should filter or emphasize its cells in the embedding.

However, the visualization **library** should remain modular. Provide coordination APIs rather than forcing a fixed dashboard.

## 11. Build a calm default interface

A polished first screen might contain:

* A full-canvas embedding
* A floating search field at the upper left
* A compact hierarchy panel at the left edge
* A small encoding selector at the upper right
* A scale and cell-count indicator at the bottom
* A collapsible detail panel on selection

Avoid permanently visible toolbars with twenty icons. Use contextual controls.

Possible top-level modes:

```text
Explore    Compare    Annotate    Export
```

Everything else can appear contextually.

## 12. Use motion carefully

Animation should explain state changes:

* Smooth camera interpolation
* Cluster expansion and contraction
* Density-to-point transitions
* Filter transitions
* Movement between two embeddings
* Morphing between UMAP, t-SNE, PCA, or spatial coordinates

A particularly powerful feature would be **embedding morphing**:

```ts
viewer.transitionToEmbedding("umap", {
  duration: 800,
  preserveSelection: true
});
```

This would let users see how neighborhoods change across projection techniques rather than viewing static plots separately.

Avoid continuous floating, pulsing, or orbital movement. Cells are data observations, not decorative particles.

## 13. Establish a performance-aware aesthetic

Performance decisions and aesthetic decisions should be unified.

For example:

* When zoomed out, aggregate cells into screen-space tiles.
* When moving, temporarily lower sampling density.
* When the camera stops, progressively refine.
* Compute density and selection on the GPU.
* Use indexed attributes instead of duplicating strings.
* Load metadata by column and on demand.
* Use Web Workers or WASM for preprocessing.
* Prefer WebGPU, with a WebGL2 fallback.

The user should perceive this as graceful refinement rather than degraded quality:

```text
Immediate: structural overview
Within a frame: representative cells
After interaction stops: full visual refinement
```

That is better than freezing until every point has rendered.

## 14. Separate the renderer from the biology layer

A clean architecture could be:

```text
@cellvista/core
GPU buffers, camera, picking, density, level of detail

@cellvista/data
AnnData, Arrow, Zarr, CSV and Parquet adapters

@cellvista/biology
Cell ontology, HRA hierarchy, biomarkers and annotations

@cellvista/react
React components and hooks

@cellvista/ui
Legends, taxonomy browser, search and selection panels

@cellvista/export
PNG, SVG overlays, session JSON and publication layouts
```

The core renderer should understand numeric attributes and hierarchical groups. The biology package should make it immediately useful for HRA and single-cell data.

This separation would broaden adoption beyond HRA without sacrificing your domain contribution.

## 15. Define three “hero demos”

A serious visualization library needs demonstrations that instantly communicate its value.

### Demo 1: Million-cell atlas

* One million cells
* Smooth pan and zoom
* Semantic zooming
* Hierarchical cell types
* Density-to-cell transition

### Demo 2: Dataset and donor comparison

* Same embedding
* Split or blended comparison
* Batch-effect lens
* Donor composition
* Difference density

### Demo 3: Embedding-to-anatomy linkage

* Select a cell population
* Show its organ and anatomical structures
* Explore biomarkers
* Link back to HRA entities

The first demo sells engineering quality. The second sells analytical usefulness. The third establishes the project’s scientific identity.

## 16. Features that could make it research-worthy

Rendering one million points alone is an engineering contribution, but probably not a sufficient visualization research contribution. A stronger paper could center on:

1. **Hierarchical semantic zooming for cellular embeddings**
2. **Uncertainty-aware exploration of large cell representations**
3. **Multiscale linking between embedding and anatomical spaces**
4. **Visual comparison across donors, datasets, and embedding models**
5. **Perceptually stable rendering during aggregation and zoom**
6. **Progressive visual analytics for million-cell datasets**

A promising research framing would be:

> How can a visualization system preserve biologically meaningful structures while interactively transitioning between aggregated and individual representations of million-scale cell embeddings?

## 17. My recommended visual concept

I would build the first version around the concept:

# **Cellular Cartography**

The embedding is presented as an atlas:

* Major populations are territories.
* Density contours form terrain.
* Cell subtypes form nested regions.
* Transitional populations form boundaries.
* Individual cells appear as the user approaches.
* Biological lenses reveal alternative layers.
* Anatomical links provide geographic provenance.

This metaphor fits the HRA far better than a conventional scatterplot, and it gives the project an aesthetic identity independent from Helios.

A possible one-sentence product vision:

> **A GPU-native visual analytics library for navigating millions of cells across embedding, anatomical, and molecular spaces.**

The most important first prototype is not a full dashboard. It is a single immaculate canvas demonstrating **semantic zooming, density rendering, hierarchical coloring, fluid selection, and one biological lens**. Once that interaction feels exceptional, the surrounding library architecture can grow around it.

[1]: https://github.com/cns-iu/hra-cell-embeddings "cns-iu/hra-cell-embeddings"
[2]: https://github.com/filipinascimento/helios-web "filipinascimento/helios-web: A web-based framework to ..."
[3]: https://humanatlas.io/about "About the Human Reference Atlas"
[4]: https://hubmapconsortium.org/indiana-university-bloomington-hive/ "Indiana University Bloomington HIVE – HuBMAP Consortium"
