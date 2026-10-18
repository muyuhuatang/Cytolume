/*
 * Colormaps — reflection-0 §4.
 *
 * Continuous: the DARK theme defaults to magma — its dark low end fuses into the
 * #0B0E14 canvas, so zero reads as "off" (honest density); inferno is its fierier,
 * more orange sibling; viridis / cividis are perceptually-uniform toggles. The LIGHT
 * "paper" theme renders cells as a darkened LUT-hue INK; it defaults to `ylorrd` (warm red
 * ink) and also offers single-hue inks (emerald / plum / amber / rose / azure). (Theme→default
 * wiring lives in main3d.ts; warm maps' orange/yellow glow best on dark — a dark warm ink
 * lands red/brown on paper.)
 *
 * Categorical: "Cytolume Core 24" — the first 8 entries are pinned to the
 * Okabe-Ito colorblind-safe set, the rest are a distinct high-separation
 * extension. Past ~24 categories we stop inventing hues and switch to
 * focus+context instead (not this module's job).
 *
 * Everything is delivered to the GPU as a 256-wide RGBA LUT texture so a
 * recolor is a one-texel-fetch swap, never a CPU pass over the points.
 */

type Stops = string[];

// matplotlib magma / viridis / cividis anchor stops (low → high)
const MAGMA: Stops = [
  "#000004", "#1c1044", "#4f127b", "#812581",
  "#b5367a", "#e55064", "#fb8761", "#fec287", "#fcfdbf",
];
const VIRIDIS: Stops = [
  "#440154", "#482878", "#3e4a89", "#31688e", "#26828e",
  "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725",
];
const CIVIDIS: Stops = [
  "#00204d", "#00336f", "#39486b", "#575d6d", "#707173",
  "#8a8779", "#a69d75", "#c4b56c", "#e4cf5b", "#ffe945",
];

// matplotlib inferno (fiery; a warmer, more orange sibling of magma).
const INFERNO: Stops = [
  "#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60",
  "#cf4446", "#ed6925", "#fb9b06", "#f7d03c", "#fcffa4",
];
// matplotlib coolwarm — a DIVERGING blue → neutral → red (Moreland).
const COOLWARM: Stops = [
  "#3b4cc0", "#6a8bef", "#9ebeff", "#c5d6f2", "#dcdcdc",
  "#f3c6ad", "#ed8a6c", "#cf4a40", "#b40426",
];
// ColorBrewer YlOrRd — sequential yellow → orange → red.
const YLORRD: Stops = [
  "#ffffcc", "#ffeda0", "#fed976", "#feb24c", "#fd8d3c",
  "#fc4e2a", "#e31a1c", "#bd0026", "#800026",
];

// Single-hue ramps tuned for the LIGHT "ink on paper" pass (the renderer darkens the LUT
// hue to ~0.45 ink): one refined hue family each, so the ink reads clean — not the muddy
// multi-hue mix magma/inferno collapse to on paper. (On the dark glow pass these read as a
// calm single-hue glow.)
const EMERALD: Stops = [
  "#eef7f3", "#c4e6da", "#8fcdba", "#56ab93", "#2f8870", "#19604f", "#0d3f34",
];
const PLUM: Stops = [
  "#f7e9f1", "#e6bdd7", "#cf8cb8", "#b25a97", "#8c3470", "#641b4d", "#3e1031",
];
const AMBER: Stops = [
  "#fbf0df", "#f7d49e", "#f0b25f", "#e2902f", "#c46a1b", "#964710", "#5f2c08",
];
const ROSE: Stops = [
  "#fcebf0", "#f5c6d5", "#ea96ae", "#d96585", "#b53e62", "#852341", "#531228",
];
const AZURE: Stops = [
  "#e7f3f7", "#bfe2ec", "#8acdde", "#4eafc8", "#2789a6", "#13627c", "#0a4053",
];

const CONTINUOUS: Record<string, Stops> = {
  magma: MAGMA,
  inferno: INFERNO,
  viridis: VIRIDIS,
  cividis: CIVIDIS,
  coolwarm: COOLWARM,
  ylorrd: YLORRD,
  emerald: EMERALD,
  plum: PLUM,
  amber: AMBER,
  rose: ROSE,
  azure: AZURE,
};

