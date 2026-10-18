# Cytolume — Reflection 5: Map Legibility (As-Built)

> **Status:** Built / verified · **Date:** 2026-06-27 · **Series:** `reflection-N-*.md`
> **Builds on:** `reflection-4` (the interaction track — hover/lasso/focus+context, the renderer **selection mask**, and the `window.__r3d` automation surface), and answers two open complaints raised back in `reflection-0 §4` and `reflection-1 §6`/`§11`: *"48 categorical hues are not distinguishable"* and *"the embedding reads as confetti, not a named map."* This reflection is the **as-built record** of the v1 map-legibility layer that closes those: **auto cluster labels** at each cell-type's visual centroid, and a **cell-type legend with focus+context** — hover a type to spotlight it, click to pin. Everything ships against the 453k synthetic cloud in the `?r3d=1` / Renderer3D path; the 2D regl path and `Camera2D` were left untouched (2D has no `worldToScreen`, so labels there are genuinely blocked — out of scope for v1).
>
> The thesis is unchanged and still load-bearing: **only the data layer emits light; brightness honestly encodes density; blending is an encoding.** Labels add **no** light — they are quiet chrome, *structure first, labels second*. The only non-data light remains the reserved indigo `#5B8DEF`, used here for exactly one thing: marking the focused/pinned legend row.

---

## 0. Why this document exists

Reflection-4 made the cloud *interrogable* (pick a cell, lasso a region, dim the rest) but left it *anonymous*: a beautiful confetti of 48 hues with no names and no way to tell two oranges apart. The honest answer to "you can't distinguish 48 categorical colors" was promised in reflection-1 §6 but not yet built — **don't invent 48 distinguishable colors (impossible); instead let the user spotlight one type at a time, and name the clusters in place.** This track built exactly that, against a fixed inter-module contract, reusing the renderer's existing dim path verbatim so the map gained semantics without a single new render pass or a second "dim" look.

It is an **as-built** record, not a scope — the code exists, `npm run typecheck` and `npm run build` are both green, and the headless adversarial verifier passed all six checks.

---

## 1. What was built

Two features, behind a single new left-edge panel + an overlay layer:

| Feature | What it does | Where |
|---|---|---|
| **Auto cluster labels** | Each present cell type gets a quiet name span anchored at its **data-space centroid**, projected to screen every frame so it tracks the orbit. **Decluttered** (no two labels closer than 48 px) and **semantic-zoomed** (few names when zoomed out — the biggest populations — up to all-present as you push in). | `labels/centroids.ts`, `labels/declutter.ts`, `ui/label-overlay.ts` |
| **Focus legend** | A compact, collapsible, scrollable panel pinned to the **left edge** listing every present type: matching swatch, name, count, and %. **Hover** a row → that type stays lit, all others **dim**. **Click** → pin the focus. Esc clears. | `ui/legend.ts`, `core/renderer3d.ts` (category focus) |

**Module map (all additive — `types.ts`/`index.ts` exports already covered `Renderer3D`):**

- `src/labels/` (NEW, pure, no DOM): `centroids.ts` (mean position per present category, O(count)), `declutter.ts` (collision + semantic-zoom cap, with a self-test).
- `src/ui/` (NEW DOM, no `index.html` edits): `legend.ts`, `label-overlay.ts`, `map-legibility.css` (imported from the 3D wiring, **not** `style.css`, so the 2D path never pulls it in).
- `src/core/renderer3d.ts`: one new uniform `u_focusCategory` + `setFocusCategory(cat)` — the category dim branch (this file only).
- `src/main3d.ts` + `index.html`: all wiring (legend rows, centroid cache, per-frame projection + declutter, hover/pin/Esc, semantic-zoom math) + the `window.__r3d` verifier accessors. `index.html` itself was **not** edited — the legend and overlay are DOM-injected.

---

## 2. The design

### 2.1 Centroids — *where* a type's mass sits

