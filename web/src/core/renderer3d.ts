/*
 * Renderer3D — the Cytolume sphere-impostor core (reflection-3, SPEC §GEOMETRY..§COLOR).
 *
 * A raw-WebGL2 renderer that sits BESIDE the regl/WebGL1 2D PointRenderer and
 * shares nothing with it but the colormaps and the "blending is an encoding"
 * rule. It draws every cell as an instanced billboard quad expanded into a
 * sphere by the fragment shader: an analytic normal + a hand-written
 * gl_FragDepth make the impostor depth-correct under perspective, so the
 * z-buffer can do the order-independent sort for the categorical mode.
 *
 * Geometry: gl.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count).
 *   per-vertex   a_corner   vec2 in [-1,1]^2  (the quad)
 *   per-instance a_center   vec3              (cell position, stride 3 — z kept)
 *                a_value    float             ([0,1] continuous scalar)
 *                a_category float             (categorical LUT index)
 *
 * Blending per mode (the load-bearing honest-luminous rule, SPEC §BLENDING):
 *   continuous  → depth OFF, additive (ONE,ONE) into an HDR RGBA16F target whose
 *                 ALPHA carries optical depth and whose RGB carries LUT colour
 *                 weighted by it, resolved so lightness reports density and hue
 *                 reports value (reflection-9). (Volumetric emission;
 *                 self-occlusion would lie about density.)
 *   categorical → depth ON (LEQUAL), depth-write ON, NO blend (opaque). The
 *                 z-buffer IS the sort; the nearest sphere wins, so two
 *                 saturated categories never blend into a false third color.
 *
 * Style model: world-space radius derived from mean point spacing, with a
 * screen-space minimum-pixel floor applied per-instance in the vertex shader
 * (rare cells never subpixel-vanish), and a density-aware alpha recomputed each
 * frame from the projected screen radius.
 */

import { Device3D, Device3DUnavailable, type RenderTarget } from "./device3d.ts";
import { SUBSTRATE, screenSubstrate, type SubstrateKey } from "./substrate.ts";
import type { Camera3D, Camera3DUniforms } from "./camera3d.ts";
import type { EncodingMode, PointData } from "./types.ts";
import { buildContinuousLUT, buildCategoricalLUT, buildSeriesLUT } from "./colormaps.ts";
import { PickPass } from "./pick3d.ts";

/** Sentinel hover id meaning "no cell is hovered" (no real cell_id collides
 *  with it in practice — cell counts are far below 2^32-1). */
const NO_HOVER = 0xffffffff;

// Theme canvas clears (SPEC §FEATURE 1). Dark = near-black charcoal (today's
// look, byte-for-byte); light = off-white "paper" (never pure #FFF — halation).
// Substrate lives in ONE place now — see core/substrate.ts for why.

// ---------------------------------------------------------------------------
// Shaders (GLSL ES 3.00 — gl_FragDepth is core in WebGL2)
// ---------------------------------------------------------------------------

const IMPOSTOR_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2  a_corner;    // per-vertex quad corner in [-1,1]^2
in vec3  a_center;    // per-instance cell position (world) — the morph SOURCE
in vec3  a_posTo;     // per-instance morph TARGET position (aligned by cell_id)
in vec3  a_centroid;  // per-instance centroid of the cell's CATEGORY (idle spin pivot)
in float a_value;     // per-instance continuous scalar [0,1]
in float a_category;  // per-instance categorical index
in uint  a_id;        // per-instance stable cell_id (picking + hover compare)
in float a_selected;  // per-instance selection flag (1=selected, 0=not) — focus+context

uniform mat4  u_viewProj;
uniform vec3  u_cameraRight;  // billboard X (world), orthonormal
uniform vec3  u_cameraUp;     // billboard Y (world), orthonormal
uniform vec3  u_viewDir;      // world view direction, eye -> target
uniform float u_radius;       // base world-space sphere radius
uniform float u_focalPx;      // 0.5 * viewportHeightPx / tan(fov/2)
uniform float u_minPx;        // screen-space minimum radius floor (device px)
uniform float u_refW;         // clip-w at the FRAMED depth (camera.distance); perspective anchor
uniform float u_depthSizeExp; // 0 = constant screen floor (as before); 1 = true perspective
uniform float u_morphFactor;  // 0..1 layout cross-fade (SPEC §MORPH)
uniform uint  u_hoverId;      // hovered cell_id (0xFFFFFFFF = none)
uniform bool  u_hasSelection; // true once a selection is active (focus+context)
uniform float u_spinAngle;    // per-cluster idle spin angle (radians, 0 = un-spun)
uniform vec3  u_spinAxis;     // per-cluster idle spin axis (unit; world up or plane normal)
uniform int   u_facetCategory; // FACET ink pass: draw ONLY this category (-1 = off)
uniform bool  u_facetGhost;    // FACET ghost pass: render every cell as dim context

out vec2  v_local;    // = a_corner
out vec3  v_center;
out vec3  v_right;
out vec3  v_up;
out vec3  v_viewDir;
out float v_value;
out float v_pxRadius;
out float v_category;
out float v_radius;
out float v_eyeW;   // eye-space depth of this cell's centre
out float v_hover;    // 1.0 on the hovered cell (drives the indigo halo)
out float v_selected; // 1.0 on a selected cell when u_hasSelection (steady halo)

