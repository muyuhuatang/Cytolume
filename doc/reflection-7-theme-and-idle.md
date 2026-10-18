# Cytolume — Reflection 7: Light/Dark Theme + Idle "Alive" Motion (As-Built)

> **Status:** Built / verified · **Date:** 2026-06-27 · **Series:** `reflection-N-*.md`
> **Builds on:** `reflection-6` (the density underlay — the relief beneath the names), and reaches back through `reflection-3`'s HDR float impostor path and `reflection-0 §4`'s blending/aesthetic rules. This reflection is the **as-built record** of two showcase features that make the vis feel finished and alive: a **Light/Dark theme** that turns the honest-luminous dark map into an inverted **"paper" mode** (density → *ink* on off-white instead of glow on near-black), and an **idle "alive" auto-orbit** that gently breathes the 3D scene to life after a few seconds of quiet. Both ship on the `?r3d=1` / `Renderer3D` path; the theme also touches the 2D `regl` `PointRenderer` path and all the HTML/CSS chrome. Idle motion is **3D-only** by nature (`Camera2D` cannot orbit).
>
> The thesis is unchanged and load-bearing: **only the data layer carries the encoding; chrome stays flat; indigo `#5B8DEF` is the only selection accent.** The theme honours it precisely — light mode does not invent a new look, it *inverts the same honest encoding* (dense = dark, sparse = bare). Idle motion adds **no** light and **no** data — it is a camera affordance that any interaction instantly cancels.

---

## 0. Why this document exists

