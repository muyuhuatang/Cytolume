# Cytolume — Reflection 4: The Interaction Track (As-Built)

> **Status:** Built / verified · **Date:** 2026-06-27 · **Series:** `reflection-N-*.md`
> **Builds on:** `reflection-3` §7 ("Interaction adjacency"), which promised that the 3D renderer would make "depth-correct picking/hover/lasso fall out for free" and listed the exact seam — a pick FBO, `cell_id` per-instance attribute, a hover/select state channel, and `uViewProj` for self-projection. This reflection is the **as-built record** of the v1 interaction layer that consumed that seam: a rich hover card, freeform lasso selection, focus+context dimming of the unselected cloud, and a selection-summary card. Everything here ships against the 453k synthetic cloud in the `?r3d=1` path; the 2D regl path and `Camera2D` were left untouched (2D has no pick yet — deliberately out of scope).
>
> The thesis is unchanged and still load-bearing: **only the data layer emits light; brightness honestly encodes density; blending is an encoding.** Interaction adds exactly **one** non-data light — the reserved indigo `#5B8DEF` — used for hover and selection halos, and nothing else.

---

## 0. Why this document exists

Reflection-3 built the 3D renderer and, critically, *designed for interaction it did not yet build*: it left a clean seam (`pick(x,y) → cell_id`, `setHoverId`, the `u_hoverId` state uniform, the indigo HALO constant, `camera.worldToScreen`). This track turned that seam into a usable, Helios-feel interaction surface without writing a single new line of GLSL outside the renderer's own selection mask. This document records what was built, the design of each affordance, the renderer's selection-mask mechanism, how it reuses the pick seam, why the selection is `cell_id`-keyed (and therefore morph-stable), what was deferred, and the build/verify workflow that gated it.

It is an **as-built** record, not a scope — the code exists, `npm run typecheck` and `npm run build` are both green, and a headless adversarial verifier passed all six checks.

---

## 1. What was built

Four affordances, three new modules' worth of code, behind a single new **Tool** control:

| Affordance | What it does | Where |
|---|---|---|
| **Rich hover card** | In Orbit mode, hovering a cell picks it (depth-correct), grows it ×1.18 with an indigo rim, and shows an anchored card: `cell #id` (IBM Plex Mono, tabular-nums) + cell type + expression. Follows the cursor without covering it. | `ui/hover-card.ts` |
| **Freeform lasso** | In Lasso mode, a pointer drag draws an indigo polygon over the canvas; on release the polygon is closed and every cell whose **projected, front-facing** screen point falls inside is selected. | `interaction/lasso.ts`, `interaction/projection.ts`, `ui/lasso-overlay.ts` |
| **Focus + context** | A live selection dims the rest of the cloud: continuous cells crush emission ×0.16 and desaturate toward luminance-gray; categorical cells become a dark ~18%-luminance gray. Selected cells keep full color + a steady indigo rim + a slight size boost. | `core/renderer3d.ts` (selection mask) |
| **Selection summary** | A card (bottom-left, above the footer) shows the selected count, the top cell type + %, a few type rows, and a **Clear** button. | `ui/selection-summary.ts`, `interaction/selection-store.ts` |

Clearing is wired two ways: the summary's **Clear** button and the **Esc** key both drop the selection everywhere (store, renderer dimming, summary card, any half-drawn lasso).

**Module map (all additive — `types.ts`/`index.ts` exports already covered `Renderer3D`):**

- `src/interaction/` (NEW, pure logic, no DOM): `projection.ts`, `lasso.ts`, `selection-store.ts`, `selftest.ts`.
- `src/ui/` (NEW DOM, no `index.html` edits): `hover-card.ts`, `selection-summary.ts`, `lasso-overlay.ts`, `interaction.css`.
- `src/core/renderer3d.ts`: the selection mask (`a_selected` attribute + `u_hasSelection` uniform + `setSelection`/`clearSelection` + focus+context shader branches).
- `src/main3d.ts` + `index.html`: the **Tool: Orbit / Lasso** control and all wiring, plus an automation surface on `window.__r3d`.

