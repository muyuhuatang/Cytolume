# Cytolume — Reflection 8: HRA Human-Body Panel + Click-to-Locate (As-Built)

> **Status:** Built / verified · **Date:** 2026-06-27 · **Series:** `reflection-N-*.md`
> **Builds on:** `reflection-3` (the `?r3d=1` `Renderer3D` orbit path + GPU picking), `reflection-4` (the interaction grammar: orbit-drag / right-drag-pan / lasso), `reflection-5` (the left-edge cell-type legend), and `reflection-7` (the light/dark theme tokens this panel inverts with). This is the **as-built record** of a small, fixed-size **HRA human-body view** docked under the legend that, on a cell **click**, highlights + zooms a real 3D anatomical model (`<ccf-body-ui-wc>`) to where that cell type "lives" — turning a click into *a link to the exact location in the body*.
>
> **Honesty note up front:** the predecessor `.h5ad` carries no per-cell anatomy (its 48 `CL_label` types are placeholders `type00…type47`), so the **cell-type → organ mapping is SYNTHETIC** and clearly labelled as such in the UI (a `SYNTHETIC` tag on the panel) and in code. What is **real** is the embed itself and the geometry: the HRA web component, its 3D organ models, and the per-organ `rui_location` registrations (pulled from public HRA GTEx data). Real per-cell organ + CCF coordinates are a one-file swap when the data arrives (see §6 + `data-request.md`).

---

## 1. What was built

Three pieces on the `?r3d=1` path; the 2D `regl` path (`main.ts`) is untouched.

1. **A fixed-size body panel** (`web/src/body/body-panel.ts` + `body-panel.css`) — a 244×374 px DOM card pinned to the **bottom-left rail, below the legend**, hosting the HuBMAP HRA **CCF Body UI** web component `<ccf-body-ui-wc>`. Theme-aware via the shared `--panel/--border/--text` tokens (it inverts with light/dark exactly like the legend). It is a **separate DOM overlay, NOT the `#stage` WebGL canvas**, so embedding orbit/zoom can never resize or move it — verified (§5).
2. **A synthetic cell-type → body-node mapping** (`web/src/body/body-map.ts`) — assigns each of the 48 `CL_label` types to one of 12 organs, each carrying a **real, valid CCF `rui_location`** SpatialEntity registration. Lung-dominant (16/48 types) because the predecessor dataset is lung; the rest spread across heart, liver, kidney, spleen, pancreas, colon, small intestine, skin, blood vasculature, uterus, mammary gland for a livelier demo.
3. **Click-to-locate wiring** (`web/src/main3d.ts`) — a click (`pointerdown`+`pointerup` with ≤5 px travel, distinct from an orbit-drag) picks the cell at the device pixel, reads its `cellType` via `source.getCell(id)`, maps it to a body node, and sets `bodyUi.highlightID = nodeId` + `bodyUi.zoomToID = nodeId` so the 3D body **highlights and flies** to that location. The panel caption updates to `Located in: <Organ>`.

---

## 2. The embed (proven by the reflection-8 spike)

The spike established the **only** working CDN bundle and the data contract; this build uses them verbatim.

- **Bundle:** `https://cdn.humanatlas.io/ui/ccf-body-ui-wc/wc.js` (+ optional `styles.css`). The jsDelivr `ccf-ui@2/body-ui/wc.js` bundle is **broken** (its default ontology URL is CORS-blocked → permanently black canvas). The HRA bundle instead renders from the CCF API (`https://apps.humanatlas.io/api/v1/scene` + `/v1/reference-organs`, both `Access-Control-Allow-Origin: *`).
- **API endpoint** is configured **before** the element connects, via `globalThis.dbOptions = { remoteApiEndpoint: 'https://apps.humanatlas.io/api' }` (set in `ensureBundle()` prior to injecting the `<script>`).
- **Element inputs (the only three):** `data` = `[{ id, rui_location }, …]`, `highlightID` (string), `zoomToID` (string). Internally `highlightID`/`zoomToID` are prefixed to `…/entity/<id>`, so they take a **data-item `id`** (here `"lung"`, `"heart"`, …), **not** an organ IRI.
- **Guarded:** the embed is wrapped in `try/catch` + a 12 s `customElements.whenDefined` timeout race. On any failure it swaps the stage for a quiet "Body view unavailable (offline?)" placeholder; the embedding keeps working. A `highlight()` requested before the element finishes loading is re-applied once it is ready.

The component needs internet to fetch its 3D organ GLBs at runtime — acceptable per spec.

---

## 3. The synthetic mapping + the real `rui_location`s

`body-map.ts` is explicit about what is invented vs. real (big header comment + a `SYNTHETIC` UI tag):

