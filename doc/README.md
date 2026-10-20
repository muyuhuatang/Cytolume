# Cytolume — Documentation

Cytolume is a GPU-rendered (WebGL2) TypeScript library for navigating millions of
single-cell embeddings as an honest, luminous tissue-map — plus a thin showcase app
that demonstrates it. The source lives in [`../web`](../web); this folder holds the
documentation and the design journal.

The name combines **cyto-** (cell) with **lume**, evoking light and illumination:
**illuminating the cellular landscape**.

The [live showcase](https://muyuhuatang.github.io/Cytolume/) is deployed through
GitHub Pages. Release `de0642a` passed its production build and deployment, with
manual browser acceptance confirmed by the project owner. It includes a reopenable
Quick start guide, clearer Anatomy / Demo mapping labels, model download progress,
and the bundled Inter font. The [deployment workflow](../.github/workflows/deploy-pages.yml) lists
every build and verification step.

The repository README now includes the Cytolume name explanation and an
[eight-second Chrome capture](../media/01-hero-light-anatomy.gif) in light mode with
the anatomy panel visible. The [capture metadata](../media/01-hero-light-anatomy.json)
records the source URL, browser and view settings. To refresh the
preview, run `npm run capture:readme -- --headful` from `web/` (see [web/README.md](../web/README.md)).

## Start here

- **[COOKBOOK.md](COOKBOOK.md)** — the practical guide: getting started, a tour of the
  showcase app and its controls, the public library API, and copy-pasteable recipes.
- **[CASE-STUDY.md](CASE-STUDY.md)** — the narrative walkthrough of what was built and why.

## Design journal

The `reflection-*` files are the as-built development record — one per track of work,
each building on the last. They capture the rationale, trade-offs, and verification
behind the code (referenced from code comments as `(reflection-N)`).
These entries preserve the implementation at each stage; use the cookbook for
current UI behavior and the deployment guide for the published release.

| Doc | Track |
| --- | --- |
| [reflection-0-general-plan.md](reflection-0-general-plan.md) | The overall plan and architecture goals |
| [reflection-1-chatgpt-suggestion.md](reflection-1-chatgpt-suggestion.md) | Early architecture input |
| [reflection-2-p0-data-spine.md](reflection-2-p0-data-spine.md) | P0 data spine (tiles, manifest, 3D-aware format) |
| [reflection-3-3d-renderer-track.md](reflection-3-3d-renderer-track.md) | The raw-WebGL2 `Renderer3D` (sphere impostors, GPU picking) |
| [reflection-4-interaction-track.md](reflection-4-interaction-track.md) | Interaction grammar (hover, lasso, focus+context) |
| [reflection-5-map-legibility.md](reflection-5-map-legibility.md) | Map legibility (cluster labels, cell-type legend) |
| [reflection-6-density-underlay.md](reflection-6-density-underlay.md) | Screen-space GPU-KDE density underlay + contours |
| [reflection-7-theme-and-idle.md](reflection-7-theme-and-idle.md) | Light/Dark "paper" theme + idle auto-orbit |
| [reflection-8-body-panel.md](reflection-8-body-panel.md) | The HRA "Body location" 3D panel |
| [reflection-9-honest-encoding.md](reflection-9-honest-encoding.md) | Framing, the luminance-locked resolve, the two 1-D keys, and plate provenance |

## Reference & planning

- **[data-request.md](data-request.md)** — research-data integration requirements,
  input fields, and provenance (referenced from `web/src/body/body-map.ts`).
- **[initial-idea.md](initial-idea.md)** — the original concept note.