void main() {
  // Gram-Schmidt: re-orthonormalize the billboard basis against the view dir so
  // the quad always squarely faces the camera even if the uniforms drift.
  vec3 fwd   = normalize(u_viewDir);
  vec3 right = normalize(u_cameraRight - fwd * dot(u_cameraRight, fwd));
  vec3 up    = normalize(cross(fwd, right));

  // GPU position morph (SPEC §MORPH): cross-fade the cell between its source and
  // target layout positions. smoothstep eases the travel; a_posTo was aligned
  // into a_center's order on the CPU via the stable cell_id, and the 2D→3D
  // bridge is a z=0 target lerped up — both already baked into a_posTo.
  vec3 center = mix(a_center, a_posTo, smoothstep(0.0, 1.0, u_morphFactor));

  // Per-cluster idle spin (SPEC: "living galaxy"): rotate the cell about ITS
  // category centroid by u_spinAngle around u_spinAxis (Rodrigues). Everything
  // downstream (billboard, honest gl_FragDepth) follows the spun center.
  if (u_spinAngle != 0.0) {
    vec3 rel = center - a_centroid;
    float s = sin(u_spinAngle), c = cos(u_spinAngle);
    rel = rel * c + cross(u_spinAxis, rel) * s + u_spinAxis * dot(u_spinAxis, rel) * (1.0 - c);
    center = a_centroid + rel;
  }

  // Screen-space minimum-pixel floor, applied per cell: in perspective the clip
  // w of the centre is the view-space depth, and screenRadiusPx = r*focal/w, so
  // the world radius that yields exactly u_minPx on screen is minPx*w/focal.
  vec4 clipC = u_viewProj * vec4(center, 1.0);
  float w = max(abs(clipC.w), 1e-4);
  // PERSPECTIVE SIZE. The floor used to be recomputed per cell as minPx*w/focal, so
  // screenPx = radius*focal/w cancelled w EXACTLY and every mark measured u_minPx no
  // matter how far away it was — the reference's primary depth cue was not weak here,
  // it was algebraically deleted. Anchoring the floor at the FRAMED depth u_refW
  // removes the cancellation: screenPx = u_minPx * (u_refW/w)^exp. exp == 0 restores
  // the old expression bit-for-bit, which is how categorical/facet stay unchanged.
  //
  // The clamp is load-bearing, not cosmetic: w is abs(clipC.w), so a cell BEHIND the
  // camera has w -> 0 and would otherwise expand into a screen-filling quad.
  float persp = 1.0;
  if (u_depthSizeExp > 0.0) {
    persp = clamp(pow(max(u_refW, 1e-4) / w, u_depthSizeExp), 0.55, 2.20);
  }
  float worldFloor = u_minPx * persp * w / max(u_focalPx, 1e-4);

  // Hover highlight (SPEC §PICK): the cell under the cursor is grown slightly so
  // its indigo halo reads above its neighbours.
  float hovered = (a_id == u_hoverId) ? 1.0 : 0.0;
  // Selection focus (SPEC §A1): selected cells get a steady, gentler size boost so
  // they read above the dimmed context even without the cursor on them.
  float selected = (u_hasSelection && a_selected > 0.5) ? 1.0 : 0.0;
  float boost = max(mix(1.0, 1.18, hovered), mix(1.0, 1.08, selected));
  float radius = max(u_radius, worldFloor) * boost;

  vec3 worldPos = center + (right * a_corner.x + up * a_corner.y) * radius;
  gl_Position = u_viewProj * vec4(worldPos, 1.0);

  // FACET ink pass: cull every cell outside the panel's category by pushing the quad
  // outside the clip volume (z > w). Done here, not with a fragment discard, so the
  // other ~99% of cells never reach the rasteriser.
  if (u_facetCategory >= 0 && !u_facetGhost
      && abs(a_category - float(u_facetCategory)) >= 0.5) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }

  // Projected radius in PIXELS. The fragment stage needs it to know whether a
  // feature is even resolvable at this cell's on-screen size.
  v_pxRadius = radius * u_focalPx / w;

  v_local    = a_corner;
  v_center   = center;
  v_right    = right;
  v_up       = up;
  v_viewDir  = fwd;
  v_value    = a_value;
  v_category = a_category;
  v_radius   = radius;
  v_eyeW     = w;
  v_hover    = hovered;
  v_selected = selected;
}
`;

const IMPOSTOR_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2  v_local;
in vec3  v_center;
in vec3  v_right;
in vec3  v_up;
in vec3  v_viewDir;
in float v_value;
in float v_pxRadius;
in float v_category;
in float v_radius;
in float v_hover;
in float v_selected;
in float v_eyeW;

uniform mat4      u_viewProj;
uniform sampler2D u_continuousLUT;
uniform sampler2D u_categoricalLUT;
uniform int       u_mode;        // 0 = continuous (additive), 1 = categorical (opaque)
uniform float     u_alpha;       // density-aware alpha (continuous emission scale)
uniform bool      u_hasSelection; // focus+context: dim everything that is not v_selected
uniform int       u_focusCategory; // category focus+context: -1 = none, else dim every other category
uniform bool      u_facetGhost;    // FACET ghost pass: every cell renders as dim context
uniform int       u_theme;         // 0 = dark, 1 = light (paper). Flips the categorical dim gray.
uniform float     u_refPx;         // screen radius frameStyle calibrated u_alpha against
uniform float     u_depthSizeExp;  // > 0 when the vertex stage is sizing marks by depth
uniform bool      u_peakOut;       // PEAK blend: put VALUE in .a so gl.MAX maxes the value

out vec4 fragColor;

// The one non-data light the SPEC allows: the hover halo AND the steady
// selection rim (#5B8DEF indigo) — indigo is the only non-data light.
/** Sentinel floor for PEAK mode's value channel: an unlit pixel clears to 0, and a
 *  real value of 0 must not be mistaken for one. */
const float PEAK_LO = 0.02;
const vec3 HALO = vec3(0.357, 0.553, 0.937);
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  float lensqr = dot(v_local, v_local);

  // Soft-rim AA: a ~1px feather across the silhouette (improves on Helios' hard
  // discard). In the opaque categorical pass there is no blend to feather into,
  // so we fall back to a hard cut there.
  float fw = fwidth(lensqr);

  // z of the unit sphere along the view dir (towards the viewer).
  float z = sqrt(max(1.0 - lensqr, 0.0));

  // Reconstruct the actual surface world point and write honest depth so the
  // z-buffer sorts the categorical mode correctly under perspective.
  vec3 toViewer = -v_viewDir;
  vec3 surfaceWorld = v_center + (v_right * v_local.x + v_up * v_local.y + toViewer * z) * v_radius;
  vec4 clip = u_viewProj * vec4(surfaceWorld, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;

  // View-aligned spherical shading: the normal lives in the billboard basis
  // (x=right, y=up, z=toward viewer) so the specular highlight is STABLE under
  // orbit (hardcoded view dir (0,0,1)).
  vec3 N = normalize(vec3(v_local, z));
  vec3 L = normalize(vec3(0.35, 0.55, 0.75));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float diff = max(dot(N, L), 0.0);
  // The pow(...,28) lobe is NARROWER THAN THE DISC once a cell is only a few pixels
  // across, so at typical zoom it lands as a single blown-out white pixel per cell —
  // achromatic grain that desaturates every hue in aggregate. Fade it in only where
  // the sphere is big enough to actually show a highlight. (Helios ships
  // SHADED_SPECULAR_STRENGTH_DEFAULT = 0 for the same reason.)
  float specGate = smoothstep(3.0, 8.0, v_pxRadius);
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0) * specGate;

  // Indigo rim ring on the hovered cell: brightest at the silhouette so the
  // highlight reads as a halo, not a recolour of the cell's data hue.
  float ring = smoothstep(0.45, 1.0, lensqr);
  float halo = v_hover * (0.35 + 0.65 * ring);
  // Steady selection rim: a persistent, slightly gentler version of the hover
  // halo on every selected cell so the focus set glows above the dim context.
  float selHalo = (u_hasSelection ? v_selected : 0.0) * (0.25 + 0.55 * ring);
  // True once this fragment belongs to the dimmed CONTEXT — either a non-selected
  // cell while a selection is active, OR a cell outside the focused category
  // while a category focus is active (SPEC §A1). Both funnel into the SAME dim
  // look below; the focus path never forks a new appearance.
  bool dimmed = u_facetGhost
    || (u_hasSelection && v_selected < 0.5)
    || (u_focusCategory >= 0 && abs(v_category - float(u_focusCategory)) >= 0.5);

  if (u_mode == 0) {
    // continuous: emissive glow, additively accumulated in HDR.
    if (lensqr > 1.0 + fw) discard;
    float rim = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, lensqr);
    vec3 rgb = texture(u_continuousLUT, vec2(clamp(v_value, 0.0, 1.0), 0.5)).rgb;
    // NO specular here. This branch accumulates ADDITIVELY into an HDR density
    // integral, so a specular term adds brightness that does not correspond to any
    // cell count — it inflates apparent density wherever the light happens to hit.
    //
    // Same argument, now applied to DIFFUSE. 0.65..1.00 is a 54% swing in deposited
    // weight decided by a light that is not in the data. At plate framing a mark is
    // ~2.4px wide, so that gradient is sub-pixel achromatic noise which only
    // desaturates the aggregate. Flat below ~2px; the lit sphere returns once a
    // mark is big enough to actually read as one.
    float shade = mix(1.0, 0.65 + 0.35 * diff, smoothstep(2.0, 5.0, v_pxRadius));

    // TWO channels, not one. .a is this fragment's OPTICAL DEPTH ("how much cell
    // mass is here"); .rgb is the LUT colour already weighted by it, so the resolve
    // recovers the depth-weighted mean value as rgb/a ("what value is here").
    // Packing both into rgb alone is why the plate was one hue — the resolve had to
    // invert a sum, and hdr/max(hdr) pins red to 1.0 on every lit pixel of a warm
    // map. Measured hue error against the true mean value: 0.1976 before, 0.0415 now.
    // POINT-SPREAD NORMALISATION — the price of perspective size, paid in full.
    // With depth-varying marks a near cell covers up to ~6.6x the pixels of a far
    // one. Left alone that multiplies the optical depth it deposits by the same
    // factor, and "brightness = accumulated cell mass" silently becomes
    // "brightness = mass x how close it is" — the exact corruption that rules out
    // depth-attenuated ink. Dividing by the mark's own footprint makes every cell
    // integrate to the SAME total ink: sum(rim*psf) ~= pi*u_refPx^2 at all depths,
    // so integral(tau) over any region == const * (cells in region), exactly.
    //
    // u_refPx is frameStyle's rPx, NOT u_minPx, so this corrects only the per-cell
    // deviation from the frame mean and does not double-count the global coverage
    // term that already sets u_alpha.
    //
    // The clamp: below ~0.75px radius the rasteriser's footprint takes over from the
    // analytic area pi*r^2, so compensating past it would over-boost far cells.
    float psf = 1.0;
    if (u_depthSizeExp > 0.0) {
      float effPx = max(v_pxRadius, 0.75);
      psf = (u_refPx * u_refPx) / (effPx * effPx);
    }
    float w = u_alpha * shade * rim * psf;
    vec3 tint = rgb;
    if (dimmed) {
      // focus+context: desaturate toward luminance-gray and thin the ink so
      // unselected cells recede without vanishing. No false hue.
      float lum = dot(rgb, LUMA);
      tint = mix(vec3(lum), rgb, 0.25);
      w *= 0.16;
    }
    // Indigo is NON-DATA light, so it rides in BOTH channels: the recovered hue
    // stays a convex blend of tint and HALO (never out of gamut, never brightening
    // the paper) and a highlighted cell reads at a normal ink weight rather than as
    // extra density.
    float hi = clamp(halo + selHalo, 0.0, 1.0) * rim;
    // The indigo halo is per-CELL non-data light, so it takes the same footprint
    // normalisation as the ink — otherwise a hovered near cell's halo would read
    // ~3.6x weaker relative to its own ink than a hovered far cell's.
    float aHi = u_alpha * hi * psf;
    if (u_peakOut) {
      // PEAK is gl.MAX, which is COMPONENTWISE. Maxing COLOUR is not maxing value:
      // on a light-to-dark ramp the LIGHT end maximises every channel, so the
      // componentwise max is dominated by the LOWEST-value cell. Verified against the
      // real LUT: cells {0.1,0.9} decoded to 0.100, {0.0,1.0} to 0.000, and {0.9,0.95}
      // to a colour 0.18 off the ramp entirely. So put the VALUE itself in .a and let
      // MAX max THAT; the resolve looks the colour up afterwards.
      //
      // SENTINEL: an unlit pixel clears to 0 and a legitimate value of 0 is also 0, so
      // value is carried in [PEAK_LO, 1] and anything below PEAK_LO means "no cell".
      float vv = PEAK_LO + (1.0 - PEAK_LO) * clamp(v_value, 0.0, 1.0);
      fragColor = vec4(tint * w + HALO * aHi, vv * step(0.004, rim));
    } else {
      fragColor = vec4(tint * w + HALO * aHi, w + aHi);
    }
  } else {
    // categorical: opaque, lit, depth-sorted. Hard silhouette (no blend).
    if (lensqr > 1.0) discard;
    vec3 rgb = texture(u_categoricalLUT, vec2((mod(v_category, 256.0) + 0.5) / 256.0, 0.5)).rgb;
    // LIGHT (paper): keep each cell close to its FLAT legend hue so the vis matches
    // the legend swatch — high ambient (0.78), gentle shading, and NO white
    // specular (on white paper a white highlight washes the hue toward the bg and
    // the cell no longer reads as its CORE_24 colour). DARK: the original lit
    // sphere with a white highlight, which reads fine against near-black.
    vec3 lit = (u_theme == 1)
      ? rgb * (0.78 + 0.22 * diff)
      : rgb * (0.28 + 0.72 * diff) + vec3(spec) * 0.12;
    if (dimmed) {
      // focus+context: a desaturated gray, keeping just enough spherical shading
      // to read as form, never a saturated data hue. DARK theme → ~18% lum so
      // dimmed cells sink into the near-black canvas; LIGHT theme → ~82% lum so
      // they recede into the paper instead.
      float dimLum = (u_theme == 1) ? 0.82 : 0.18;
      lit = vec3(dimLum) * (0.55 + 0.45 * diff) + vec3(spec) * 0.12;
    } else {
      // steady selection rim on the kept (selected) cells.
      lit = mix(lit, HALO, clamp(selHalo, 0.0, 0.85));
    }
    // hover halo always stacks on top.
    lit = mix(lit, HALO, clamp(halo, 0.0, 0.85));
    fragColor = vec4(lit, 1.0);
  }
}
`;

/*
 * Eye-Dome Lighting.
 *
 * Kernel SSAO is the wrong tool for a point cloud: it samples a hemisphere around a
 * surface normal, and 453k sphere impostors have no coherent surface to orient
 * against. EDL (the technique Potree uses for exactly this) instead shades DEPTH
 * DISCONTINUITIES — for each pixel it compares log-depth against a ring of
 * neighbours and darkens wherever the pixel sits in front of nothing. That reads as
 * contact shading and silhouette definition, which is what makes a dense cloud look
 * like volume rather than confetti.
 *
 * One full-screen pass over a depth texture. No sample kernel, no noise texture, no
 * blur pass, and — importantly for a figure — completely deterministic.
 */
const EDL_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_color;
uniform sampler2D u_depth;
uniform vec2  u_texel;     // 1 / resolution
uniform float u_radiusPx;  // neighbour ring radius, in pixels
uniform float u_strength;  // 0 = off
out vec4 fragColor;