---

## 2. The design, affordance by affordance

### 2.1 Hover card — the cheap, honest detail read

Hover reuses the renderer's existing pick seam verbatim. On `pointermove` in Orbit mode, `eventToDevicePx(e) → renderer.pick(devX, devY) → cell_id`. A hit drives three things at once: `renderer.setHoverId(id)` (the renderer grows the cell ×1.18 and rims it indigo via `u_hoverId`), the footer's bare `cell #id` readout (kept for continuity), and the rich `HoverCard.show({ id, cellType, dataset, expr }, clientX, clientY)`. The card's fields come from `source.getCell(id)` — `cellType` is the resolved `CL_label` name (the source's dict is loaded at boot), `expr` is the cell's `confidence`. The card is anchored to the cursor with a small offset so it never sits under the pointer. A miss (`id < 0`) hides the card and resets the hover state.

The honest rule holds: the only added light is the indigo rim; the card is chrome (`#12161F` panel, `rgba(255,255,255,.1)` border, `#E6E9EF` text), it emits nothing into the data layer.

### 2.2 Lasso — projection + point-in-polygon, brute-force and exact

Lasso is pure CPU logic split across two pure modules so it is testable without a browser:

- **`projection.ts`** — `projectToScreen(pd, camera)` walks every cell, runs `camera.worldToScreen([x,y,z])` (z=0 for 2D layouts), and emits `{ sx, sy, vis }` in CSS px, where `vis` is the in-front-of-camera / finite / `depth01 ∈ [0,1]` flag. This is the *same* ground-truth transform the renderer uses to place billboards, so the lasso and the render agree by construction.
- **`lasso.ts`** — `lassoSelect(polygonCssPx, pd, camera, dpr)` projects each cell and ray-casts a standard point-in-polygon test against the polygon; only **visible** cells inside the polygon are returned, as a `Uint32Array` of `cell_id`s. Brute-force over the full count is fine at 453k (the verifier measured exact agreement: 0 false-positives, 0 false-negatives against an independent re-projection oracle).

The on-screen polygon is drawn by `LassoOverlay` — a `position:fixed`, `pointer-events:none` 2D canvas over the WebGL canvas, thin indigo `#5B8DEF` stroke + faint fill. `begin()/addPoint(x,y)/end()/clear()`. While a lasso gesture is live, orbit, dolly, and hover are all suppressed (`lassoing` guard), and the gesture survives a brief `pointerleave` so the drag isn't lost at the canvas edge.

`projection.ts` is intentionally a superset of what `lasso.ts` strictly needs — it exists as the reusable projection primitive for any future region tool (box/radius), even though v1 ships lasso only.

### 2.3 Focus + context — the renderer dims, honestly

This is the only part of interaction that touches the renderer, and it reuses the hover state-channel pattern: a per-instance `in float a_selected` (1/0) plus a `uniform bool u_hasSelection`. When a selection is active, the fragment shader branches on `dimmed = u_hasSelection && v_selected < 0.5`:

- **Continuous (additive):** `emit = mix(vec3(lum), emit, 0.25) * 0.16` — desaturate toward luminance-gray, then crush emission to ~16%. Unselected density recedes but never vanishes (rare cells must survive).
- **Categorical (opaque):** `lit = vec3(0.18) * (0.55 + 0.45*diff)` — a dark ~18%-luminance gray that keeps just enough spherical shading to read as form but is never a saturated data hue.

Selected cells keep full color plus a **steady** indigo rim (`selHalo`, a gentler always-on version of the hover halo) so the focus set glows above the context. Hover still stacks on top. Both branches obey reflection-0 §4: dimming desaturates toward gray, it never invents a third color, and the indigo is the only non-data light.

