# Cytolume — Reflection 9: Framing, the Honest Encoding, and the Plate (As-Built)

> **Status:** Built / verified · **Date:** 2026-08-26 · **Series:** `reflection-N-*.md`
> **Builds on:** `reflection-3` (the `Renderer3D` impostor pass this rewrites the resolve of), `reflection-5` (cluster labels + legend), `reflection-6` (the density underlay whose semantic-zoom anchor had to be rebased), and `reflection-7` (the light/dark theme whose substrate is now a single constant).
>
> This round was run as a **gauntlet against a named reference** — [Helios](https://heliosweb.io): fan out on the build, grade it with a *separate, harsh* critic against real captures of the reference, act on the critic's list, repeat. The reference stills are working material only — they are captures of someone else's application, so they are gitignored and are **not** part of this repository. Re-capture your own if you want to repeat the exercise.
>
> **Honesty note up front:** four of the defects fixed here were cases where the app **asserted something it could not know**, and two were cases where a channel **encoded something other than what its key claimed**. Those are the interesting ones. The measured numbers below are from the real renderer on the real 453,251-cell spine, not from a model of it.

---

## 1. What changed, in one table

| Attribute | Before | After | How measured |
| --- | --- | --- | --- |
| Cloud fills the plot rect | 40% | **88%** | ink bbox on a captured frame |
| Cloud centring | 52%, 61% | **54%, 48%** | bbox centre vs rect centre |
| Lit-pixel chroma | 0.153 | **0.267** | median over lit px |
| Luminance IQR | 0.314 | **0.439** | p25–p75 over lit px |
| Ink darker than the key's own floor | 7.26% | **1.17%** | L\* vs ramp endpoint (L\* 25.9) |
| Effectively black ink | 2.43% | **0.00%** | L\* < 10 |
| Mark diameter span with depth | 1.0× (none) | **2.58×** | vertex-stage arithmetic |
| Total deposited ink across that change | — | **0.55%** | sum of optical density |
| Peak-mode value reported | the **minimum** | the maximum | LUT inversion + R−G on frame |
| Plate substrate | `#eef0f3` (UI chrome) | `#ffffff` (paper) | corner sample of the export |

---

## 2. Framing: fit the projection, not a bounding sphere

`camera.fitSphere` framed a **3-D bounding sphere** centred on the **per-axis median**. Both are the wrong statistic:

- A median describes where the **mass** is, not where the **extent** is. On `umap3d` the median sits **95.9 world units** off the midpoint of the quantile interval in Y — 0.55 of the half-extent, ≈103 CSS px of vertical mis-centring, which is the visible "cloud sits low".
- A sphere radius over-states an anisotropic cloud, and `fitSphere` then fitted it to `min(vFov, hFov)`, throwing away the larger field of view entirely.
- The fit also spent the ~35% of canvas hidden under the floating panels.

**Now:** `robustViewExtent()` (`core/robust-bounds.ts`) measures the extent along the camera's own `right`/`up`/`viewDir`, and `camera.fitExtent()` fits the two screen axes **independently** against a DOM-measured content rect. Two constraints, larger wins:

- **FILL** — the robust core spans the content rect (this is what makes the cloud big).
- **HOLD** — *every* point, tails included, still lands on the canvas. Outliers still render; they simply do not choose the zoom. A plate that silently drops cells has misstated `n`.

Knock-on recalibrations, both required: `labelMaxCount` and `Renderer3D.densityStrength` were anchored on a magic `2.4` derived from the *old, looser* fit. Left alone, tightening the fit would have taken the label count 23 → 42 and driven the density underlay to 0.003 — i.e. silently vanished. Both are now relative to `camera.fitDistance`.

The app also **boots at `HERO_ROTATION`**. The code comment already said the identity rotation "reads as a flat blob"; nothing applied the fix, so the first frame was the pose the comment condemned and only drifted to a 3/4 view via wall-clock auto-orbit.

---

## 3. The colour channel: two bugs, one structural

### 3a. The value encoding was destroyed before tonemapping

The light resolve recovered hue with `hdr / max(hdr.r, hdr.g, hdr.b)`. Dividing accumulated colour by its own max channel **pins the red channel to exactly 1.0 on every lit pixel** of a warm map — plate-wide R variance measured **0**. That is why the colorbar promised YlOrRd and the plot delivered one mauve wash. Not a matter of taste: the key described a figure that was not on screen.

**Fix:** carry **optical depth in the HDR alpha channel** (previously cleared to 1 and discarded) and LUT colour weighted by it in `.rgb`. The resolve then recovers `hue = acc.rgb / acc.a` — the depth-weighted **mean cell value** — with density as a separate quantity.

### 3b. …and then the two quantities fought over one channel

Beer-Lambert (`PAPER * pow(mix(1,hue,INK), tau)`) fixed the wash but created a subtler problem: **the per-unit decay rate is a function of hue**, so value and density interact *multiplicatively*. Consequences, all measured on the shader:

- **157 (value, τ) pairs differing by more than 0.20 in value collapse within one JND.** Value 0.42 @ τ13.3 is ΔE76 **0.15** from value 0.62 @ τ6.1 — byte-identical on paper. The forward map was **many-to-one**.
- Density was *already* clamped, at a **hue-dependent** threshold: τ stopped encoding at 10.7 for value 1.0 but not until 1784 for value 0.2 — a 167× spread.
- The misread was **directional**: pixels at τ ≥ 100 decoded to median value **0.44** while the plate median was 0.79, so a reader using the ramp called the black cores "top of scale" when they were below average.

**A 2-D bivariate key was designed, and rejected.** No key of any dimensionality can invert a many-to-one map, and the key's own rectangle would have been a lie: at value 0.00 the density axis moves **2.5 L\*** across a 48× change in cell count, while at value 1.00 the same span moves **66 L\***. Every ramp in `core/colormaps.ts` was measured to confirm none can carry hue at near-constant lightness (ylorrd 72.9 L\*, magma 97.8, viridis 76.0, coolwarm 50.1). Clamping τ fails too: the globally-safe clamp is **1.21, below the plate's own p90 of 4.02**.

**Fix — the luminance lock.** Factor absorption into a hue-free **strength** (carries density) times a luminance-normalised **direction** (carries value), on a log axis with a **declared** ceiling:

```glsl
vec3  a  = -log(max(mix(vec3(1.0), hue, INK), vec3(1e-4)));
vec3  an = a / max(dot(LUMA, a), 1e-4);          // direction: value
float d  = min(log(1.0 + tau) / log(1.0 + u_tauMax), 1.0);  // strength: density
vec3  c  = u_paper * exp(-d * u_inkK * an);
float yt = dot(LUMA, u_paper) * exp(-d * u_inkK);
c *= yt / max(dot(LUMA, c), 1e-6);               // L* = f(density), exactly
```

Out-of-gamut pixels desaturate toward their own (correct) luminance rather than clipping a channel, which would rotate the hue and silently change the reported value. The dark branch is the emissive dual and gets the same treatment, with the same τ ceiling so a plate and its dark twin encode density identically.

**Caveat recorded honestly:** the dark branch carries a `LUMA_FLOOR` guard that, on this dataset, **does nothing** — core saturation is 0.432 with and without it, to three decimals. `hue` is the depth-*weighted mean*, and dense pixels average to mid-ramp (value 0.44, luma 0.444), above the floor. It is kept as a bound for data whose means do reach the dark end, not because it improved this plate.

### 3c. Peak mode reported the minimum

`gl.MAX` is **componentwise**, and the resolve recovered hue as `rgb/max(rgb)`. On a light-to-dark ramp the *light* end maximises every channel, so the componentwise max is dominated by the **lowest**-value cell. Verified against the real LUT:

```
cells {0.1, 0.9}     -> 0.100   (true max 0.90)
cells {0.0, 1.0}     -> 0.000   (true max 1.00)
cells {0.9, 0.95}    -> 0.750, and 0.183 off the ramp entirely
```

The code comment claimed it "answers what is the strongest value here". It answered the weakest. **Fix:** in peak mode the impostor writes the **value itself** into `.a` (with a sentinel floor, so a legitimate value of 0 stays distinguishable from "no cell") and the resolve looks the colour up from `LUT(value)` rather than trying to invert a componentwise max. Verified: mean R−G moved 44.5 → **86.9**, i.e. it now lands at the dark-red high-value end.

---

## 4. Marks: the depth cue was algebraically deleted

Zooming into the reference showed its 3-D read is **not** shading — every node is a hard-edged opaque disc whose **size varies with depth**. Cytolume had none of that, and the cause was exact:

```glsl
worldFloor = u_minPx * w / u_focalPx     // per-cell, proportional to depth
radius     = max(u_radius, worldFloor)
screenPx   = radius * u_focalPx / w      // the w terms cancel EXACTLY
```

The data radius is 0.37 px against a 1.2 px floor, so the floor always won and **every one of 453,251 marks rendered at exactly `minPx` regardless of depth**. Anchoring the floor at the **framed** depth (`u_refW`) removes the cancellation; the perspective ratio returns as a **2.58× diameter span**, 1.7–4.3 px.

**The part that makes it honest.** Bigger marks cover more pixels and would deposit proportionally more optical depth — turning τ from *cell mass* into *mass × proximity*, exactly the corruption that rules out depth-attenuated ink. Each fragment's weight is therefore divided by its own footprint:

```
total = alpha·shade·(π·pxRadius²)·(refPx²/pxRadius²) = alpha·shade·π·refPx²   — independent of depth
```

Measured: **total plate ink moved 0.55%** while diameters vary 2.58×. `∫τ ∝ N(cells)` still holds exactly.

Two invariants were verified rather than assumed:

- **Pick parity.** `pick3d.ts` carries a verbatim copy of the size formula so the id raster matches the screen. It was updated in lockstep; proof is that pick hit-rate **tracks the exponent** (0.1438 at exp 1 vs 0.1388 at exp 0) — if it had not been updated, both would read 0.1388.
- **Categorical untouched.** The `modeFlag` gate forces the exponent to 0 on the opaque paths. Verified under frozen motion: **max channel diff 0, changed pixels 0**.

> A first attempt at that second test showed 180,486 changed pixels and looked like a regression. It was idle auto-orbit drifting the camera between captures — an uncontrolled test, not a real diff. Freeze motion before comparing frames.

**Rejected, with reasons.** Eye-dome lighting on the continuous path: a pixel integrates ~53 cells spread through the cluster's depth, so a prepass yields only the *nearest* cell's depth — a Poisson sample uncorrelated with its neighbour's. EDL on that noisy field produces salt-and-pepper darkening **strongest exactly where cells are densest**: a density artefact painted onto a density encoding. It is also multiplicative on the resolve, so "darker" would mean both *more cells* and *in front of something*. Depth-attenuated ink: the cloud orbits, and **a density encoding whose values change when you rotate the camera is not a density encoding**.

---

## 5. The keys: two 1-D, not one 2-D

Because the luminance lock makes L\* a function of density alone and hue a function of value alone, **two independent 1-D keys are legitimate** — which is precisely what a bivariate key of a many-to-one map never was.

**Value key** (`EXPR`): ticks at round values in **data units** (never fractions of the ramp), a distribution strip so the domain is shown rather than asserted, the colormap named with an honest character (`ylorrd · sequential · ordered lightness (ColorBrewer)` — *not* "perceptually uniform", which YlOrRd is not), plus the domain and clipping disclosures.

**Density key**: hue-free grey ramp ticked in **cells along the ray**. This is a real unit, not decoration: point-spread normalisation makes one cell deposit a fixed optical depth regardless of depth, so `N = τ / (alpha · exposure)`. Measured on screen: `tauPerCell = 0.11432`, ceiling **280 cells**. The plate reads a different ceiling (**379** at scale 2) because alpha depends on dpr — the key reads its calibration from the frame that was actually drawn, which is why it must not be a constant.

Both keys are built from the **same constants the shader uses** — never sampled from the framebuffer — so key and marks cannot disagree, and the export stays deterministic.

> **The mistake worth recording:** the on-screen key was rewired to the honest descriptor while the **export** was left on the old hardcoded `label:"Cell value", lo:"0", hi:"1"`. Every plate therefore printed a clean calibrated 0–1 scale that the instrument explicitly refuses to assert — the honesty work discarded at the one moment it gets published. Both keys now share one `continuousKey()` / `densityKey()` source.

---

## 6. Provenance: absence must be meaningful

Three separate places asserted things they could not know.

1. **`figureCaption` read `!spine ? "SYNTHETIC" : ""`** — i.e. *a spine is loaded, therefore the data is real*. False, and it failed in the worst direction: the shipped spine **is** seeded gaussians with fabricated CL CURIEs, so the plate dropped its disclosure precisely when serving synthetic data. Provenance is now a **positive claim**: `isSynthetic()` returns true unless a manifest declares `provenance.synthetic: false` (optional block added to `SpineManifest`).
2. **The key hardcoded "normalised".** Nothing normalises anything — values are copied from `expr.f32` and merely clamped in the shader. The key now reports the stored extent and says the units were never declared.
3. **The render stamp had no camera state.** Two plates of a *3-D* embedding shot from different angles carried byte-identical provenance. Pose now leads the line:

```
n = 453,251 cells · umap3d · 3D · SYNTHETIC DATA — not for publication
     · 23 of 47 cell types labelled (24 omitted, no room)
pose q[-0.2128,0.2882,0.0659,0.9313] d368.0 fov60 persp · marks 1.00x (1.2 px)
     · ink 3.0x · accum sum · depth-cue n/a · density off · theme light · cmap ylorrd
```

**Silently dropped labels.** `labelMaxCount` is a semantic-zoom device; on the export path its input is *pinned* (`camera.distance == fitDistance` by construction), so it degenerated to a constant and deleted roughly half the type names with no indication. It is now uncapped for the plate, and the plate states the omission — which **revealed that the cap was never the binding constraint**. With it removed, geometry still limits placement to 23, because labels sit on their centroids and collide. Leader lines are therefore a *measured* requirement, not a stylistic preference.

---

## 7. Substrate: one constant, three values

`#eef0f3` was written as a literal in **two** shader constants while the composited key's panel used `#ffffff` — three values, no source of truth, and the plate background was the app's **UI chrome colour inherited by accident**. `core/substrate.ts` now holds the only definition, delivered to both shaders as uniforms:

| Key | Hex | Used by |
| --- | --- | --- |
| `screen-dark` | `#0b0e14` | dark theme, chosen to avoid halation on an emissive display |
| `screen-light` | `#eef0f3` | light theme on screen |
| `print` | `#ffffff` | **the export only** — paper is white |

Print is selected by the export path and restored afterwards; it is guarded, because white paper under an emissive resolve is just a white rectangle. Verified: export background moved `rgb(238,240,243)` → `rgb(255,255,255)`, screen unchanged.

---

## 8. Control surface

The panel was nine flat `<select>` rows with no headers. It is now grouped `DATA / MARKS / CONTEXT / VIEW` using `<details>` (plain HTML disclosure — collapsible and keyboard-accessible, no JS), with mark sliders carrying live numeric readouts.

The rule that matters: **a control the current render path cannot act on goes visibly inert with a written reason.** Depth cue is gated on `edlStrength > 0 && !densityActive` *inside* `renderCategorical`, so on the default continuous encoding it has nothing to act on — it is disabled and says so, rather than silently doing nothing. Every mark control is mirrored module-side and printed in the render stamp; a control the caption does not record produces two plates that differ under identical provenance.

`?size` / `?ink` / `?edl` / `?blend` make a tuned plate reproducible from a link, matching the existing `?density` / `?motion` / `?spin`.

---

## 9. Verification

All numbers above come from the real renderer, driven through a local Chrome via `playwright-core`. GL device confirmed per run: `ANGLE (NVIDIA … RTX 4060, D3D11)` — **not** SwiftShader; the software path renders correctly but took ~5 min for the 48-panel facet plate versus **0.7 s** on the GPU.

Two traps worth remembering:

- **Never `import("/src/main3d.ts")` from a driver script.** After any edit Vite serves the app's copy under an HMR `?t=` query, so a plain dynamic import resolves to a different URL and **instantiates a second app instance** with its own `mode` and a null `activePD`. Symptom: an export refuses in 3 ms with "needs categorical mode and loaded data" immediately after `setMode` provably worked. Go through `window.__r3d`, which is bound to the booted instance. `__r3d.state()` exists so a driver can assert readiness instead of sleeping.
- **The shader sources are JS template literals.** A backtick in a shader *comment* terminates the string and produces a TypeScript parse error dozens of lines away. Broke this twice.

---

## 10. Not done

Nine of the eleven verified plate-as-artifact changes remain. They share one root cause: **the plate inherits its parameters from the running app instead of declaring them.**

- **Format / aspect** — the plate is 16:9 because the *browser window* is. Ink spans 68% of plate width against 86% of its height, so roughly a third is empty. Needs a declared physical size and an aspect derived from the data.
- **Type sizes** — every font size is a CSS-px literal times `scale`, so its *printed* size depends on `cssW`. At 183 mm that puts cluster labels at **3.73 pt**, under any journal's floor. They need to be specified in points, derived from the plate's physical width.
- **Leader lines** (3 changes) — labels sit on the cores they name, punching a halo through the exact ink the figure asks you to read. Section 6 established this is also what caps the label count.
- **Figure furniture** — no panel letter, no title block; the key is still a rounded card with a border rather than flat furniture in a reserved rail.
- **Quantile HOLD** + an exact count of cells outside the frame; **fit-constraint reporting** so the aspect claim is verifiable rather than argued; and the two call sites (`updateLabels`, `contentRect`) that break once the plate stops sharing the window's aspect.

**And the standing one.** The plate's own footer reads *SYNTHETIC DATA — not for publication*. Until `public/spine` is rebuilt from real HuBMAP data with a manifest that positively declares `synthetic: false`, that line settles the publication question ahead of everything above. See [`data-request.md`](data-request.md).

---

## 11. Files

| File | Change |
| --- | --- |
| `web/src/core/robust-bounds.ts` | `+ robustViewExtent()` — extent in the camera's screen basis |
| `web/src/core/camera3d.ts` | `+ fitExtent()`, `fitDistance`, `viewHalfDepth`; `nearFar` brackets the view axis |
| `web/src/core/renderer3d.ts` | luminance-locked resolve (both themes), optical depth in HDR alpha, perspective mark size + PSF normalisation, peak-mode value channel, `tauPerCell` / density-key helpers, substrate uniforms |
| `web/src/core/substrate.ts` | **new** — the one substrate definition |
| `web/src/core/pick3d.ts` | mirrors the new size formula (id raster must match the screen) |
| `web/src/ui/continuous-domain.ts` | **new** — the one description of the continuous channel |
| `web/src/ui/colorbar.ts` | ticks, distribution strip, second (density) key |
| `web/src/ui/figure-composite.ts` | ticked + distribution key on the plate, density key, render stamp, substrate-aware ink |
| `web/src/labels/declutter.ts` | `+ declutterLabelsWithStats()`; hard halo; opacity floor 0.35 → 0.75 |
| `web/src/main3d.ts` | `contentRect()`, `fitRobust()`, hero boot, `continuousKey()`, `densityKey()`, `isSynthetic()`, `figureRenderStamp()`, `labelOmissionNote()`, mark controls |
| `web/src/data/manifest.ts` | `ContinuousChannel` (domain/unit/transform), optional `provenance` block |
| `web/index.html`, `web/src/style.css` | grouped panel, mark sliders, inert-state styling, readout moved off the figure rail |