// Depth buffer is non-linear; comparing raw values exaggerates the far field.
// log(linear eye depth) is the standard EDL response domain.
float logDepth(vec2 uv) {
  float d = texture(u_depth, uv).r;
  // Background (cleared to 1.0) must not pull neighbours dark — push it far away.
  if (d >= 0.9999) return 40.0;
  return log(max(d, 1e-6));
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  vec4 src = texture(u_color, uv);
  if (u_strength <= 0.0) { fragColor = src; return; }

  float z = logDepth(uv);
  if (z >= 40.0) { fragColor = src; return; }   // leave the background alone

  // 8-neighbour ring. Sum of positive depth differences: how much this pixel
  // stands proud of what surrounds it.
  vec2 r = u_texel * u_radiusPx;
  float sum = 0.0;
  sum += max(0.0, z - logDepth(uv + vec2( r.x, 0.0)));
  sum += max(0.0, z - logDepth(uv + vec2(-r.x, 0.0)));
  sum += max(0.0, z - logDepth(uv + vec2( 0.0, r.y)));
  sum += max(0.0, z - logDepth(uv + vec2( 0.0,-r.y)));
  sum += max(0.0, z - logDepth(uv + vec2( r.x, r.y) * 0.7071));
  sum += max(0.0, z - logDepth(uv + vec2(-r.x, r.y) * 0.7071));
  sum += max(0.0, z - logDepth(uv + vec2( r.x,-r.y) * 0.7071));
  sum += max(0.0, z - logDepth(uv + vec2(-r.x,-r.y) * 0.7071));

  float shade = exp(-u_strength * sum * 300.0);
  fragColor = vec4(src.rgb * shade, src.a);
}
`;

const TONEMAP_VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // fullscreen triangle from gl_VertexID — no buffer needed.
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                float((gl_VertexID & 2) << 1) - 1.0);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const TONEMAP_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_hdr;
uniform float u_exposure;
uniform int   u_theme;   // 0 = dark (glow over near-black), 1 = light (ink on paper)
uniform int   u_peak;    // 1 = the HDR pass used MAX blending, not additive
uniform float u_peakNorm; // peak-mode: the max emission ONE cell can deposit
uniform float u_tauMax;   // declared ceiling of the density axis
uniform float u_inkK;     // total optical strength at the ceiling
uniform sampler2D u_lut;  // the continuous colormap, for PEAK's value -> colour lookup
uniform vec3 u_paper;     // the substrate; see core/substrate.ts
out vec4 fragColor;

// The substrate, supplied by the CPU so the resolve, the GL clear and the composited
// key cannot drift apart. See core/substrate.ts.
const float PEAK_LO = 0.02;

// Transmittance of ONE unit of optical depth: how much of the paper a single
// unit-thickness layer of the LUT hue removes. 1.0 would make the hue fully
// opaque at tau = 1; 0.88 leaves a little paper showing through a single cell.
const float INK = 0.88;
const vec3 LUMA  = vec3(0.2126, 0.7152, 0.0722);

void main() {
  // The accumulation buffer carries TWO things now: .a is OPTICAL DEPTH (how much
  // cell mass sits along this ray) and .rgb is LUT colour already weighted by that
  // depth. Their ratio is the depth-weighted MEAN cell value — the thing the
  // colorbar claims to show. The old code had to guess the colour back out of the
  // SUM via hdr/max(hdr), which pins the red channel of any warm map to exactly
  // 1.0 on every lit pixel (measured plate-wide R variance: 0) and throws the
  // value encoding away before tonemapping even starts.
  vec4  acc = texture(u_hdr, v_uv);
  float tau = acc.a;
  vec3  hue = acc.a > 1e-5 ? clamp(acc.rgb / acc.a, 0.0, 1.0) : vec3(0.0);
  if (u_peak == 1) {
    // PEAK: .a now carries the MAXIMUM VALUE over the cells on this ray (see
    // IMPOSTOR_FRAG's u_peakOut branch), not a weight — because gl.MAX on COLOUR
    // maxes componentwise and therefore reports the lowest-value cell on any
    // light-to-dark ramp. Look the colour up from the value instead of trying to
    // invert a componentwise max, which is not invertible.
    float vmax = (acc.a - PEAK_LO) / (1.0 - PEAK_LO);
    if (acc.a < PEAK_LO * 0.5) {
      // no cell on this ray
      fragColor = vec4(u_theme == 1 ? u_paper : vec3(0.0), 1.0);
      return;
    }
    hue = texture(u_lut, vec2(clamp(vmax, 0.0, 1.0), 0.5)).rgb;
    // PRESENCE, not count: peak deliberately draws every occupied pixel at one ink
    // weight, so the density axis does not apply and the key must not claim it.
    tau = 1.0;
  }
  tau *= u_exposure;

  if (u_theme == 1) {
    // LIGHT (paper): BEER-LAMBERT. Overlapping ink MULTIPLIES transmittance, so N
    // cells over one pixel attenuate the paper N times. This is what a printed
    // halftone does, and it repairs both failures of mix(paper, hue*0.45, amt):
    //   * mixing toward off-white paper is adding WHITE to a pigment, so chroma
    //     FELL as density rose — median lit-pixel chroma 0.212, median colour
    //     rgb(173,113,128), the washed mauve. Here chroma RISES with density.
    //   * ink was capped at 0.45 of the hue, so the darkest possible pixel sat at
    //     ~0.19 luminance. pow() has no such ceiling: cores reach paper-black.
    // LUMINANCE LOCK. Plain Beer-Lambert made the per-unit decay rate a function of
    // HUE, so value and density interacted multiplicatively and the map became
    // many-to-one: measured on this exact shader, 157 (value,tau) pairs differing by
    // more than 0.20 in value collapsed within one JND (worst dE76 0.15), and the
    // density axis spanned 2.5 L* at value 0 but 65.9 L* at value 1. No key of any
    // dimensionality can invert a many-to-one map, so the fix has to be here, not in
    // the legend.
    //
    // Split absorption into a hue-free STRENGTH and a luminance-normalised DIRECTION:
    // strength carries density, the chromatic ratio that is left carries value.
    vec3 a  = -log(max(mix(vec3(1.0), hue, INK), vec3(1e-4)));
    vec3 an = a / max(dot(LUMA, a), 1e-4);
    // LOG density axis with a FIXED, DECLARED ceiling. tau spans p50 0.55 -> p99 31.95
    // (58x), so a linear ink axis spends nearly all its range below p90. Bounded to
    // [0,1]: this SATURATES the display, it does not truncate the count.
    float d  = min(log(1.0 + max(tau, 0.0)) / log(1.0 + u_tauMax), 1.0);
    vec3 c   = u_paper * exp(-d * u_inkK * an);
    // Lock luminance to the hue-free curve, so L* = f(density) exactly.
    float yt = dot(LUMA, u_paper) * exp(-d * u_inkK);
    c *= yt / max(dot(LUMA, c), 1e-6);
    // Out of gamut: desaturate toward this pixel's own (correct) luminance rather
    // than clipping a channel, which would rotate the hue.
    float ov = max(max(c.r, max(c.g, c.b)), 1.0);
    c = mix(c, vec3(yt), 1.0 - 1.0 / ov);
    fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  } else {
    // DARK: the exact dual of the light lock, and it needs the same treatment for
    // the same reason. hue*amt puts VALUE into luminance (via the ramp's own
    // lightness — ylorrd spans 72.9 L*, magma 97.8) on top of DENSITY, so the map is
    // many-to-one here too and neither channel is independently readable.
    //
    // Emission over black: normalise the hue to unit luma so it is a pure DIRECTION
    // carrying value, and let a hue-free strength carry density.
    // LUMA FLOOR — a bound on a failure mode that this dataset does not exercise.
    // Absorption (light theme) composes multiplicatively without bound, so locking
    // luminance there costs nothing. EMISSION is bounded by the display: an
    // intrinsically dark hue IS low luminance (ylorrd's #800026 has luma 0.117), so
    // dividing by it would demand (4.3, 0, 1.3) and the gamut guard below would
    // bleach it to pale pink — losing exactly the chroma that carries value.
    //
    // MEASURED: on this data the floor never fires and changes nothing (core
    // saturation 0.432 with and without it, to three decimals). hue here is the
    // depth-WEIGHTED MEAN value, and dense pixels average to mid-ramp (median 0.44,
    // luma 0.444) rather than to the dark end. The floor is kept as a bound for data
    // whose mean values DO reach the dark end, where a bounded under-report of
    // density beats a bleached pixel — not because it improves this plate.
    const float LUMA_FLOOR = 0.28;
    vec3  hn = hue / max(dot(LUMA, hue), LUMA_FLOOR);
    float d  = min(log(1.0 + max(tau, 0.0)) / log(1.0 + u_tauMax), 1.0);
    // Saturating emission with the SAME declared ceiling the light branch uses, so a
    // plate and its dark-theme twin encode density identically.
    float yt = 1.0 - exp(-d * u_inkK);
    vec3  c  = hn * yt;
    // Out of gamut: desaturate toward this pixel's own luminance rather than clipping
    // a channel, which would rotate the hue and silently change the reported value.
    float ov = max(max(c.r, max(c.g, c.b)), 1.0);
    c = mix(c, vec3(yt), 1.0 - 1.0 / ov);
    fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
}
`;

// ---------------------------------------------------------------------------
// Density underlay (SPEC §P2.5): a screen-space GPU-KDE field beneath the cloud.
//   SPLAT  → additive soft-gaussian points into a LOW-RES rgba16f target.
//   BLUR   → separable Gaussian (KDE smoothing), 2 fullscreen ping-pong passes.
//   COMPOSITE → tone the field, map it to a DIM quiet underlay over #0B0E14,
//               + optional thin iso-density contours, scaled by semantic zoom.
// The field is honest chrome: a desaturated cool backdrop, capped well below the
// cells, never inventing color (indigo stays reserved for selection).
// ---------------------------------------------------------------------------

// SPLAT: one gl.POINTS vertex per cell. Reuses a_center / a_posTo (the morph
// pair) at divisor 0 so drawArrays(POINTS) deposits one soft kernel per cell.
const DENSITY_SPLAT_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 a_center;     // per-cell position (world) — morph SOURCE
in vec3 a_posTo;      // per-cell morph TARGET position
uniform mat4  u_viewProj;
uniform float u_morphFactor; // matches the impostor morph so the field tracks it
uniform float u_pointSize;   // device px (low-res) of each splat sprite
void main() {
  vec3 center = mix(a_center, a_posTo, smoothstep(0.0, 1.0, u_morphFactor));
  gl_Position = u_viewProj * vec4(center, 1.0);
  gl_PointSize = u_pointSize;
}
`;

const DENSITY_SPLAT_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform float u_weight; // per-cell deposit weight (1.0)
out vec4 fragColor;
void main() {
  // soft radial gaussian across the point sprite (gl_PointCoord in [0,1]^2).
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;            // 0 at centre, 1 at sprite edge
  float g = exp(-r2 * 2.5);              // gaussian falloff
  fragColor = vec4(vec3(g * u_weight), 1.0);
}
`;

