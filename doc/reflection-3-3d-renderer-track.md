# Cytolume — Reflection 3: The 3D Renderer Track

> **Status:** Scoping / actionable · **Date:** 2026-06-27 · **Series:** `reflection-N-*.md`
> **Supersedes/revises:** `reflection-0` §5 (WebGPU+OIT+SSAO "deferred to P3"), §7 (3D as the P3 phase), §8.2 (recommended "2D-first through P2, 3D as P3"). Building on `reflection-2` §7, which already pulled the **spine** 3D-forward and declared a "3D-renderer track [that] starts right after P0," this reflection scopes that track. The net revision: **3D is no longer a single far-future phase.** It splits into *3D-now* (perspective sphere-impostor volume, orbit camera, GPU morph, depth-correct picking hooks) which is this track, and *3D-polish-later* (WebGPU path, full multi-pass OIT, SSAO, bloom) which stays deferred. Reflection-0's instinct to defer the *expensive tail* holds; its instinct to defer *all* of 3D does not.
>
> The thesis is unchanged and load-bearing throughout: **only the data layer emits light; brightness honestly encodes density; blending is an encoding.** 3D must not break that — and the depth buffer turns out to be the tool that *protects* it.

---

## 0. Why this document exists

The owner asked for "a 3D version and interactive effects in the web interface like Helios." Reflection-2 made the data spine able to *feed* that (dims:3, stable `cell_id`, octree, 6-tuple bounds, `umap3d`/`pca3d` already render — projected to XY as a stopgap). This document is the opinionated scope for the renderer that consumes it: what "3D like Helios" actually means for a **point cloud** (not a node-link graph), the exact GPU stack, the camera, the architecture and the regl-vs-WebGL2 fork, how the honest-luminous rule survives in depth, the 2D↔3D morph demo, what it must expose so the interaction track gets depth-correct picking for free, and the multi-agent workflow that builds it.

It is deliberately decisive so the next reflection has something concrete to push against.

---

## 1. What "3D like Helios" means for a point cloud

Helios's premium feel is **a stack of GPU choices, not one effect** (reflection-0 §3). Reading its actual source confirms the stack is *separable* from its graph model. We adopt the **feel**, discard the **graph**.

**Transplants cleanly (adopt):**

| Helios technique | Why it transfers to embeddings | Verdict |
|---|---|---|
| **Billboard-quad sphere impostors** (instanced 4-vert, world-space radius, Gram-Schmidt camera basis) | A cell *is* a sphere; this is the canonical way to draw millions of perspective-correct spheres without geometry. | **Adopt as-is.** Replaces GL_POINTS in 3D. |
| **Analytic sphere-normal from `v_local`** (`normal = normalize(vec3(local, sqrt(1-lensqr)))`) | Pure math, zero deps, exact unit normal. | **Adopt as-is.** |
| **`gl_FragDepth` impostor depth write** (reconstruct surface point along view dir, transform through `viewProj`, `depth*0.5+0.5`) | This is the whole ballgame for correct 3D occlusion of soft spheres. | **Adopt as-is.** Core of the track. |
| **View-aligned spherical shading** (Lambert + spec, hardcoded view-dir `(0,0,1)`, ambient lerped by `normal.z`) | Gives per-sphere volume; view-aligned keeps specular *stable as you orbit* (a real usability win). | **Adopt as-is.** This is our primary depth cue, before SSAO. |
| **Quaternion arcball + log-dolly + world-space pan + SLERP/smoothstep/logLerp transitions** | Most of the "fluid" feel lives here. | **Adopt** (see §3). |
| **GPU position-morph hook** (`mix(from,to,t)`, `u_morphFactor`) | The signature transition; the spine's stable `cell_id` makes it legal. | **Adopt + extend** (see §6). |
| **Weighted-Blended OIT** (dual MRT RGBA16F accumulate + revealage, additive `(ONE,ONE)`, divide-resolve) | Order-independent translucency for millions, no CPU sort. | **Adopt — but narrowly** (see §2.4; it is *not* the headline for categorical). |
| **TBIR / texelFetch indirect, RenderTargetPool, resource-versioning, readPixels picking** | GPU-scalability + interaction substrate. | **Adopt the patterns** as the architecture matures; not all are day-one. |

