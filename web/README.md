# Cytolume

> A GPU-rendered web library that turns millions of single cells into an honest, luminous tissue-map you can fly through.

The name combines **cyto-** (cell) with **lume**, evoking light and illumination:
**illuminating the cellular landscape**.

Cytolume is the interactive, packaged successor to the static-notebook prototype
[`cns-iu/hra-cell-embeddings`](https://github.com/cns-iu/hra-cell-embeddings)
(Katy Börner / CNS-IU, Human Reference Atlas). Where the predecessor shipped
static matplotlib PNGs of ~453k cells, Cytolume renders the *same kind of data*
interactively, at million-to-tens-of-millions scale, with a signature look.

The rendering feel is inspired by [Helios-web](https://github.com/filipinascimento/helios-web)
— a *stack* of GPU choices, not one bloom filter — transplanted from networks
onto point-cloud embeddings.

See the planning docs in the repo root: `initial-idea.md`,
`reflection-0-general-plan.md`, `reflection-1-chatgpt-suggestion.md`.

## Status — P1 (MVP) scaffold

This is the start of **P1: honest dark scatter** (reflection-0 §7). What runs today:

- `regl`/WebGL point renderer on the `#0B0E14` canvas.
- **The one rule** — blending is an encoding: additive HDR + Reinhard tone-map
  for continuous/density (density-as-glow), premultiplied alpha-over for
  categorical (never additive — that invents a false third cell type).
- magma / viridis / cividis continuous LUTs + "Cytolume Core 24" categorical
  (Okabe-Ito–pinned), delivered as GPU LUT textures.
- **Density-aware opacity** recomputed every frame from the camera (fixed global
  alpha is banned — it's the exact blob the predecessor fought).
- Logarithmic-zoom 2-D camera (pan + zoom-about-cursor).
- **P0 data spine (synthetic 453k stand-in) — built & wired.** Offline Python
  pipeline (`spine/export`) → Parquet → quantized binary tiles + manifest under
  `public/spine`; a dependency-free `SpineTileSource` (`src/data`) streams the
  `.bin` tiles into the renderer. Falls back to the in-memory synthetic generator
  if no spine is present. Four layouts — `tsne2d`, `tsne2d_alt`, **`umap3d`**,
  **`pca3d`** — switchable live; the spine is 3D-aware (reflection-2). The real
  source `.h5ad` drops in without code changes.
- **3D renderer track — built & verified (reflection-3).** A raw-WebGL2
  `Renderer3D` (beside the regl 2D path) with instanced **sphere-impostor**
  billboards + `gl_FragDepth` + view-aligned shading; `Camera3D` (quaternion
  arcball, log-dolly, pan, transitions); per-mode blending that keeps the honest
  rule (additive **depth-off** density vs opaque **depth-on** categorical — the
  z-buffer *is* the order-independent sort); **GPU `cell_id` morph** (fly between
  embeddings) + synchronized camera; and a **depth-correct GPU pick** pass. A
  **View: 2D / 3D** toggle switches substrates. ~52–60fps orbiting 453k on an
  RTX 4060; all six adversarial checks pass (incl. additive order-independence
  and the false-third-color test).
- **Interaction track v1 — built & verified (reflection-4).** On the 3D view: a
  rich **hover card** (cell id / type / expr, off the depth-correct pick), a
  freeform **lasso** selection (`src/interaction` projects cells via the camera +
  point-in-polygon → `cell_id[]`), **focus+context dimming** (a per-cell
  `a_selected` mask: selected keep color + indigo halo, unselected desaturate to
  ~16%), and a **selection summary** card (count, cell-type breakdown, Clear).
  Selections are `cell_id` sets, so they **survive an embedding morph**. A
  **Tool: Orbit / Lasso** control switches modes.
- **Map legibility v1 — built & verified (reflection-5).** On the 3D view: **auto
  cluster labels** at each cell-type's centroid (`src/labels` declutter +
  semantic-zoom by population, tracking the orbit), and a **cell-type legend**
  (left edge; swatch = `CORE_24[cat%24]` matching the render, count, %) with
  **hover-to-focus / click-to-pin** — the focused type stays lit, the rest dim.
  This is the honest answer to ">24 hues": isolate any one of 48 types. Reads as
  a *named map*, not confetti.
- **Density underlay v1 — built & verified (reflection-6, P2.5).** A screen-space
  **GPU-KDE** field (additive splat → separable Gaussian blur) painted *under* the
  3D cloud as quiet cool-slate **terrain**, optional thin **iso-density contour
  bands**, and a **semantic-zoom blend** (field dominant zoomed-out → fades as you
  push into the cells). A **Density: Off / Underlay / Contours** control. Stays
  honest — dimmer than the cells, no false color; `off` is byte-for-byte original.
  60 fps with it on.
- **Light/Dark theme + ambient motion (reflection-7).** A **Theme: Dark | Light**
  toggle — Light is a "paper" mode where density darkens to *ink* instead of
  glowing (the additive accumulation is theme-agnostic; only the tonemap composite
  flips). Plus an idle **"alive" auto-orbit**: after ~2.5 s of no input the 3D
  scene gently turns, stopping instantly on any interaction. Cell size is now
  derived from *local* density, so clusters read crisply in both 3D layouts.

Not yet built (tracked in the docs): the real cell data (request drafted in
`../data-request.md`, awaiting the source `.h5ad`); interaction extras
(named-cohort compare/pinning, biological lenses, nearest-neighbor expansion,
2D-path pick + labels); the biology hierarchy (`src/biology`) and collapsible
taxonomy tree; volumetric/per-category density + vector contours; and the
deferred 3D-polish (WebGPU, full multi-pass OIT, SSAO, bloom).

## Architecture (reflection-1 §14)

```
src/core/     2D: PointRenderer + Camera2D (regl);  3D: Renderer3D + Camera3D +
              device3d + pick3d + math3d (raw WebGL2);  colormaps  ← the deliverable
src/data/     TileSource + SpineTileSource (.bin/.json/.f32 loader) + synthetic
src/interaction/ projection + lasso point-in-polygon + selection store
src/labels/   per-category centroids + declutter (semantic-zoom labels)
src/biology/  cell ontology, HRA hierarchy, biomarkers       (stub)
src/ui/       hover card · selection summary · lasso overlay · legend · labels
src/main.ts   2D showcase boot;  src/main3d.ts  3D boot (?r3d=1 / View:3D)
spine/export/ offline Python pipeline: h5ad/synth → Parquet → tiles + manifest
public/spine/ browser-served artifacts (manifest.json, tiles/*.bin, columns/*.f32)
```

## Develop

```bash
npm install
npm run dev          # dev server — open the printed URL; LANDS IN 3D by default
npm run build:app    # static showcase site → dist-app/ (for deployment)
npm run preview:app  # serve the built dist-app/ locally
npm run build        # typecheck + library bundle (dist/cytolume.js) + .d.ts
npm run build:types  # declarations only → dist/core/index.d.ts
npm run typecheck
npm run shot         # headless screenshot harness (drives system Edge, real GPU)
```

Useful URL params: `?view=2d` (force the flat regl view), `?layout=tsne2d|umap3d|…`,
`&theme=light`, `&r3d=1` (legacy 3D shortcut). The bare URL = 3D · umap3d · dark.

### Deploy

For GitHub Pages, use the workflow in `.github/workflows/deploy-pages.yml` at the
release repository root. It generates all cell layouts and chooses the correct
base path automatically. See [the upload guide](../doc/GITHUB-PAGES.md).

The HRA body panel now uses a pinned local snapshot in `public/vendor/hra/`
(about 134.5 MiB, including 22 models, scene data, component code and licenses).
`npm run build:app` verifies its SHA-256 hashes and packages those files without
contacting HRA. `npm run test:hra` checks the static API adapter offline;
`npm run test:hra:browser` checks rendering in system Chrome with outside HTTP blocked.
Only the explicit `npm run hra:refresh` command downloads a new snapshot.

For GitHub project Pages, set `BASE_PATH=/Cytolume/` (using your repository name)
when building. All data paths and the service-worker scope follow that base.
For PowerShell: `$env:BASE_PATH='/Cytolume/'`, then `npm run build:app`.
See [the cookbook](../doc/COOKBOOK.md#reproducing-the-body-panel) for provenance,
licenses, verification and refresh instructions.

`npm run build:app` emits a self-contained static site in `web/dist-app/`
(`index.html` + hashed assets + the ~42 MB `spine/` tiles). Deploy that folder to
any static host — e.g. **Netlify**: drag `dist-app/` onto
[app.netlify.com/drop](https://app.netlify.com/drop), or
`netlify deploy --prod --dir=dist-app` (a `netlify.toml` at the repo root configures
git-connected builds, with long-cache headers on `/spine/*`).

The Pages workflow uses Node 24.19.0 and Python 3.14.6.

### Regenerating the data spine

```bash
# from web/
python -m pip install -r spine/requirements.txt
python -m spine.export.build_all             # all four layouts + six checks
```

The spine artifacts under `spine/build/` and `public/spine/` are git-ignored and
fully regenerable. Swapping the synthetic generator in `spine/export/synth.py`
for a real `.h5ad` loader is the only change needed to ship real cells.

## License

MIT.
