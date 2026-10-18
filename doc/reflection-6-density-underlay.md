# Cytolume — Reflection 6: Density Underlay (As-Built)

> **Status:** Built / verified · **Date:** 2026-06-27 · **Series:** `reflection-N-*.md`
> **Builds on:** `reflection-5` (map legibility — auto cluster labels + focus legend), which closed by naming **"the P2.5 KDE density underlay + contours (the relief beneath the names)"** as the natural next pass, and reaches all the way back to `reflection-1 §1-§3`'s "navigable cellular landscape / soft density territories." This reflection is the **as-built record** of that pass: a **screen-space GPU-KDE density field** painted *under* the 3D point cloud, optional **thin iso-density contour bands**, and a **semantic-zoom blend** that makes the field dominant when you pull back to the atlas and fade as you push into the cells. Everything ships on the `?r3d=1` / `Renderer3D` path against the 453k synthetic cloud; the 2D `regl` path is untouched (it never sees the new passes).
>
> The thesis is unchanged and load-bearing: **only the data layer emits light; brightness honestly encodes density; blending is an encoding.** A density field is a *derived* quantity, not data light — so the underlay is deliberately **quiet chrome**: a dim, desaturated cool backdrop capped far below the cells, inventing no color and reserving indigo `#5B8DEF` for selection alone. *Terrain first, never a second sun.*

---

## 0. Why this document exists

Reflection-5 made the cloud *named* but the space *between* the names was still flat #0B0E14 — no sense of the underlying density terrain that reflection-1 promised. The honest worry (recorded in reflection-5 §6) was that a density shade is a derived light, not data light, so it could easily lie: out-glow the cells, invent a heat-map hue, or wash the canvas into a uniform fog. This track built the field while answering each of those — the underlay tracks the *actual on-screen cell density*, stays dimmer than the dimmest cluster, adds exactly **one** cool slate tint, and `off` mode is byte-for-byte the original renderer.

It is an **as-built** record, not a scope. The code exists in `core/renderer3d.ts` (pipeline + `setDensityMode`) and is wired in `main3d.ts` + `index.html` (the Density select). `npm run typecheck` and `npm run build` are both green, and the headless adversarial verifier passed all six checks at 60 fps.

---

## 1. What was built

One feature — a density underlay with three modes — behind a single new panel select and a renderer API:

| Piece | What it does | Where |
|---|---|---|
| **Density underlay** | A screen-space GPU **kernel-density estimate** of the cloud: every cell splats a soft gaussian into a low-res float target, a separable blur smooths it into a continuous field, and a composite paints it as a **dim cool backdrop** under the points. | `core/renderer3d.ts` (SPLAT/BLUR/COMPOSITE) |
| **Iso-band contours** | The same field, plus thin iso-density lines at three toned thresholds (smoothstep edges) — restrained boundary relief for the major populations. | `DENSITY_COMPOSITE_FRAG` (`u_contours`) |
| **Semantic-zoom blend** | `u_densityStrength ∈ [0,1]` from `camera.distance / boundsRadius` — ≈1 zoomed out (field dominant), → 0 zoomed in (points take over). | `Renderer3D.densityStrength()` |
| **The toggle** | `setDensityMode("off" | "underlay" | "contours")`, default **off** (passes skipped entirely → byte-identical original). UI: the **Density** select; URL `&density=<mode>`. | `renderer3d.ts`, `main3d.ts`, `index.html` |

**Module map (additive — no new files, no new exports):**

- `src/core/renderer3d.ts`: four new GLSL programs (`DENSITY_SPLAT_VERT/FRAG`, `DENSITY_BLUR_FRAG`, `DENSITY_COMPOSITE_FRAG`), the `densityMode` field + `setDensityMode()` / `densityModeValue`, and the `buildDensityField` → `blurPass` → `compositeDensity` pipeline injected into **both** render branches (`renderContinuous`, `renderCategorical`). A dedicated `densityVAO` re-binds the existing per-instance `centerBuffer` (`a_center`) + morph-target buffer (`a_posTo`) at divisor 0 so `drawArrays(POINTS)` deposits one splat per cell — **no new geometry uploaded**.
- `src/main3d.ts`: `DensityMode` state + `setDensity()`, the `#density` select listener, the `&density=` URL param, and the `window.__r3d.setDensityMode` / `getDensityMode` automation accessors.
- `index.html`: the `#density-row` select (Off / Underlay / Underlay + contours), revealed only on the 3D path.