**Does not transplant (skip / re-derive):**

- **The node-link graph model**, edge rendering, edge-OIT-as-the-main-event. Cytolume is embeddings. (reflection-0 §3: edges are an *open* question; out of this track.)
- **SSAO as Helios ships it** — the findings are explicit and correct: SSAO assumes a continuous rasterized surface; a sparse point cloud's depth buffer has gaps and normal-reconstruction goes noisy/arbitrary. **Default: skip SSAO; rely on spherical shading for volume.** Revisit only as constrained polish (§2.5, §9).

**Looks like:** orbit a glowing ~453k-cell UMAP-3D cloud; near cells are larger and shaded with a stable highlight, far cells recede, clusters have real volume, the canvas stays `#0B0E14` and nothing but cells emits light.

---

## 2. The 3D rendering stack

### 2.1 Geometry: billboard quads, not GL_POINTS

The 2D path uses `gl_PointSize` sprites. **For 3D, fork to instanced billboard quads** (`drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count)`, one instance per cell, `a_corner ∈ [-1,1]²`). Reasons, decisive:

1. `gl_PointSize` is capped (often ≤64px), clips erratically at frustum edges, and can't carry a clean world-space radius for `gl_FragDepth` reconstruction.
2. Billboard quads give the exact Helios pipeline: camera right/up (Gram-Schmidt-orthogonalized to view dir), `world = center + (right*c.x + up*c.y)*radius`, `v_local = c` for fragment-side normal + depth.
3. Quads are the door to TBIR later (ID-only instance buffer + texelFetch), which is how this scales to 10M.

The 2D `PointRenderer` keeps GL_POINTS. This is a genuine fork, not a flag (§4).

### 2.2 Per-fragment sphere depth + shading