`computeCentroids(pd)` is a single O(count) pass: accumulate the mean position of every cell per category index (`z=0` for 2D layouts), emit one `{ category, centroid:[x,y,z], count }` per **present** category, sorted ascending by index for determinism. It answers only *where* — projection, culling, and collision live downstream. The centroid set is computed **once per `setData`** (cached) and re-projected every frame; recomputing on a morph commit / layout change keeps the anchors honest as the cloud rearranges.

### 2.2 Declutter + semantic zoom — named landmarks, not confetti

`declutterLabels(cands, { minGapPx, maxCount })` is pure and testable:

1. Drop invisible candidates (off-screen / behind camera).
2. Sort by **population descending** (deterministic tiebreak on category index) — so the biggest clusters win and own their screen neighbourhood.
3. Greedily keep up to `maxCount` candidates that are ≥ `minGapPx` (48 px center-to-center) from every already-kept label.
4. Ease the opacity of the last ~20 % of the kept budget down toward the cutoff, so the cap **dissolves** as zoom changes instead of popping labels in and out.

**Semantic zoom** lives in the wiring's `labelMaxCount(present)`: it reads `camera.distance / boundsRadius` (the `fit()`-recorded radius), maps the zoomed-out anchor (~2.4) → `MIN_LABELS = 8` and the pushed-in anchor (~0.55) → *every present type*, and clamps between. The verifier confirmed the monotonic ladder: **4 labels zoomed-out → 12 at default fit → 34 pushed-in**, with the closest visible pair at 52.89 px ≥ the 48 px floor (no overlaps).

### 2.3 Per-frame projection — labels track the orbit

Each frame the wiring projects every cached centroid via `camera.worldToScreen([x,y,z])` (device px), divides by `dpr` to CSS px, marks `visible = depth ∈ [0,1] && on-screen`, builds `LabelCandidate`s, runs `declutterLabels`, and hands the survivors to `LabelOverlay.update`. Because the labels project from the *exact same* transform the renderer uses to place billboards, a label is glued to its cluster by construction — the verifier measured `maxDelta = 0.000 px` between each label and its re-projected centroid, before and after a 140×70 px orbit drag (all common labels moved > 3 px, 0 stuck).

`LabelOverlay` keys spans by text and reconciles (move survivors, create newcomers, remove the absent) so it never thrashes the DOM at ~48 labels/frame. Spans are restrained Inter ~11 px, semi-transparent, `pointer-events:none` (never steals orbit/lasso), centered with `translate(-50%,-50%)`, and carry **only** a dark text-shadow for legibility on the dark canvas — quiet, never glowing.

### 2.4 The legend — focus+context, the honest answer to 48 hues

`Legend(onHover, onClick, parent?)` injects a left-edge panel. `show(rows)` renders one row per present type — swatch + name + `count.toLocaleString()` + `pct` — using the design tokens (`#12161F` bg, `rgba(255,255,255,.1)` border, `#E6E9EF` text, IBM Plex Mono + `tabular-nums` for the right-aligned numbers). It is collapsible (header stays) and scrolls past ~16 rows. `setFocus(cat)` marks the pinned/hovered row (indigo wash, others recede to 0.38 opacity) **without** firing callbacks — pure presentation driven by the host. Hover fires `onHover(cat)`, leave fires `onHover(null)`, click fires `onClick(cat)`.

The wiring binds it: `onHover(cat)` → `renderer.setFocusCategory(cat)`; `onHover(null)` → fall back to the pinned category (or −1); `onClick(cat)` → toggle the pin, re-apply focus, mark the row; **Esc** clears both the pin and any selection. Hovering down the list is now a *spotlight sweep* through the 48 types — the user never has to discriminate two near-identical hues by eye, because only one is lit at a time.

---

## 3. The category-focus renderer mechanism — reusing the dim path

The renderer change is deliberately tiny and **forks no new appearance**. One new uniform `uniform int u_focusCategory` (default −1) and one method `setFocusCategory(cat)` — a pure uniform flip, no buffer re-upload, free to call every frame on hover. The fragment shader funnels category-focus into the **exact same** `dimmed` branch the selection mask already uses:

```glsl
bool dimmed = (u_hasSelection && v_selected < 0.5)
  || (u_focusCategory >= 0 && abs(v_category - float(u_focusCategory)) >= 0.5);
```