This integration pass itself changed **no renderer source** — the pipeline was already built and verified; the pass ran typecheck + build, captured the final screenshots, and wrote this record.

---

## 2. The pipeline — SPLAT → BLUR → COMPOSITE

The whole field is rebuilt every frame at **half resolution** (`w/2 × h/2`), so the extra cost is three cheap fullscreen-ish passes that never touch the 60 fps orbit.

### 2.1 SPLAT — accumulate the kernel centres

`buildDensityField` binds a low-res `rgba16f` target (`density-a`), clears it, turns **depth off** and **additive blend on** (`ONE, ONE`), and issues a single `gl.drawArrays(gl.POINTS, 0, count)` through `DENSITY_SPLAT_VERT`. Each vertex is one cell at `mix(a_center, a_posTo, smoothstep(u_morphFactor))` — the **exact same morph** the impostors use, so the field tracks the umap3d↔pca3d transition frame-for-frame rather than smearing across it. The fragment writes a soft radial gaussian over the point sprite (`exp(-r² · 2.5)`, `u_pointSize ≈ 3 px`), weight 1. The result is an honest screen-space histogram of cell mass: where many cells project together, the float accumulates high.

### 2.2 BLUR — the KDE smoothing

Two fullscreen passes of a separable 9-tap Gaussian (`DENSITY_BLUR_FRAG`, depth + blend off), ping-ponging `a → b` (horizontal) then `b → a` (vertical), with the tap offset `u_step = spread · (1/lowW, 0)` then `(0, 1/lowH)`. Convolving the splat accumulation with a Gaussian *is* a kernel-density estimate — the discrete deposits become a continuous, smooth density field. `spread = 2.0` low-res texels gives soft territories without bleeding clusters into one another.

### 2.3 COMPOSITE — tone, dim, tint, contour

`compositeDensity` binds the **screen**, blend off, and draws the fullscreen triangle through `DENSITY_COMPOSITE_FRAG`:

1. **Tone for dynamic range:** `t = 1 − exp(−d · u_gain)` — a saturating curve so dense regions read as terrain while empty space stays at canvas. `u_gain` is **adapted to the cloud**: `densityGainScale / meanSplatPerLowResPixel`, so the field looks the same whether the data is 50k or 5M cells (it normalizes by mean density, not raw count).
2. **Dim + tint:** `col = CANVAS + FIELD_TINT · (t · u_peak · u_strength)`, with `FIELD_TINT = (0.17, 0.21, 0.31)` — a **desaturated cool slate**, and `u_peak = 0.6` capping the field's contribution. Measured peak field gain is **~0.05 luminance**, far below any cluster — terrain, not data.
3. **Contours (when enabled):** three iso-lines at `t = 0.30 / 0.52 / 0.74` via `1 − smoothstep(0, fwidth(t)·1.5, |t − thr|)`, added at `LINE_TINT · line · u_strength · 0.16` — thin, AA'd, dim. Restrained boundary relief, not a fill.

---

## 3. The inject-before-points pass order — the load-bearing trick

The renderer's `render()` historically did `clear(CANVAS_RGB)` and then drew the cloud. The density composite is injected into **that gap**: the field is built first (its own low-res targets), then `compositeDensity` writes the **full backdrop** (canvas color **+** dim field) straight to the screen with **blend off** — so the composite *doubles as the color clear*. Critically, after it runs the code clears **only the depth buffer**, never the color — erasing the color here would wipe the underlay. The point passes then draw over the surviving field:

- **Continuous:** the cloud accumulates into the HDR `rgba16f` target as before; the Reinhard tonemap is then composited **additively** (`ONE, ONE`) over the underlay — so glow stacks on top of terrain, and the field shows through wherever emission is ~0.
- **Categorical:** opaque, depth-tested points are drawn straight over the underlay — they **cover their own pixels**, leaving the field visible in the gaps between discrete cells = literal territory under the populations.