Fragment shader: `lensqr = dot(v_local, v_local); if (lensqr > 1.0) discard;` reconstruct `normal`, reconstruct the surface point along the view direction, write `gl_FragDepth` (Helios's formula, adopted verbatim). Apply view-aligned Lambert+spec. **Anti-aliasing:** Helios uses a hard `dist>1.0` discard with no `fwidth` AA (a documented gotcha — aliases at high magnification). We **improve on Helios here**: a 1–1.5px `smoothstep` rim via `fwidth(lensqr)` for the beauty view, falling back to hard discard in the 10M perf regime. This is cheap and the 2D path's soft gaussian already establishes the look.

### 2.3 The depth-vs-additive tension — resolved explicitly

This is the crux of porting the honest-luminous rule into 3D, and the place a naive port breaks. Two facts collide:

- **Additive density (continuous mode) is depth-*ignorant by design.*** A sum is commutative; brightness = the integral of emission along the view ray. That is *exactly* the honest encoding — a dense column of cells should glow brighter precisely because you see *through* all of them. So in 3D, additive mode is a **volumetric emission integral**, not a set of occluding surfaces.
- **Categorical (alpha-over) needs order.** You cannot CPU-sort millions of cells per frame.

**Resolution (decisive, and it keeps the §4-rule intact):**

| Mode | Depth test | Depth write | Blend | Rationale |
|---|---|---|---|---|
| **Continuous / density** | **OFF** (against itself) | OFF | additive `(ONE,ONE)` → HDR float → Reinhard | Honest emission integral. Self-occlusion would *lie* about density. (May depth-test against *opaque* geometry if ever mixed, but never against other cells.) |
| **Categorical** | **ON** (`LEQUAL`) | ON (`gl_FragDepth`) | **opaque, no blend** in the core | **The z-buffer is a free, exact, order-independent sort.** Nearest sphere wins the pixel — *no two saturated categories are ever blended*, so the "false third cell type" is structurally impossible. This is the cleanest possible enforcement of reflection-0 §4. |
| **Focus + context (dimmed)** | ON | core only | translucent gray (alpha-over or WBOIT) | Unselected cells lerp to desaturated gray at ~15–25% (reflection-0 §4). Gray-over-gray invents no category, so translucency is *safe here.* |

This is the key insight, and it revises the loose framing in the findings ("categorical wants depth+OIT"): **categorical does not want OIT for ordering — it wants the depth buffer.** OIT is order-*independent averaging*; a weighted average of red and green is still olive — it would re-invent the false third color the rule forbids. So:

### 2.4 Where OIT actually earns its keep (narrowly)

Weighted-Blended OIT is **adopted, but it is not the categorical-ordering mechanism.** Its legitimate uses in Cytolume:

1. **The desaturated focus+context layer** — many translucent *gray* fragments that should composite without sorting and whose averaging is hue-neutral. This is where dense translucency without z-sort genuinely matters.
2. **Optional soft-rim translucency** in the categorical beauty view, confined to the ~1px antialiased shell — a fraction of coverage, biologically defensible as AA, not category mixing.

It is **never** used to composite two saturated categories into a blended hue. If a region is so overlapped that opaque-depth categorical reads as a hard z-fight mosaic, the honest answer is **switch to focus+context or the density underlay** — not to average the hues. We adopt Helios's exact dual-MRT RGBA16F + additive-accumulate + divide-resolve mechanism (with the `EXT_color_buffer_float`/`half_float`/`float_blend` capability gate and alpha-blend fallback), but scope it to those two layers. **Full multi-pass OIT polish across all modes is deferred** (§8).

### 2.5 Emergent glow tone-map (shared, unchanged)

The continuous HDR-additive → Reinhard pipeline transfers *verbatim* from the 2D `PointRenderer` (`hdr / (hdr+1)`, gentle gamma lift, exposure ~1.15). It is viewport-independent and dimension-agnostic. Helios's **boost variant** (`clamp(weight,0,4)` before Reinhard) is a worthwhile optional toggle to emphasize dense clusters. **No bloom filter** — glow stays emergent (reflection-0 §4); restrained bloom remains a deferred P3 toggle, off in categorical.

### 2.6 SSAO — default off

Per the findings and the honest thesis: skip. Spherical shading is our volume cue. If, after measurement, dense-cluster shells read flat, a **constrained** SSAO — sampling only where the depth buffer is locally continuous (cluster surfaces, not isolated points) — is the deferred experiment, gated on a visible win (§9). The separable bilateral-blur math is worth keeping in the toolbox for bloom regardless.

---

## 3. Camera3D

**Fork from `Camera2D`.** The 2D affine (`uOffset`, `uScale`, `pixelsPerDataUnit()`, z=0) cannot express projection, orbit, near/far, or FOV (the share-vs-fork table in the findings is right). New `Camera3D` produces `uView`, `uProj`, `uViewProj`, plus `uCameraRight`/`uCameraUp`/`uViewDir` for billboard expansion.

**Adopt Helios's camera wholesale** (it's production-grade and the math is documented down to line numbers):

- **Perspective default** (FOV ~60°), **orthographic toggle** (dynamic bounds: viewHeight = distance). UMAP/t-SNE distances are *not quantitative* (reflection-0 §6 forbids treating them as such), so perspective foreshortening is aesthetically free — no honesty cost. Ortho is the "inspect" mode.
- **Quaternion arcball/trackball** rotation with the zoom-dependent gain (`clamp(pow(distanceRatio,0.6),1,5)`), basis from `vec3TransformQuat`, **renormalize every frame** (drift guard + finite-check reset — a real gotcha).
- **Logarithmic dolly** (`distance *= exp(deltaY*0.001)`, clamped). Note the 2D/3D wheel-sign inversion gotcha; match user expectation.
- **World-space pan** (`pan3DBy`, FOV/projection-aware `worldPerPixel`).
- **Transitions:** SLERP (rotation) + smoothstep (pose) + logLerp (distance/zoom/near/far) on a RAF controller (~320ms default). This is the camera half of the morph demo (§6).