Reflection-6 left the map honest, named, and terrained — but **monochromatically dark**, and **static** when the user stepped away. Two showcase gaps remained: (1) a dark-only vis reads as "a tool," not "a medium" — a paper mode makes it presentable on a white page, in print, in a light-themed deck; and (2) a frozen 3D scene reads as *dead* the moment the user stops dragging. This pass closed both without disturbing the dark default (which must stay byte-for-byte today's look) and without adding any new data light.

The honest worry going in was that "light mode" usually means *throw a white background behind a glow shader* — which would either wash the cells out or force a second, dishonest appearance. The key insight (recorded in the spec and proven below) made it tractable: **the additive HDR accumulation pass is theme-agnostic** — it just measures cell-mass per pixel — so only the **canvas clear** and the **fullscreen tonemap composite** need to branch. Light mode is the *same measurement*, composited as ink-over-paper instead of glow-over-black.

It is an **as-built** record, not a scope. The code exists in `core/renderer3d.ts` + `core/renderer.ts` (`setTheme` + the tonemap branch), `style.css` + the `ui/*.css` chrome audit, and `main3d.ts` (the idle loop) / `main.ts` + `index.html` (theme wiring). `npm run typecheck` and `npm run build` are both green, and the headless adversarial verifier passed **22/22** assertions across all required checks.

---

## 1. What was built

Two features, behind one new panel row and a frame-loop addition:

| Feature | What it does | Where |
|---|---|---|
| **Light / Dark theme** | A `Theme: Dark | Light` select (default **Dark** = today's look, byte-for-byte). Light flips the canvas to off-white **paper** and recomposites the data layer as **ink** (density darkens the page toward a LUT-tinted ink) across BOTH renderer paths, plus inverts all HTML/CSS chrome via design tokens. Persists via `&theme=light|dark`. | `core/renderer3d.ts`, `core/renderer.ts`, `style.css`, `ui/map-legibility.css`, `ui/interaction.css`, `index.html`, `main.ts`, `main3d.ts` |
| **Idle "alive" auto-orbit** | After ~2.5 s of no interaction the 3D scene gently auto-orbits — a calm turntable yaw (~6°/s) plus a tiny sinusoidal pitch bob, **eased in over ~1 s** so it never jolts. ANY interaction resets the clock and stops it on the next frame. Default **ON**. | `main3d.ts` |

**Module map (additive — no new source files, no new exports):**

- `src/core/renderer3d.ts`: a `theme` field + `setTheme()` / `themeValue` getter, `canvas4()` (theme-dependent clear) + `themeFlag()` (0/1 shader uniform), a new `uniform int u_theme` threaded into the impostor shader (categorical dim), the **TONEMAP** composite (continuous ink branch), and the **DENSITY_COMPOSITE** (slate-tint flip). `CANVAS_RGB` became a pair `CANVAS_DARK` / `CANVAS_LIGHT`.
- `src/core/renderer.ts` (the 2D `regl` path): the same `theme` field + `setTheme()` / `themeValue`, a `uTheme` + `uCanvas` uniform on the tonemap program, and a conditional clear (`enable: () => this.theme !== "light"`) so the paper composite owns the background.
- `src/style.css`: a `:root[data-theme="light"] { … }` block overriding the `--canvas/--panel/--border/--text/--text-dim/--accent` tokens **and** the derived `--label-halo`. Chrome reads `var()` and inverts automatically.
- `src/ui/map-legibility.css` + `ui/interaction.css`: the chrome **audit** — every hard-coded light-on-dark value (label-overlay text + halo, legend, hover card, selection summary, lasso overlay) re-pointed at tokens.
- `src/main3d.ts`: the idle loop (`stepIdle`, `markInteract`, capture-phase listeners), the `#theme` select listener, the `&theme=` param, and the `window.__r3d.setTheme/getIdleActive/setIdleEnabled` accessors.
- `src/main.ts`: the 2D path's `#theme` wiring (sets `dataset.theme`, calls `renderer.setTheme`, persists the param) — **no** idle motion (2D can't orbit).
- `index.html`: the `#theme-row` select (Dark / Light), near View.

This integration pass changed **no** renderer source — the features were already built and verified; it ran typecheck + build, captured the final screenshots, and wrote this record.

---

## 2. The theme design — invert the encoding, not the look

### 2.1 The key insight: accumulation is theme-agnostic; only the composite flips

The continuous (HDR) path is two passes: an **additive accumulation** that splats every cell's emission into an `rgba16f` target (a per-pixel measure of cell mass), then a **fullscreen Reinhard tonemap** that maps that HDR buffer to the screen. The insight that made light mode honest *and* cheap: the accumulation pass **does not change** — it measures the same cell mass regardless of theme. Only two things branch on a new `uniform int u_theme` (0 = dark, 1 = light):

1. **The canvas clear color** — `CANVAS_DARK #0B0E14` ↔ `CANVAS_LIGHT #EEF0F3` (never pure `#000`/`#FFF`).
2. **The tonemap composite fragment** (`TONEMAP_FRAG`):
   - **DARK:** `out = vec4(reinhard(hdr), 1.0)` — glow **added** over near-black. Today's behaviour, byte-for-byte (the dark branch is literally untouched).
   - **LIGHT:** `out = mix(PAPER, ink, reinhard(hdrLuma))` where `ink = reinhard(hdr) * 0.42` — a dark, **hue-carrying** ink still tinted by the magma/viridis LUT. Dense pixels darken the paper toward LUT-tinted ink; sparse pixels stay bare paper. So `dense = dark ink, sparse = bare paper` — the *inverse* of the dark map, the *same* honest density encoding.

The verifier proved the ink-over-paper composite never lies the way a glow shader would: in light continuous, the densest pixel reads `minLuma 0.420 < paper 0.940`, and **nothing ever exceeds the paper luminance** — density darkens, it never glows brighter than the page.

### 2.2 Categorical (opaque cells): the dim color flips, geometry doesn't

Categorical mode draws opaque, lit, depth-tested cells — that geometry is theme-independent. Only the **focus/selection dim** color flips: dark mode dims context to a ~0.18-lum dark gray (cells sink into the near-black); light mode dims to a ~0.82-lum **light** gray (`float dimLum = (u_theme == 1) ? 0.82 : 0.18;`) so dimmed cells recede into the *paper* instead of standing out as dark blobs. The selection halo stays the accent indigo in both. Verifier: light categorical clusters read as dark ink on paper (`minLuma 0.075`), clearly distinct from the `#EEF0F3` background.

### 2.3 The 3D density underlay: the slate tint inverts sign

The reflection-6 underlay composites a desaturated cool slate **added** over near-black. On paper that would be invisible (you can't add brightness to a white page and read terrain). So in light mode the field tint becomes a **negative** slate that *subtracts* from the paper — `FIELD_TINT_LIGHT = vec3(-0.13,-0.11,-0.16)`, `LINE_TINT_LIGHT = vec3(-0.30,-0.26,-0.34)` — so dense terrain reads as a darker slate on white. Same field, sign-flipped composite. Same honesty rails (capped well below the cells, one tint, no invented hue, indigo reserved).

### 2.4 The CSS token override + chrome audit

`style.css` carries the dark tokens at `:root`; a single `:root[data-theme="light"] { … }` block overrides `--canvas/--panel/--border/--text/--text-dim/--accent` to the light palette. The page sets `document.documentElement.dataset.theme = "light"|"dark"`, and **most** chrome (panels, selects, the bottom readout) already reads `var()` and inverts for free.

The dangerous part was the **audit** — surfaces with *hard-coded* light-on-dark colors that would vanish on paper:

- **Label overlay** (`map-legibility.css`): was white text + dark shadow (correct on near-black, *invisible* on paper). Re-pointed at `--cyto-text` (= `--text`) with a token-driven `--cyto-label-halo` (= `--label-halo`). Dark theme → light text + dark halo; light theme → **dark** text (`#1A1D24`) + **light** halo (`rgba(255,255,255,.9)`). It inverts instead of disappearing — verifier confirmed no light-on-light invisibility.
- **Legend, hover card, selection summary, lasso overlay** (`legend.ts` / `map-legibility.css` / `interaction.css`): each hard-coded color swapped to the design tokens so they invert in lockstep. The lasso stroke and the legend focus wash both ride `--cyto-accent`, keeping indigo as the one selection accent in both themes.

Verifier: light panel bg `rgb(255,255,255)`, `#count` text `rgb(26,29,36)` — dark-on-light, the chrome inverted cleanly.

### 2.5 Wiring + persistence

The `#theme` select (Dark/Light) lives in `index.html #panel` near View. Both `main.ts` (2D) and `main3d.ts` (3D) wire it: on change set `document.documentElement.dataset.theme`, call `renderer.setTheme(t)`, and persist via `history.replaceState` writing `&theme=light|dark`. The param is **read on boot** (default dark), so a fresh load of `?r3d=1&layout=umap3d&theme=light` boots directly into paper — renderer, chrome, and select all light, no flash of dark. `window.__r3d.setTheme(t)` is exposed for the verifier. **Default theme = dark; if `setTheme` is never called the renderer is identical to today.**

---

## 3. The idle "alive" auto-orbit (3D-only)

When the user does nothing for a short while, the 3D scene gently comes alive — a slow ambient turntable, so the vis feels *living* rather than frozen. It lives entirely in `main3d.ts`:

- **The clock.** `lastInteract = performance.now()`, reset by a capture-phase `markInteract` on `pointerdown/move/up`, `wheel`, `keydown` — and, because the legend/labels are DOM overlays whose events bubble to `window`, legend hover + lasso reset it too. Morph/camera-transition starts also call `markInteract` so a programmatic fly-to defers idle motion.
- **The gate.** Each frame `stepIdle(now, dt)` runs only when **all** hold: `idleEnabled` && `now - lastInteract > IDLE_MS (2500)` && `!dragging` && `!lassoing` && `morph === null` && `!camera.isTransitioning` && `tool === "orbit"`. Otherwise it sets `idleActive = false` and resets the pitch phase so the next session starts from rest (no jump).
- **The motion.** A constant yaw `IDLE_YAW_DEG_PER_SEC = 6` (in the calm 4–8°/s band) plus a tiny `IDLE_PITCH_AMP_DEG = 3` sinusoidal pitch bob (period 9 s) so it *drifts*, not spins. Both are **eased in 0→1 over `IDLE_RAMP_MS = 1000`** with a smoothstep ramp, so the turntable spins up smoothly instead of jolting. Everything is `dt`-scaled (dt clamped ≤ 100 ms to survive a tab stall) for frame-rate independence. Motion is applied through the existing `camera.rotateByPixels(dx, dy)` — angles are converted to its pixel units via `ROTATE_PX_PER_DEG` (the inverse of Camera3D's private `0.008 rad/px` rotate speed), and the pitch bob applies the **frame-to-frame delta** of the sin target so the camera rocks rather than accumulating tilt.
- **The stop.** Any interaction resets `lastInteract`, which drops the gate on the very next frame — a **clean stop** (ease-out is optional per spec; the user is now driving, so an instant halt is correct).
- **Automation.** `window.__r3d.getIdleActive()` (true only on frames actually orbiting) and `setIdleEnabled(b)` (master switch; turning it off also clears `idleActive`).

The verifier confirmed all four idle behaviours: after ~2.5 s of quiet `getIdleActive()` flips true and the camera rotation drifts gently (per-sample quaternion delta ~1.5e-3, ≈6°/s — calm, not a spin); a single wheel/pointer event halts it **immediately** (`getIdleActive` false, zero post-drift, no resume inside the window); and `setIdleEnabled(false)` keeps it off through the full idle window. The **2D path got no motion** — `Camera2D` can't orbit, so `main.ts` was deliberately left untouched.

---

## 4. Verification & integration result

**Adversarial verifier** (`web/_verifytheme.mjs`, msedge headless via `playwright-core`, `?r3d=1&layout=umap3d`, synchronous `renderer.render()` + `gl.readPixels` in the same JS task — no `preserveDrawingBuffer` — for luminance/corner-pixel readback through `window.__r3d`) — **22/22 assertions green** across these checks:

1. **Light canvas off-white:** readback corner `rgb(238,240,243) = #EEF0F3`, meanLuma 0.930 vs dark 0.015 — a strong, correct discriminator.
2. **`#theme` select + `&theme=light` persist:** `setTheme('light')` sets `dataset.theme=light`, `select.value=light`, `renderer.themeValue=light`, and `history.replaceState` writes the param. A fresh reload with `&theme=light` boots light directly.
3. **Light categorical legible:** clusters are dark ink on paper (`minLuma 0.075`, ink-frac 0.028 of sampled pixels < 0.80 luma).
4. **Light continuous = ink, not glow:** densest pixel `minLuma 0.420 < paper 0.940`; `maxLuma 0.940` never exceeds the paper — density darkens toward LUT-tinted ink, never glows brighter.
5. **Light chrome dark-on-light:** panel `rgb(255,255,255)`, `#count` text `rgb(26,29,36)`. Label overlay uses `--cyto-text` (`#1a1d24`) + `--label-halo` (`rgba(255,255,255,.9)`) — inverts correctly, never light-on-light.
6. **Dark unchanged:** dark continuous corner `rgb(0,0,0)`, meanLuma 0.015 (the tonemap dark branch outputs `vec4(mapped,1.0)`, byte-for-byte today's look); categorical maxLuma 1.0. Default theme = dark, `setTheme` not required.
7. **Idle:** activates after ~2.5 s quiet (`getIdleActive` true, gentle drift ~1.5e-3/sample ≈6°/s); stops immediately on one wheel event (zero post-drift); `setIdleEnabled(false)` disables it through the full window.
8. **No regression:** lasso (453,251 cells in BOTH themes), hover/pick (valid `cell_id`), legend focus + 14 decluttered labels, density underlay/contours/off, morph (committed + layout flip umap3d→pca3d), orbit + dolly — all work; **zero** page/console errors, zero non-favicon 404s.

**This integration pass confirmed:**

- `npm run typecheck` — **GREEN** (`tsc --noEmit`, clean).
- `npm run build` — **GREEN** (`tsc --noEmit && vite build`; `dist/cytolume.js` **292.46 kB** / gzip 73.73 kB, built in ~0.58 s).
- **Final headless screenshots** (1440×900, msedge, `web/_shottheme.mjs`), both umap3d categorical with the 48-row legend + 12 visible cluster labels:
  - `web/_shot-theme-light.png` — the **paper** map: off-white `#EEF0F3` canvas, white panels with dark text, **dark** cluster labels with a light halo, the 48-type legend dark-on-white, clusters legible as colored ink on the page.
  - `web/_shot-theme-dark.png` — the **dark** map for contrast: near-black canvas, white labels, glowing clusters — byte-for-byte today's look, unchanged.
- **Polish held.** Light mode reads as a clean paper theme (cells / labels / legend / cards all legible, indigo still the only accent), dark is identical to today, and idle motion is calm and unobtrusive. The constants (`ink ×0.42`, `dimLum 0.82`, the negative slate tints, `IDLE_YAW 6°/s`, `IDLE_RAMP 1 s`) already read as intended and hard-passed the verifier; re-tuning a green build would only risk a regression, so they were left as shipped.

---

## 5. What was deferred (and why)

Held back deliberately, matching the spec's optional/out items:

- **Light-mode categorical contrast tuning for pale hues.** The Core-24 palette was tuned for a dark field; a few **pale** categorical hues (light yellows, pale greens) sit at lower contrast on the `#EEF0F3` paper than they do on near-black. v1 keeps the **same** palette in both themes so a swatch always matches its dots (the reflection-5 colorSlot contract is load-bearing) and relies on the name + focus-spotlight to disambiguate — but a theme-aware darkening of the palest hues for light mode is a real future polish pass. Deferred to keep the swatch↔dot identity exact and avoid a second LUT.
- **2D idle motion.** Intentionally none — `Camera2D` has no orbit; "breathing" a 2D scatter would mean a pan/zoom drift, which is a different (and more intrusive) affordance. When/if the 2D camera grows a gentle drift it gets its own pass; `main.ts` was left untouched.
- **An explicit "Idle motion: On/Off" checkbox.** The spec marked it optional. The `window.__r3d.setIdleEnabled(b)` switch exists for automation, but no visible checkbox was added — default-ON with instant interaction-cancel needs no chrome, and the panel stays uncluttered. Trivial to surface later if it earns the row.
- **Auto / system theme (`prefers-color-scheme`).** The select is explicit Dark/Light with URL persistence; honoring the OS theme on first boot is a small follow-on, deferred to keep the default deterministic (dark) for the showcase.
- **Ease-out on idle stop.** Spec-permitted clean stop shipped; a decel ease-out when the user grabs the camera was judged unnecessary (and slightly fights the user who is now driving).

---

## 6. Build workflow & next steps

**Workflow (as run):** the work split along the spec's two features. Theme: a **renderer** phase adding `setTheme` + the `u_theme` branch to BOTH `renderer3d.ts` (tonemap ink branch, categorical dim flip, density slate flip, canvas clear) and `renderer.ts` (2D tonemap + conditional clear) — keeping the additive accumulation pass untouched per the key insight — then a **CSS** phase (the `[data-theme="light"]` token block + the hard-coded-color audit across the `ui/*.css` chrome), then a thin **wiring** phase (`index.html` select + `main.ts`/`main3d.ts` listeners + `&theme=` param + `window.__r3d` accessors). Idle: a single `main3d.ts` phase (the clock, the gate, the eased motion, the accessors). An **adversarial verifier** (`_verifytheme.mjs`) then gated "done" against **independent oracles** — canvas/corner luminance readback per theme, the ink-not-glow inequality (`dense < paper`, nothing brighter than paper), dark-branch byte-equality, chrome text luminance, idle activation + immediate-stop + disable, and a full no-regression sweep — rather than the features' own output. 22/22 green.

**Known gaps / honest notes:**

- **Dark continuous empty background is pure `#000`, not `#0B0E14`** — a documented nuance, not a regression. The tonemap dark branch outputs `vec4(mapped, 1.0)` and overwrites the `#0B0E14` GL clear wherever HDR is empty; this is today's behaviour byte-for-byte (the dark branch was untouched). The `#0B0E14` clear still manifests as the GL clear and in categorical (opaque-cell) mode. Worth flagging only because the palette note says "never pure `#000`"; in continuous mode the empty page is `#000` both before and after this change.
- **Light mode keeps the dark-tuned palette** — pale categorical hues are lower-contrast on paper (§5). Names + focus-spotlight carry legibility; a theme-aware palette is the future polish.
- **Idle motion is 3D-only** by design — the 2D path has none (§5).
- The `window.__r3d.setTheme/getIdleActive/setIdleEnabled` accessors are additive, read-only/idempotent, and inert in production; typecheck stays green.

**Next steps:** the natural follow-ons are (1) the **theme-aware categorical palette** that darkens the palest hues for light mode without breaking the swatch↔dot identity; (2) **`prefers-color-scheme`** auto-default on first boot; (3) a visible **idle-motion toggle** + optional 2D drift if it earns its place; and then the still-open big rocks from earlier reflections — the **density-driven LOD / streaming** track and the first **real h5ad** data + CL ontology (still the highest-risk dependency, reflection-2 §8.1). With the theme + idle pass done, the showcase is presentable on both dark and light pages and feels alive at rest — the next reflection should record whichever of streaming-LOD or real-data lands first.

---

*Builds on reflection-6 (the density underlay — whose composite gained the inverted light-mode slate tint), reflection-5 (labels + legend + `window.__r3d` — whose chrome was audited to token-driven inversion), reflection-3's HDR float impostor path (the theme-agnostic additive accumulation is exactly that path; only the tonemap composite flips), reflection-2's stable `cell_id`, and reflection-0 §4's blending/aesthetic rules unchanged. The theme added **no** new data light — it inverts the *same* honest density encoding (glow-over-black ↔ ink-on-paper) and keeps indigo `#5B8DEF` as the one selection accent in both modes. Idle motion added **no** light and **no** data — a calm camera affordance any interaction cancels. Dark is today's renderer byte-for-byte. Artifacts: verifier `web/_verifytheme.mjs`, shot driver `web/_shottheme.mjs`, screenshots `web/_shot-theme-light.png` + `web/_shot-theme-dark.png` (all gitignored `_*`).*