- **Invented:** the `CELL_TYPE_NODE[48]` table (type index → organ). `bodyNodeForCellType(cellType)` parses the trailing index from a `CL_label` name (`"CL:0000007_type07"` → `7`, also accepts a raw numeric category) and looks it up, returning `null` when unmappable.
- **Real:** the 12 `rui_location` objects. Each is a valid CCF `SpatialEntity` (JSON-LD, `@context` = the HRA ccf-context) with a `placement` whose `target` is a Visible-Human reference organ IRI (`http://purl.org/ccf/latest/ccf.owl#VHFLung`, `#VHFHeart`, …) and real translation/rotation/dimension values. They were pulled from the public HRA GTEx tissue-block dataset (`https://apps.humanatlas.io/api/v1/gtex/rui_locations.jsonld`), one representative female-reference block per organ. `BODY_DATA` (the array fed to `.data`) is `BODY_NODES.map(n => ({ id, rui_location }))`.

So the *positions in the body are anatomically real*; only *which cell type points at which position* is synthetic.

---

## 4. The click → highlight flow (in `main3d.ts`)

The existing orbit-drag sets `dragging = true` on `pointerdown` and rotates on move. Click discrimination rides on top without disturbing it:

1. `pointerdown` (left, orbit tool) records `downClientX/Y` alongside the existing `dragging = true`.
2. `pointerup`: if `dragging && !e.shiftKey` and cursor travel `hypot(Δx,Δy) ≤ CLICK_SLOP_PX (5)`, it is a **click** → `selectCell(renderer.pick(devX, devY))`. (Shift+left is the pan convenience, so it never counts as a click; lasso and right-drag-pan have their own branches and are unaffected.)
3. `selectCell(id)`: on a miss clears the body highlight; otherwise `source.getCell(id).cellType` → `bodyNodeForCellType()` → `bodyPanel.highlight(nodeId)`, which sets `highlightID` + `zoomToID` on the live element and updates the caption.

Orbit-drag, right-drag-pan, hover, lasso, and the Motion/Spin config all keep working (a real orbit moves >5 px and is never misread as a click).

**Verifier seam** (`window.__r3d`): `selectCell(id)`, `getBodyNodeId(cellType)`, `bodyReady()`, `bodyFailed()`, `bodyHighlightId()`, `bodyElementHighlightID()`, and `bodyPanel`.

---

## 5. Verification (headless, playwright-core msedge)

`npm run typecheck` is **green**. Two headless scripts (`web/_verify-body*.mjs`, gitignored) confirmed against the live dev server:

- **Panel renders a body:** `.cyto-body` present, fixed **244×374** at `left:20`, stage **300 px**; `<ccf-body-ui-wc>` defined + mounted; `bodyReady === true`. Screenshot `_body-panel.png` shows the 3D human figure in the panel (not a black canvas).
- **Mapping:** `type00 → lung`, `type16 → heart`, `type47 → mammary-gland`, raw `"7" → lung`.
- **Click→highlight:** picking a real cell (id `406222`, `cellType type42`) → `selectCell` returned `"skin"`; both `bodyHighlightId()` and the element's read-back `highlightID` became `"skin"`; clearing returns them to `null`/`""`. The body reacts.
- **Independent of embedding zoom:** 10× hard wheel-zoom on `#stage` left the panel rect **byte-identical** (`panelStable === true`).
- **Theme inversion:** `?theme=light` flips the chrome to paper mode; the panel + `Located in: Heart` caption invert correctly (`_body-highlight-light.png`).
- One non-fatal `404` is logged by the bundle (an optional asset); it does not block readiness.

---

## 6. TODO — real CCF data (the one-file swap)

The synthetic mapping is the **only** invented part and is isolated to `body-map.ts`. When real data arrives:

- **Replace** `CELL_TYPE_NODE` / `bodyNodeForCellType` with a real per-cell **organ** + **CCF `rui_location`** join from the HRA `.h5ad` (`obs`: `organ` / `anatomical_structure` / a per-cell or per-tissue-block `rui_location`).
- A single representative `rui_location` per organ/tissue block is already enough (that is exactly the shape `BODY_NODES` holds today) — so the swap touches no other file: `main3d.ts`, `body-panel.ts`, and the CSS are data-agnostic.
- Request logged in `data-request.md` (new row: per-cell organ/anatomical-structure + CCF `rui_location`).

Until then the panel is honestly labelled **SYNTHETIC** in the UI and the code header.

---

## 7. Files

- `web/src/body/body-map.ts` — synthetic mapping + 12 real `rui_location`s + `bodyNodeForCellType` / `BODY_DATA`.
- `web/src/body/body-panel.ts` — the guarded `<ccf-body-ui-wc>` host (`BodyPanel`, `highlight()`).
- `web/src/body/body-panel.css` — fixed-size, theme-aware left-rail card; caps the legend height so the rail never overlaps.
- `web/src/main3d.ts` — imports the panel CSS; instantiates `BodyPanel`; `selectCell()`; click-vs-orbit discrimination in `pointerdown`/`pointerup`; `window.__r3d` seam.
- `data-request.md` — added the per-cell organ + `rui_location` request row.