**Tighten near/far for embeddings.** Helios's `[0.1, 100000]` is graph-scale; embedding bounds are small. Derive near/far from the layout's 6-tuple bounds + distance so the depth buffer's precision is spent where the cells are (matters for `gl_FragDepth` correctness).

**Share from Camera2D:** viewport/DPR plumbing, and the *concept* of `fit()` — re-implemented to fit the 6-tuple bounds into the frustum (set target = bounds center, distance from bounds radius + FOV).

**Switching 2D⇄3D:** the modes carry separate pan/zoom state and will "pop" if you cross-fade naively (documented gotcha). We don't cross-fade them — the 2D→3D transition *is* the morph (§6), driven by a single Camera3D animating from a top-down ortho framing.

---

## 4. Renderer architecture — and the regl/WebGL2 fork

### 4.1 Shared core, forked substrate

Do **not** retrofit `PointRenderer`. Build a **`Renderer3D`** beside it, behind a small common interface (`setData(PointData)`, `render(camera, mode)`, `setColormap`, `pick(x,y)`, `destroy`). `main.ts` swaps *implementations*, not pipelines — exactly the pattern reflection-2 §6 used for `TileSource`.

**Genuinely shared (extract to modules, no duplication):** `colormaps.ts` LUT builders + the 256-wide LUT texture story, the Reinhard tone-map pass, the density-aware style *model* (re-parameterized, §4.3), `PointData` upload, the `#0B0E14` canvas constant. These are dimension-agnostic.

**Genuinely forked:** the GL substrate, vertex transform (perspective vs ortho-affine), geometry (billboard quads vs GL_POINTS), the depth/shading/pick/OIT passes, and the FBO set.

### 4.2 RESOLVE: raw WebGL2 for the 3D path, not regl-on-WebGL2

The findings flag the constraint and float `createREGL({gl:2})`. **Decision: fork the 3D path to a thin raw-WebGL2 renderer; keep regl for the 2D path.** Reasons, decisive:

1. **`gl_FragDepth` is core in WebGL2**, an extension (`EXT_frag_depth`, *not currently requested*, "fragile, may be absent") in WebGL1. The entire track depends on reliable per-fragment depth. This alone forces WebGL2.
2. **regl is WebGL1-first.** Its WebGL2 support is partial and it does **not** cleanly expose the three things this track needs most: **MRT/`drawBuffers`** (weighted OIT), **`gl_FragDepth`**, and **integer/`usampler2D` textures** (TBIR + pick encoding). Fighting regl to emit those costs more than writing ~a few hundred lines of explicit WebGL2 — which is precisely what Helios itself does (its `WebGL2Device` is a thin raw wrapper for exactly this reason).
3. A thin device wrapper (mirroring Helios's `beginFrame/endFrame/createFramebuffer/readPixels/presentFramebuffer`, plus `RenderTargetPool` and resource-versioning) is the **right** abstraction and keeps the WebGPU path (deferred) swappable behind the same surface.
4. The 2D renderer is verified at 453k@60fps and ships value *today*. Forcing it onto a new substrate risks a working MVP for no 2D benefit. Leave it.

**Safest-default caveat:** if a future audit shows regl's WebGL2 mode reliably exposes `drawBuffers` + `gl_FragDepth` in our target browsers, the *thin-wrapper* design still lets us host it inside regl — but we do not bet the track on it. Build raw WebGL2; treat regl-WebGL2 as an unneeded convenience.

### 4.3 Passes & FBOs

```
per frame (3D):
  [continuous]   additive billboard pass  → HDR RGBA16F (depth OFF) → Reinhard → screen
  [categorical]  opaque billboard pass    → screen (depth ON, gl_FragDepth)
                 + (optional) WBOIT pass for the desaturated context layer
                   → MRT {accum RGBA16F, revealage} → divide-resolve → composite
  [picking, on demand]  id-encode billboard pass (same geometry, same gl_FragDepth)
                   → RGBA8 pick FBO → readPixels(1×1) at cursor
```

FBOs via a `RenderTargetPool` keyed on `(tag,w,h,format)`: `hdr` (RGBA16F), `pick` (RGBA8 + DEPTH24, nearest filter), and `oitAccum`/`oitReveal` (RGBA16F) only when the context layer is active. Resource-versioning (skip re-upload when `PointData` version unchanged) is adopted from Helios's `WebGLResourceCache` — critical so camera-only orbit frames don't re-upload millions of positions.

### 4.4 Point size in perspective — world-space radius + pixel floor

**Decision: world-space radius** (radius in data units; near cells larger, far cells smaller — the real perspective depth cue), **with a screen-space minimum clamp (~1.2px after DPR).** Pure world-space radius makes far/over-zoomed cells go subpixel and *vanish* — the exact blob-inverse failure (rare cells must survive, reflection-0 §4). Pure screen-space radius throws away the perspective volume cue. World-space + min-px floor keeps both. The density-aware **alpha** is recomputed from the *projected* screen radius (per-cell or per-frame-representative), replacing `pixelsPerDataUnit()` which is structurally 2D. Same Matejka-style coverage→alpha curve, new metric.

---

## 5. Data flow

The spine (reflection-2) already delivers everything; this track just stops throwing the third dimension away.

- `SpineTileSource.ensureLayout(name)` returns `PointData{ count, dims:3, positions(stride 3), ids(cell_id), categories, values, bounds(6) }`. `umap3d`/`pca3d` tiles + octree LOD already exist.
- **Stop dropping z.** `main.ts:projectTo2D()` currently collapses a 6-tuple to a 4-tuple and discards z for the 2D renderer. The 3D path **bypasses `projectTo2D` entirely** and uploads stride-3 positions + 6-tuple bounds directly to `Renderer3D`. `projectTo2D` survives only as the explicit adapter when a 3D layout is viewed in the (legacy) 2D renderer.
- **LOD:** the octree's id-seeded subsample levels (no popping, reflection-2 §4) drive 3D LOD by frustum + distance: coarse tiles when zoomed out (sparse representative glow), leaf tiles stream in on dolly. `tilesFor(view)` already takes a view query; extend `ViewQuery` to carry the frustum for 3D culling.
- **Continuous channel** (density / marker gene) streams as a `cell_id`-keyed column exactly as in 2D — a LUT swap, never a tile refetch.
- **Buffer order caveat for morph:** tiles are Morton-ordered *per layout*, so the same `cell_id` sits at a different buffer index in `umap3d` vs `tsne2d`. The renderer/loader keeps the per-tile `cell_id` arrays (already baked), so aligning two layouts into a common draw order is a scatter through the `cell_id`→index map (§6) — no spine change needed.

---

## 6. 2D↔3D and embedding morph — the signature demo

The spine **guarantees `cell_id` is stable across all layouts** (reflection-2 §2.1, §9 verifier asserts it). That is the entire license for GPU position-morph.

**Mechanism:** dual position buffers `a_posFrom`, `a_posTo` + `u_morphFactor t∈[0,1]`; vertex shader `pos = mix(a_posFrom, a_posTo, smoothstep(t))`. Helios morphs the *camera* only (its vertices are static); we **extend** it with geometry morph — the findings call this out as the needed extension, and we own it.

- **Aligning the two buffers:** build `a_posTo` in `a_posFrom`'s order via the `cell_id`→index map over the **resident working set** (loader already has both layouts' `cell_id` arrays). Selections survive the morph because they're `cell_id` sets (reflection-2 §5).
- **2D→3D dimensionality bridge:** treat the 2D layout as the **z=0 plane** and lerp z from 0 → the UMAP-3D z. At t=0 it's a flat tSNE seen top-down (ortho); as t advances, cells *lift into volume*.
- **Synchronized camera:** the Camera3D animates *in lockstep* — SLERP rotation from top-down to a 3/4 orbit, logLerp distance, smoothstep timing, same RAF clock as `u_morphFactor`. One controller drives both. ~300–500ms slow-in/out, never a hard cut (reflection-0 §5).