So a focused category gets the identical honest dim look reflection-4 designed:
- **Continuous:** desaturate toward luminance-gray, then crush emission ×0.16 (`mix(vec3(lum), emit, 0.25) * 0.16`) — context recedes but never vanishes.
- **Categorical:** a dark ~18 %-lum gray keeping just enough spherical shading to read as form (`vec3(0.18) * (0.55 + 0.45*diff)`) — never a saturated false hue.

It is independent of and composable with `setSelection`: a cell stays bright only when it is **neither** selection-dimmed **nor** focus-dimmed; the steady indigo selection rim and the hover halo are unchanged and stack on top. The verifier confirmed the honest signature: focusing category *k* leaves *k*'s own saturated color un-dimmed (satLum 0.569 → 0.569) while a far cluster *j* drops mean-lum 0.409 → 0.119 (ratio 0.29), opening the *k*-vs-*j* contrast to 2.76×; clearing restores *j* to 0.409 exactly. No GLSL was written outside `renderer3d.ts`, and the 2D path saw none of it.

---

## 4. The swatch == render == `CORE_24[cat % 24]` correctness note (the colorSlot trap)

The single most dangerous lie this panel could tell is a swatch that doesn't match the dot. The trap: `CategoricalDict` carries an optional `colorSlot[]`, and it is tempting to color the legend by `CORE_24[colorSlot[cat]]`. **But the renderer's LUT does not use `colorSlot`.** `buildCategoricalLUT()` cycles Core-24 by the **raw** category index, and the shader samples `texture(u_categoricalLUT, vec2((mod(v_category,256.0)+0.5)/256.0, .5))` — so the on-screen color of category `c` is `CORE_24[c % 24]`, full stop. The legend therefore colors every swatch with `CORE_24[cat % 24]` to **match the plot exactly**, and the cluster labels carry no color at all (they sit on the already-correct dots).

The verifier nailed this against the colorSlot trap: for category 21, the legend row color `#ff7f00 == CORE_24[21 % 24]`, and the most-saturated on-screen pixel sampled at that cluster read `[255,127,0]` → nearest Core-24 index 21 (cos 1.000). Panel and plot agree by construction.

---

## 5. How it solves "> 24 hues"

There are 48 synthetic CL_label types and only 24 Core-24 colors, so the palette **wraps** — category 0 and category 24 are the same orange on screen. This is not a bug to paper over with a 48-color ramp (no 48-color categorical scale is mutually distinguishable on a dark field anyway — reflection-0 §4). It is solved on three honest fronts:

1. **Names over the clusters.** A label reads `CL:0000021_type21` *in place*; you don't need the color to be unique because the text is.
2. **Focus+context spotlight.** Hover/pin any one type and it is the *only* lit thing — color collisions are irrelevant when 47 of 48 are gray.
3. **The legend is the index.** Count + % + swatch per row turns the palette wrap into a lookup table, not a guessing game; the swatch is the *real* rendered color (§4), so a wrapped pair is visibly, honestly the same hue — and the user resolves it by name or by spotlight, never by eye-matching two oranges.

---

## 6. What was deferred (and why)

