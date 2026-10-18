# Cytolume

> A GPU-rendered web library that turns millions of single cells into an honest, luminous tissue-map you can fly through.

Cytolume renders single-cell embeddings (UMAP / t-SNE / PCA) at 450k–millions of points
in the browser with WebGL2, and exports them as **publication-grade figures** whose keys
state exactly what they can and cannot support.

![Cytolume rendering ~453k cells in 3D](media/01-hero-3d-glow.png)

> ### ⚠️ The bundled data is synthetic
>
> This repository ships a **generator**, not a dataset. `spine/export/synth.py` produces
> 453,251 seeded gaussian points with placeholder cell-type labels
> (`CL:0000000_type00` … `type47` — fabricated CURIEs that happen to resolve to real Cell
> Ontology terms).
>
> Every figure exported from it prints **`SYNTHETIC DATA — not for publication`** on its
> face, and will keep doing so until a spine manifest positively declares
> `provenance.synthetic: false`. That is deliberate: nothing about the app can distinguish
> a real spine from a seeded one by inspection, so the truth has to be *asserted* by
> whatever builds the tiles, never inferred. See [`doc/data-request.md`](doc/data-request.md).

---

## Quick start

The release workflow uses **Node 24.19.0** and **Python 3.14.6**.

```bash
cd web
npm ci
python -m pip install -r spine/requirements.txt

# Generate the data spine (~42 MB, git-ignored, regenerable — not shipped in the repo)
python -m spine.export.build_all             # all four layouts + six validation checks

npm run dev                                   # http://localhost:5173
```

Swapping `spine/export/synth.py` for a real `.h5ad` loader is the only change needed to
render real cells — no other code touches the data.

## GitHub Pages

Commit this release directory's **contents** at the repository root, so that
`web/`, `doc/`, and `.github/` are directly inside the repository. Select
**Settings → Pages → Source → GitHub Actions**, then push to `main` using Git.
For an existing repository, start from a clone to preserve its commit history.

The workflow installs locked dependencies, generates and verifies all four cell
layouts, verifies the frozen HRA snapshot, builds `web/dist-app/`, and deploys it.
The repository URL determines the asset base path automatically. It never runs
`hra:refresh`; anatomy models and API responses come from the files in this repo.

For Git upload instructions and first-deployment checks, see
[doc/GITHUB-PAGES.md](doc/GITHUB-PAGES.md).

## What it does

- **Two encodings.** *Categorical* draws opaque, depth-sorted sphere impostors, one hue per
  cell type. *Continuous* accumulates an optical-depth integral and resolves it so
  **lightness carries density and hue carries cell value**, each with its own 1-D key.
- **Honest density.** Point-spread normalisation makes every cell deposit the same total
  ink regardless of depth, so `∫τ` over any image region is exactly proportional to the
  number of cells in it. The density key is ticked in **cells along the ray** — a real
  unit, not an arbitrary ramp.
- **Keys that disclose.** Ticks in data units, a distribution strip, the colormap named
  with a *measured* character (`ordered lightness`, not "perceptually uniform" unless it
  is), plus what the producer did **not** declare.
- **Deterministic export.** Two exports of identical data agree byte for byte: no
  wall-clock input, no GPU readback on the plate path, and an in-flight layout morph is
  committed or the export is refused.
- **Interaction.** Orbit, lasso selection, hover pick, focus+context, layout morphing,
  cluster labels with collision declutter, a screen-space GPU-KDE density underlay, and an
  HRA human-body panel that locates a clicked cell type.

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

If you read one, read [`reflection-9`](doc/reflection-9-honest-encoding.md): it covers the
resolve that makes density and value independently readable, and — more usefully — records
the approaches that were **measured and rejected**, with the numbers.

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

## License

[MIT](LICENSE).

The application is MIT licensed. Bundled HRA component code retains its MIT and dependency
notices; anatomical models/data retain CC BY 4.0 and per-object creator metadata.
See `web/public/vendor/hra/ATTRIBUTION.txt` and the cookbook's reproducibility section.