/** Cytolume Core 24 — Okabe-Ito (0..7) then a distinct extension (8..23). */
export const CORE_24: Stops = [
  "#e69f00", "#56b4e9", "#009e73", "#f0e442",
  "#0072b2", "#d55e00", "#cc79a7", "#999999",
  "#8dd3c7", "#fb8072", "#80b1d3", "#fdb462",
  "#b3de69", "#fccde5", "#bc80bd", "#ccebc5",
  "#ffed6f", "#a6cee3", "#1f78b4", "#33a02c",
  "#e31a1c", "#ff7f00", "#6a3d9a", "#b15928",
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Build a 256×1 RGBA8 LUT by linearly interpolating between anchor stops. */
/** The stop list backing a continuous colormap — the SAME source the GPU LUT is
 *  built from, so a UI colorbar and the rendered marks cannot disagree. */
export function CONTINUOUS_STOPS(name: string): Stops {
  return CONTINUOUS[name] ?? MAGMA;
}

export function buildContinuousLUT(name: string): Uint8Array {
  const stops = CONTINUOUS[name] ?? MAGMA;
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8Array(256 * 4);
  const segs = rgb.length - 1;
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * segs;
    const lo = Math.min(Math.floor(f), segs - 1);
    const t = f - lo;
    const c0 = rgb[lo];
    const c1 = rgb[lo + 1];
    lut[i * 4 + 0] = Math.round(lerp(c0[0], c1[0], t));
    lut[i * 4 + 1] = Math.round(lerp(c0[1], c1[1], t));
    lut[i * 4 + 2] = Math.round(lerp(c0[2], c1[2], t));
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** Build a 256×1 RGBA8 categorical LUT (nearest, no interpolation). */
/* ---------------------------------------------------------------------------
 * Figure-safe categorical series.
 *
 * A scatter is an ALL-PAIRS form: any two clusters can end up adjacent, so every
 * pair of hues must be separable — not just neighbouring slots. Under that rule
 * only THREE hues clear the CVD and normal-vision floors in both themes
 * (validated: worst all-pairs CVD dE 9.2 light / 9.4 dark; normal-vision 15.7 /
 * 18.9). Everything past the third folds into a reserved neutral "Other", and
 * identity for those types comes from direct labels, focus, and small multiples.
 *
 * This replaces CORE_24 for rendering. CORE_24 cycled at 24, so with 48 cell
 * types every hue served exactly two types — byte-identical, dE 0, indistinguishable
 * by any means. It also failed the CVD and normal-vision gates on ADJACENT pairs
 * before cycling was even considered.
 * ------------------------------------------------------------------------- */

/** Distinct identity hues, in fixed assignment order. Never cycled. */
export const SERIES_LIGHT: Stops = ["#2a78d6", "#eb6834", "#1baf7a"];
export const SERIES_DARK: Stops = ["#3987e5", "#d95926", "#199e70"];
/** Reserved neutral for every category past the series cap. Deliberately low-chroma
 *  (it fails the chroma floor by design — it is a non-identity colour). */
export const OTHER_LIGHT = "#646a72";
export const OTHER_DARK = "#5a5f66";

/** How many categories get a distinct hue before folding to "Other". */
export const SERIES_CAP = SERIES_LIGHT.length;

/** Hues + neutral for a theme. */
export function seriesPalette(theme: "light" | "dark"): { series: Stops; other: string } {
  return theme === "light"
    ? { series: SERIES_LIGHT, other: OTHER_LIGHT }
    : { series: SERIES_DARK, other: OTHER_DARK };
}

/**
 * Build the 256-entry categorical LUT from an explicit per-category slot map, so
 * the GPU table is indexed by category directly (the shader samples
 * `mod(v_category, 256)`) and NOTHING is ever cycled.
 *
 * `slotForCat[c]` is an index into `series`, or -1 for the reserved neutral.
 */
export function buildSeriesLUT(
  slotForCat: Int32Array | number[],
  theme: "light" | "dark",
): Uint8Array {
  const { series, other } = seriesPalette(theme);
  const rgb = series.map(hexToRgb);
  const oth = hexToRgb(other);
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const slot = i < slotForCat.length ? slotForCat[i] : -1;
    const c = slot >= 0 && slot < rgb.length ? rgb[slot] : oth;
    lut[i * 4 + 0] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

export function buildCategoricalLUT(stops: Stops = CORE_24): Uint8Array {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = rgb[i % rgb.length];
    lut[i * 4 + 0] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
