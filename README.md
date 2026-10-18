# Cytolume

> Explore single-cell maps in 2D and 3D, powered by the GPU.

Cytolume is a WebGL2 visualization library and interactive showcase for large single-cell
embeddings. Explore UMAP, t-SNE, and PCA layouts, focus on cell populations, connect the
view to anatomical context, and export figures with clear legends and data provenance.

![Cytolume rendering ~453k cells in 3D](media/01-hero-3d-glow.png)

## Reproducible demo data

The included demo generates **453,251 synthetic cells across 48 example categories**
from fixed random seeds. It provides a consistent starting point for exploring rendering,
layout transitions, selection, and figure export. The simulated coordinates, values, and
annotations make the demo easy to regenerate and use for development and testing.

The anatomy panel uses versioned **Human Reference Atlas models**, bundled locally for
reproducibility. The demo's cell-to-organ associations illustrate how anatomical context
can complement an embedding view.

Research datasets can be integrated through the Python data pipeline; see the
[data integration guide](doc/data-request.md) for input fields and provenance metadata.
Demo exports include a synthetic-data label to keep their origin clear when shared.

## Quick start

The release workflow uses **Node 24.19.0** and **Python 3.14.6**.

```bash
cd web
npm ci
python -m pip install -r spine/requirements.txt

# Generate the reproducible demo data (~42 MB)
python -m spine.export.build_all             # all four layouts + six validation checks

npm run dev                                   # http://localhost:5173
```

The rendering layer consumes a shared data format. To explore a research dataset,
adapt the Python input pipeline to read your `.h5ad` source and generate the same
layout, metadata, and tile files.

## GitHub Pages

Commit this release directory's **contents** at the repository root, so that
`web/`, `doc/`, and `.github/` are directly inside the repository. Select
**Settings → Pages → Source → GitHub Actions**, then push to `main` using Git.
For an existing repository, start from a clone to preserve its commit history.

The workflow installs locked dependencies, generates and verifies all four cell
layouts, verifies the frozen HRA snapshot, builds `web/dist-app/`, and deploys it.
The repository URL determines the asset base path automatically. Each build packages
the versioned anatomy models and scene data stored in this repository.

For Git upload instructions and first-deployment checks, see
[doc/GITHUB-PAGES.md](doc/GITHUB-PAGES.md).

## What it does

- **Start exploring immediately.** A short, reopenable guide introduces map navigation,
  cell selection, and anatomical context on the first visit.
- **Explore in 2D and 3D.** Switch between embedding layouts, orbit the 3D view, and
  follow the same cells through animated layout transitions.
- **Focus on populations.** Inspect individual cells, select groups with a lasso, and
  highlight categories through the legend while keeping the surrounding map in view.
- **Read values and density.** Dedicated categorical and continuous encodings pair with
  separate value and density keys, distribution strips, and labeled scales.
- **Add anatomical context.** Explore HRA reference anatomy alongside the cell map,
  with organ highlighting, female/male reference models, and visible model download
  progress. The panel labels the illustrative cell-to-organ links as **Demo mapping**.
- **Export consistent figures.** Capture annotated figures with legends, declared units,
  and data provenance. Deterministic figure composition supports repeatable exports
  from the same data and view settings.

| | |
|---|---|
| ![Named map](media/02-named-map.png) | ![Category focus](media/03-category-focus.png) |
| ![Lasso selection](media/04-lasso-selection.png) | ![Density atlas](media/05-density-atlas.png) |

## Documentation

- **[doc/COOKBOOK.md](doc/COOKBOOK.md)** — getting started, the control panel, the keys,
  figure export, the library API, and recipes.
- **[doc/CASE-STUDY.md](doc/CASE-STUDY.md)** — the narrative of what was built and why.
- **[doc/README.md](doc/README.md)** — the design journal index. The `reflection-*` files
  are the as-built record, one per track of work.

For the rendering design and validation results, start with
[`reflection-9`](doc/reflection-9-honest-encoding.md), which explains how density and
continuous values remain independently readable.

## Layout

```
web/          the library + showcase app (Vite + TypeScript, no framework)
  src/core/     Renderer3D, Camera3D, colormaps, substrate, picking
  src/ui/       keys, legend, hover card, figure compositor
  src/data/     spine manifest + tile decoding
  spine/export/ the Python exporter that builds the data spine
doc/          design journal, cookbook, case study
media/        figures used in the docs
```

## Credits

- Rendering approach inspired by **[Helios-web](https://github.com/filipinascimento/helios-web)**
  (Filipi Nascimento) — a *stack* of GPU choices transplanted from network layouts onto
  point-cloud embeddings.
- Successor to the static-notebook prototype
  **[cns-iu/hra-cell-embeddings](https://github.com/cns-iu/hra-cell-embeddings)**
  (Katy Börner / CNS-IU, Human Reference Atlas).
- The body panel includes a pinned **HuBMAP HRA CCF Body UI** component, scene data,
  metadata, and 22 anatomical models in `web/public/vendor/hra/`. They are served
  locally with no runtime HRA API/CDN dependency. `snapshot.json` records versions,
  sources and SHA-256 hashes; `ATTRIBUTION.txt` and `licenses/` retain the credits
  and licenses. Run `npm run hra:verify` from `web/` to verify the snapshot offline.
- **[Inter](https://github.com/rsms/inter/releases/tag/v4.1)** by Rasmus Andersson and
  the Inter Project Authors is bundled locally in `web/public/vendor/inter/`, with its
  SIL Open Font License and SHA-256 records. Run `npm run font:verify` from `web/`.
  The app loads its font from the same site.

## License

[MIT](LICENSE).

The application is MIT licensed. Bundled HRA component code retains its MIT and dependency
notices; anatomical models/data retain CC BY 4.0 and per-object creator metadata.
The bundled Inter font retains the SIL Open Font License 1.1.
See `web/public/vendor/hra/ATTRIBUTION.txt` and the cookbook's reproducibility section.
