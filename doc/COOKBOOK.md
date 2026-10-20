# Cytolume Cookbook

Practical, code-grounded documentation for **Cytolume** — a GPU-rendered TypeScript library
(and showcase app) for navigating millions of single-cell embeddings as an honest, luminous
tissue-map. The source lives in [`../web`](../web); the design rationale behind each feature
is in this folder's reflection journal (see [README.md](README.md)).

## Contents

1. [Getting Started](#getting-started) — install, run, repo layout, build outputs, URL params
2. [Using the Showcase App](#using-the-showcase-app) — every control + panel, mouse & keyboard
3. [Using the Library (API Reference)](#using-the-library-api-reference) — the public `core` surface
4. [Recipes](#recipes) — provide your own data, custom colormaps, picking/selection, theming

---

## Getting Started

Cytolume is a GPU/WebGL + TypeScript **library** for navigating millions of single-cell embeddings as a luminous, honest tissue-map, plus a **thin showcase app** that drives it. The 2D path is regl (WebGL1); the 3D path is raw WebGL2. The library core (renderer, camera, picking, colormaps) is the deliverable; the showcase in `src/main.ts` is just its first consumer. The only runtime dependency is `regl`.

### Repository layout

Everything lives under `web/` (paths below are relative to the repo root). The design journal (reflection notes, case study, data request) lives alongside this cookbook in `doc/`.

```
web/
  index.html            showcase entry → loads /src/main.ts
  src/
    main.ts             showcase boot + view router (2D ↔ 3D)
    main3d.ts           3D boot (raw-WebGL2 Renderer3D)
    core/               PointRenderer + Camera2D (regl); Renderer3D + Camera3D
                        + pick + math (WebGL2); colormaps  ← the library
    data/               TileSource / SpineTileSource / synthetic adapters
    biology/            cell ontology / HRA hierarchy / biomarkers (stub)
    interaction/        camera projection · lasso · selection store
    labels/             per-category centroids + declutter labels
    ui/                 hover card · selection summary · legend · overlays
    body/               HRA CCF Body-UI panel (body-panel.ts / body-map.ts)
  public/spine/         browser-served data artifacts (manifest + tiles)
  vite.config.ts        library build (lib mode)
  vite.app.config.ts    deployable showcase build
  scripts/screenshot.mjs  headless screenshot harness
```

The library's public surface is `src/core/index.ts`:

```ts
import {
  PointRenderer, Camera2D,
  Renderer3D, Camera3D, Device3DUnavailable,
  buildContinuousLUT, buildCategoricalLUT, CORE_24,
} from "cytolume";
import type {
  CellRecord, PointData, EncodingMode, ContinuousColormap, RenderState,
} from "cytolume";
```

### Prerequisites

Use **Node 24.19.0** and **Python 3.14.6**, matching the Pages workflow. JavaScript
dependencies are locked in `web/package-lock.json`; Python dependencies are pinned
in `web/spine/requirements.txt`. The interactive showcase needs WebGL2.

### Running it

All commands run from `web/`. The npm scripts (`web/package.json`):

```bash
npm ci
python -m pip install -r spine/requirements.txt
python -m spine.export.build_all  # generate all four demo layouts and run six checks
npm run dev          # vite dev server — open the printed URL (lands in 3D)
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + library bundle + TypeScript declarations → dist/
npm run test:hra     # offline anatomy routing and model download progress checks
npm run build:app    # HRA/font verification + typecheck + showcase build → dist-app/
npm run preview:app  # vite preview for dist-app/ on port 4317
npm run preview      # vite preview (uses the library config)
npm run shot         # node scripts/screenshot.mjs (headless screenshots)
```

`npm run shot` drives headless Edge via `playwright-core` against a running dev server (no browser download). Start `npm run dev` first; override targets with env vars — `URL` (default `http://localhost:5391/`), `OUT` (default `screenshots`), `CHANNEL` (`msedge` | `chrome`), `HEADFUL=1` to watch it run.

For the README's light-theme GIF with visible anatomy, use
`npm run capture:readme -- --headful`. This opens the published site in Google Chrome
and needs Python with Pillow 12.3.0. Install the encoder
with `python -m pip install Pillow==12.3.0`. The script writes the GIF, a PNG still and
JSON capture metadata under `media/`; review them before committing.

### Two build outputs

There are two distinct Vite configs, producing two different artifacts:

- **Library bundle** — `vite.config.ts` (lib mode). Entry `src/core/index.ts`, ES format only, target `es2022`, lib name `Cytolume`. `npm run build` emits `dist/cytolume.js` (the package `main`/`module`) and TypeScript declarations; package types resolve to `dist/core/index.d.ts` via the `exports` map. This is the deliverable you consume from other code.
- **Showcase app** — `vite.app.config.ts`. Builds from `index.html` (which pulls in `main.ts`/`main3d.ts`) and copies everything under `public/`, including the spine tiles, committed HRA snapshot and local Inter font. `npm run build:app` verifies both snapshots before writing `dist-app/`. Generate the cell data first with `python -m spine.export.build_all`; the app build does not generate it. The default base is `/`; set `BASE_PATH=/Cytolume/` for a GitHub project site (use the actual repository name). The data loader, body assets, and service-worker scope follow that base. `npm run preview:app` serves the built site on port 4317.

Both configs share the path aliases `@core`, `@data`, `@biology`, `@ui`.

### Entry point and default view

The showcase entry is `index.html`, which mounts a single `<canvas id="stage">` and loads `/src/main.ts`. `main.ts` is the single entry point and a **view router**: it picks one of two rendering substrates (they can't share one GL context — WebGL1 regl vs raw WebGL2), commits the choice to the URL, and boots accordingly:

- **3D** (`Renderer3D`, sphere impostors) via `src/main3d.ts` — **the default.** The bare URL lands in 3D with the `umap3d` layout.
- **2D** (`PointRenderer`, regl point cloud) — only when 2D is explicitly requested.

The in-page **View** control (`#view`) switches substrates by writing `?view=` and reloading.

The **Quick start** guide opens on the first visit, with instructions for the active
2D or 3D view. **Start exploring** collapses it; its heading reopens it at any time.
Dismissal is remembered in local storage when available and does not change the map.

### URL parameters

| Param | Values | Effect |
| --- | --- | --- |
| `view` | `2d` \| `3d` | Force a substrate (precedence over everything else). |
| `layout` | `tsne2d` \| `tsne2d_alt` \| `umap3d` \| `pca3d` | Initial embedding (3D default `umap3d`). A `…2d` layout with no `view` pin falls back to the 2D view. |
| `theme` | `dark` \| `light` | Chrome/render theme (defaults to `light` when unset). |
| `r3d` | `1` | Legacy shortcut for the 3D view (treated as `view=3d`). |
| `morph` | a layout name | 3D only — auto-fly to the named layout once, two frames after boot. (Pressing `m` toggle-morphs between `umap3d` and `pca3d`.) |
| `density` | `off` \| `underlay` \| `contours` | 3D only — KDE density underlay mode (default `off`). |
| `motion` | `always` \| `idle` \| `off` | 3D only — ambient camera auto-orbit (default `always` = non-stop; `idle` = only after ~2.5 s of quiet). |
| `spin` | `on` \| `off` | 3D only — per-cluster auto-spin, independent of `motion` (default `on`). |

Example: `?view=3d&layout=pca3d&theme=dark&density=contours`.

---

## Using the Showcase App

The showcase is the Vite app under `web/`. After completing the setup and data
generation in [Running it](#running-it), start it from the repository root with:

```bash
cd web
npm run dev      # vite dev server
```

Other scripts: `npm run build` (typecheck + library build), `npm run build:app` / `npm run preview:app` (standalone deployable app on port 4317).

The whole UI is one `#stage` canvas plus DOM overlays. A bare URL boots the **3D** view by default; only an explicitly-requested 2D layout (or `?view=2d`) falls back to the regl 2D substrate. The two substrates use different GL contexts, so switching View reloads the page.

### The control panel (top-right)

Controls are `id`'d `<select>`s and `<input type=range>`s in `index.html`, wired in
`web/src/main.ts` (top-level + 2D path) and `web/src/main3d.ts` (3D path). Rows that are
3D-only start hidden (`display:none`) and are revealed once the 3D boot finishes.

The controls are grouped into four collapsible `<details>` sections — **Data**,
**Marks**, **Context**, **View** — with a separate **Quick start** disclosure above
them. The guide adapts to the active view, remembers dismissal when local storage
is available, and can be reopened from its heading. Group membership is
presentational; every control `id` is unchanged.

A control the *current render path cannot act on* is rendered **inert** (dimmed +
`disabled`) with a written reason rather than silently doing nothing — see
[Marks](#marks-3d-only).

| Row | id | Group | Options (value → label) | Shown in |
|-----|----|----|----|----|
| Theme | `theme` | Context | `dark` → Dark · `light` → Light | 2D + 3D |
| View | `view` | View | `2d` → 2D · `3d` → 3D | 2D + 3D |
| Layout | `layout` | Data | populated from the data manifest (`<key> · <dims>D`) | 2D + 3D (after load) |
| Tool | `tool` | View | `orbit` → Orbit · drag to rotate · `lasso` → Lasso · drag to select | 3D only |
| Encoding | `mode` | Data | `continuous` → Continuous · density glow · `categorical` → Cell type | 2D + 3D |
| Colormap | `cmap` | Data | see list below | 2D + 3D (continuous only) |
| Density | `density` | Context | `off` → Off · `underlay` → Underlay · `contours` → Underlay + contours | 3D only |
| Motion | `motion` | View | `always` → Always · `idle` → When idle · `off` → Off | 3D only |
| Cluster spin | `spin` | View | `on` → On · `off` → Off | 3D only |
| Size | `marksize` | Marks | slider 0.7–2.5 (mark scale) | 3D only |
| Ink | `ink` | Marks | slider 0.5–8 (ink per unit optical depth) | 3D only |
| Depth cue | `edl` | Marks | slider 0–1.2 (eye-dome strength) | 3D only, **categorical** only |
| Accumulate | `blend` | Marks | `sum` → Sum · cell mass · `peak` → Peak · strongest | 3D only, **continuous** only |

#### View

Switching commits `?view=2d|3d` to the URL and reloads (a clean context teardown). The current `layout` is preserved across the swap; the legacy `?r3d=1` flag is normalized to `?view=` and removed.

#### Layout

In **3D**, changing the layout **morphs** the cloud cell-by-cell (cell_id-aligned, ~1.4 s) to the new layout instead of jump-cutting; the dropdown is disabled mid-morph. In **2D**, picking a 2D layout re-renders in place; picking a **3D** layout hands off to the 3D substrate (reload) — unless you've pinned `?view=2d`, in which case it stays projected to XY.

#### Theme

Defaults to **light**; boot into dark with `?theme=dark` (or pick Dark from the dropdown live). The choice is persisted to `?theme=` via `history.replaceState` (no reload — the renderer flips live), and in 3D it also re-tints the Body panel background.

#### Encoding and Colormap

`categorical` colors each cell by its cell type (Core-24 LUT); `continuous` accumulates an
**optical-depth integral** and resolves it so that **lightness carries density and hue
carries cell value** — the two are independently readable, and each has its own 1-D key
(see [The keys](#the-keys)). Selecting `categorical` hides the Colormap row.

Colormap options (exactly the `<select>` list): `magma`, `inferno`, `viridis`, `cividis`, `coolwarm`, `ylorrd` (YlOrRd), `emerald`, `plum`, `amber`, `rose`, `azure`.

In **3D**, the default is **theme-aware** (`dark → magma`, `light → ylorrd`) and auto-swaps whenever you flip the theme — until you pick a colormap yourself, after which your choice sticks across theme flips. The 2D substrate has no theme-linked colormap.

#### Marks (3D only)

Direct control over how a cell is drawn, added in **reflection-9**. Each slider shows a
live numeric value, and every one of them is printed in the exported plate's provenance
line — a control the caption does not record would let two plates differ under identical
provenance.

- **Size** (`?size=`, 0.7–2.5) scales the world radius *and* the screen-space floor
  together, so a mark grows coherently instead of the floor clamping the change away.
- **Ink** (`?ink=`, 0.5–8) scales accumulated optical depth before the resolve — how much
  ink one unit of cell mass lays down. Turn this if the plate reads too light or too
  heavy; do not re-tune the coverage model for it.
- **Depth cue** (`?edl=`, 0–1.2) is eye-dome lighting strength. It is gated on
  `edlStrength > 0 && !densityActive` *inside* `renderCategorical`, so on the default
  continuous encoding it has nothing to act on and is shown **inert** with a reason. It is
  also suspended while the density underlay is on.
- **Accumulate** (`?blend=`) chooses the continuous blend. `sum` is `FUNC_ADD` — a density
  integral, so darkness rises with the number of cells along the ray, and the density key
  ticks it in real cell counts. `peak` is `gl.MAX` normalised to one cell's ceiling, so
  darkness means **presence, not a count**; the key says so, and the density axis does not
  apply. Inert on the categorical encoding.

#### Density (3D only)

Screen-space GPU-KDE field beneath the cloud. `underlay` draws the field; `contours` adds iso-lines on top. Read once from `?density=` on boot; **not** written back to the URL when changed.

#### Motion + Cluster spin (3D only)

- **Motion** drives the auto camera drift. `always` (default) runs continuously, pausing only during an active drag/pan/lasso/morph (hover does not stop it); `idle` runs only after ~2.5 s of no interaction at all; `off` disables it. Flat (2D-lifted) layouts use a bounded sway instead of a turntable so they never tilt edge-on. Persisted to `?motion=`.
- **Cluster spin** (default On) slowly rotates each cell-type cluster about its own centroid, independent of Motion. Turning it Off snaps clusters back immediately. Persisted to `?spin=`.

### Mouse + keyboard

**3D view** (footer hint: `left-drag rotate · right-drag pan · scroll zoom`):

- **Left-drag** — orbit (rotate) when Tool = Orbit; **draw the lasso polygon** when Tool = Lasso.
- **Shift + left-drag** — pan (trackpad convenience).
- **Right-drag** — pan, in either tool (canvas context menu is suppressed).
- **Scroll wheel** — dolly (zoom).
- **Left click** (cursor travel ≤ 5 px, Orbit tool) — pick the cell and light up its organ in the Body panel.
- **`m` / `M`** — morph between `umap3d` and `pca3d`.
- **`Esc`** — cancel an in-progress lasso, clear the legend pin, and clear the selection.

**2D view** (footer hint: `drag to pan · scroll to zoom`): left-drag pans, scroll zooms toward the cursor. No orbit/lasso/click-select.

### Hover readout + selection (3D)

The footer shows `<count> cells · <fps> fps · 3D` (the zoom slot reads `3D`; in 2D it shows `1.0×`-style zoom). In 3D a `cell #<id>` / `no cell` span is appended. Hovering a cell (Orbit tool, not dragging) highlights it and opens a rich **hover card** with its cell type, dataset, and confidence.

Drawing a **lasso** selects all enclosed cells: the renderer dims everything else (focus+context) and a **selection summary** card appears with a clear button. `Esc` or that button drops the selection.

### The keys

Exactly one key is on screen at a time, and it always describes the encoding actually in
use: the **cell-type legend** in categorical mode, the **continuous keys** below in
continuous mode.

In continuous mode there are **two 1-D keys**, not one — because the resolve makes
lightness a function of density alone and hue a function of value alone, so the two axes
are independently readable. (A 2-D bivariate key was designed and rejected: before the
resolve was fixed the forward map was many-to-one, and no key of any dimensionality can
invert a many-to-one map. See `reflection-9` §3.)

**Value key** — titled with the channel name from the manifest (e.g. `EXPR`, not a generic
"cell value"), it carries:

- **Ticks at round values in DATA units**, never fractions of the ramp. A tick at "half way
  along" tells a reader nothing they can carry to a number.
- **A distribution strip** — a histogram of the actual column across the domain, so the
  domain is *shown* rather than asserted. It is how you can see at a glance that a domain
  is badly chosen or that the producer clipped.
- **The colormap named, with an honest character** — e.g. `ylorrd · sequential · ordered
  lightness (ColorBrewer)`. "Perceptually uniform" is a measured property, not a
  compliment, and is claimed only for the ramps that have it (magma, inferno, viridis,
  cividis).
- **Disclosures**: where the domain came from (`domain = stored extent; units not declared
  by the producer` when the manifest declares none), what fraction of cells sit on an
  endpoint (a pile-up means the producer clipped), and the `SYNTHETIC` flag.

**Density key** — a hue-free grey ramp ticked in **cells along the ray**. This is a real
unit: point-spread normalisation makes one cell deposit a fixed optical depth regardless of
its depth, so `N = τ / (alpha · exposure)`. The ramp is logarithmic and states where it
saturates (`280+`), because above the ceiling the *display* saturates while the count does
not — a reader must be able to tell those apart. In `peak` blend the density axis does not
apply and the key says so instead of showing one.

Both keys are built from the **same constants the shader uses** — never sampled from the
framebuffer — so the key and the marks cannot disagree, and two exports of identical data
stay byte-identical. The exported plate carries the same keys as the screen; see
[Exporting a figure](#exporting-a-figure) if you are checking a plate.

### Cell-type legend (left rail)

A collapsible "Cell types" panel (`Legend`, in `web/src/ui/legend.ts`), injected into the DOM. Each row shows the type's real on-screen swatch (`CORE_24[cat % 24]`), name, count, and percentage, sorted by count descending; the header shows the present-type count and a `–`/`+` collapse toggle.

- **Hover a row** → focus that type (all others dim in the plot).
- **Click a row** → pin the focus (click again, or `Esc`, to unpin).

### Anatomy panel (HRA, 3D)

Below the legend sits the **Anatomy** card (`BodyPanel`, in `web/src/body/body-panel.ts`), tagged **Demo mapping**. It embeds a pinned local copy of the HuBMAP HRA `<ccf-body-ui-wc>` component. The anatomy is HRA reference geometry; the cell-to-organ links are illustrative associations for this synthetic demo. The component, scene responses, metadata, and all 22 supported female/male models are committed under `web/public/vendor/hra/` and served by the same site.

- **Click a cell** in the embedding → the linked organ lights up at its anatomical position inside a translucent body, and the caption reads `Demo link: <organ>` (otherwise `Select a cell to explore anatomy`).
- **Female / Male** segmented toggle picks the reference body; organs with no male variant fall back to a whole-body glow. The choice persists to `?sex=male` and restores on reload.
- **Download progress** reports bytes for the current scene's models (about 37.4 MiB for the initial female skin and lung). It remains visible after the component initializes, until those downloads finish. Parsing and rendering may finish shortly afterward. Switching scenes reuses already downloaded model counts, and duplicate requests do not inflate the progress bar.
- It is a separate DOM overlay, so embedding orbit/zoom never move it. Initialization or model-download failures show an explanatory message with a **Reload page** button. The embedding continues to work, and there is no fallback to an upstream CDN/API. The `Anatomy: HRA · CC BY 4.0` link opens the bundled attribution.

### Reproducing the body panel

`public/vendor/hra/snapshot.json` records the snapshot ID, capture time, exact model
versions, upstream URLs, byte sizes, and SHA-256 hashes. The approximately **134.5 MiB**
snapshot is part of the source/release tree, not a browser cache or a build-time download.
Model geometry is unchanged. Per-object metadata preserves creators, DOI, and license.
`licenses/` contains MIT, third-party component notices, and CC BY 4.0; the original
component is also retained in `upstream/wc.js`.

The only vendor-code patch changes its hardcoded API base to our same-origin static
adapter. `hra-scene-sw.js` serves the frozen reference-organ and scene JSON, turns model
paths into URLs within the current site, and keeps each tab's female/male choice separate.
Single-skin scenes are captured too. Ontology/PURL strings in the data remain identifiers;
they do not require network lookups. Models are checked for external textures/buffers and
unbundled decoder requirements. This adapter needs **HTTPS or localhost**; opening
`index.html` via `file://` is not supported.

From `web/`:

```bash
npm run hra:verify       # offline: all hashes, model dependencies and reference coverage
npm run test:hra         # offline: worker at / and /Cytolume/, streaming and scene-change progress
npm run font:verify      # offline: pinned Inter font and license hashes
npm run test:hra:browser # system Chrome: render both sexes and skin/organ selections with outside HTTP blocked
```

The browser check writes captures to `screenshots/hra-offline/`; set `CHANNEL=msedge`
to use system Edge. It starts its own isolated static fixture and requires no dev server.

Normal builds only verify the committed snapshot. To deliberately update it, run
`npm run hra:refresh`, inspect the new manifest and resources, run both checks above,
and commit the snapshot with the application. Do not put refresh in CI or an install
hook. Keep `.gitattributes`' `-text` rule for snapshot files so a Windows checkout does
not change the bytes covered by their hashes.

Inter 4.1 is committed under `public/vendor/inter/`, including its license and
`snapshot.json` with exact source URLs and hashes. Its stylesheet uses a relative
font URL and `font-display: swap`; builds verify the committed bytes without a font
CDN request. GitHub Pages should publish `dist-app/` including `vendor/hra/`,
`vendor/inter/`, and `hra-scene-sw.js`.
The cell-data spine is still generated separately; its existing synthetic-data disclosure
and the synthetic cell-type-to-organ mapping are unchanged. A fixed asset snapshot does
not promise identical raster pixels across different GPU drivers or browser versions.

### Exporting a figure

The app is the instrument; the **plate** is the product. Export runs through
`window.__r3d` (the debug/automation seam), on the render loop, so the readback happens in
the same task as the draw.

```js
await __r3d.saveFigure(3);                    // hero plate -> download, 3x the CSS viewport
await __r3d.saveFacets(2, 6, 48);             // small-multiples plate, 6 cols, up to 48 types
const blob = await __r3d.exportFigureBlob(2); // the bytes, for automation
__r3d.renderStamp();                          // the exact provenance clause the next export prints
```

**Determinism is the contract.** Two exports of identical data must agree byte for byte, so
the export path:

- calls `setFigureMode(true)`, which snaps the camera to `HERO_ROTATION`, disables motion
  and cluster spin, and **commits any in-flight layout morph** — mid-morph positions are a
  blend of two arbitrary coordinate systems and correspond to nothing. An export that
  somehow reaches the loop with a morph live is **refused**, loudly, rather than writing a
  plate of blended coordinates.
- uses no wall-clock input and performs **no GPU readback** on any path that reaches a
  plate. Everything the keys need (`tauPerCell`, `refPx`, the substrate) is CPU state
  already computed for the frame that was drawn.
- switches to the **print substrate** (`#ffffff`) for the duration and restores the screen
  substrate afterwards. Paper is white; the screen tone is a UI choice, not a figure
  parameter. Guarded — print requires the light theme.
- **uncaps the label budget.** `labelMaxCount` is a semantic-zoom device whose input is
  pinned on the export path; left alone it silently deletes roughly half the type names.
  Whatever geometry still cannot place is **stated on the plate**.

**What the plate carries.** Two provenance lines — what the data *is*, then how it was
*drawn*:

```
n = 453,251 cells · umap3d · 3D · SYNTHETIC DATA — not for publication
     · 23 of 47 cell types labelled (24 omitted, no room)
pose q[-0.2128,0.2882,0.0659,0.9313] d368.0 fov60 persp · marks 1.00x (1.2 px)
     · ink 3.0x · accum sum · depth-cue n/a · density off · theme light · cmap ylorrd
```

The pose leads the render line deliberately: for a 3-D embedding the camera changes the
picture more than any cosmetic setting, and without it two plates shot from different
angles would carry identical provenance.

> **`SYNTHETIC DATA — not for publication`** appears unless the spine's manifest positively
> declares `provenance.synthetic: false`. Absence is meaningful: nothing about the app can
> distinguish a real spine from a seeded one by inspection, so the truth has to be asserted
> by whatever built the tiles. See [`data-request.md`](data-request.md).

**Known limits** (see `reflection-9` §10): the plate's aspect is still inherited from the
browser window rather than declared, type sizes are specified in CSS px rather than points
(so their *printed* size depends on the window), and cluster labels sit on the cores they
name rather than being leader-lined off them.

### URL query parameters

| Param | Values | Effect | Persisted? |
|-------|--------|--------|-----------|
| `view` | `2d` \| `3d` | Choose substrate (default 3D) | Yes (set on change, reload) |
| `r3d` | `1` | Legacy alias for `view=3d` | Recognized on load; normalized away to `view=` on change |
| `theme` | `dark` \| `light` | Theme (default light) | Yes (`replaceState`) |
| `layout` | a manifest layout key | Initial layout (3D default target `umap3d`) | Carried across view/layout switches |
| `density` | `underlay` \| `contours` | Density mode on boot (else off) | No |
| `motion` | `off` \| `idle` | Motion mode on boot (else `always`) | Yes (`replaceState`) |
| `spin` | `off` | Cluster spin off on boot (else on) | Yes (`replaceState`) |
| `size` | `0.7`–`2.5` | Mark scale on boot (else 1) | No |
| `ink` | `0.5`–`8` | Ink per unit optical depth on boot (else 3) | No |
| `edl` | `0`–`1.2` | Depth-cue strength on boot (else 0.35) | No |
| `blend` | `peak` | Continuous blend on boot (else `sum`) | No |
| `sex` | `male` | Body panel reference body (else female) | Yes (`replaceState`) |
| `morph` | a layout key | Auto-fly to that layout once after the first frame | No |

---

## Using the Library (API Reference)

The public surface lives in `web/src/core/index.ts`. Everything below is exported from there:

```ts
import {
  PointRenderer,        // 2D regl renderer
  Camera2D,             // 2D pan/zoom camera
  Renderer3D,           // 3D sphere-impostor renderer
  Device3DUnavailable,  // thrown by new Renderer3D() when WebGL2 is missing
  Camera3D,             // 3D orbit camera
  buildContinuousLUT,   // (name) => Uint8Array  256×1 RGBA8 LUT
  buildCategoricalLUT,  // (stops?) => Uint8Array 256×1 RGBA8 LUT
  CORE_24,              // string[] of 24 hex categorical colors
} from "./core/index.ts";

import type {
  CellRecord,
  PointData,
  EncodingMode,
  ContinuousColormap,
  RenderState,
} from "./core/index.ts";
```

### Data shapes

`PointData` is the GPU-ready, column-wise structure every renderer consumes (`web/src/core/types.ts`):

```ts
interface PointData {
  count: number;
  dims: 2 | 3;
  positions: Float32Array; // length = count * dims; interleaved [x,y(,z), ...]
  values: Float32Array;    // length = count; per-point scalar in [0,1] (continuous encoding)
  categories: Uint16Array; // length = count; category index 0..255 into the categorical LUT
  ids: Uint32Array;        // length = count; stable cell_id (picking + cross-layout morph join)
  bounds: number[];        // length 4 for 2D [minX,minY,maxX,maxY]; length 6 for 3D [minX,minY,minZ,maxX,maxY,maxZ]
}
```

`positions` is in data space — the GPU maps it via the camera, the buffer is never CPU-transformed. `values` must already be normalized to `[0,1]` (log/arcsinh + percentile-clamped upstream).

`CellRecord` is the *logical* per-cell shape used by adapters / the biology layer (in the hot path cells live as the typed arrays above, never as an array of objects):

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
  donor?: string;
  dataset?: string;
  study?: string;
  confidence?: number;
}
```

Encoding + colormap types:

```ts
type EncodingMode = "continuous" | "categorical";

type ContinuousColormap =
  | "magma" | "inferno" | "viridis" | "cividis" | "coolwarm"
  | "ylorrd" | "emerald" | "plum" | "amber" | "rose" | "azure";

interface RenderState { mode: EncodingMode; colormap: ContinuousColormap; }
```

`continuous` blends additively (emissive glow); `categorical` never blends additively — the 2D `PointRenderer` draws premultiplied OVER, the 3D `Renderer3D` draws opaque and lets the depth buffer do the sort — so two saturated categories never fuse into a false third color. The mode is passed per frame to `render()` — there is no `setMode` method.

### Colormap helpers

- `buildContinuousLUT(name: string): Uint8Array` — builds a 256×1 RGBA8 LUT by interpolating the named ramp's anchor stops. `name` is a plain string; an unknown name falls back to `magma`. Valid names are the `ContinuousColormap` members above.
- `buildCategoricalLUT(stops: string[] = CORE_24): Uint8Array` — builds a 256×1 RGBA8 LUT with nearest (no interpolation); entry `i` uses `stops[i % stops.length]`.
- `CORE_24: string[]` — the "Cytolume Core 24" palette: entries 0–7 are the Okabe-Ito colorblind-safe set, 8–23 a high-separation extension.

### `Renderer3D` (raw WebGL2, sphere impostors)

```ts
const renderer = new Renderer3D(canvas); // throws Device3DUnavailable if WebGL2 is missing
```

`new Renderer3D(canvas)` constructs a `Device3D` internally and **throws `Device3DUnavailable`** (an `Error` subclass carrying a `.caps` capability probe) when `getContext("webgl2")` is unavailable — catch it and fall back to the 2D `PointRenderer`.

Key public methods:

| Method | Notes |
| --- | --- |
| `setData(data: PointData): void` | Uploads instance buffers. **Throws** if `data.dims !== 3`. Resets `morphFactor` and `spinAngle` to 0, clears any selection and hover, and resets the cell_id → index map (rebuilt lazily). |
| `setColormap(name: string): void` | Re-uploads the continuous LUT in place (one `texSubImage2D`, no point pass). Unknown name falls back to `magma`. |
| `setTheme(t: "dark" \| "light"): void` | `"dark"` (default) glow-on-near-black; `"light"` ink-on-paper. Also `get themeValue`. |
| `render(camera: Camera3D, mode: EncodingMode): void` | Draws one frame. Reads viewport from `gl.drawingBufferWidth/Height` and sets the camera viewport itself. Caches frame state for `pick()`. |
| `pick(x: number, y: number): number` | Returns the cell_id under drawing-buffer pixel `(x, y)` (origin top-left), or `-1` for no hit / empty / before first `render()`. |
| `setHoverId(id: number \| null): boolean` | Highlights a cell (indigo halo + slight scale); `null`/negative clears. Returns `true` when the hover state changed. Also `get hoveredId` (`-1` when none). |
| `setSelection(ids: Uint32Array \| null): void` | Focus+context: listed cell_ids stay bright with a halo, others dim. Keyed on cell_id, survives a morph. `null` restores all. |
| `clearSelection(): void` | Equivalent to `setSelection(null)`. |
| `setFocusCategory(cat: number): void` | Keeps one categorical index bright, dims the rest. `-1` clears. Uniform-only, free to call per frame. |
| `setMorphTarget(positions: Float32Array \| null): void` | Uploads a `count*3` target layout for the cross-fade; drive `renderer.morphFactor` in `[0,1]`. **Throws** if length !== `count*3`. `null` makes the morph inert. |
| `setDensityMode(mode: "off" \| "underlay" \| "contours"): void` | GPU-KDE underlay. `"off"` (default) skips all density passes. Also `get densityModeValue`. |
| `destroy(): void` | Frees all GL buffers, textures, programs, and the device. |

Tunable public fields: `radiusScale` (default `1.0`), `minPxFloor` (screen-space min radius in CSS px, default `1.2`), `morphFactor`, `spinAngle`, `spinAxis`; plus a `readonly device` handle.

### `PointRenderer` (2D, regl)

```ts
const renderer = new PointRenderer(canvas);
```

| Method | Notes |
| --- | --- |
| `setData(data: PointData): void` | Uploads buffers and derives point density from `data.bounds` (uses the first 4 entries). Reads only x/y. |
| `setColormap(name: string): void` | Re-uploads the continuous LUT. |
| `setTheme(t: "dark" \| "light"): void` | Theme flip; also `get themeValue`. |
| `render(camera: Camera2D, mode: EncodingMode): void` | Draws one frame; sets the camera viewport from `canvas.width/height`. Continuous uses an HDR additive pass when supported. |
| `get pointCount: number` | Cell count of the last `setData`. |
| `destroy(): void` | Destroys the regl context. |

### `Camera3D` (orbit)

Public fields: `target: Vec3`, `rotation: Quat`, `distance: number`, `fov: number` (radians, ~60° default), `orthographic: boolean`.

Key methods:

- `setViewport(width, height, dpr?)` — CSS pixels + device-pixel-ratio.
- `fit(bounds: number[], pad = 1.1): void` — frames a 6-tuple box; centers `target`, dollies out, records the bounds radius for tight near/far. Leaves orientation untouched.
- `rotateByPixels(dxPx, dyPx)` — arcball orbit (NaN-free at poles).
- `dolly(delta)` — logarithmic zoom (raw wheel `deltaY`; positive pulls back).
- `panByPixels(dxPx, dyPx)` — pan `target` in the camera right/up plane.
- `uniforms(): Camera3DUniforms` — `{ u_viewProj, u_cameraRight, u_cameraUp, u_viewDir }`, consumed by `render()`.
- `pixelsPerWorldUnitAt(depth)`, `projection()`, `view()`, `viewProj()`, `nearFar()`, `eye()`, `right()`, `up()`, `viewDir()`, `worldToScreen(p)`.
- Pose / morph controller: `getPose()`, `setPose(p)`, `transitionTo(to: Partial<CameraPose>, durationMs = 320)`, `step(dtMs): boolean` (advance per RAF; returns `true` while animating), `stopTransition()`, `get isTransitioning`.

### `Camera2D` (pan/zoom)

Public fields: `cx`, `cy` (data-space center), `s` (NDC-per-data on Y).

- `setViewport(width, height)`
- `fit(bounds: number[], pad = 1.08)` — accepts a 2D tuple `[minX,minY,maxX,maxY]`; for a 3D layout pass the XY sub-bounds, not the raw 6-tuple.
- `panByPixels(dxPx, dyPx)` — drag pan in CSS pixels.
- `zoomAt(delta, ndcX, ndcY)` — logarithmic zoom about a cursor in NDC (`[-1,1]`, y-up); positive `delta` zooms out.
- `uniforms(): { uOffset: [number, number]; uScale: [number, number] }`
- `pixelsPerDataUnit(): number`

### Minimal end-to-end (3D)

```ts
import { Renderer3D, Camera3D, Device3DUnavailable, type PointData } from "./core/index.ts";

const canvas = document.querySelector("canvas")!;

let renderer: Renderer3D;
try {
  renderer = new Renderer3D(canvas);
} catch (err) {
  if (err instanceof Device3DUnavailable) {
    // ...fall back to the 2D PointRenderer here...
  }
  throw err;
}

const data: PointData = {
  count: 3,
  dims: 3,
  positions: new Float32Array([0,0,0,  1,0,0,  0,1,1]),
  values:    new Float32Array([0.1, 0.6, 0.9]),
  categories: new Uint16Array([0, 1, 2]),
  ids:        new Uint32Array([0, 1, 2]),
  bounds:     [0, 0, 0, 1, 1, 1], // [minX,minY,minZ, maxX,maxY,maxZ]
};

renderer.setData(data);
renderer.setColormap("viridis");

const camera = new Camera3D();
camera.fit(data.bounds);

function frame() {
  renderer.render(camera, "continuous"); // or "categorical"
  requestAnimationFrame(frame);
}
frame();

// cleanup: renderer.destroy();
```

The 2D path mirrors this with `PointRenderer` + `Camera2D`, a `dims: 2` `PointData` (4-entry `bounds`), and `camera.fit([minX,minY,maxX,maxY])` after `camera.setViewport(...)`.

---

## Recipes

### Provide your own data

The renderer consumes `PointData` (column-wise typed arrays, `web/src/core/types.ts`):

```ts
export interface PointData {
  count: number;
  dims: 2 | 3;
  positions: Float32Array; // length = count * dims (interleaved x,y[,z])
  values: Float32Array;    // length = count, each in [0,1] (continuous encoding)
  categories: Uint16Array; // length = count, category index 0..255 → categorical LUT
  ids: Uint32Array;        // length = count, stable cell_id (picking + morph join)
  bounds: number[];        // 4 nums [minX,minY,maxX,maxY] (2D) or 6 (3D)
}
```

A minimal hand-built cloud (three 3-D points):

```ts
const pd: PointData = {
  count: 3,
  dims: 3,
  positions: new Float32Array([0,0,0,  1,0,0,  0,1,1]),
  values:     new Float32Array([0.1, 0.6, 1.0]),
  categories: new Uint16Array([0, 1, 2]),
  ids:        new Uint32Array([0, 1, 2]),
  bounds: [0,0,0, 1,1,1],
};
renderer.setData(pd); // Renderer3D.setData THROWS unless dims === 3
```

`Renderer3D.setData` rejects `dims:2`; `main3d.ts` lifts 2-D layouts to `z=0` via its `as3D` helper before uploading. The showcase never hand-builds `PointData` at the call site — it goes through a `TileSource` (`web/src/data/tile-source.ts`): `getActivePointData()` returns the `PointData`, plus `getCell(id)`, `query(region)`, `loadColumn(name)`, `setLayout(name)`, and a `manifest`. `SyntheticTileSource` (`web/src/data/synthetic-source.ts`) is the reference implementation: it calls `makeSyntheticEmbedding(opts)` (`web/src/data/synthetic.ts`, options `{ count, clusters, seed }`) to produce the `PointData`, then fills a minimal stub `SpineManifest` (single `"synthetic"` 2-D layout, one tile). The real spine path loads `manifest.json` over HTTP via `loadManifest(baseUrl)` (`web/src/data/manifest.ts`) and hands the result to `SpineTileSource`; the browser never reads Parquet/Arrow. To inject your own cloud at runtime, either call `window.__r3d.setData(pd)` (swaps the resident `PointData` directly) or implement `TileSource` (mirroring `SyntheticTileSource`) so the showcase swaps a *source*, not a pipeline.

### Add a custom continuous colormap

Colormaps live in `web/src/core/colormaps.ts`. A continuous map is just an array of hex anchor stops (low → high) registered in the `CONTINUOUS` record:

```ts
// web/src/core/colormaps.ts
const TEAL: Stops = ["#e6f5f4", "#8fd0c8", "#3f9a92", "#176058", "#06302c"];

const CONTINUOUS: Record<string, Stops> = {
  magma: MAGMA, inferno: INFERNO, /* … */ azure: AZURE,
  teal: TEAL, // ← add it
};
```

Then add the name to the `ContinuousColormap` union in `web/src/core/types.ts`:

```ts
export type ContinuousColormap = "magma" | /* … */ "azure" | "teal";
```

…and expose it in the panel by adding an `<option>` under `#cmap` in `web/index.html`:

```html
<select id="cmap"> … <option value="teal">teal</option> </select>
```

`buildContinuousLUT(name)` turns the stops into a 256×1 RGBA8 `Uint8Array`: it hex-decodes each stop, then for each of the 256 texels computes `f = (i/255) * (stops-1)` and linearly interpolates (`lerp`) between the two bracketing stops (alpha fixed at 255). `Renderer3D.setColormap(name)` re-uploads it with `texSubImage2D`, so a recolor is one texture swap — no CPU pass over the points. Unknown names fall back to `MAGMA`.

Light-theme caveat: the "paper" theme renders cells as a *darkened* LUT hue (ink at ~0.45), so warm multi-hue maps (magma/inferno/YlOrRd) collapse to muddy red/brown on paper. For light, prefer single-hue inks (`emerald`/`plum`/`amber`/`rose`/`azure`) which stay clean. Per-theme defaults are wired in `main3d.ts` via `THEME_CMAP = { dark: "magma", light: "ylorrd" }`; the active map follows the theme until the user picks one in `#cmap` (then `userPickedCmap` makes their choice stick across theme flips).

### Pick a cell / wire selection

`Renderer3D.pick(x, y)` takes **device-pixel** coords (top-left origin; multiply CSS coords by `dpr`) and returns the front-most cell_id along the cursor ray, or `-1` for a miss / before the first frame. `main3d.ts` converts a pointer event with `eventToDevicePx(e)` and, on a left press+release that travelled `<= CLICK_SLOP_PX` (5 px), treats it as a click:

```ts
function eventToDevicePx(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, rect.width);
  const sy = canvas.height / Math.max(1, rect.height);
  return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
}

// pointerup (click discrimination):
const [dx, dy] = eventToDevicePx(e);
selectCell(renderer.pick(dx, dy)); // -1 clears
```

`selectCell(id)` joins the id to metadata and drives the body panel:

```ts
function selectCell(id: number): string | null {
  if (id < 0 || !source) { bodyPanel.highlight(null); return null; }
  const rec = source.getCell(id);                 // TileSource metadata join
  const nodeId = bodyNodeForCellType(rec.cellType);
  bodyPanel.highlight(nodeId);                     // HRA body zoom/highlight
  return nodeId;
}
```

Hover uses the same `pick`: `renderer.setHoverId(id)` (indigo halo, `null`/`-1` clears). Lasso selection is a separate path — `lassoSelect(polygonCssPx, activePD, camera, dpr)` → `SelectionStore` → `renderer.setSelection(ids)`. The `window.__r3d` seam exposes `pick(x,y)`, `selectCell(id)`, and `lassoSelectCssPolygon(points)` for scripting.

### Switch theme from code

`Renderer3D.setTheme("dark" | "light")` flips the composite live (no reload); `themeValue` reads it back. In the showcase, call `main3d.ts`'s `setTheme`, which also updates the chrome tokens, the `#theme` select, the body-panel background, the `&theme=` URL param, and (unless the user picked one) the default colormap:

```ts
window.__r3d.setTheme("light"); // chrome + renderer + default cmap + URL
// or, against a bare renderer:
renderer.setTheme("dark");
```

Boot theme comes from `&theme=light|dark` (default light); `__r3d.getTheme()` returns the renderer's current theme.