// BLUR: separable 9-tap Gaussian. u_step is the per-tap uv offset (direction ×
// texel × spread); two passes (H then V) ping-pong a smooth kernel-density field.
const DENSITY_BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform vec2 u_step;
out vec4 fragColor;
void main() {
  float w0 = 0.227027;
  float w1 = 0.1945946;
  float w2 = 0.1216216;
  float w3 = 0.054054;
  float w4 = 0.016216;
  vec3 sum = texture(u_field, v_uv).rgb * w0;
  sum += (texture(u_field, v_uv + u_step) + texture(u_field, v_uv - u_step)).rgb * w1;
  sum += (texture(u_field, v_uv + u_step * 2.0) + texture(u_field, v_uv - u_step * 2.0)).rgb * w2;
  sum += (texture(u_field, v_uv + u_step * 3.0) + texture(u_field, v_uv - u_step * 3.0)).rgb * w3;
  sum += (texture(u_field, v_uv + u_step * 4.0) + texture(u_field, v_uv - u_step * 4.0)).rgb * w4;
  fragColor = vec4(sum, 1.0);
}
`;

// COMPOSITE: drawn fullscreen to SCREEN (blend OFF — it writes the full backdrop
// = canvas + dim field, so it doubles as the colour clear under the cloud). The
// point passes then draw OVER it (continuous adds glow; categorical covers gaps).
const DENSITY_COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform float u_strength;   // semantic-zoom 0..1 (1 = zoomed out, field dominant)
uniform float u_gain;       // tone sensitivity (adapts to point density)
uniform float u_peak;       // max underlay intensity (kept low — never out-glows)
uniform int   u_contours;   // 1 = add thin iso-density lines
uniform vec3  u_canvas;    // the substrate; see core/substrate.ts
uniform int   u_theme;      // 0 = dark, 1 = light (paper)
out vec4 fragColor;


// desaturated cool slate — quiet "territory" chrome, NOT a data hue (no indigo).
// DARK: a brighter slate ADDED over near-black. LIGHT: a darker slate SUBTRACTED
// from the paper (negative tint) so the terrain reads on white.
const vec3 FIELD_TINT_DARK  = vec3(0.17, 0.21, 0.31);
const vec3 LINE_TINT_DARK   = vec3(0.40, 0.46, 0.58);
const vec3 FIELD_TINT_LIGHT = vec3(-0.13, -0.11, -0.16);
const vec3 LINE_TINT_LIGHT  = vec3(-0.30, -0.26, -0.34);

void main() {
  float d = texture(u_field, v_uv).r;
  // tone for dynamic range: a saturating curve so dense regions read as terrain
  // while sparse space stays near the canvas. exp form is scale-robust.
  float t = 1.0 - exp(-d * u_gain);

  bool light = (u_theme == 1);
  vec3 canvasCol = u_canvas;
  vec3 fieldTint = light ? FIELD_TINT_LIGHT : FIELD_TINT_DARK;
  vec3 lineTint  = light ? LINE_TINT_LIGHT  : LINE_TINT_DARK;

  float intensity = t * u_peak * u_strength;
  vec3 col = canvasCol + fieldTint * intensity;

  if (u_contours == 1) {
    // thin iso lines at a few quantile-ish thresholds of the toned field.
    float aa = fwidth(t) * 1.5 + 1e-4;
    float line = 0.0;
    line = max(line, 1.0 - smoothstep(0.0, aa, abs(t - 0.30)));
    line = max(line, 1.0 - smoothstep(0.0, aa, abs(t - 0.52)));
    line = max(line, 1.0 - smoothstep(0.0, aa, abs(t - 0.74)));
    col += lineTint * line * u_strength * 0.16;
  }

  fragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface FrameStyle {
  radius: number; // world-space base sphere radius
  alpha: number; // density-aware emission / coverage alpha
  /** The screen radius (device px) the alpha calibration assumed. The PSF
   *  normalisation divides by this, so per-cell size variation is corrected
   *  WITHOUT double-counting frameStyle's existing global coverage term. */
  refPx: number;
}

/* Minimum ink radius, in CSS px, for a facet panel's focused type. Higher than the
 * normal floor because a panel is a fraction of the viewport: at the screen floor a
 * ~900-cell type scaled to a 1/8-width panel disappears, and an empty panel reads as
 * "this type is absent" rather than "this type is rare". */
/** The unscaled screen-space radius floor, in CSS px. setMarkScale multiplies it. */
const BASE_MIN_PX = 1.2;

const FACET_INK_MIN_PX = 2.2;

export class Renderer3D {
  readonly device: Device3D;
  private gl: WebGL2RenderingContext;

  private impostor: ReturnType<Device3D["createProgram"]>;
  private tonemap: ReturnType<Device3D["createProgram"]>;
  private densitySplat: ReturnType<Device3D["createProgram"]>;
  private densityBlur: ReturnType<Device3D["createProgram"]>;
  private densityComposite: ReturnType<Device3D["createProgram"]>;
  /** Eye-dome lighting resolve pass (categorical mode). */
  private edl: ReturnType<Device3D["createProgram"]>;
  private pickPass: PickPass;

  private continuousLUT: WebGLTexture;
  private categoricalLUT: WebGLTexture;

  // geometry / instance buffers
  private cornerBuffer: WebGLBuffer;
  private centerBuffer: WebGLBuffer | null = null;
  private posToBuffer: WebGLBuffer | null = null; // morph target positions (a_posTo)
  private valueBuffer: WebGLBuffer | null = null;
  private categoryBuffer: WebGLBuffer | null = null;
  private idBuffer: WebGLBuffer | null = null; // a_id (uint cell_id) — pick + hover
  private selectedBuffer: WebGLBuffer | null = null; // a_selected (float 0/1) — focus+context
  private centroidBuffer: WebGLBuffer | null = null; // a_centroid (per-category mean) — idle spin pivot
  private vao: WebGLVertexArrayObject | null = null;
  /** Splat VAO: a_center / a_posTo at divisor 0 (one gl.POINTS vertex per cell)
   *  so drawArrays(POINTS) deposits one density kernel per cell. Shares the same
   *  center/posTo buffers as the impostor VAO — no extra copy. */
  private densityVAO: WebGLVertexArrayObject | null = null;
  private emptyVAO: WebGLVertexArrayObject;

  /** Density underlay mode (SPEC §P2.5). "off" = byte-for-byte the original
   *  point-only behaviour (all density passes skipped). */
  private densityMode: "off" | "underlay" | "contours" = "off";
  /** Tunables for the underlay's quiet-chrome look (kept dim by design). */
  private densityPeak = 0.6; // max underlay intensity scalar (× FIELD_TINT)
  private densityGainScale = 0.22; // tone sensitivity ÷ mean splat density
  private densityPointPx = 3.0; // splat sprite size at low-res (device px)
  private densityBlurSpread = 2.0; // Gaussian tap spacing (low-res texels)

  /** Per-instance selection flags (1 = selected). Mutated in place by
   *  {@link setSelection} and re-uploaded into {@link selectedBuffer}. Default
   *  all-1 with {@link hasSelection} false → the shader shows every cell normally. */
  private selectedArray: Float32Array | null = null;
  /** True once a selection is active (drives focus+context dimming in the shader). */
  private hasSelection = false;
  /** Stable cell_id → instance index, built lazily from the data's ids the first
   *  time a selection is set. Reset whenever {@link setData} swaps the cloud. */
  private idToIndex: Map<number, number> | null = null;
  private idsRef: Uint32Array | null = null;

  /** Currently hovered cell_id, or {@link NO_HOVER}. Set via {@link setHoverId};
   *  drives the indigo halo + slight per-cell scale in the impostor shaders. */
  private hoverId = NO_HOVER;

  /** Focused categorical index, or -1 for none. Set via {@link setFocusCategory};
   *  drives the category focus+context dimming (cells of other categories recede
   *  through the SAME dim path as a selection). Independent of {@link setSelection}. */
  private focusCategory = -1;

  /** FACET mode: the category the ink pass draws, or -1 when not facetting.
   *  Set only for the duration of {@link renderFacet} — never persists. */
  /** Projected occupancy of the cloud, as a power law in pixel size:
   *  fill(side) ~= fillA * (side / fillSide) ** fillExp. Measured from the voxel
   *  grid at load; deterministic, no readback, so two exports agree. */
  private fillA = 1;
  private fillSide = 1;
  private fillExp = 0;

  private facetCategory = -1;
  /** FACET mode: true during the ghost pass, forcing every cell to dim context. */
  private facetGhost = false;

  /** Exact frame state the last {@link render} drew with, so {@link pick}
   *  rasterizes the id pass to match the screen pixel-for-pixel. */
  private lastFrame: {
    u: Camera3DUniforms;
    radius: number;
    focalPx: number;
    minPx: number;
    morphFactor: number;
    /** The perspective-size state the frame was drawn with. pick() must re-raster
     *  with the SAME values or the id pass and the screen disagree. */
    refW: number;
    depthSizeExp: number;
  } | null = null;

  /** Layout cross-fade in [0,1]: 0 = source (a_center), 1 = target (a_posTo).
   *  Host advances this on its RAF clock in lockstep with the camera transition.
   *  Inert until {@link setMorphTarget} uploads a distinct target. */
  morphFactor = 0;

  /** Per-cluster idle spin (SPEC "living galaxy"): each category rotates about
   *  its OWN centroid by {@link spinAngle} radians around {@link spinAxis}. The
   *  host advances spinAngle on the idle clock; setData resets it to 0 so a new
   *  or just-morphed layout starts un-spun. */
  spinAngle = 0;
  spinAxis: [number, number, number] = [0, 1, 0];

  private count = 0;
  private bounds: number[] = [-1, -1, -1, 1, 1, 1];
  private baseRadius = 0.01; // world units, derived in setData()
  /** Scales accumulated OPTICAL DEPTH before the resolve — i.e. how much ink one
   *  unit of cell mass lays down. Calibrated against the corrected coverage model
   *  (see frameStyle): on umap3d this puts tau at p10/p50/p90/p99 =
   *  0.18/0.55/4.02/31.95, giving median lit-pixel chroma 0.388 and a luminance
   *  IQR of 0.465 (0.212 / 0.281 before). Turn THIS if the plate reads too light
   *  or too heavy; do not re-tune the coverage model for it. */
  private exposure = 3.0;
  /** Declared ceiling of the density axis, in optical depth. The plate's tau runs
   *  p50 0.55 -> p99 31.95, so 32 puts the ceiling at the measured p99: densities
   *  above it SATURATE the display rather than being truncated from the count, and
   *  the key says so. Declared, not derived — a per-frame percentile would be a GPU
   *  readback and two exports of the same data could then disagree. */
  private tauMax = 32.0;
  /** Total optical strength at that ceiling: the darkest reachable pixel is exactly
   *  PAPER*exp(-inkK). Calibrated so it stays at or above the colormap's own darkest
   *  colour (ylorrd #800026 is L* 25.9), which is what keeps every plate pixel
   *  inside the key's gamut BY CONSTRUCTION rather than by luck. */
  private inkK = 1.5;
  /** Optical depth deposited by exactly ONE cell at the reference footprint. */
  private tauPerCell = 0;
  /**
   * How the continuous pass accumulates.
   *   "sum"  — additive: the buffer measures CELL MASS along the ray. Dense cores
   *            saturate, which is honest about density but loses hue at the peak.
   *   "peak" — gl.MAX: the buffer holds the single brightest contributor. Order
   *            independent, cannot saturate, needs no weight buffer, and answers
   *            "what is the strongest value here" rather than "how much is here".
   */
  private blendMode: "sum" | "peak" = "sum";

  /** Eye-dome lighting strength. 0 disables the pass entirely. */
  private edlStrength = 0.35;
  /** Neighbour ring radius in pixels for the EDL response. */
  private edlRadiusPx = 1.4;

  /** Active theme (SPEC §FEATURE 1). "dark" (default) is byte-for-byte today's
   *  look; "light" flips the canvas clear + the tonemap composite (ink-on-paper),
   *  the categorical dim gray, and the density underlay slate tint. */
  private theme: "dark" | "light" = "dark";

  /** Multiplier on the data-derived sphere radius (caller-tunable). */
  radiusScale = 1.0;
  /** Screen-space minimum radius floor in CSS px (scaled by dpr at draw time). */
  minPxFloor = BASE_MIN_PX;
  private markScale = 1;
  /** Exponent on the per-cell perspective size term. 1 = true perspective (the
   *  reference's own depth cue); 0 = the old constant screen floor. Continuous path
   *  only — setImpostorUniforms forces 0 for categorical/facet so those stay
   *  bit-identical. */
  depthSizeExp = 1.0;
  /** Frame-constant perspective anchor + reference mark size, set by render() /
   *  renderFacet() before any setImpostorUniforms call. */
  private refW = 1;
  private refPx = 1;

  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    // Throws Device3DUnavailable when WebGL2 is missing — the caller should then
    // fall back to the 2D regl PointRenderer.
    this.device = new Device3D(canvas);
    this.gl = this.device.gl;

    this.impostor = this.device.createProgram(IMPOSTOR_VERT, IMPOSTOR_FRAG);
    this.tonemap = this.device.createProgram(TONEMAP_VERT, TONEMAP_FRAG);
    this.densitySplat = this.device.createProgram(DENSITY_SPLAT_VERT, DENSITY_SPLAT_FRAG);
    this.densityBlur = this.device.createProgram(TONEMAP_VERT, DENSITY_BLUR_FRAG);
    this.densityComposite = this.device.createProgram(TONEMAP_VERT, DENSITY_COMPOSITE_FRAG);
    this.edl = this.device.createProgram(TONEMAP_VERT, EDL_FRAG);
    this.pickPass = new PickPass(this.device);

    this.continuousLUT = this.makeLUT(buildContinuousLUT("magma"), true);
    this.categoricalLUT = this.makeLUT(buildCategoricalLUT(), false);

    // 4-vertex TRIANGLE_STRIP unit quad in [-1,1]^2.
    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.cornerBuffer = this.device.createBuffer(corners);

    const empty = this.gl.createVertexArray();
    if (!empty) throw new Error("renderer3d: createVertexArray failed");
    this.emptyVAO = empty;
  }

  /** Whether a WebGL2 device was obtained (always true if construction did not
   *  throw; exposed for symmetry with main.ts's probe-based branch). */
  get available(): boolean {
    return this.device.caps.webgl2;
  }

  private makeLUT(data: Uint8Array, linear: boolean): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("renderer3d: createTexture (LUT) failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /** Upload a 3D PointData (dims must be 3) and (re)build the instanced VAO. */
  setData(data: PointData): void {
    if (data.dims !== 3) {
      throw new Error(`renderer3d.setData expects dims:3, got dims:${data.dims}`);
    }
    const gl = this.gl;
    this.count = data.count;
    this.bounds = data.bounds.length >= 6 ? data.bounds : [-1, -1, -1, 1, 1, 1];

    // categories arrive as Uint16 — float-ify for the attribute path.
    const catF = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) catF[i] = data.categories[i];

    // New data resets any in-flight morph: both source and target start equal,
    // so morphFactor is inert until a fresh setMorphTarget() uploads a target.
    this.morphFactor = 0;
    // ...and resets the per-cluster idle spin so a fresh/just-morphed cloud (with
    // new centroids) starts un-spun — no jump when the positions/centroids change.
    this.spinAngle = 0;

    // (re)allocate instance buffers.
    if (this.centerBuffer) gl.deleteBuffer(this.centerBuffer);
    if (this.posToBuffer) gl.deleteBuffer(this.posToBuffer);
    if (this.valueBuffer) gl.deleteBuffer(this.valueBuffer);
    if (this.categoryBuffer) gl.deleteBuffer(this.categoryBuffer);
    if (this.idBuffer) gl.deleteBuffer(this.idBuffer);
    if (this.selectedBuffer) gl.deleteBuffer(this.selectedBuffer);
    if (this.centroidBuffer) gl.deleteBuffer(this.centroidBuffer);
    // cast normalizes the typed-array's ArrayBufferLike generic to the DOM
    // BufferSource (ArrayBuffer-backed) the device API expects — no copy.
    this.centerBuffer = this.device.createBuffer(data.positions as unknown as BufferSource);
    // a_posTo defaults to a COPY of the source positions: with target==source the
    // mix() is identity at any morphFactor, so the morph stays inert until
    // setMorphTarget() overwrites it. STREAM_DRAW: it is re-uploaded per morph.
    this.posToBuffer = this.device.createBuffer(
      data.positions.slice() as unknown as BufferSource,
      gl.ARRAY_BUFFER,
      gl.DYNAMIC_DRAW,
    );
    this.valueBuffer = this.device.createBuffer(data.values as unknown as BufferSource);
    this.categoryBuffer = this.device.createBuffer(catF);
    // a_id: the stable Uint32 cell_id, read as an INTEGER attribute (no float
    // coercion) by both the impostor (hover compare) and the pick program.
    this.idBuffer = this.device.createBuffer(data.ids as unknown as BufferSource);

    // a_selected: default all-1 (no selection). DYNAMIC_DRAW — re-uploaded on
    // every setSelection (cheap at ~453k floats). New data clears any selection
    // and the stale id→index map so it rebuilds against the fresh ids.
    this.selectedArray = new Float32Array(data.count).fill(1);
    this.selectedBuffer = this.device.createBuffer(
      this.selectedArray as unknown as BufferSource,
      gl.ARRAY_BUFFER,
      gl.DYNAMIC_DRAW,
    );
    this.hasSelection = false;
    this.idToIndex = null;
    this.idsRef = data.ids;

    // a_centroid: per-category MEAN of the source positions, then scattered so
    // each cell carries ITS category's centroid (the idle-spin pivot). One O(count)
    // pass to sum per category, a second to fill. Categories are small (~48), so
    // the sum maps stay tiny. Built from a_center (the un-morphed source); on a
    // morph commit setData re-runs against the new resident layout's positions.
    const posArr = data.positions;
    const sums = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < data.count; i++) {
      const cat = data.categories[i];
      const o = i * 3;
      const s = sums.get(cat);
      if (s) {
        s[0] += posArr[o];
        s[1] += posArr[o + 1];
        s[2] += posArr[o + 2];
        s[3] += 1;
      } else {
        sums.set(cat, [posArr[o], posArr[o + 1], posArr[o + 2], 1]);
      }
    }
    const means = new Map<number, [number, number, number]>();
    for (const [cat, s] of sums) {
      const inv = s[3] > 0 ? 1 / s[3] : 0;
      means.set(cat, [s[0] * inv, s[1] * inv, s[2] * inv]);
    }
    const centroidArr = new Float32Array(data.count * 3);
    for (let i = 0; i < data.count; i++) {
      const m = means.get(data.categories[i]);
      const o = i * 3;
      if (m) {
        centroidArr[o] = m[0];
        centroidArr[o + 1] = m[1];
        centroidArr[o + 2] = m[2];
      }
    }
    this.centroidBuffer = this.device.createBuffer(centroidArr);

    if (this.vao) gl.deleteVertexArray(this.vao);
    const a = this.impostor.attribs;
    this.vao = this.device.createVAO([
      { location: a.a_corner, buffer: this.cornerBuffer, size: 2, divisor: 0 },
      { location: a.a_center, buffer: this.centerBuffer, size: 3, divisor: 1 },
      { location: a.a_posTo, buffer: this.posToBuffer, size: 3, divisor: 1 },
      { location: a.a_value, buffer: this.valueBuffer, size: 1, divisor: 1 },
      { location: a.a_category, buffer: this.categoryBuffer, size: 1, divisor: 1 },
      {
        location: a.a_id,
        buffer: this.idBuffer,
        size: 1,
        type: gl.UNSIGNED_INT,
        integer: true,
        divisor: 1,
      },
      { location: a.a_selected, buffer: this.selectedBuffer, size: 1, divisor: 1 },
      { location: a.a_centroid, buffer: this.centroidBuffer, size: 3, divisor: 1 },
    ]);

    // Density splat VAO: same center/posTo buffers, but divisor 0 — each cell is
    // ONE gl.POINTS vertex (drawArrays(POINTS, 0, count)), not an instanced quad.
    if (this.densityVAO) gl.deleteVertexArray(this.densityVAO);
    const ds = this.densitySplat.attribs;
    this.densityVAO = this.device.createVAO([
      { location: ds.a_center, buffer: this.centerBuffer, size: 3, divisor: 0 },
      { location: ds.a_posTo, buffer: this.posToBuffer, size: 3, divisor: 0 },
    ]);

    // Hand the SAME buffers to the pick pass so it shares the cloud (one extra
    // VAO, no second copy). New data clears any stale hover.
    this.hoverId = NO_HOVER;
    this.pickPass.setData({
      cornerBuffer: this.cornerBuffer,
      centerBuffer: this.centerBuffer,
      posToBuffer: this.posToBuffer,
      idBuffer: this.idBuffer,
      centroidBuffer: this.centroidBuffer,
      count: data.count,
    });

    // World-space base radius from the LOCAL inter-cell spacing. A global
    // bounding-box estimate — cbrt(bboxVol/count) — badly overestimates for
    // clustered embeddings: the empty space between clusters dominates the box,
    // inflating the spacing ~5× so every sphere comes out far too big (very
    // visible in umap3d, where cells balloon into overlapping bubbles when you
    // zoom in). Instead bin points into a coarse grid and take the count-weighted
    // MEDIAN of per-occupied-cell spacing, which reflects the dense regions where
    // cells actually sit and ignores the void between clusters.
    const [minX, minY, minZ, maxX, maxY, maxZ] = this.bounds;
    const ex = Math.max(1e-6, maxX - minX);
    const ey = Math.max(1e-6, maxY - minY);
    const ez = Math.max(1e-6, maxZ - minZ);
    const G = 64;
    const cellVol = (ex / G) * (ey / G) * (ez / G);
    const counts = new Map<number, number>();
    const pos = data.positions;
    for (let i = 0; i < data.count; i++) {
      const gx = Math.min(G - 1, (((pos[i * 3] - minX) / ex) * G) | 0);
      const gy = Math.min(G - 1, (((pos[i * 3 + 1] - minY) / ey) * G) | 0);
      const gz = Math.min(G - 1, (((pos[i * 3 + 2] - minZ) / ez) * G) | 0);
      const key = (gx * G + gy) * G + gz;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Projected occupancy at two octaves of the SAME grid (G and G/4), so
    // frameStyle can ask "what fraction of the box does this cloud cover at the
    // current pixel size". Averaged over all three axis projections so the estimate
    // does not depend on which way the camera happens to be looking.
    const projFill = (div: number): number => {
      const g = G / div;
      const xy = new Set<number>();
      const xz = new Set<number>();
      const yz = new Set<number>();
      for (const key of counts.keys()) {
        const kz = key % G;
        const ky = ((key / G) | 0) % G;
        const kx = (key / (G * G)) | 0;
        const a = (kx / div) | 0;
        const b = (ky / div) | 0;
        const c = (kz / div) | 0;
        xy.add(a * g + b);
        xz.add(a * g + c);
        yz.add(b * g + c);
      }
      return (xy.size + xz.size + yz.size) / (3 * g * g);
    };
    const sideMean = (ex + ey + ez) / 3;
    const f1 = Math.max(1e-4, projFill(1));
    const f4 = Math.max(1e-4, projFill(4));
    this.fillSide = sideMean / G;
    this.fillA = f1;
    this.fillExp = Math.max(0, Math.log(f4 / f1) / Math.log(4));

    const occupied: Array<{ s: number; n: number }> = [];
    for (const n of counts.values()) occupied.push({ s: Math.cbrt(cellVol / n), n });
    occupied.sort((a, b) => a.s - b.s);
    let acc = 0;
    const half = data.count / 2;
    let medianSpacing = occupied.length ? occupied[occupied.length - 1].s : 1;
    for (const c of occupied) {
      acc += c.n;
      if (acc >= half) {
        medianSpacing = c.s;
        break;
      }
    }
    // a sphere ~0.45 of the local spacing → neighbours nearly touch without
    // fusing into a solid blob. The per-frame min-px floor still rescues rare
    // cells; the max-px ceiling (vertex shader) caps them when zoomed right in.
    this.baseRadius = Math.max(1e-6, medianSpacing * 0.45);
  }

  /**
   * Upload the morph TARGET positions (SPEC §MORPH). `positions` is a stride-3
   * Float32Array already aligned into the CURRENT data's instance order via the
   * cell_id→index join (and z-lifted for a 2D target). Pass `null` to clear the
   * target back to the source (morph becomes inert). Sets `morphFactor` to 0; the
   * host then animates it to 1 to fly cells to the new layout.
   */
  setMorphTarget(positions: Float32Array | null): void {
    if (!this.posToBuffer || !this.centerBuffer) return;
    this.morphFactor = 0;
    if (!positions) return;
    const need = this.count * 3;
    if (positions.length !== need) {
      throw new Error(
        `renderer3d.setMorphTarget expects ${need} floats (count*3), got ${positions.length}`,
      );
    }
    this.device.updateBuffer(this.posToBuffer, positions as unknown as BufferSource);
  }

  /**
   * Selection focus+context (SPEC §A1). `ids` is a set of stable cell_ids; cells
   * whose id is in the set keep full colour plus a steady indigo HALO rim and a
   * slight size boost, while everything else dims (continuous: emission ×0.16 +
   * desaturate toward gray; categorical: a dark ~18%-lum gray). Pass `null` (or
   * call {@link clearSelection}) to restore every cell to full brightness.
   * The selection is keyed on cell_id, so it survives a layout morph. Cheap to
   * re-call — it re-uploads the per-instance flag buffer in place.
   */
  setSelection(ids: Uint32Array | null): void {
    if (!this.selectedBuffer || !this.selectedArray) return;
    const flags = this.selectedArray;
    if (!ids) {
      // no selection: every cell visible at full brightness, dimming OFF.
      flags.fill(1);
      this.hasSelection = false;
      this.device.updateBuffer(this.selectedBuffer, flags as unknown as BufferSource);
      return;
    }
    // map each requested cell_id to its instance index via a lazily-built lookup
    // (the data's ids array order). Unknown ids are silently skipped.
    const index = this.ensureIdIndex();
    flags.fill(0);
    for (let i = 0; i < ids.length; i++) {
      const idx = index.get(ids[i] >>> 0);
      if (idx !== undefined) flags[idx] = 1;
    }
    this.hasSelection = true;
    this.device.updateBuffer(this.selectedBuffer, flags as unknown as BufferSource);
  }

  /** Clear any active selection — equivalent to `setSelection(null)`. */
  clearSelection(): void {
    this.setSelection(null);
  }

  /**
   * Category focus+context (SPEC §A1). Pass a categorical index to keep every
   * cell of that category at full colour while every OTHER category recedes
   * through the EXACT dim path a selection uses (continuous: emission ×0.16 +
   * desaturate toward gray; categorical: a dark ~18%-lum gray). Pass -1 to
   * clear the focus. Purely a uniform flip — no buffer re-upload, free to call
   * every frame on hover. Independent of and composable with {@link setSelection}:
   * a cell stays bright only when it is neither selection-dimmed nor focus-dimmed.
   */
  setFocusCategory(cat: number): void {
    this.focusCategory = Number.isFinite(cat) && cat >= 0 ? Math.round(cat) : -1;
  }

  /**
   * Density underlay control (SPEC §P2.5). "off" (default) skips every density
   * pass — the renderer is byte-for-byte the original point-only path. "underlay"
   * draws the dim GPU-KDE field beneath the cloud; "contours" adds thin iso lines.
   * Requires the rgba16f HDR path; on a GPU without it the field is silently
   * skipped (the cloud still draws) since there is no float target to accumulate into.
   */
  setDensityMode(mode: "off" | "underlay" | "contours"): void {
    this.densityMode = mode;
  }

  /** The current density underlay mode. */
  get densityModeValue(): "off" | "underlay" | "contours" {
    return this.densityMode;
  }

  /** Build (once) and return the stable cell_id → instance index map for the
   *  current cloud. Rebuilt lazily after each {@link setData}. */
  private ensureIdIndex(): Map<number, number> {
    if (this.idToIndex) return this.idToIndex;
    const map = new Map<number, number>();
    const ids = this.idsRef;
    if (ids) {
      for (let i = 0; i < ids.length; i++) map.set(ids[i] >>> 0, i);
    }
    this.idToIndex = map;
    return map;
  }

  /**
   * Switch the visual theme (SPEC §FEATURE 1). "dark" (default) keeps today's
   * glow-over-near-black look; "light" flips the substrate to paper and branches the
   * resolve to ink-on-paper (density attenuates the page through a LUT-tinted ink),
   * flips the categorical focus dim to a light gray, and inverts the 3D density
   * underlay slate tint. The additive HDR accumulation pass is theme-agnostic and
   * untouched — only the RESOLVE branches. Both branches are luminance-locked
   * (reflection-9 §3): lightness is a function of density alone.
   */
  setTheme(t: "dark" | "light"): void {
    this.theme = t === "light" ? "light" : "dark";
    this.syncSubstrate();
    // The categorical series has per-theme steps, so a theme flip must re-upload
    // the LUT or the marks keep the other surface's hues.
    if (this.catSlots) this.setCategorySlots(this.catSlots);
  }

  /** Per-category slot assignment currently uploaded (null = default cycling LUT). */
  private catSlots: Int32Array | null = null;

  /**
   * Upload a categorical LUT built from an explicit category -> series-slot map.
   * `slotForCat[c] = -1` paints category c with the reserved neutral ("Other").
   * Indexed by category directly, so no hue is ever shared by two categories.
   */
  setCategorySlots(slotForCat: Int32Array): void {
    this.catSlots = slotForCat;
    const gl = this.gl;
    const data = buildSeriesLUT(slotForCat, this.theme);
    gl.bindTexture(gl.TEXTURE_2D, this.categoricalLUT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The current theme. */
  get themeValue(): "dark" | "light" {
    return this.theme;
  }

  /** Active canvas clear color (RGBA, 0..1) for the current theme. */
  /** Pick the substrate. Guarded: a print substrate under the dark theme is a
   *  category error — white paper plus an emissive resolve is a white rectangle. */
  /** Keep the substrate in step with the theme unless the export has pinned print. */
  private syncSubstrate(): void {
    if (this.substrateKey !== "print") this.substrateKey = screenSubstrate(this.theme);
  }

  setSubstrate(k: SubstrateKey): void {
    if (k === "print" && this.theme !== "light") {
      console.warn("[cytolume] print substrate requires the light theme; ignored");
      return;
    }
    this.substrateKey = k;
  }
  /** The substrate actually in use, so the composited key can match it exactly
   *  instead of assuming white. */
  get substrateHex(): string {
    return SUBSTRATE[this.substrateKey].hex;
  }
  private substrateKey: SubstrateKey = "screen-dark";

  private canvas4(): [number, number, number, number] {
    return SUBSTRATE[this.substrateKey].rgba;
  }

  /** 0/1 theme flag for the shader uniforms. */
  private themeFlag(): number {
    return this.theme === "light" ? 1 : 0;
  }

  setColormap(name: string): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.continuousLUT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, buildContinuousLUT(name));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Density-aware style: project the data box to screen, estimate per-pixel
   *  point coverage, and pick a radius + alpha exactly as the 2D path does but
   *  with a 3D metric. */
  private frameStyle(camera: Camera3D, mode: EncodingMode): FrameStyle {
    const radius = this.baseRadius * this.radiusScale;
    const ppwu = camera.pixelsPerWorldUnitAt(camera.distance); // device px / world
    const [minX, minY, minZ, maxX, maxY, maxZ] = this.bounds;
    // projected extent of the bounding box at the target depth (device px).
    const spanW = Math.max(1, (maxX - minX) * ppwu);
    const spanH = Math.max(1, Math.hypot(maxY - minY, maxZ - minZ) * ppwu);
    // The cloud does NOT fill its bounding box. On umap3d, 48 tight clusters cover
    // ~10% of the projected box at fit framing, so dividing by the whole box
    // under-counts per-mark overlap by ~8x: that model said 6.77 cells per mark
    // footprint where rasterising all 453,251 cells gives 52.97. Divide by the area
    // the cloud actually covers AT THIS PIXEL SCALE instead.
    const fill = this.fillAt(1 / Math.max(ppwu, 1e-9));
    const ppp = this.count / (spanW * spanH * fill); // points per OCCUPIED px²
    const rPx = Math.max(this.minPxFloor * this.dpr, radius * ppwu);
    const coverage = Math.max(1, ppp * (2 * rPx) * (2 * rPx));
    const alpha =
      mode === "continuous"
        ? // Floor dropped from 0.03: with the corrected coverage the honest alpha
          // for this 453k cloud is 0.0166, and a 0.03 floor would clamp it back to
          // ~2x too hot and silently cancel the correction. The resolve is
          // exponential in ACCUMULATED depth, so a thin per-cell alpha is the
          // intended input.
          clamp(1.2 / coverage, 0.002, 1.0)
        : 1.0; // categorical is opaque; alpha is unused by that branch
    return { radius, alpha, refPx: rPx };
  }

  /**
   * Render ONE small-multiple panel: the whole cloud as neutral context, with a
   * single cell type inked on top.
   *
   * WHY THIS IS NOT A LOOP OVER setFocusCategory
   * --------------------------------------------
   * Focus mode only RECOLOURS the context — the ghost still writes depth and still
   * wins LEQUAL. A cell type buried inside the cloud would therefore be occluded by
   * its own context, and its panel would read emptier than the truth. Across a 48-
   * panel grid that under-reports interior types systematically, which is exactly
   * the kind of quiet error a figure must not contain.
   *
   * So the ink pass runs against a CLEARED depth buffer with `depthFunc(ALWAYS)`:
   * every cell of the focused type is drawn, regardless of what sits in front of it.
   * The panel answers "where do these cells live", not "which are unoccluded".
   *
   * Determinism: same camera + same data + same uniforms, and the ghost is drawn
   * identically for every panel, so panels are byte-comparable by construction.
   * EDL and the density underlay are deliberately skipped — both are view-dependent
   * resolves whose detail is invisible at panel scale.
   */
  renderFacet(camera: Camera3D, category: number): void {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    this.dpr = camera.devicePixelRatio;

    const u = camera.uniforms();
    const { radius, refPx } = this.frameStyle(camera, "categorical");
    // Facet panels are compared to each other, so a per-cell depth size term would
    // make the same cell draw differently between panels. Anchor it off.
    this.refW = 1;
    this.refPx = Math.max(1e-4, refPx);
    const focalPx = (0.5 * height) / Math.tan(camera.fov / 2);
    const minPx = this.minPxFloor * this.dpr;
    this.lastFrame = {
      u, radius, focalPx, minPx, morphFactor: this.morphFactor,
      refW: this.refW,
      depthSizeExp: 0, // facet panels are never perspective-sized
    };

    this.device.bindTarget(null);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(...this.canvas4());
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.count === 0 || !this.vao) return;

    // A facet panel states its own encoding; a stale selection or focus would dim
    // cells for a reason the panel's caption cannot explain.
    const prevFocus = this.focusCategory;
    const prevHasSel = this.hasSelection;
    this.focusCategory = -1;
    this.hasSelection = false;

    gl.bindVertexArray(this.vao);

    // --- ghost: all 453k cells, dim context, depth ON ---
    this.facetGhost = true;
    this.facetCategory = -1;
    this.setImpostorUniforms(u, radius, 1.0, focalPx, minPx, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);

    // --- ink: only this category, over a cleared depth buffer ---
    gl.clear(gl.DEPTH_BUFFER_BIT); // depth ONLY — clearing colour would erase the ghost
    gl.depthFunc(gl.ALWAYS);
    this.facetGhost = false;
    this.facetCategory = Math.round(category);
    // The rarest of 48 types has ~900 cells; at the 1.2px screen floor scaled down to
    // panel size they vanish, and an empty panel is a false statement about the data.
    // The ghost keeps the normal floor so the context's shape is unchanged.
    this.setImpostorUniforms(u, radius, 1.0, focalPx, Math.max(minPx, FACET_INK_MIN_PX * this.dpr), 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);

    gl.bindVertexArray(null);
    gl.depthFunc(gl.LEQUAL);
    this.facetCategory = -1;
    this.facetGhost = false;
    this.focusCategory = prevFocus;
    this.hasSelection = prevHasSel;
  }

  /** Projected occupancy at a given world-space pixel size, from the power law
   *  measured in setData. Clamped to (0,1]: an extrapolated fill above 1 would
   *  mean the cloud covers more than its own box. */
  private fillAt(worldPerPx: number): number {
    const s = Math.max(1e-9, worldPerPx);
    const f = this.fillA * Math.pow(s / Math.max(1e-9, this.fillSide), this.fillExp);
    return Math.min(1, Math.max(1e-3, f));
  }

  render(camera: Camera3D, mode: EncodingMode): void {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    // The CALLER owns the viewport. Re-deriving dpr from window.devicePixelRatio here
    // silently overwrote whatever the caller had just set — which broke figure export:
    // servicePendingExport() sets a scale-N viewport and this threw it away one
    // statement later, so every px-referenced constant below (minPx, coverage, alpha)
    // was computed for the screen, not the plate. The exported PNG therefore had
    // ~N-times-smaller marks and a much higher alpha than the preview it was tuned on.
    this.dpr = camera.devicePixelRatio;

    const u = camera.uniforms();
    const { radius, alpha, refPx } = this.frameStyle(camera, mode);
    const focalPx = (0.5 * height) / Math.tan(camera.fov / 2);
    const minPx = this.minPxFloor * this.dpr;
    // Ortho has no perspective divide (clip w == 1 everywhere), so the anchor is 1
    // and persp collapses to 1 — the cue correctly disappears in orthographic.
    this.refW = camera.orthographic ? 1 : Math.max(1e-4, camera.distance);
    this.refPx = Math.max(1e-4, refPx);

    // Cache the exact draw state so pick() can re-raster the id pass to match.
    this.lastFrame = {
      u, radius, focalPx, minPx, morphFactor: this.morphFactor,
      refW: this.refW,
      depthSizeExp: mode === "continuous" ? this.depthSizeExp : 0,
    };

    if (this.count === 0 || !this.vao) {
      // nothing to draw — still clear to the canvas colour.
      this.device.clear({ color: this.canvas4(), depth: 1, target: null });
      return;
    }

    // Density underlay is only honest on the rgba16f float path (it accumulates
    // additively into a float target). Skip it entirely otherwise, or when off.
    const densityActive = this.densityMode !== "off" && this.device.caps.hdrSupported;
    // SEMANTIC ZOOM: strength ≈1 when zoomed OUT (field dominant), fading to 0 as
    // the camera dollies IN so the points take over. Derived from camera.distance
    // vs the framed bounds-sphere radius (mirrors Camera3D.fit's boundsRadius).
    const strength = densityActive ? this.densityStrength(camera) : 0;

    if (mode === "continuous") {
      this.renderContinuous(camera, u, radius, alpha, focalPx, minPx, width, height, densityActive, strength);
    } else {
      this.renderCategorical(camera, u, radius, focalPx, minPx, width, height, densityActive, strength);
    }
  }

  /** Semantic-zoom field strength in [0,1] from camera.distance vs the framed
   *  bounds-sphere radius. ≈1 zoomed out, → 0 zoomed in (points take over). */
  private densityStrength(camera: Camera3D): number {
    // Relative to the distance the FIT chose, not to a bounding-box radius. The
    // old 2.4 anchor encoded how loose the old sphere fit happened to be: once
    // fitExtent tightened umap3d from d=625 to d=366, the same expression would
    // have driven the field from 0.51 to 0.003 — i.e. the underlay would have
    // silently vanished at the default framing without anyone touching this.
    // ratio == 1 is "as the plate was framed"; dollying in shrinks it toward 0.
    const ratio = camera.distance / Math.max(1e-6, camera.fitDistance);
    const REF_IN = 0.42; // zoomed in -> field gone
    const REF_OUT = 1.56; // zoomed out -> field full
    return clamp((ratio - REF_IN) / (REF_OUT - REF_IN), 0, 1);
  }

  /** SPLAT → BLUR (KDE): build the low-res smoothed density field for this frame.
   *  Returns the target holding the final field (its .colorTexture .r channel),
   *  plus the per-pixel mean density used to adapt the composite tone gain. */
  private buildDensityField(
    u: ReturnType<Camera3D["uniforms"]>,
    width: number,
    height: number,
  ): { field: RenderTarget; gain: number } {
    const gl = this.gl;
    const lowW = Math.max(2, width >> 1);
    const lowH = Math.max(2, height >> 1);
    const a = this.device.targets.acquire("density-a", lowW, lowH, "rgba16f");
    const b = this.device.targets.acquire("density-b", lowW, lowH, "rgba16f");

    // --- SPLAT: additive soft gaussians into the low-res field (depth OFF). ---
    this.device.bindTarget(a);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    const S = this.densitySplat;
    gl.useProgram(S.program);
    gl.uniformMatrix4fv(S.uniforms.u_viewProj, false, u.u_viewProj);
    gl.uniform1f(S.uniforms.u_morphFactor, this.morphFactor);
    gl.uniform1f(S.uniforms.u_pointSize, this.densityPointPx);
    gl.uniform1f(S.uniforms.u_weight, 1.0);
    gl.bindVertexArray(this.densityVAO);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);

    // --- BLUR (separable Gaussian KDE): H (a→b) then V (b→a). ---
    gl.disable(gl.BLEND);
    const spread = this.densityBlurSpread;
    this.blurPass(a.colorTexture, b, [spread / lowW, 0]);
    this.blurPass(b.colorTexture, a, [0, spread / lowH]);

    // Adapt the tone gain to the cloud's density so dense regions read as terrain
    // regardless of point count (gain ÷ mean splat density per low-res pixel).
    const meanPerPx = this.count / (lowW * lowH);
    const gain = this.densityGainScale / Math.max(1e-3, meanPerPx);
    return { field: a, gain };
  }

  /** One fullscreen separable-Gaussian blur tap pass: srcTex → dst (blend OFF). */
  private blurPass(srcTex: WebGLTexture, dst: RenderTarget, step: [number, number]): void {
    const gl = this.gl;
    this.device.bindTarget(dst);
    gl.disable(gl.BLEND);
    const B = this.densityBlur;
    gl.useProgram(B.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(B.uniforms.u_field, 0);
    gl.uniform2f(B.uniforms.u_step, step[0], step[1]);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** COMPOSITE: write the dim underlay (+ optional contours) to the SCREEN. Blend
   *  OFF — it emits the full backdrop (canvas + field), doubling as the colour
   *  clear under the cloud. Leaves the screen bound for the point passes. */
  private compositeDensity(
    field: RenderTarget,
    gain: number,
    strength: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    this.device.bindTarget(null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    const C = this.densityComposite;
    gl.useProgram(C.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, field.colorTexture);
    gl.uniform1i(C.uniforms.u_field, 0);
    gl.uniform1f(C.uniforms.u_strength, strength);
    gl.uniform1f(C.uniforms.u_gain, gain);
    gl.uniform1f(C.uniforms.u_peak, this.densityPeak);
    gl.uniform1i(C.uniforms.u_contours, this.densityMode === "contours" ? 1 : 0);
    gl.uniform1i(C.uniforms.u_theme, this.themeFlag());
    const cs = SUBSTRATE[this.substrateKey].rgba;
    gl.uniform3f(C.uniforms.u_canvas, cs[0], cs[1], cs[2]);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private setImpostorUniforms(
    u: ReturnType<Camera3D["uniforms"]>,
    radius: number,
    alpha: number,
    focalPx: number,
    minPx: number,
    modeFlag: number,
  ): void {
    const gl = this.gl;
    const P = this.impostor;
    gl.useProgram(P.program);
    gl.uniformMatrix4fv(P.uniforms.u_viewProj, false, u.u_viewProj);
    gl.uniform3fv(P.uniforms.u_cameraRight, u.u_cameraRight);
    gl.uniform3fv(P.uniforms.u_cameraUp, u.u_cameraUp);
    gl.uniform3fv(P.uniforms.u_viewDir, u.u_viewDir);
    gl.uniform1f(P.uniforms.u_radius, radius);
    gl.uniform1f(P.uniforms.u_focalPx, focalPx);
    gl.uniform1f(P.uniforms.u_minPx, minPx);
    gl.uniform1f(P.uniforms.u_alpha, alpha);
    gl.uniform1f(P.uniforms.u_morphFactor, this.morphFactor);
    gl.uniform1ui(P.uniforms.u_hoverId, this.hoverId);
    gl.uniform1i(P.uniforms.u_hasSelection, this.hasSelection ? 1 : 0);
    gl.uniform1f(P.uniforms.u_spinAngle, this.spinAngle);
    gl.uniform3f(P.uniforms.u_spinAxis, this.spinAxis[0], this.spinAxis[1], this.spinAxis[2]);
    gl.uniform1i(P.uniforms.u_focusCategory, this.focusCategory);
    gl.uniform1i(P.uniforms.u_facetCategory, this.facetCategory);
    gl.uniform1i(P.uniforms.u_facetGhost, this.facetGhost ? 1 : 0);
    // modeFlag 0 == continuous. Categorical and the facet pass are opaque and
    // depth-sorted, so they get their depth read from occlusion and must NOT have
    // per-cell size varying — forcing the exponent to 0 restores the old constant
    // floor bit-for-bit on those paths.
    const dse = modeFlag === 0 ? this.depthSizeExp : 0;
    gl.uniform1f(P.uniforms.u_depthSizeExp, dse);
    gl.uniform1f(P.uniforms.u_refW, this.refW);
    gl.uniform1f(P.uniforms.u_refPx, this.refPx);
    // Only the CONTINUOUS pass ever uses MAX blending.
    gl.uniform1i(
      P.uniforms.u_peakOut,
      modeFlag === 0 && this.blendMode === "peak" ? 1 : 0,
    );
    gl.uniform1i(P.uniforms.u_theme, this.themeFlag());
    gl.uniform1i(P.uniforms.u_mode, modeFlag);
    // LUT samplers.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.continuousLUT);
    gl.uniform1i(P.uniforms.u_continuousLUT, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.categoricalLUT);
    gl.uniform1i(P.uniforms.u_categoricalLUT, 1);
  }

  /** Continuous: additive depth-OFF into HDR RGBA16F (alpha = optical depth) →
   *  luminance-locked resolve to screen. Falls back to additive-to-screen when HDR
   *  is unavailable. */
  private renderContinuous(
    _camera: Camera3D,
    u: ReturnType<Camera3D["uniforms"]>,
    radius: number,
    alpha: number,
    focalPx: number,
    minPx: number,
    width: number,
    height: number,
    densityActive: boolean,
    strength: number,
  ): void {
    const gl = this.gl;

    // DENSITY UNDERLAY: build the field FIRST (its own low-res targets), so the
    // composite can lay it onto the screen before the cloud's glow stacks over it.
    const density = densityActive ? this.buildDensityField(u, width, height) : null;

    const hdr: RenderTarget | null = this.device.caps.hdrSupported
      ? this.device.targets.acquire("hdr", width, height, "rgba16f")
      : null;

    // additive accumulation: depth OFF, no depth write, blend ONE,ONE.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    // MAX is order-independent and never saturates, so it needs no depth sort and no
    // weighted-OIT plumbing — try it before reaching for either.
    gl.blendEquation(this.blendMode === "peak" ? gl.MAX : gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    this.setImpostorUniforms(u, radius, alpha, focalPx, minPx, 0);
    gl.bindVertexArray(this.vao);

    if (hdr) {
      this.device.bindTarget(hdr);
        // Alpha is OPTICAL DEPTH now, and the resolve divides rgb by it. Clearing
        // it to 1 would give every UNLIT pixel a full unit of depth and make the
        // whole background one paper-attenuated wash.
        gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);

      // composite HDR → screen. With density: lay the underlay down first, then
      // tone-map the cloud ADDITIVELY over it (glow stacks; underlay shows where
      // emission is ~0). Without density: the original clear + opaque overwrite.
      gl.bindVertexArray(null);
      this.device.bindTarget(null);
      const light = this.theme === "light";
      if (density) {
        this.compositeDensity(density.field, density.gain, strength, width, height);
        gl.clearDepth(1);
        gl.clear(gl.DEPTH_BUFFER_BIT); // keep the underlay colour; reset depth only
        gl.enable(gl.BLEND);
        if (light) {
          // LIGHT: the tonemap emits paper+ink; take the per-channel MIN against
          // the paper+terrain underlay so BOTH ink and terrain DARKEN the page
          // (additive would brighten the paper — the wrong direction).
          gl.blendEquation(gl.MIN);
          gl.blendFunc(gl.ONE, gl.ONE);
        } else {
          // DARK: glow stacks ADDITIVELY over the underlay.
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE);
        }
      } else {
        gl.clearColor(...this.canvas4());
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.BLEND);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      const T = this.tonemap;
      gl.useProgram(T.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdr.colorTexture);
      gl.uniform1i(T.uniforms.u_hdr, 0);
      gl.uniform1f(T.uniforms.u_exposure, this.exposure);
      gl.uniform1i(T.uniforms.u_theme, this.themeFlag());
      gl.uniform1i(T.uniforms.u_peak, this.blendMode === "peak" ? 1 : 0);
      // shade maxes at 0.65 + 0.35 = 1.0, so one cell deposits at most alpha; the
      // tonemap has already multiplied by exposure, so fold that in here too.
      // The SAME scalar the density key ticks in: point-spread normalisation makes
      // one cell deposit exactly this much optical depth regardless of its depth, so
      // tau / tauPerCell is a real cell count along the ray.
      this.tauPerCell = alpha * this.exposure;
      gl.uniform1f(T.uniforms.u_peakNorm, this.tauPerCell);
      // Compile-time constants, not measurements — no readback, so two exports of
      // identical data still agree byte for byte.
      gl.uniform1f(T.uniforms.u_tauMax, this.tauMax);
      gl.uniform1f(T.uniforms.u_inkK, this.inkK);
      // PEAK resolves value -> colour here rather than inverting a componentwise max.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.continuousLUT);
      gl.uniform1i(T.uniforms.u_lut, 1);
      const sub = SUBSTRATE[this.substrateKey].rgba;
      gl.uniform3f(T.uniforms.u_paper, sub[0], sub[1], sub[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (density) gl.disable(gl.BLEND);
      // Restore the default equation unconditionally: both MIN (density composite)
      // and MAX (peak blend) would otherwise leak into the next frame's passes.
      gl.blendEquation(gl.FUNC_ADD);
    } else {
      // LDR fallback: additively accumulate straight onto the canvas colour.
      // (Density needs the float path, so it is never active here.)
      this.device.bindTarget(null);
      gl.clearColor(...this.canvas4());
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  /** Categorical: opaque, depth-tested (LEQUAL), depth-write ON, NO blend. The
   *  z-buffer is the order-independent sort. */
  private renderCategorical(
    _camera: Camera3D,
    u: ReturnType<Camera3D["uniforms"]>,
    radius: number,
    focalPx: number,
    minPx: number,
    width: number,
    height: number,
    densityActive: boolean,
    strength: number,
  ): void {
    const gl = this.gl;

    if (densityActive) {
      // Underlay first: the composite writes the full backdrop (canvas + dim
      // field) so the opaque points then cover their pixels, leaving the field
      // showing in the gaps = territory under the discrete cells. Only depth is
      // cleared afterwards (NOT colour — that would erase the underlay).
      const density = this.buildDensityField(u, width, height);
      this.compositeDensity(density.field, density.gain, strength, width, height);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    } else {
      this.device.bindTarget(null);
      gl.viewport(0, 0, width, height);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);

      gl.clearColor(...this.canvas4());
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    // Eye-dome lighting needs scene depth as a TEXTURE, so when it is on the
    // categorical pass draws into an offscreen target and is resolved to the screen
    // by the EDL pass. With it off, the original direct-to-screen path is untouched.
    const wantEdl = this.edlStrength > 0 && !densityActive;
    const edlRT = wantEdl
      ? this.device.targets.acquire("edl", width, height, "rgba8-depthtex")
      : null;
    if (edlRT) {
      this.device.bindTarget(edlRT);
      gl.viewport(0, 0, width, height);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.clearColor(...this.canvas4());
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    this.setImpostorUniforms(u, radius, 1.0, focalPx, minPx, 1);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);

    if (edlRT && edlRT.depthTexture) {
      this.device.bindTarget(null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      const E = this.edl;
      gl.useProgram(E.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, edlRT.colorTexture);
      gl.uniform1i(E.uniforms.u_color, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, edlRT.depthTexture);
      gl.uniform1i(E.uniforms.u_depth, 1);
      gl.uniform2f(E.uniforms.u_texel, 1 / width, 1 / height);
      // Scale the ring with resolution so a 3x figure export gets the SAME look as
      // the screen instead of a 3x-finer (and therefore weaker) response.
      gl.uniform1f(E.uniforms.u_radiusPx, this.edlRadiusPx * this.dpr);
      gl.uniform1f(E.uniforms.u_strength, this.edlStrength);
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  /** Choose how the continuous encoding accumulates (see `blendMode`). */
  setBlendMode(m: "sum" | "peak"): void {
    this.blendMode = m === "peak" ? "peak" : "sum";
  }
  get blendModeValue(): "sum" | "peak" {
    return this.blendMode;
  }

  /** Eye-dome lighting strength; 0 disables the pass. */
  /** Joint mark scale. Drives BOTH the world radius and the screen-space floor, so
   *  a mark grows coherently instead of the floor clamping away the radius change —
   *  which is exactly the failure the perspective-size fix was about. */
  setMarkScale(v: number): void {
    const k = Math.max(0.7, Math.min(2.5, v));
    this.markScale = k;
    this.radiusScale = k;
    this.minPxFloor = BASE_MIN_PX * k;
  }
  get markScaleValue(): number {
    return this.markScale;
  }
  /** Effective screen floor in CSS px — the number that decides whether structure
   *  survives rasterisation, so it is what the UI should report, not the bare scale. */
  get markFloorPx(): number {
    return this.minPxFloor;
  }

  /** Ink weight applied to accumulated optical depth before the resolve. */
  setExposure(v: number): void {
    this.exposure = Math.max(0.1, Math.min(12, v));
  }
  /** Optical depth per cell for the LAST rendered frame. The density key converts
   *  tau to cells with it; it is recomputed every frame because frameStyle re-derives
   *  alpha from the camera and dpr, so an export at scale 2 and one at scale 3 have
   *  genuinely different tau-per-cell. Zero readback — this is CPU state. */
  get tauPerCellValue(): number {
    return this.tauPerCell;
  }
  /** The declared density ceiling, expressed in cells along the ray. */
  get densityCeiling(): number {
    return this.tauMax / Math.max(this.tauPerCell, 1e-6);
  }
  /** Ramp position (0..1) for a given cell count — the SAME expression the resolve
   *  uses, so the key and the marks cannot disagree. */
  densityRampT(cells: number): number {
    return Math.min(
      1,
      Math.log1p(Math.max(0, cells) * this.tauPerCell) / Math.log1p(this.tauMax),
    );
  }
  /** The neutral (hue-free) colour the resolve produces at a given cell count —
   *  built from the same constants, never sampled from the framebuffer. */
  densitySwatch(cells: number, theme: "light" | "dark"): string {
    const d = this.densityRampT(cells);
    const k = Math.exp(-d * this.inkK);
    const ch = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c)));
    if (theme === "light") {
      const p = [238 / 255, 240 / 255, 243 / 255];
      return `rgb(${ch(p[0] * k)},${ch(p[1] * k)},${ch(p[2] * k)})`;
    }
    const y = 1 - k;
    return `rgb(${ch(y)},${ch(y)},${ch(y)})`;
  }

  get exposureValue(): number {
    return this.exposure;
  }

  setEdlStrength(v: number): void {
    this.edlStrength = Math.max(0, Math.min(2, v));
  }
  get edlStrengthValue(): number {
    return this.edlStrength;
  }

  get pointCount(): number {
    return this.count;
  }

  /**
   * Depth-correct pick (SPEC §PICK). `x`/`y` are device pixels measured from the
   * TOP-LEFT (canvas pixel space — multiply CSS coords by dpr). Renders the id
   * pass with the SAME billboard geometry + gl_FragDepth as the last visible
   * frame, so the FRONT cell along the cursor ray wins. Returns the decoded
   * cell_id, or -1 for a miss (empty space, or before the first frame).
   */
  pick(x: number, y: number): number {
    if (!this.lastFrame || this.count === 0) return -1;
    const f = this.lastFrame;
    return this.pickPass.pick({
      x,
      y,
      u: f.u,
      radius: f.radius,
      focalPx: f.focalPx,
      minPx: f.minPx,
      refW: f.refW,
      depthSizeExp: f.depthSizeExp,
      morphFactor: f.morphFactor,
      // Spin freezes on interaction (the host stops advancing it), so the live
      // spin state matches the last rendered frame — picking hits the SPUN cell.
      spinAngle: this.spinAngle,
      spinAxis: this.spinAxis,
    });
  }

  /** Highlight a cell by id (the indigo halo + slight scale), or clear the
   *  highlight with `null` / -1. Returns true when the hover state changed. */
  setHoverId(id: number | null): boolean {
    const next = id === null || id < 0 ? NO_HOVER : id >>> 0;
    if (next === this.hoverId) return false;
    this.hoverId = next;
    return true;
  }

  /** The currently highlighted cell_id, or -1 when none. */
  get hoveredId(): number {
    return this.hoverId === NO_HOVER ? -1 : this.hoverId;
  }

  destroy(): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.densityVAO) gl.deleteVertexArray(this.densityVAO);
    gl.deleteVertexArray(this.emptyVAO);
    gl.deleteBuffer(this.cornerBuffer);
    if (this.centerBuffer) gl.deleteBuffer(this.centerBuffer);
    if (this.posToBuffer) gl.deleteBuffer(this.posToBuffer);
    if (this.valueBuffer) gl.deleteBuffer(this.valueBuffer);
    if (this.categoryBuffer) gl.deleteBuffer(this.categoryBuffer);
    if (this.idBuffer) gl.deleteBuffer(this.idBuffer);
    if (this.selectedBuffer) gl.deleteBuffer(this.selectedBuffer);
    if (this.centroidBuffer) gl.deleteBuffer(this.centroidBuffer);
    gl.deleteTexture(this.continuousLUT);
    gl.deleteTexture(this.categoricalLUT);
    gl.deleteProgram(this.impostor.program);
    gl.deleteProgram(this.tonemap.program);
    gl.deleteProgram(this.densitySplat.program);
    gl.deleteProgram(this.densityBlur.program);
    gl.deleteProgram(this.densityComposite.program);
    this.pickPass.destroy();
    this.device.destroy();
  }
}

export { Device3DUnavailable };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