### 2.4 Selection summary — a card that cannot lie

`SelectionStore` holds the selection as a `Uint32Array` of `cell_id`s (not layout indices) and exposes `set/clear/ids/count/isEmpty` plus `summarize(pd, source)`. Summarize joins each id back through `source.getCell(id)` (whose `cellType` is the resolved `CL_label` name), rolls up type counts, sorts descending, and returns `{ count, topType:{name,pct,count}, types[], datasets? }`. `SelectionSummary.show(...)` renders count, top type + %, a few rows, and a **Clear** button bound to an `onClear` callback. The verifier recomputed the top-type percentage independently from `PointData.categories` and it matched the rendered card exactly (41% / modal-category 57,673) — the card reports what is actually selected.

---

## 3. The renderer selection-mask mechanism

The mask is deliberately the **same shape** as the hover state channel reflection-3 §7 prescribed — "flip a uniform or a 1-bit mask, not re-upload geometry":

- One per-instance attribute `a_selected` (a `Float32Array`, `DYNAMIC_DRAW`, divisor 1) + one `uniform bool u_hasSelection`. Default is **all-1 / `u_hasSelection=false`** — i.e. no selection means every cell at full brightness, dimming off.
- `setSelection(ids)`: build a lazy `cell_id → instance-index` map (over the data's `ids` array order), `flags.fill(0)`, set `flags[idx]=1` for each known id (unknown ids silently skipped), set `u_hasSelection=true`, and re-upload the flag buffer in place. Cheap at 453k floats — no geometry, no positions re-touched.
- `clearSelection()` ≡ `setSelection(null)`: `flags.fill(1)`, `u_hasSelection=false`.
- The vertex shader passes `v_selected` through; the fragment shader does the focus+context branching (§2.3). Selected cells also get a slight size boost in the vertex stage.

This kept the public renderer API strictly additive (no `types.ts`/`index.ts` churn) and let the four interaction affordances compose at the wiring layer without any GLSL knowledge.

---

## 4. How it reuses the pick seam

The whole track is a consumer of reflection-3's seam — it added **no** new rendering passes:

- **Hover** = `pick()` (the existing id-encode FBO + `readPixels` round-trip, depth-correct because the pick pass shares the billboard geometry and `gl_FragDepth`) → `setHoverId()` (the existing `u_hoverId` channel) → DOM card. The renderer already grew + rimmed the hovered cell; interaction just added the metadata card on top.
- **Lasso** = `camera.worldToScreen()` (the exposed projection) on the CPU → point-in-polygon → a `cell_id[]`. The renderer's job was only to *highlight + dim* the returned set, which it does through the §3 mask — exactly the "renderer owns highlight state; interaction owns cursor→id→UI and spatial queries" contract from reflection-3 §7.
- **Selection halo** rides the **same indigo `HALO` constant** the hover rim uses — one reserved non-data light, two uses (transient hover, steady selection).

No GLSL was written outside `renderer3d.ts`'s own mask, and the 2D path never saw any of it.

---

## 5. `cell_id`-stable selection across morph

The selection is keyed on `cell_id`, and `cell_id` is stable across all layouts (reflection-2 §2.1). That is the entire license for selection surviving the signature 2D↔3D / cross-layout morph:

- `SelectionStore` holds `cell_id`s, never buffer indices.
- The renderer's `setSelection` re-derives the `cell_id → index` map from whatever `PointData` is currently resident, so the *same* ids light the *same* cells regardless of each layout's Morton order.
- At morph commit, `main3d.ts` calls `renderer.setData(targetPD)` (which resets the per-instance flags), then immediately `renderer.setSelection(store.ids)` again — so the dimming/highlight is re-projected onto the new layout's instance order. The verifier confirmed a 140,180-cell selection survived a `umap3d → pca3d` morph byte-for-byte (missing=0, extra=0).

---

## 6. What was deferred (and why)

Held back deliberately to keep v1 sharp (matching the spec's OUT list):

- **Named-cohort compare / pin** — saving multiple selections and diffing them. The store is single-selection by design; multi-cohort is the obvious next layer but adds UI and color-budget questions (the indigo is spoken for).
- **Biological lenses** — marker-gene / dataset / quality overlays driven from the selection. Needs the real h5ad channels (still the highest-risk dependency, reflection-2 §8.1).
- **Nearest-neighbor expansion** ("grow selection to similar cells") — wants the KD-tree spatial index, not just point-in-polygon.
- **Box / radius / polygon-variant region tools** — `projection.ts` is already the reusable primitive for these, but v1 ships **lasso only**.
- **2D-path interaction** — the 2D regl renderer has **no pick pass yet**, so hover/lasso there is genuinely blocked, not just deprioritized. When the 2D path grows a pick FBO, the same `interaction/` + `ui/` modules should drop straight onto it (they only need a projection and a pick callback).

---

## 7. Build workflow & next steps

**Workflow (as run):** the spec fanned the work into three parallel **Foundations** agents against a fixed inter-module contract — A1 (renderer selection mask), A2 (pure `interaction/` logic + a point-in-polygon self-test), A3 (DOM `ui/` cards + `interaction.css`) — that composed at a single **Wiring** phase owning `main3d.ts` + `index.html` (the Tool control + the `window.__r3d` automation surface). An **adversarial verifier** (`_verifyux.mjs`, msedge headless via playwright-core) then gated "done" by cross-checking every claim against an **independent oracle** rather than the interaction's own output: lasso geometry vs a re-projection of each returned id, focus+context vs GL luminance readback, summary % vs a recompute from `PointData.categories`, hover text vs `source.getCell`, morph-survival vs a byte-compare of the id set, and a no-regression sweep (orbit + dolly + zero non-favicon errors). All six green.

**This integration pass confirmed:**
- `npm run typecheck` — **GREEN** (`tsc --noEmit`, clean).
- `npm run build` — **GREEN** (`tsc --noEmit && vite build`, `dist/cytolume.js` 275.96 kB / gzip 68.77 kB, built in ~0.6s).
- Mode + colormap still work in 3D: cycled all three colormaps (magma/viridis/cividis) with zero console/page errors; the colormap row correctly hides in categorical mode and re-shows in continuous.
- **Esc** clears the selection (count → 0, summary hidden) — no leftover state.
- Final headless screenshots captured (1280×800, msedge): an active lasso selection (left band lit + indigo rims, the rest dimmed to gray, summary card showing 149,904 cells / top type `CL:0000036_type36` 38%) and a hover card (`cell #12985 · CL:0000015_type15 · Expr 0.855`).

**Known gaps / honest notes:**
- The verifier added two **additive, read-only** accessors to the `window.__r3d` automation surface — `getCell(id)` and `activePD()` — so an oracle outside the interaction code can re-project ids and recompute stats. They are inert for production behavior and typecheck stays green; a zero-production-diff verifier could instead read back GL buffers (more fragile).
- v1 is **3D-only**; 2D interaction is blocked on the 2D pick pass (§6).
- Single-selection only; cohorts/lenses/NN-expansion are the next track.

**Next steps:** grow the 2D pick FBO so `interaction/`+`ui/` compose onto the 2D path; then named cohorts (the multi-selection color budget is the open design question); then lenses once real h5ad channels land. Reflection-5 should record the real-data swap and the first cohort-compare design.

---

*Builds on reflection-3 §7; honors reflection-2's stable `cell_id` and reflection-0 §4's blending/aesthetic rules unchanged. The interaction layer added exactly one non-data light — indigo `#5B8DEF` — for hover and selection, and nothing else. Artifacts: verifier `web/_verifyux.mjs`, polish driver `web/_final_shots.mjs`, screenshots `web/_final_lasso.png` + `web/_final_hover.png` (all gitignored `_*`).*