**Looks like / the demo:** "Fly from tSNE-2D to UMAP-3D." Start: a flat glowing tSNE map, camera overhead. Press play: every cell *travels* to its UMAP-3D coordinate while the camera tilts and orbits into the volume; clusters inflate into 3D structure; a prior selection stays lit on the same cells throughout. This is the five-second "whoa" (reflection-0 §9, portfolio bar).

---

## 7. Interaction adjacency

This track and the interaction track are siblings, both unblocked by P0 (reflection-2 §7). The 3D renderer's job is to make depth-correct picking/hover/lasso **fall out for free** — the interaction track should never have to touch GLSL.

What `Renderer3D` **must expose**:

1. **A pick pass** rendering `cell_id` → RGBA8 to an offscreen FBO using the **same billboard geometry and the same `gl_FragDepth`**. Because the pick pass writes identical per-fragment depth, the depth-nearest sphere wins the pixel → **picking is depth-correct by construction** (you pick the *front* cell, not one occluded behind it). `readPixels(pick, {x,y,1,1})` at the cursor, decode RGBA8→`cell_id` (bit-exact; reflection-2 §9 already verifies the encode round-trip).
2. **`cell_id` as a per-instance attribute** already (the spine bakes it per tile). No hashing, no string compare at pick time.
3. **A state channel** (mirroring Helios's per-node state bits): `u_hoverId` / a small selection mask → per-cell scale + halo-color multiplier, applied in the vertex/fragment shader. Hover/select becomes *flip a uniform or a 1-bit mask*, **not** re-upload geometry. Halos = the reserved indigo `#5B8DEF` (reflection-0 §4), the only non-data light permitted, and it rides on the data layer.
4. **Lasso/region → `cell_id[]`** stays the interaction track's job (kdbush/KD-tree over resident points, reflection-2 §5); the renderer only needs to *highlight* a returned id set via (3). In 3D, lasso projects through the frustum; the renderer exposes `uViewProj` so the interaction track can project itself.

The contract: **renderer owns the pick FBO + id-encode shader + highlight state; interaction track owns cursor→id→UI and spatial queries.** Clean seam.

---

## 8. Roadmap fit & success criteria

### In THIS track (3D-now)

WebGL2 `Renderer3D`; instanced billboard sphere-impostors with `gl_FragDepth` + view-aligned spherical shading + soft-rim AA; `Camera3D` (perspective+ortho, arcball, log-dolly, world-pan, SLERP/smoothstep/logLerp transitions); world-space radius + min-px floor; **additive-emission continuous (depth-off) + depth-opaque categorical (the §2.3 resolution)**; focus+context gray with narrow WBOIT; HDR+Reinhard glow; GPU `mix(from,to,t)` morph + synchronized camera (the tSNE-2D→UMAP-3D demo); the pick FBO + id-encode + highlight-state hooks for the interaction track.

### Deferred (3D-polish-later — stays P3)

WebGPU path (WebGL2 fallback); **full multi-pass OIT across all modes**; SSAO (constrained, gated on a measured win); restrained bloom; diverging A/B density mode; CVD-sim preview + light theme. These are exactly reflection-0 §7's P3 list *minus* the four things (sphere depth, orbit, morph, 3D structure) we've pulled forward.

### Beside the other tracks

Parallel to the **interaction track** (consumes §7's hooks) and downstream of the still-pending **real h5ad** (reflection-2 §8.1 — the highest risk). Until real data lands, this track builds and verifies against the synthetic 453k stand-in (now z-bearing) and the `pca3d`/`umap3d` layouts; the swap to real coords is a data change, not a code change.

### Success bar

- **`pca3d` 453k cloud** orbits at **≥60fps** on RTX-4060-class, **≥30fps** mid-laptop; depth-correct occlusion; stable specular under orbit.
- **The 2D→3D morph runs at 60fps** end-to-end, selection-stable.
- **3D pick round-trip < 16ms**, returns the depth-front cell.
- **Scales toward 10M** (TBIR + min-px clamp + opaque-depth categorical keep it feasible; OIT confined to the context layer so MRT bandwidth doesn't dominate).
- **No false third cell type** at any categorical overlap (the §2.3 invariant, adversarially tested in §10).

**Looks like:** the P3 row of reflection-0's table — "3D clusters with real volume; the 'wow' demo" — reached without WebGPU, without SSAO, by leaning on depth + shading + morph.

---

## 9. Open decisions & risks

1. **regl vs raw WebGL2 (resolved, but flagged).** Recommend **raw WebGL2 fork** for the 3D path (§4.2). Risk: a second GL substrate to maintain. Mitigation: a thin Helios-style device wrapper; shared LUT/tone-map/style modules; 2D path untouched.
2. **OIT cost at 10M.** Dual RGBA16F MRT ≈ 2× framebuffer bandwidth. **Safest default: don't put categorical through OIT at all** (§2.3 makes depth the sorter); confine OIT to the context-gray layer, which is a *subset* of cells. Re-measure before widening.
3. **Additive + depth correctness.** The subtle trap: enabling depth-test on the additive pass would let near cells *occlude* far ones and under-count density — a lie. **Additive must never self-depth-test.** Called out so no one "fixes" it. (Adversarially tested in §10.)
4. **SSAO worth-it?** Uncertain. Findings say skip; spherical shading may suffice. **Default: off.** Decide empirically; only a *depth-continuity-constrained* SSAO is even a candidate, and only if shells read flat.
5. **Point size in perspective.** World-space radius + min-px floor (§4.4). Risk: tuning the floor so rare cells survive without fattening dense cores into mush. The 2D density-aware curve is the starting parameterization; expect re-tuning against the screen-space metric.
6. **Morph buffer alignment at scale.** The `cell_id`→index scatter is cheap on the resident set but must be re-validated when the working set changes mid-morph (LOD streaming during a transition). Safest default: **freeze the resident set for the morph's duration** (no LOD swaps mid-fly), stream after it settles.
7. **Near/far precision.** Tight, bounds-derived planes are required for honest `gl_FragDepth`; too-tight clips the cloud. Derive from 6-tuple bounds + a margin; verify no clipping at full orbit.

---

## 10. The build workflow (ready to script)

A multi-agent Workflow that *builds* the track. Fan-out where passes are independent; an **adversarial verifier** gates "done." Mirrors reflection-2 §9's shape.

**Phase 0 — Substrate & capability probe (single agent, sequential).**
Scaffold `Renderer3D` on a thin raw-WebGL2 device beside `PointRenderer`. Probe: WebGL2 context, depth buffer, `drawBuffers`/MAX_COLOR_ATTACHMENTS≥2, `EXT_color_buffer_float`/`half_float`/`float_blend`, `gl_FragDepth` core. Emit a `capabilities` record + documented fallbacks (no-float → alpha-blend; no-MRT → no context-OIT). *Gate:* WebGL2 ctx with depth + `gl_FragDepth` confirmed; caps logged.

**Phase 1 — Static sphere-impostor core (single agent, sequential — everything builds on it).**
Instanced billboard quads + analytic normal + `gl_FragDepth` + view-aligned shading + soft-rim AA, perspective, single layout (`pca3d`, the cheap honest baseline). *Gate:* 453k 3D cloud renders; spheres occlude correctly (visible depth ordering); ≥60fps RTX-class; no `gl_FragDepth` inversion.

**Phase 2 — FAN-OUT (independent passes, parallel workers).**
- **W-A · Camera3D:** arcball + log-dolly + world-pan + ortho/persp + SLERP/smoothstep/logLerp transitions + bounds-derived near/far + `fit(6-tuple)`.
- **W-B · Blending modes:** additive-emission (depth-off) HDR→Reinhard; depth-opaque categorical; focus+context gray; optional narrow WBOIT context resolve.
- **W-C · Style model:** world-space radius + min-px floor; density-aware alpha from projected screen radius.
- **W-D · Pick substrate:** id-encode pass (shared geometry + `gl_FragDepth`) → RGBA8 FBO → `readPixels` → decode; highlight state channel (`u_hoverId` + mask → scale/halo).
*Per-worker gates:* W-A orbit stable, quaternion renormalized, no NaN at poles; W-B each mode renders; W-C rare cells never subpixel-vanish; W-D decoded id round-trips bit-exact.

**Phase 3 — Morph (single agent, depends on W-A).**
Dual-buffer `mix(from,to,t)` keyed by `cell_id` (scatter-aligned, frozen resident set) + z=0→z lift + synchronized camera on one RAF clock. The tSNE-2D→UMAP-3D demo. *Gate:* 60fps morph; selection stays on the same cells.

**Phase 4 — ADVERSARIAL VERIFICATION (single agent, MUST pass to ship).** Assume the renderer lies; try to break it:
- **Depth correctness vs sorted reference:** render a categorical scene opaque-depth, and again with a CPU painter's-sorted reference; **opaque pixels must match within epsilon.**
- **Additive order-independence:** render the continuous cloud in two randomized draw orders; **pixels must be identical** (proves the sum is commutative and depth-test is OFF — catches the §9.3 trap).
- **The false-third-color test (the non-negotiable rule):** render two overlapping *saturated* categories; **assert no pixel's hue lies between the two source hues** beyond the ≤1px AA rim. Guards reflection-0 §4 directly.
- **Morph id-stability:** a sampled `cell_id` at t=1 sits at its true `umap3d` coordinate, **bit-exact to the layout parquet**; selection set invariant across the morph.
- **3D pick round-trip + occlusion:** click N points (including over occluded cells); decoded id == the **depth-front** ground-truth cell, never one behind it.
- **fps gates:** `pca3d` 453k ≥60fps RTX-class / ≥30 mid-laptop; 10M synthetic ≥30fps **or** the regression is documented with the bottleneck.
*Gate:* all green → track `verified`; any red → bounce to the responsible phase with the failing assertion.

**Phase 5 — Integration (single agent).**
Wire `Renderer3D` behind the existing `TileSource`; `main.ts` 2D⇄3D mode switch; **bypass `projectTo2D` for the 3D path** (stop dropping z; keep it only as the explicit 3D-in-2D adapter). Expose the pick/highlight hooks (§7) for the interaction track. *Gate:* `umap3d`/`pca3d` render in true 3D from real spine tiles; 2D path unchanged; no API break.

**Shape:** Phase 0→1 sequential (the substrate and the impostor are the spine of the track); **Phase 2 fans out into four independent passes**; Phase 3 depends only on the camera; **Phase 4 is the adversarial gate** — depth-vs-sorted, additive order-independence, and the false-third-color test are the three checks that, if green, mean 3D is both *correct* and *honest.*

---

*Diverges from reflection-0 §5/§7/§8.2 where stated; extends reflection-2 §7. Aesthetic/blending rules unchanged (reflection-0 §4) — and in 3D the depth buffer is what enforces them. Next reflection should record the real-h5ad acquisition outcome (reflection-2 §8.1), the chosen point-size floor, and the SSAO go/no-go after measurement.*