Held back deliberately to keep v1 sharp (matching the spec's OUT list):

- **GPU-KDE density underlay + contours (P2.5).** A separate render pass that shades the field by local density and draws iso-contours — the "tissue-map relief" under the labels. Real value, but it is its own pass with its own honesty questions (a density field is a *derived* light, not data light), so it gets its own track.
- **2D-path labels.** `Camera2D` has no `worldToScreen`, so there is no projection to anchor a label to. Genuinely blocked, not deprioritized — when the 2D camera grows a projection, `labels/` + `ui/label-overlay.ts` drop straight onto it (they only need a project-point callback).
- **Biology class hierarchy / collapsible taxonomy tree.** The synthetic data is a **flat** 48-type CL_label set; a real ontology (cell-class → subclass → type) would let labels collapse by zoom into named *regions*, but there is no hierarchy to collapse yet. Waits on real h5ad CL metadata (still the highest-risk dependency, reflection-2 §8.1).
- **Label search / filter, channel-swap crossfades.** Out of scope for a legibility v1; the legend is the index for now.

---

## 7. Build workflow & next steps

**Workflow (as run):** the spec fanned the work into three parallel **Foundations** agents against a fixed inter-module contract — A1 (renderer category-focus, `renderer3d.ts` only), A2 (pure `labels/` logic + a declutter self-test), A3 (DOM `ui/` legend + overlay + `map-legibility.css`) — that composed at a single **Wiring** phase owning `main3d.ts` + `index.html` (legend rows, centroid cache, per-frame project+declutter, hover/pin/Esc, semantic-zoom, and the `window.__r3d` accessors `setFocusCategory`/`getLegendRows`/`getVisibleLabels`/`getCentroidScreen`). An **adversarial verifier** (`_verifymap.mjs`, msedge headless via playwright-core, synchronous `render()`+`readPixels` for GL luminance/hue readback) then gated "done" against **independent oracles** rather than the feature's own output: label position vs `getCentroidScreen`, min-gap + monotonic semantic zoom, orbit-tracking vs re-projection, swatch vs a Core-24 cosine-nearest of the rendered pixel (the colorSlot trap), focus dimming vs luminance readback, legend % vs a recompute from `PointData.categories`, and a no-regression sweep. All six green.

**This integration pass confirmed:**
- `npm run typecheck` — **GREEN** (`tsc --noEmit`, clean).
- `npm run build` — **GREEN** (`tsc --noEmit && vite build`; `dist/cytolume.js` 277.35 kB / gzip 69.18 kB, built in ~0.56s).
- **Final headless screenshots** captured (1440×900, msedge): the **labeled map** — `web/_shot-map-labeled.png` (umap3d, categorical, 12 visible cluster labels + the 48-row legend with swatches/counts/%) — and a **focused category** — `web/_shot-map-focused.png` (type 21 lit orange, the other 47 dimmed to gray, the legend row 21 marked with the indigo wash).
- Mode + colormap still work: switching Encoding to categorical lights the labels/legend; the continuous colormap row behaves as before. Hover card, lasso, focus+context selection, and the umap3d↔pca3d morph all still pass (verifier check 6: lasso 453,251 cells, hover id 191,625, dolly+orbit respond, morph reached f≈0.33 mid-flight and committed `layout=pca3d`; 0 page/console errors).
- **Esc** clears both the legend pin and any selection — no leftover state.

**Known gaps / honest notes:**
- v1 is **3D-only**; 2D labels are blocked on `Camera2D.worldToScreen` (§6).
- The legend swatch is correct *only because* it mirrors the renderer's raw-index LUT (§4); if a future track switches the LUT to honor `colorSlot`, the legend's `CORE_24[cat % 24]` must change in lockstep — this coupling is load-bearing.
- The flat 48-type synthetic set means semantic zoom currently scales by **population**, not by an ontology; the "labels collapse into named regions" payoff waits on real CL hierarchy (§6).
- The `window.__r3d` verifier accessors (`getLegendRows`/`getVisibleLabels`/`getCentroidScreen`/`setFocusCategory`) are additive, read-only, and inert for production; typecheck stays green.

**Next steps:** the **P2.5 KDE density underlay + contours** (the relief beneath the names) is the natural next pass; then the 2D projection so labels compose onto `Camera2D`; then, once real h5ad CL metadata lands, the **collapsible taxonomy** that turns 48 flat labels into a zoomable class → subclass → type hierarchy. Reflection-6 should record the density pass and the first real-ontology label collapse.

---

*Builds on reflection-4 (selection mask + dim path + `window.__r3d`); honors reflection-2's stable `cell_id`, reflection-1 §6/§11 (focus+context legend, left-edge panel), and reflection-0 §4's blending/aesthetic rules unchanged. The map-legibility layer added **no** data light — labels are quiet chrome — and reused the single reserved indigo `#5B8DEF` only to mark the focused legend row. Artifacts: verifier `web/_verifymap.mjs`, shot driver `web/_shotmap.mjs`, screenshots `web/_shot-map-labeled.png` + `web/_shot-map-focused.png` (all gitignored `_*`).*
