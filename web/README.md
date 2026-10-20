# Cytolume

> Explore single-cell maps in 2D and 3D, powered by the GPU.

The name combines **cyto-** (cell) with **lume**, evoking light and illumination:
**illuminating the cellular landscape**.

This folder contains the TypeScript rendering library, interactive showcase,
Python data exporter, and bundled anatomy and font assets.

[Live demo](https://muyuhuatang.github.io/Cytolume/) ·
[Cookbook and API](../doc/COOKBOOK.md) ·
[Deployment guide](../doc/GITHUB-PAGES.md)

## Current showcase

The demo contains **453,251 synthetic cells across 48 example categories**,
generated from fixed seeds. It opens in **3D**, with the **umap3d** layout and
**light** theme. A collapsible Quick start guide introduces the controls.

- Switch among four layouts: `tsne2d`, `tsne2d_alt`, `umap3d`, and `pca3d`.
- In 3D, orbit, inspect cells, select with a lasso, focus cell populations, and
  follow selections through layout transitions.
- Explore categorical and continuous encodings, density overlays, light/dark
  themes, and figure export with legends and data provenance.
- Use the Anatomy panel for HRA reference models, female/male views, illustrative
  cell-to-organ links, and model download progress.

Research datasets can be integrated by adapting the Python input pipeline and
declaring their metadata and provenance; see the
[data integration guide](../doc/data-request.md). The current pipeline generates
the bundled demo and does not import an arbitrary `.h5ad` file automatically.

## Develop

Use **Node 24.19.0** and **Python 3.14.6**, matching the Pages workflow. Run these
commands from `web/`:

```bash
npm ci
python -m pip install -r spine/requirements.txt
python -m spine.export.build_all  # generate all four layouts and run six data checks
npm run dev                     # open the URL printed by Vite
```

The generated `spine/build/` and `public/spine/` directories are ignored by Git.
Rerun `python -m spine.export.build_all` to regenerate the demo.

Useful URL parameters include `?view=2d`, `?layout=pca3d`, `?theme=dark`, and
`?motion=off&spin=off`. The legacy `?r3d=1` shortcut still selects 3D. See the
[full parameter list](../doc/COOKBOOK.md#url-parameters).

## Build and verify

```bash
npm run typecheck
npm run test:hra     # offline anatomy routing and model download progress checks
npm run build:app    # verify HRA/font snapshots, typecheck, build showcase → dist-app/
npm run preview:app  # serve dist-app/ on port 4317
npm run build       # library bundle + TypeScript declarations → dist/
```

`npm run build:app` packages the existing generated data; run the data generation
step above first. The library build exports `dist/cytolume.js` and declarations
starting at `dist/core/index.d.ts`.

For a browser check of local anatomy rendering, install Google Chrome and run
`npm run test:hra:browser`. This check blocks external HTTP requests. The Pages
workflow runs the offline checks and production build; browser checks are local.

## Deploy

The repository's `.github/workflows/deploy-pages.yml` deploys GitHub Pages on each
push to `main`. It installs locked dependencies, generates and checks all layouts,
runs offline anatomy checks, verifies the HRA and Inter snapshots, and builds the
site with the Pages base path. See the [deployment guide](../doc/GITHUB-PAGES.md)
for routine updates and first-time setup.

For a manual project-site build in PowerShell:

```powershell
$env:BASE_PATH = '/Cytolume/'
npm run build:app
npm run preview:app
```

Publish the contents of `dist-app/`. HRA models, scene data, component code, and
the Inter font are served by the same site. The HRA snapshot includes 22 models
and records versions, sources, licenses, and SHA-256 hashes in `public/vendor/hra/`;
the font snapshot is in `public/vendor/inter/`. See
[anatomy reproducibility](../doc/COOKBOOK.md#reproducing-the-body-panel).

## Refresh the README preview

With Google Chrome installed, run from the release repository's `web/` directory:

```powershell
python -m pip install Pillow==12.3.0
npm run capture:readme -- --headful
```

The recorder opens the live site in an isolated Chrome session and produces an
eight-second light-theme GIF with visible anatomy, a full-size PNG, and JSON
capture metadata under `media/` at the repository root. It checks anatomy in each
captured frame before updating the README. Review the result, then commit and push.
Pass `--repo <path>` to write the assets into a different checkout.

## Source layout

```text
src/core/         renderer, cameras, picking, colormaps; public library entry index.ts
src/data/         tile sources, manifest and binary decoding
src/interaction/  lasso projection and selection state
src/labels/       cluster centroids and label placement
src/ui/           legend, keys, hover card, figure compositor and Quick start
src/body/         anatomy panel and illustrative cell-to-organ mapping
src/main.ts       view router and 2D showcase
src/main3d.ts     3D showcase
spine/export/     Python data generation, tiling and validation
public/vendor/   pinned HRA and Inter assets
scripts/         asset checks, browser checks and README capture
```

The [design journal](../doc/README.md) preserves the implementation history and
earlier performance measurements. Use the cookbook for current controls and APIs.

## License

The application is MIT licensed. Bundled HRA code, anatomical models/data, and
Inter retain their respective licenses and attribution files under `public/vendor/`.