So the underlay is *under* by construction, not by a fragile blend ordering. The verifier confirmed it: in categorical mode the background just outside a dense cluster gains **+0.050 lum** while an empty corner stays exactly at canvas, and the cluster's own peak luminance is unchanged Off↔On (0.8 % delta) — the field never replaced or washed the cells.

---

## 4. How it stays honest & quiet

The field is a derived light, so it lives under hard honesty rails:

- **Float-path only.** The density passes run **only** when `caps.hdrSupported` (the `rgba16f` accumulate path). On an LDR fallback they're skipped entirely — no half-honest integer approximation.
- **Dimmer than the dimmest cell.** `u_peak = 0.6 × FIELD_TINT` lands the field's peak at ~0.05 lum, comfortably below the `< 0.6×`-of-cell-peak honesty bound. The cells out-glow the terrain, always.
- **One tint, no invented hue.** The entire field is a single cool desaturated slate (`b ≥ g ≥ r`); the verifier measured 100 % of changed gap pixels as cool with **7°** added-hue std — one consistent tint, never a heat-map rainbow, never a per-category color, and **never indigo** (still reserved for selection).
- **`off` is the original renderer, byte-for-byte.** Default mode `off` skips every density pass; the verifier confirmed `off → underlay → off` is byte-identical at sampled pixels.
- **Semantic zoom is the only modulation.** `densityStrength = clamp((distance/boundsRadius − 1.0) / (2.4 − 1.0), 0, 1)` multiplies the whole underlay + contour intensity: ≈1 at the atlas, → 0 as you dive in. Mean field gain measured monotonic **Out 0.102 > Mid 0.095 > In 0.053** — the terrain yields to the cells exactly when the cells become the subject.

---

## 5. Verification & integration result

**Adversarial verifier** (`web/_verifydensity.mjs`, msedge headless via `playwright-core`, live `getContext('webgl2')` + `readPixels` luminance/hue readback through `window.__r3d`) — all six checks green:

1. **Tracks data:** +0.050 lum just outside a dense cluster vs 0.000 in an empty corner — the field follows cells, not a uniform wash.
2. **Beneath + quiet:** cluster peak Off 0.992 ≈ On 1.000 (0.8 % delta); field peak 0.050 ≪ cell peak.
3. **Contours restrained:** +15 ridge bumps over plain underlay, line pixels only **9.1 %** of the scan width — thin iso-bands, not a fill.
4. **Semantic zoom:** mean gain Out 0.102 > Mid 0.095 > In 0.053, monotonic and fading in.
5. **Honest rules:** `off` reproducible byte-for-byte; one consistent cool slate tint (100 % cool, 7° hue std); 1 pixel (0.18 %) tripped the strict indigo gate as an AA edge artifact (within the "beyond AA" exemption).
6. **Perf + no regression:** **60 fps** with underlay ON on both umap3d *and* pca3d at 453k (target ≥45); lasso (441,652 selected), hover (cell #347601 with populated card), legend focus, and the umap3d↔pca3d morph all still work; only console noise is the favicon 404.

**This integration pass confirmed:**

- `npm run typecheck` — **GREEN** (`tsc --noEmit`, clean).
- `npm run build` — **GREEN** (`tsc --noEmit && vite build`; `dist/cytolume.js` **286.48 kB** / gzip 71.80 kB, built in ~0.57 s).
- **Final headless screenshots** (1440×900, msedge, `web/_shotdensity.mjs`):
  - `web/_shot-density-underlay.png` — the dim KDE field as a soft halo beneath the umap3d categorical clusters; cells clearly dominate, terrain reads in the gaps.
  - `web/_shot-density-contours.png` — the same scene with thin iso-density bands tracing each major population's boundary.
  - `web/_shot-density-atlas.png` — a zoomed-out atlas (`camera.distance ≈ 1647`) where semantic zoom makes the field the dominant soft landscape around the now-tiny clusters.
- **Tuning held as verified.** The constants (`densityPeak 0.6`, `densityGainScale 0.22`, `densityPointPx 3.0`, `densityBlurSpread 2.0`) already read as quiet terrain that never competes with the cells (check 2 hard-passed); re-tuning a green build would only risk a regression, so they were left as shipped.

---

## 6. What was deferred (and why)

Held back deliberately, matching the spec's OUT list:

- **True volumetric 3D KDE.** This field is **screen-space** — it estimates density of the *projection*, not a world-space 3D density volume. A real volumetric KDE (froxel grid / 3D blur, ray-marched) would be view-independent and could shade occlusion, but it's a much heavier pass with its own honesty questions (what does "density" mean through a transparent volume?). The screen-space field is the honest, cheap v1.
- **GPU marching-squares vector contours.** The contours here are **shader iso-bands** (smoothstep on the toned field), not extracted polylines. Crisp vector contours with labels/quantile thresholds need a marching-squares pass over the field texture — deferred; the shader bands give the restrained relief without the machinery.
- **Per-category density fields.** One global field today. Per-type fields (splat masked by category, composited per legend focus) would let the underlay answer "where does *this* population live" — but that multiplies the passes and couples to the focus state; it waits.
- **Density-driven point-thinning LOD.** The semantic-zoom blend fades the *field*, not the points. Thinning the cloud by local density when zoomed out (so the atlas isn't 453k overplotted dots) is real value but belongs to the **streaming/LOD track**, not the underlay.

---

## 7. Build workflow & next steps

**Workflow (as run):** a single renderer-owned implementation phase (the SPLAT/BLUR/COMPOSITE pipeline + `setDensityMode` in `renderer3d.ts`, reusing the existing fullscreen-triangle pattern and the per-instance `centerBuffer`), a thin wiring phase (`main3d.ts` + `index.html` Density select + `&density=` param + `window.__r3d` accessors), then an **adversarial verifier** (`_verifydensity.mjs`) that gated "done" against **independent oracles** — gap-luminance readback vs an empty corner, cluster-peak Off vs On, a contour ridge/line-width scan, the monotonic zoom ladder, a cool-tint hue histogram + indigo gate, and a perf/no-regression sweep — rather than the feature's own output. All six green.

**Known gaps / honest notes:**

- The field is **3D-path only** (`?r3d=1`) and **HDR-path only** (`caps.hdrSupported`); on the 2D `regl` path and on LDR fallbacks it is absent by design.
- The contours are **shader iso-bands**, not vector polylines — they cannot yet be labeled or exported (§6).
- Density is the **screen projection's** density, not a world-space volume — a thin slab viewed edge-on reads denser than face-on. Honest for an atlas overview; noted for anyone expecting volumetric truth (§6).
- The `window.__r3d.setDensityMode` / `getDensityMode` accessors are additive, read-only, and inert in production; typecheck stays green.

**Next steps:** the natural follow-ons are the **density-driven LOD / streaming** track (thin the cloud by local density when zoomed out so the atlas isn't overplotted), **per-category density fields** keyed to legend focus (the underlay answering "where does *this* type live"), and — once it earns its cost — a **volumetric 3D KDE** for view-independent terrain. Reflection-7 should record whichever of streaming-LOD or real-h5ad data lands first.

---

*Builds on reflection-5 (labels + focus legend + `window.__r3d`); honors reflection-3's HDR float impostor path (the density field rides the same `rgba16f` targets + fullscreen-triangle pattern), reflection-2's stable `cell_id`, and reflection-1 §1-§3's "navigable cellular landscape." The density underlay added **no** data light — it is dim, desaturated, capped terrain that never out-glows the cells, invents no hue, and leaves the reserved indigo `#5B8DEF` for selection alone. `off` mode is the original renderer byte-for-byte. Artifacts: verifier `web/_verifydensity.mjs`, shot driver `web/_shotdensity.mjs`, screenshots `web/_shot-density-underlay.png` + `web/_shot-density-contours.png` + `web/_shot-density-atlas.png` (all gitignored `_*`).*
