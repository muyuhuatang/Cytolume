/*
 * Cytolume 3D showcase boot (reflection-3) — activated by `?r3d=1`.
 *
 * A self-contained sibling of the 2D boot in main.ts: it claims the SAME canvas
 * + readout DOM, but drives the raw-WebGL2 Renderer3D with an orbit Camera3D and
 * uploads stride-3 positions (z is kept, never projected away). The default
 * active layout is pca3d (override with `&layout=umap3d`). The 2D path in
 * main.ts is left completely untouched; this module is only imported when r3d=1.
 */
import "./style.css";
import "./ui/interaction.css";
import "./ui/map-legibility.css";
import "./body/body-panel.css";
import { Renderer3D, Camera3D } from "./core/index.ts";
import type { EncodingMode, ContinuousColormap, PointData } from "./core/index.ts";
import { qFromAxisAngle, qMul, clamp, type Quat } from "./core/math3d.ts";
import { seriesPalette, SERIES_CAP } from "./core/colormaps.ts";
import { loadManifest, type CategoricalDict } from "./data/manifest.ts";
import { SpineTileSource } from "./data/spine-tile-source.ts";
import { SyntheticTileSource } from "./data/synthetic-source.ts";
import type { TileSource } from "./data/tile-source.ts";
import { lassoSelect, type Point2 } from "./interaction/lasso.ts";
import { SelectionStore } from "./interaction/selection-store.ts";
import { HoverCard } from "./ui/hover-card.ts";
import { SelectionSummary } from "./ui/selection-summary.ts";
import { LassoOverlay } from "./ui/lasso-overlay.ts";
import { computeCentroids, type Centroid } from "./labels/centroids.ts";
import { declutterLabelsWithStats, type DeclutterResult, type LabelCandidate, type PlacedLabel } from "./labels/declutter.ts";
import { Legend, type LegendRow } from "./ui/legend.ts";
import { Colorbar } from "./ui/colorbar.ts";
import { compositeFigure, drawFacetChrome, drawFacetCaption } from "./ui/figure-composite.ts";
import {
  buildDomain,
  colormapNote,
  domainNote,
  formatTick,
  invalidateDomains,
  niceTicks,
  toFraction,
  type ContinuousKeySpec,
} from "./ui/continuous-domain.ts";
import { robustViewExtent } from "./core/robust-bounds.ts";
import { CONTINUOUS_STOPS } from "./core/colormaps.ts";
import { LabelOverlay } from "./ui/label-overlay.ts";
import { BodyPanel } from "./body/body-panel.ts";
import { bodyNodeForCellType } from "./body/body-map.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const themeSel = document.getElementById("theme") as HTMLSelectElement | null;
const modeSel = document.getElementById("mode") as HTMLSelectElement;
const cmapSel = document.getElementById("cmap") as HTMLSelectElement;
const cmapRow = document.getElementById("cmap-row") as HTMLElement;
const layoutSel = document.getElementById("layout") as HTMLSelectElement;
const layoutRow = document.getElementById("layout-row") as HTMLElement;
const toolSel = document.getElementById("tool") as HTMLSelectElement;
const toolRow = document.getElementById("tool-row") as HTMLElement;
const densitySel = document.getElementById("density") as HTMLSelectElement;
const densityRow = document.getElementById("density-row") as HTMLElement;
const motionSel = document.getElementById("motion") as HTMLSelectElement;
const motionRow = document.getElementById("motion-row") as HTMLElement;
const spinSel = document.getElementById("spin") as HTMLSelectElement;
const spinRow = document.getElementById("spin-row") as HTMLElement;
const sizeSlider = document.getElementById("marksize") as HTMLInputElement;
const sizeOut = document.getElementById("marksize-out") as HTMLOutputElement;
const inkSlider = document.getElementById("ink") as HTMLInputElement;
const inkOut = document.getElementById("ink-out") as HTMLOutputElement;
const edlSlider = document.getElementById("edl") as HTMLInputElement;
const edlOut = document.getElementById("edl-out") as HTMLOutputElement;
const edlRow = document.getElementById("edl-row") as HTMLElement;
const blendRow = document.getElementById("blend-row") as HTMLElement;
const blendSel = document.getElementById("blend") as HTMLSelectElement;
const marksGrp = document.getElementById("marks-grp") as HTMLElement;
const marksNote = document.getElementById("marks-note") as HTMLElement;
const countEl = document.getElementById("count") as HTMLElement;
const fpsEl = document.getElementById("fps") as HTMLElement;
const zoomEl = document.getElementById("zoom") as HTMLElement;

// Hover readout: a span appended to the footer (created here so the untouched
// 2D path in main.ts never sees it). Shows the picked cell_id under the cursor.
const cellEl = document.createElement("span");
cellEl.id = "cellid";
const cellSep = document.createElement("span");
cellSep.className = "sep";
cellSep.textContent = "·";
const readoutEl = document.getElementById("readout");
if (readoutEl) {
  readoutEl.insertBefore(cellEl, readoutEl.querySelector(".hint"));
  readoutEl.insertBefore(cellSep, cellEl);
}
function showCellId(id: number): void {
  cellEl.textContent = id < 0 ? "no cell" : `cell #${id}`;
}
showCellId(-1);

// Footer control hint — the 3D scheme (left-drag rotates, right-drag pans). The
// 2D path keeps its own "drag to pan" hint from index.html.
const hintEl = document.querySelector("#readout .hint");
if (hintEl) hintEl.textContent = "left-drag rotate · right-drag pan · scroll zoom";

const params = new URLSearchParams(window.location.search);
const requestedLayout = params.get("layout") ?? "umap3d";
/** `&morph=<layout>` auto-flies from the active layout to <layout> after boot. */
const requestedMorph = params.get("morph");

const renderer = new Renderer3D(canvas);
const camera = new Camera3D();

/** The canonical 3/4 view: ~34° yaw, ~26° pitch. A 3D embedding viewed down -Z (the
 *  identity rotation the camera boots with) reads as a flat blob — this angle is what
 *  makes the third dimension legible. Shared by the morph fly-to and figure mode so a
 *  captured plate always shows the same designed pose. */
const HERO_ROTATION: Quat = qMul(
  qFromAxisAngle([0, 1, 0], 0.6),
  qFromAxisAngle([1, 0, 0], -0.45),
);
// Boot INTO the hero pose rather than drifting into it. The comment above is not
// aspirational: the camera's identity rotation looks straight down -Z, which is
// the flat-blob read, and it is also a looser fit (d=404 vs 366 on umap3d) because
// the cloud presents a wider silhouette from there. Setting it here means the very
// first fit is computed at the pose the figure exports at.
camera.setRotation(HERO_ROTATION);

// --- theme (SPEC §FEATURE 1) ------------------------------------------------
// Read &theme=light|dark (default dark = today's look). main.ts already applied
// dataset.theme for the chrome on boot; here we drive the renderer + listener and
// expose setTheme on the __r3d seam for the verifier.
type Theme = "dark" | "light";
const initialTheme: Theme = params.get("theme") === "dark" ? "dark" : "light";
/** Each theme's DEFAULT continuous colormap (dark → magma, light → YlOrRd). Switched
 *  automatically with the theme until the user picks a colormap themselves (then their
 *  choice sticks across theme flips). */
const THEME_CMAP: Record<Theme, ContinuousColormap> = { dark: "magma", light: "ylorrd" };
let userPickedCmap = false;
/** Apply a theme everywhere: chrome tokens, renderer composite, the select, and
 *  the persisted URL param (no reload — the renderer flips live). */
function setTheme(t: Theme): void {
  const next: Theme = t === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  renderer.setTheme(next);
  // Flip the HRA body panel's 3D background to match (transparent canvas over a
  // theme-tokened stage). Guarded: bodyPanel is constructed later in this module.
  bodyPanel?.setTheme(next);
  if (themeSel && themeSel.value !== next) themeSel.value = next;
  // Follow the theme's default colormap unless the user has chosen one explicitly.
  if (!userPickedCmap) applyColormap(THEME_CMAP[next]);
  const p = new URLSearchParams(window.location.search);
  p.set("theme", next);
  history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}
/** Set the continuous colormap on the renderer + reflect it in the select. */
function applyColormap(name: ContinuousColormap): void {
  renderer.setColormap(name);
  if (cmapSel && cmapSel.value !== name) cmapSel.value = name;
}
document.documentElement.dataset.theme = initialTheme;
renderer.setTheme(initialTheme);
if (themeSel) themeSel.value = initialTheme;
applyColormap(THEME_CMAP[initialTheme]); // theme's default colormap on boot
themeSel?.addEventListener("change", () => setTheme(themeSel.value as Theme));

let mode: EncodingMode = "continuous";

/** The stride-3 PointData currently resident as the morph SOURCE (a_center). */
let activePD: PointData | null = null;

/** Frame the cloud by its measured extent rather than its bounding box. A few UMAP
 *  outliers otherwise set the zoom and the data renders small in an empty frame. */
/** Chrome that FLOATS over the canvas and therefore steals plot area: the left
 *  key rail (legend / colorbar / body card) and the right control panel. On a
 *  1600px canvas that is ~562px - 35% - which the old fit spent as if it were
 *  visible. Measured from the DOM, not hardcoded, so figure mode (which hides
 *  #panel and keeps the key) needs no special case. The hover card is deliberately
 *  NOT listed: it follows the cursor, and a framing that moved with the mouse
 *  would be neither stable nor reproducible. */
const CHROME_SELECTORS =
  "#panel, #brand, #readout, .cyto-legend, .cyto-colorbar, .cyto-body";
const CHROME_GUTTER = 16; // CSS px of air between the chrome and the marks

/** The rect the cloud should centre in. COLUMNS, not boxes: the marks are a blob
 *  and the chrome stacks in two vertical rails, so trimming horizontal bands
 *  would cost height and buy nothing. */
function contentRect(): { x: number; y: number; w: number; h: number } {
  const W = canvas.clientWidth || canvas.width;
  const H = canvas.clientHeight || canvas.height;
  let left = 0;
  let right = W;
  for (const el of document.querySelectorAll<HTMLElement>(CHROME_SELECTORS)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue; // display:none / not yet mounted
    if (r.right < W / 2) left = Math.max(left, r.right + CHROME_GUTTER);
    else if (r.left > W / 2) right = Math.min(right, r.left - CHROME_GUTTER);
  }
  // Pathological narrow window: better a cloud under the panels than a sliver.
  if (right - left < W * 0.35) return { x: 0, y: 0, w: W, h: H };
  return { x: left, y: 0, w: right - left, h: H };
}

/** Frame the cloud by its measured extent IN THE CURRENT VIEW, filling the area a
 *  reader can actually see. Outliers still render - they simply do not get to
 *  choose the zoom (see core/robust-bounds.ts). NOT cached: the extent is measured
 *  in the camera's basis, so a cache keyed on `pd` alone would hand back a stale
 *  measurement the moment the pose changes - which is precisely what figure mode
 *  does before it calls this. */
function fitRobust(pd: PointData): void {
  const e = robustViewExtent(
    pd.positions,
    pd.count,
    pd.dims,
    camera.right(),
    camera.up(),
    camera.viewDir(),
  );
  camera.fitExtent(e, contentRect());
}
/** The spine source, when present (synthetic has a single layout → no morph). */
let spine: SpineTileSource | null = null;
/** The active source (spine OR synthetic) — used for getCell metadata joins. */
let source: TileSource | null = null;

const MORPH_MS = 1400; // travel duration; camera transition runs in lockstep

// --- interaction state (Tool: Orbit / Lasso) --------------------------------
type Tool = "orbit" | "lasso";
let tool: Tool = "orbit";

// --- density underlay (P2.5): screen-space GPU-KDE field beneath the cloud ---
type DensityMode = "off" | "underlay" | "contours";
let densityMode: DensityMode = "off";

/** Switch the density underlay mode; toggle the select + push to the renderer. */
function setDensity(next: DensityMode): void {
  densityMode = next;
  if (densitySel.value !== next) densitySel.value = next;
  renderer.setDensityMode(next);
}

const store = new SelectionStore();
const hoverCard = new HoverCard();
const lassoOverlay = new LassoOverlay();
const summary = new SelectionSummary(() => clearSelection());

/** True while a lasso gesture is being drawn (suppresses orbit/dolly + hover). */
let lassoing = false;

// --- map legibility (P2): legend focus+context + auto cluster labels --------
/** The CL_label dictionary (names, optional colorSlot) once loaded; null = none. */
let clDict: CategoricalDict | null = null;
/** Pinned (clicked) category for focus+context, or null. Hover overrides transiently. */
let pinnedCat: number | null = null;
/** Per-category centroids of the active layout, cached on setData (projected per frame). */
let cachedCentroids: Centroid[] = [];
/** Bounds-sphere radius of the active layout (mirrors Camera3D.fit) — semantic-zoom anchor. */
/** Last legend rows + decluttered labels, exposed read-only via window.__r3d. */
let lastLegendRows: LegendRow[] = [];
/* The key AS SHOWN: the named types plus a single folded "Other (N types)" row.
 * The export must composite THIS, not a slice of `lastLegendRows` — slicing the raw
 * rows prints the 4th type's own name and count against the neutral swatch that all
 * folded types share, which states something false about what neutral means. */
let lastDisplayRows: LegendRow[] = [];
let lastVisibleLabels: PlacedLabel[] = [];
/** What the last declutter pass dropped, so the plate can disclose it. */
let lastLabelStats: DeclutterResult | null = null;

/** The categorical index the renderer should currently focus (pinned, or none). */
function focusFor(): number {
  return pinnedCat ?? -1;
}
/** On-screen color of a category — MUST match the renderer LUT: CORE_24[cat % 24]. */
/* Category -> series slot. Built from ABUNDANCE rank each time the legend is
 * rebuilt: the `seriesCap` most populous types take the distinct hues, everything
 * else gets the reserved neutral. Colour follows the entity (a type keeps its hue
 * regardless of focus/filter), never its position on screen. */
let catSlots = new Int32Array(256).fill(-1);
/** How many types get a distinct hue. Default is the all-pairs validated cap;
 *  `?hues=N` raises it for EXPLORATION only — past the cap the hues no longer
 *  separate under CVD, so a figure must stay at the default. */
const seriesCap = (() => {
  const raw = Number(params.get("hues"));
  return Number.isFinite(raw) && raw >= 1 && raw <= 8 ? Math.floor(raw) : SERIES_CAP;
})();

/** On-screen colour of a category — MUST match the renderer LUT (both read catSlots). */
function colorForCat(cat: number): string {
  const { series, other } = seriesPalette(renderer.themeValue);
  const slot = cat >= 0 && cat < catSlots.length ? catSlots[cat] : -1;
  return slot >= 0 && slot < series.length ? series[slot] : other;
}
/**
 * The ONE description of the continuous colour channel, used by the on-screen key
 * AND the composited export key.
 *
 * Both used to hardcode `label:"Cell value", lo:"0", hi:"1", note:"normalised"` in
 * two separate places, which could drift apart and — worse — asserted a scale the
 * app has no way to know. Nothing normalises anything: values are copied from
 * expr.f32 and merely CLAMPED in the shader. Now the endpoints come from what the
 * producer declared, or failing that from what the column actually contains, and
 * the note says which of the two it was.
 */
function continuousKey(): ContinuousKeySpec | null {
  if (!activePD) return null;
  const cmap = cmapSel.value;
  const d = buildDomain({
    key: `${spine?.manifest.version ?? "syn"}:expr`,
    channel: "expr",
    values: activePD.values,
    count: activePD.count,
    manifest: spine?.manifest ?? null,
    synthetic: isSynthetic(),
  });
  const raw = niceTicks(d.vmin, d.vmax);
  const step = raw.length > 1 ? raw[1] - raw[0] : d.vmax - d.vmin;
  return {
    label: d.label,
    colormap: cmap,
    colormapNote: colormapNote(cmap),
    stops: [...CONTINUOUS_STOPS(cmap)],
    // Fractions of the RAMP, but derived from round values in DATA units — a tick
    // at "half way along" would tell a reader nothing they can carry to a number.
    ticks: raw.map((v) => ({ t: toFraction(d, v), text: formatTick(v, step) })),
    hist: d.hist,
    histMax: d.histMax,
    note: domainNote(d),
  };
}

/**
 * The DENSITY key — the second of two 1-D keys.
 *
 * These are two keys and not one 2-D key on purpose. A bivariate key was measured
 * against this exact resolve and rejected: before the luminance lock, 157 (value,
 * density) pairs differing by more than 0.20 in value collapsed within one JND, so
 * the forward map was many-to-one and no key of any dimensionality could invert it.
 * The lock makes L* a function of density alone and hue a function of value alone,
 * which is precisely what makes TWO independent 1-D keys legitimate.
 *
 * The axis is in CELLS ALONG THE RAY, not in arbitrary units: point-spread
 * normalisation makes one cell deposit a fixed optical depth regardless of depth, so
 * tau / tauPerCell is a real count. Without that this channel would be captioned
 * "darkness rises with cell count" with a constant nobody could supply — a look, not
 * a measurement.
 */
function densityKey(): {
  ticks: { t: number; text: string }[];
  swatches: { t: number; color: string }[];
  note: string[];
} | null {
  const perCell = renderer.tauPerCellValue;
  if (!(perCell > 0)) return null;
  const ceiling = renderer.densityCeiling;
  // LOG axis, so round counts in decades — a linear tick set would put every label
  // in the bottom tenth of the ramp.
  const CANDIDATES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  // The ceiling tick is placed FIRST and is never dropped: a reader must be able to
  // tell "the display saturates here" from "the data stops here". Everything else
  // has to earn its place against it.
  // Ramp fractions. The ceiling tick needs a WIDER berth than the rest: it is
  // right-anchored (translateX(-100%)), so its face extends leftward from the end of
  // the bar instead of straddling its position, and "280+" is the longest string on
  // the axis. A single symmetric gap let 200 slide under it.
  const MIN_GAP = 0.085;
  const CEIL_GAP = 0.2;
  const ticks: { t: number; text: string }[] = [
    { t: 1, text: `${Math.round(ceiling)}+` },
  ];
  for (const n of CANDIDATES) {
    if (n > ceiling) break;
    const t = renderer.densityRampT(n);
    // A log axis crowds the low decades: at this calibration 1, 2 and 5 all land in
    // the first 14% of the ramp. Drop what cannot be read rather than printing
    // labels on top of each other.
    if (ticks.some((k) => Math.abs(k.t - t) < (k.t >= 1 ? CEIL_GAP : MIN_GAP))) continue;
    ticks.push({ t, text: String(n) });
  }
  ticks.sort((a, b) => a.t - b.t);
  const swatches = Array.from({ length: 32 }, (_, i) => {
    const t = i / 31;
    // Invert the ramp position back to a cell count so the swatch is built from the
    // same expression the shader evaluates.
    const cells = (Math.expm1(t * Math.log1p(32)) ) / perCell;
    return { t, color: renderer.densitySwatch(cells, renderer.themeValue) };
  });
  return {
    ticks,
    swatches,
    note: [
      `cells along the ray · saturates at ${Math.round(ceiling)}`,
      "hue-free: lightness carries density, hue carries value",
    ],
  };
}

/** What the plate could not label, stated on the plate. An omission a reader cannot
 *  detect is an unstated edit: the unnamed clusters look like clusters nobody
 *  considered naming. Only geometry drops names on the export path — the zoom budget
 *  is disabled there — so this reports a real spatial constraint, not a setting. */
function labelOmissionNote(): string {
  const st = lastLabelStats;
  if (!st || st.considered <= 0 || st.kept >= st.considered) return "";
  return ` · ${st.kept} of ${st.considered} cell types labelled (${st.considered - st.kept} omitted, no room)`;
}

/** Human name for a category from the dict, falling back to the raw index. */
function nameForCat(cat: number): string {
  const name = clDict?.names[cat];
  return name && name.length > 0 ? name : String(cat);
}

/** Label text for the MAP - not for the legend. A CL CURIE is an IDENTIFIER, not a
 *  name: it costs 17 glyphs of prime canvas for ~6 of meaning, and since declutter
 *  collides on MEASURED box width every extra glyph evicts a label that would have
 *  fitted. The full id stays in the legend row and the hover card. A no-op for real
 *  ontology labels, which carry no numeric prefix. */
const shortNameCache = new Map<number, string>();
function shortenCL(s: string): string {
  const m = /^[A-Za-z]+[:_]\d+[_\s]+(.+)$/.exec(s);
  return m ? m[1].replace(/_/g, " ") : s;
}
function labelTextForCat(cat: number): string {
  const hit = shortNameCache.get(cat);
  if (hit !== undefined) return hit;
  const full = nameForCat(cat);
  let short = shortenCL(full);
  if (short !== full) {
    // Uniqueness guard: LabelOverlay keys spans by TEXT, so two categories
    // shortening to the same string would silently erase one of them.
    let dupes = 0;
    for (const nm of clDict?.names ?? []) if (shortenCL(nm) === short) dupes++;
    if (dupes > 1) short = full;
  }
  shortNameCache.set(cat, short);
  return short;
}

const legend = new Legend(
  // hover: focus the hovered type; on leave, fall back to the pinned focus (or none).
  (cat) => {
    markInteract(); // legend hover counts as activity → defer idle motion
    renderer.setFocusCategory(cat ?? focusFor());
  },
  // click: toggle the pin, push focus, and mark the row.
  (cat) => {
    markInteract();
    pinnedCat = pinnedCat === cat ? null : cat;
    renderer.setFocusCategory(focusFor());
    legend.setFocus(pinnedCat);
  },
);

/** Key for the CONTINUOUS encoding; the legend keys the categorical one. */
const colorbar = new Colorbar();
const labelOverlay = new LabelOverlay();

// --- HRA body panel (reflection-8) ------------------------------------------
// A fixed-size DOM card on the left rail (below the legend) hosting the HRA 3D
// body (<ccf-body-ui-wc>). Guarded internally: a load failure shows a quiet
// placeholder and never breaks the embedding. It is NOT the #stage canvas, so
// embedding zoom/orbit can't resize or move it.
const bodyPanel = new BodyPanel();

/**
 * CLICK selection (reflection-8): map a picked cell to its synthetic body node
 * and fly the HRA body there (highlight + zoom). Returns the body-node id, or
 * null on a miss / unmappable type. SYNTHETIC mapping — see body/body-map.ts.
 */
function selectCell(id: number): string | null {
  if (id < 0 || !source) {
    bodyPanel.highlight(null);
    return null;
  }
  const rec = source.getCell(id);
  const nodeId = bodyNodeForCellType(rec.cellType);
  bodyPanel.highlight(nodeId);
  return nodeId;
}

/** Drop the pin + focus (Esc). Pure state reset; safe to call when nothing pinned. */
function clearFocus(): void {
  if (pinnedCat === null) return;
  pinnedCat = null;
  renderer.setFocusCategory(-1);
  legend.setFocus(null);
}

/**
 * Recompute centroids + legend rows from the active PointData. Called on every
 * setData (initial layout, morph commit, __r3d.setData). Centroids are cached
 * here and projected to screen per-frame so labels track the orbit.
 */
function rebuildLegibility(): void {
  if (!activePD) return;
  cachedCentroids = computeCentroids(activePD);

  const total = activePD.count || 1;
  const rows: LegendRow[] = cachedCentroids.map((c) => ({
    category: c.category,
    name: nameForCat(c.category),
    color: colorForCat(c.category),
    count: c.count,
    pct: (c.count / total) * 100,
  }));
  rows.sort((a, b) => b.count - a.count || a.category - b.category);

  // Assign the distinct hues to the most populous types; everything else folds to
  // the reserved neutral. Done here because this is where abundance is known, and
  // re-done whenever the data changes so the mapping always matches what is drawn.
  catSlots = new Int32Array(256).fill(-1);
  rows.forEach((r, i) => {
    if (i < seriesCap && r.category >= 0 && r.category < catSlots.length) {
      catSlots[r.category] = i;
    }
  });
  renderer.setCategorySlots(catSlots);

  // The key must describe the encoding: with the series cap, only the top
  // `seriesCap` types carry a distinct hue, so listing 48 rows — 45 of them the same
  // grey — would claim an identity the colour channel does not carry. Named rows for
  // the hued types, then one aggregate row for the rest.
  const named = rows.slice(0, seriesCap);
  const rest = rows.slice(seriesCap);
  const displayRows: LegendRow[] =
    rest.length === 0
      ? rows
      : [
          ...named,
          {
            category: -1, // not focusable: it stands for many types
            name: `Other (${rest.length} types)`,
            color: seriesPalette(renderer.themeValue).other,
            count: rest.reduce((s, r) => s + r.count, 0),
            pct: rest.reduce((s, r) => s + r.pct, 0),
          },
        ];

  lastLegendRows = rows;
  lastDisplayRows = displayRows;
  // The legend is a CATEGORICAL key (one swatch per cell type). Showing it while the
  // marks are coloured by a continuous channel states an encoding the plot is not
  // using — a factual error in a figure, not a layout nit. Key follows the encoding.
  if (mode === "categorical") {
    colorbar.hide();
    legend.show(displayRows);
    legend.setFocus(pinnedCat);
  } else {
    // Continuous marks need a SCALE, not a list of type names. Exactly one key is
    // ever on screen, and it always describes the encoding actually in use.
    legend.hide();
    const k = continuousKey();
    colorbar.setColormap(cmapSel.value as ContinuousColormap);
    if (k) {
      colorbar.show({
        label: k.label,
        ticks: k.ticks,
        hist: k.hist,
        histMax: k.histMax,
        colormapNote: k.colormapNote,
        note: k.note,
        density: densityKey(),
      });
    }
  }
  // setData never disturbs the focus uniform, but re-assert it defensively.
  renderer.setFocusCategory(focusFor());
}

/** Few labels when zoomed out, up to all-present when pushed in (semantic zoom). */
/** Label box height in CSS px — must track `.cyto-label` line-height in
 *  ui/map-legibility.css. Used for box-based declutter. */
const LABEL_BOX_H = 16;

/** Measure a label's rendered width once per string and cache it. Declutter runs
 *  every frame, so this must not re-measure; the label face is fixed, so a string's
 *  width never changes within a session. */
const labelWidthCache = new Map<string, number>();
let labelMeasureCtx: CanvasRenderingContext2D | null = null;
function measureLabelWidth(text: string): number {
  const hit = labelWidthCache.get(text);
  if (hit !== undefined) return hit;
  if (!labelMeasureCtx) {
    labelMeasureCtx = document.createElement("canvas").getContext("2d");
    if (labelMeasureCtx) {
      // Mirror .cyto-label: 11px / 500 weight, same stack as the overlay.
      const probe = document.createElement("div");
      probe.className = "cyto-label";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      labelMeasureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      probe.remove();
    }
  }
  const w = labelMeasureCtx ? labelMeasureCtx.measureText(text).width : text.length * 6.2;
  labelWidthCache.set(text, w);
  return w;
}

const MIN_LABELS = 8;
function labelMaxCount(present: number): number {
  if (present <= MIN_LABELS) return present;
  // Relative to the distance the FIT chose, not to a bounds radius. Anchoring on
  // the geometry meant the constants encoded how loose the old fit happened to be:
  // tightening the fit from 625 to 366 on umap3d would have taken the label count
  // from 23 straight to 42 without anyone touching this function. ratio == 1 is
  // "as the plate was framed"; dollying in shrinks it toward 0.
  const ratio = camera.distance / Math.max(1e-6, camera.fitDistance);
  const REF_OUT = 1.4; // at/past the framed distance -> MIN_LABELS
  const REF_IN = 0.32; // dollied well in -> every present type
  const t = clamp((REF_OUT - ratio) / (REF_OUT - REF_IN), 0, 1);
  return Math.max(MIN_LABELS, Math.round(MIN_LABELS + t * (present - MIN_LABELS)));
}

/** Project cached centroids → CSS px, declutter by zoom, push to the overlay. */
function updateLabels(forPlate = false): PlacedLabel[] {
  if (cachedCentroids.length === 0) {
    labelOverlay.clear();
    lastVisibleLabels = [];
    return lastVisibleLabels;
  }
  // worldToScreen returns DEVICE pixels for the camera's CURRENT viewport, so the
  // divisor must be the camera's dpr — not the window's. During a figure export the
  // camera is deliberately set to the export scale; using the global dpr() here put
  // every label at scale/window_dpr times its true position, scattering them off the
  // clusters they name.
  const d = camera.devicePixelRatio;
  const cssW = canvas.clientWidth || canvas.width / d;
  const cssH = canvas.clientHeight || canvas.height / d;
  const cands: LabelCandidate[] = cachedCentroids.map((c) => {
    const [xDev, yDev, depth] = camera.worldToScreen(c.centroid);
    const x = xDev / d;
    const y = yDev / d;
    return {
      category: c.category,
      text: labelTextForCat(c.category),
      x,
      y,
      count: c.count,
      visible: depth >= 0 && depth <= 1 && x >= 0 && x <= cssW && y >= 0 && y <= cssH,
      w: measureLabelWidth(labelTextForCat(c.category)),
      h: LABEL_BOX_H,
    };
  });
  const res = declutterLabelsWithStats(cands, {
    // Clear gap between label BOXES (declutter is box-based, not centre-based),
    // so this is a small breathing space.
    minGapPx: 10,
    // PLATE: no budget. labelMaxCount is a SEMANTIC-ZOOM device that thins names
    // as you dolly out. On the export path its input is pinned (camera.distance
    // == fitDistance by construction), so it degenerates to a constant and
    // silently deletes roughly half the names. A plate that drops 25 of 48 type
    // names without saying so has made an unstated edit to the data. Geometry
    // still limits it - collisions are real - but the budget is not a figure
    // parameter.
    maxCount: forPlate ? cands.length : labelMaxCount(cands.length),
  });
  const placed = res.labels;
  lastLabelStats = res;
  labelOverlay.update(placed);
  lastVisibleLabels = placed;
  return placed;
}

/** Push the current store selection into the renderer + refresh the summary. */
function applySelection(): void {
  if (store.isEmpty) {
    renderer.clearSelection();
    summary.hide();
    return;
  }
  renderer.setSelection(store.ids);
  if (activePD && source) summary.show(store.summarize(activePD, source));
}

/** Drop the selection everywhere (store, renderer dimming, summary card). */
function clearSelection(): void {
  store.clear();
  renderer.clearSelection();
  summary.hide();
  lassoOverlay.clear();
}

/** Run the lasso hit-test over a CSS-px polygon, commit + show. Returns count. */
function runLasso(polygonCssPx: ReadonlyArray<Point2>): number {
  if (!activePD) return 0;
  const ids = lassoSelect(polygonCssPx, activePD, camera, dpr());
  store.set(ids);
  applySelection();
  return store.count;
}

/** Switch the active tool; toggle the select + (defensively) end any gesture. */
function setTool(next: Tool): void {
  tool = next;
  if (toolSel.value !== next) toolSel.value = next;
  if (next !== "lasso" && lassoing) {
    lassoing = false;
    lassoOverlay.clear();
  }
  hoverCard.hide();
}

// --- sizing -----------------------------------------------------------------
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // Keep the camera's projection (and thus worldToScreen for the labels) in sync
  // with the CSS-px viewport on every resize, not just on layout changes.
  camera.setViewport(canvas.clientWidth || w / dpr, canvas.clientHeight || h / dpr, dpr);
}
resize();
new ResizeObserver(resize).observe(canvas);

// --- figure mode ------------------------------------------------------------
/** True while the app is pinned for figure capture. */
let figureMode = false;

/**
 * Pin the app for reproducible figure capture. Camera idle-orbit, cluster spin and
 * the FPS counter all integrate wall-clock time, so two captures of the "same" view
 * differ. This freezes those inputs and hides app chrome (controls, hint, FPS/zoom
 * readout) so the frame contains only figure content. Reversible.
 */
function setFigureMode(on: boolean): boolean {
  figureMode = on;
  document.body.classList.toggle("cyto-figure-mode", on);
  if (on) {
    // FLUSH LAYOUT before anything measures the DOM. The class above hides #panel,
    // and both contentRect() (via fitRobust) and measureLabelWidth() read computed
    // geometry — so they must see the post-toggle layout, not the pre-toggle one.
    // NOTE: this is a guard, not a fix for anything observed. It was added while
    // chasing a first-export difference that turned out to be font-weight synthesis
    // (see ui/figure-composite.ts FACE); measured, it changed no pixels. Kept because
    // measuring geometry immediately after a display-changing class toggle is a real
    // hazard, and getBoundingClientRect's implicit reflow is easy to lose in a refactor.
    void document.body.offsetHeight;
    // Freezing motion is not enough for reproducibility: the idle orbit has already
    // drifted the pose by the time anyone calls this, so two captures of the "same"
    // view differ. Snap to the canonical pose — no transition, so the very next
    // rendered frame is the one that gets exported.
    // A morph in flight is the one time-varying input that freezing motion does NOT
    // cover, and it is the worst: mid-morph positions are a smoothstep blend of two
    // arbitrary coordinate systems, so they correspond to no embedding at all. Commit
    // it to the target layout rather than capturing a blend.
    if (morph) stepMorph(morph.duration - morph.elapsed);
    if (activePD) {
      camera.setPose({ ...camera.getPose(), rotation: HERO_ROTATION });
      fitRobust(activePD);
    }
    if (motionSel && motionSel.value !== "off") {
      motionSel.value = "off";
      motionSel.dispatchEvent(new Event("change"));
    }
    if (spinSel && spinSel.value !== "off") {
      spinSel.value = "off";
      spinSel.dispatchEvent(new Event("change"));
    }
  }
  return figureMode;
}

/**
 * Is the loaded data real?
 *
 * ABSENCE IS MEANINGFUL. This used to read `!spine`, i.e. "a spine was loaded, so
 * the data is real" — which is false and failed in the worst direction: the SHIPPED
 * spine is seeded gaussians with fabricated CL CURIEs (public/spine/dict/CL_label.json),
 * so the plate dropped its SYNTHETIC disclosure precisely when it was serving
 * synthetic data. Nothing about the app can distinguish a real spine from a seeded
 * one by inspection — 453,251 gaussian points look exactly like a dataset — so the
 * truth has to be ASSERTED by whatever built the tiles. Until a manifest positively
 * declares `provenance.synthetic: false`, the figure says synthetic.
 */
function isSynthetic(): boolean {
  const p = spine?.manifest.provenance;
  return !p || p.synthetic !== false;
}

/** Provenance for the figure's footer. A plate that does not state n and the
 *  embedding is not reportable; one built on synthetic data must say so on its face. */
function figureCaption(): string {
  const n = activePD?.count ?? 0;
  const layout = spine?.layout ?? "synthetic";
  const synth = isSynthetic() ? " · SYNTHETIC DATA — not for publication" : "";
  return `n = ${n.toLocaleString()} cells · ${layout} · 3D${synth}`;
}
function figureCaptionNote(): string {
  // The DARKNESS channel means different things per blend mode and this note is the
  // only place the plate says which. "sum" integrates optical depth along the ray, so
  // darkness rises with cell count. "peak" is gl.MAX normalised to ONE cell's ceiling
  // — one cell and five hundred print identically. Shipping the Accumulate control
  // without this line would let a user produce a presence map captioned as a density
  // map, which is the dishonest figure the whole panel is guarding against.
  // In SUM mode the density key states the channel precisely, in real cell counts,
  // so repeating "darkness rises with count" here would be redundant. PEAK has no
  // density axis at all — it draws every occupied pixel at one ink weight — so that
  // is the case this line exists for.
  return renderer.blendModeValue === "peak"
    ? "darkness = presence (peak blend — NOT a count)"
    : "";
}

// --- figure export ----------------------------------------------------------
/** A pending export request, consumed by the render loop. The capture MUST happen
 *  in the same task as the draw: the context is created with
 *  preserveDrawingBuffer:false (correct for runtime — see core/device3d.ts), so the
 *  backing buffer is valid only until the frame yields. Setting preserveDrawingBuffer
 *  globally would cost memory bandwidth on every frame just to serve the rare export. */
/** A queued facet-grid export. Serviced on the render loop for the same reason a
 *  single-frame export is: the GL backing store may only be resized between frames. */
let pendingFacets: {
  scale: number;
  cols: number;
  max: number;
  resolve: (b: Blob | null) => void;
} | null = null;

/**
 * Export the small-multiples plate: one panel per cell type, the whole cloud as
 * neutral context, that type inked on top.
 *
 * WHY THIS PANEL EXISTS
 * ---------------------
 * The colour channel carries `seriesCap` (3) separable hues plus one reserved
 * neutral, because 48 perceptually distinct hues do not exist — the 45 folded types
 * are honestly, but completely, anonymous on the hero plate. Faceting is how the
 * field resolves that: identity moves from the colour channel to POSITION IN A GRID,
 * which has no capacity limit and no colour-vision failure mode.
 *
 * Every panel shares one camera pose, set once before the loop and never touched
 * inside it, so the panels are directly comparable and the grid reads as one object.
 */
export function exportFacetGrid(scale = 2, cols = 6, max = 48): Promise<Blob | null> {
  return new Promise((resolve) => {
    pendingFacets = {
      scale: Math.max(1, Math.min(8, scale)),
      cols: Math.max(1, Math.min(12, cols)),
      max: Math.max(1, Math.min(96, max)),
      resolve,
    };
  });
}

/** Chrome refuses a canvas over ~2^28 px, and over 16384 in either dimension. A plate
 *  that trips either limit comes back blank rather than erroring, so clamp up front. */
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_AREA = 268_000_000;

function servicePendingFacets(): void {
  const req = pendingFacets;
  if (!req) return;
  pendingFacets = null;

  if (!activePD || mode !== "categorical") {
    console.error("[cytolume] facet export needs categorical mode and loaded data");
    req.resolve(null);
    return;
  }

  // Facet by DESCENDING abundance, the same order the legend uses, so panel position
  // carries the same ranking a reader has already learned from the hero plate.
  const cats = lastLegendRows.slice(0, req.max).map((r) => r.category).filter((c) => c >= 0);
  if (!cats.length) {
    req.resolve(null);
    return;
  }

  const prevW = canvas.width;
  const prevH = canvas.height;
  const cssW = canvas.clientWidth || prevW;
  const cssH = canvas.clientHeight || prevH;
  const prevFigure = figureMode;

  try {
    setFigureMode(true); // ONCE, before the loop: snaps the pose and commits any morph

    const rows = Math.ceil(cats.length / req.cols);
    // Panels are square-ish: a tall thin panel wastes the plate on empty background,
    // since a fitted embedding is roughly isotropic.
    let pw = Math.round((cssW / req.cols) * req.scale);
    let ph = Math.round(pw * 0.82);
    const fit = Math.min(
      MAX_CANVAS_DIM / (pw * req.cols),
      MAX_CANVAS_DIM / (ph * rows),
      Math.sqrt(MAX_CANVAS_AREA / (pw * req.cols * ph * rows)),
      1,
    );
    if (fit < 1) {
      pw = Math.max(1, Math.floor(pw * fit));
      ph = Math.max(1, Math.floor(ph * fit));
      console.warn(`[cytolume] facet plate clamped to ${pw}x${ph} per panel (canvas limit)`);
    }

    // Reserve a strip BELOW the grid for the provenance line. Without it the caption
    // draws over the bottom-left panel's marks — it sat inside that panel's plot area,
    // which both obscures data and reads as if it labelled that one panel.
    const gutter = Math.round(20 * req.scale);
    const plate = document.createElement("canvas");
    plate.width = pw * req.cols;
    plate.height = ph * rows + gutter;
    const pctx = plate.getContext("2d");
    if (!pctx) {
      req.resolve(null);
      return;
    }
    pctx.fillStyle = renderer.themeValue === "light" ? "#ffffff" : "#0a0d13";
    pctx.fillRect(0, 0, plate.width, plate.height);

    // Resize the GL backing store ONCE to panel size; the camera keeps CSS-px extents
    // so mark sizing is derived at the panel's own resolution, not the screen's.
    canvas.width = pw;
    canvas.height = ph;
    camera.setViewport(pw / req.scale, ph / req.scale, req.scale);
    // Re-fit: a facet panel is a different aspect from the window, and unlike the
    // window it carries no floating chrome - so its content rect is the whole
    // panel. fitExtent fits the two screen axes independently, so reusing a
    // distance measured for the window would under-fill or clip these. Every panel
    // shares ONE fit, so cross-panel position stays comparable - the whole point
    // of a facet grid.
    {
      const fe = robustViewExtent(
        activePD.positions,
        activePD.count,
        activePD.dims,
        camera.right(),
        camera.up(),
        camera.viewDir(),
      );
      camera.fitExtent(fe, { x: 0, y: 0, w: pw / req.scale, h: ph / req.scale });
    }

    const total = activePD.count;
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      renderer.renderFacet(camera, cat);
      const ox = (i % req.cols) * pw;
      const oy = Math.floor(i / req.cols) * ph;
      pctx.drawImage(canvas, ox, oy);
      const row = lastLegendRows.find((r) => r.category === cat);
      drawFacetChrome(pctx, {
        x: ox,
        y: oy,
        w: pw,
        h: ph,
        scale: req.scale,
        theme: renderer.themeValue,
        name: row ? row.name : nameForCat(cat),
        count: row ? row.count : 0,
        pct: row ? row.pct : 0,
        // The ink hue is only meaningful for the hued types; the folded ones share the
        // neutral, so the swatch must state what the panel actually drew.
        color: colorForCat(cat),
      });
    }

    drawFacetCaption(pctx, plate.width, plate.height, req.scale, renderer.themeValue,
      `${figureCaption()} · ${cats.length} of ${lastLegendRows.length} cell types · grey = all ${total.toLocaleString()} cells`);

    plate.toBlob((b) => req.resolve(b), "image/png");
  } catch (err) {
    console.error("[cytolume] facet export failed", err);
    req.resolve(null);
  } finally {
    canvas.width = prevW;
    canvas.height = prevH;
    camera.setViewport(cssW, cssH, dpr());
    if (!prevFigure) setFigureMode(false);
    renderer.render(camera, mode);
  }
}

let pendingExport: { scale: number; resolve: (b: Blob | null) => void } | null = null;

/**
 * Render one frame at `scale`× the on-screen backing size and return it as a PNG
 * blob. At scale 3 a 1600×900 viewport yields 4800×2700 — ~16×9 in at 300 dpi,
 * which clears Nature's raster floor for a full-width figure.
 */
export function exportFigure(scale = 3): Promise<Blob | null> {
  return new Promise((resolve) => {
    // WAIT FOR FONTS. The composited key, labels and caption are Canvas2D TEXT, and
    // Canvas2D resolves `ctx.font` against whatever the document's font set has
    // loaded AT DRAW TIME. Before `document.fonts` settles, the FACE constant
    // ('"Inter", "Helvetica Neue", Arial, sans-serif') falls back to a different
    // face. NOTE: measured, this was NOT the cause of the first-export difference
    // that prompted it — that was font-WEIGHT synthesis (see ui/figure-composite.ts
    // FACE) and awaiting fonts changed no pixels. Kept as a guard: drawing Canvas2D
    // text before the font set settles is a genuine way to get a fallback face into
    // a plate, and it costs one already-resolved promise.
    void document.fonts.ready.then(() => {
      pendingExport = { scale: Math.max(1, Math.min(8, scale)), resolve };
    });
  });
}

/** Run the queued export: grow the backing store, draw, read back, restore. */
function servicePendingExport(): void {
  const req = pendingExport;
  if (!req) return;
  pendingExport = null;

  // Never write a plate of blended coordinates. setFigureMode commits any morph, so
  // reaching here with one live means the export bypassed it — fail loudly rather
  // than emit a figure whose positions mean nothing.
  if (morph || renderer.morphFactor !== 0) {
    console.error("[cytolume] figure export refused: a layout morph is in flight");
    req.resolve(null);
    return;
  }

  const prevW = canvas.width;
  const prevH = canvas.height;
  const cssW = canvas.clientWidth || prevW;
  const cssH = canvas.clientHeight || prevH;
  // PIN THE POSE. Without this the hero plate captured whatever the idle auto-orbit
  // had drifted to, so two exports of identical data were NOT byte-identical — the
  // determinism contract this whole path is built on. The facet export already did
  // it; the hero export did not, and the only reason it was visible at all is that
  // the render stamp records the camera quaternion, so two plates disagreed on paper.
  // setFigureMode also commits any morph, kills motion and cluster spin, and snaps to
  // HERO_ROTATION — exactly the inputs that must not vary between runs.
  const prevFigureMode = figureMode;
  try {
    if (!prevFigureMode) setFigureMode(true);
    // PRINT SUBSTRATE. The screen substrate (#EEF0F3) is a UI chrome colour chosen
    // to avoid halation on an emissive display; paper is white. Inheriting the
    // screen's tone made the plate print as a grey rectangle. Only the light theme
    // can take it — white paper under an emissive resolve is a white rectangle.
    const printable = renderer.themeValue === "light";
    if (printable) renderer.setSubstrate("print");
    canvas.width = Math.floor(cssW * req.scale);
    canvas.height = Math.floor(cssH * req.scale);
    // Camera keeps CSS-px extents; only the sample density changes.
    camera.setViewport(cssW, cssH, req.scale);
    renderer.render(camera, mode);
    // Labels are projected from the CURRENT camera, so refresh them against the
    // export camera — otherwise the composited labels sit at the previous pose.
    const labels = updateLabels();

    // Composite the key onto the raster. A bare canvas.toBlob() captures the marks
    // and nothing else (legend/colorbar/labels are DOM), which is not a figure.
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) {
      canvas.toBlob((b) => req.resolve(b), "image/png");
    } else {
      ctx.drawImage(canvas, 0, 0);
      compositeFigure(ctx, {
        scale: req.scale,
        cssW,
        cssH,
        theme: renderer.themeValue,
        labels: labels.map((l) => ({ text: l.text, x: l.x, y: l.y, opacity: l.opacity })),
        legend:
          mode === "categorical"
            ? lastDisplayRows.map((r) => ({
                name: r.name,
                color: r.color,
                count: r.count,
                pct: r.pct,
              }))
            : null,
        // The PLATE must carry the same key the instrument shows. This block used to
        // hardcode label "Cell value" and lo/hi "0"/"1", so every exported figure
        // asserted a clean calibrated 0..1 scale that the app explicitly refuses to
        // assert — the honesty work discarded at the one moment it gets published.
        colorbar:
          mode === "continuous" && continuousKey()
            ? (() => {
                const k = continuousKey()!;
                return {
                  label: k.label,
                  stops: k.stops,
                  ticks: k.ticks,
                  hist: k.hist,
                  histMax: k.histMax,
                  colormapNote: k.colormapNote,
                  note: [...k.note, figureCaptionNote()].filter(Boolean),
                  density: densityKey(),
                };
              })()
            : null,
        substrate: renderer.substrateHex,
        caption: `${figureCaption()}${labelOmissionNote()}`,
        renderStamp: figureRenderStamp(),
      });
      out.toBlob((b) => req.resolve(b), "image/png");
    }
  } catch (err) {
    console.error("[cytolume] figure export failed", err);
    req.resolve(null);
  } finally {
    canvas.width = prevW;
    canvas.height = prevH;
    resize();
    // Give the SCREEN its substrate back — print is an export-only choice.
    renderer.setSubstrate(renderer.themeValue === "light" ? "screen-light" : "screen-dark");
    // Only leave figure mode if WE entered it; a caller that pinned it deliberately
    // (window.__r3d.figureMode(true) before a batch of exports) keeps its state.
    if (!prevFigureMode) setFigureMode(false);
  }
}

/** Ensure a 3D PointData. If the chosen layout is 2D (or missing), lift it to
 *  z=0 so the 3D renderer always has stride-3 positions to draw. */
function as3D(pd: PointData): PointData {
  if (pd.dims === 3) return pd;
  const xyz = new Float32Array(pd.count * 3);
  for (let i = 0; i < pd.count; i++) {
    xyz[i * 3] = pd.positions[i * 2];
    xyz[i * 3 + 1] = pd.positions[i * 2 + 1];
    xyz[i * 3 + 2] = 0;
  }
  const [minX, minY, maxX, maxY] = pd.bounds;
  return {
    count: pd.count,
    dims: 3,
    positions: xyz,
    values: pd.values,
    categories: pd.categories,
    ids: pd.ids,
    bounds: [minX, minY, 0, maxX, maxY, 0],
  };
}

/** Push the active layout into the renderer + frame the camera on its bounds. */
function applyActive(source: TileSource): void {
  const pd = as3D(source.getActivePointData());
  activePD = pd;
  renderer.setData(pd);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  camera.setViewport(canvas.width / dpr, canvas.height / dpr, dpr);
  fitRobust(pd);
  countEl.textContent = `${pd.count.toLocaleString()} cells`;
  rebuildLegibility();
}

// --- morph (SPEC §MORPH) ----------------------------------------------------

/**
 * Align `to` into `from`'s instance order via the stable cell_id, producing the
 * stride-3 target-position buffer the renderer's `a_posTo` consumes. Both inputs
 * are dims-3 (as3D already z-lifted any 2D layout → the 2D→3D bridge is implicit:
 * a 2D source sits at z=0 and lerps up into the 3D target). A cell absent from
 * the target stays put (target := its own source position) so nothing teleports.
 */
function alignTargetPositions(from: PointData, to: PointData): Float32Array {
  const out = new Float32Array(from.count * 3);
  const index = new Map<number, number>();
  for (let j = 0; j < to.count; j++) index.set(to.ids[j], j);
  for (let i = 0; i < from.count; i++) {
    const o = i * 3;
    const j = index.get(from.ids[i]);
    if (j === undefined) {
      out[o] = from.positions[o];
      out[o + 1] = from.positions[o + 1];
      out[o + 2] = from.positions[o + 2];
    } else {
      const p = j * 3;
      out[o] = to.positions[p];
      out[o + 1] = to.positions[p + 1];
      out[o + 2] = to.positions[p + 2];
    }
  }
  return out;
}

/** Union of two 6-tuple bounds — used so near/far covers both layouts mid-flight. */
function unionBounds(a: number[], b: number[]): number[] {
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
  ];
}

interface MorphState {
  toPD: PointData; // the target layout (dims-3) we commit to on completion
  toLayout: string;
  elapsed: number;
  duration: number;
}
let morph: MorphState | null = null;

/**
 * Start a layout morph from the resident layout to `toLayout`. Aligns the target
 * by cell_id, uploads it as `a_posTo`, and kicks BOTH the renderer's morphFactor
 * (advanced in the frame loop) AND a Camera3D transition that settles on the
 * target framing with a gentle 3/4 orbit — all on the one RAF clock. Returns
 * false when the morph can't run (no spine, unknown/identical layout).
 */
async function startMorph(toLayout: string): Promise<boolean> {
  if (!spine || !activePD || morph) return false;
  if (!spine.manifest.layouts[toLayout] || toLayout === spine.layout) return false;

  const toPD = as3D(await spine.ensureLayout(toLayout));

  const aligned = alignTargetPositions(activePD, toPD);
  renderer.setMorphTarget(aligned);

  // Camera flies in lockstep: frame the UNION (so near/far never clips either
  // layout), then aim target/distance at the target layout with a 3/4 orbit so
  // the 3D structure of the destination reads clearly at the end of the fly.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  camera.setViewport(canvas.width / dpr, canvas.height / dpr, dpr);
  const uni = unionBounds(activePD.bounds, toPD.bounds);
  camera.fit(uni); // sets a generous boundsRadius covering both
  camera.fit(toPD.bounds); // read the target framing
  const toTarget = [...camera.target] as [number, number, number];
  const toDistance = camera.distance;
  camera.fit(uni); // restore boundsRadius to the union for safe near/far
  const orbit: Quat = HERO_ROTATION;
  camera.transitionTo({ target: toTarget, distance: toDistance, rotation: orbit }, MORPH_MS);

  morph = { toPD, toLayout, elapsed: 0, duration: MORPH_MS };
  markInteract(); // a morph + camera transition just started → hold off idle motion
  if (layoutRow.style.display !== "none") layoutSel.disabled = true;
  return true;
}

/** Advance the morph clock; commit to the target layout when it reaches 1. */
function stepMorph(dtMs: number): void {
  if (!morph) return;
  morph.elapsed += dtMs;
  const t = clamp(morph.elapsed / morph.duration, 0, 1);
  renderer.morphFactor = t; // the vertex shader eases it with smoothstep
  if (t >= 1) {
    // Commit: the target becomes the resident layout; a_posTo resets to it and
    // morphFactor → 0, so subsequent orbits/dollies act on the target cloud.
    if (spine) spine.setLayout(morph.toLayout);
    activePD = morph.toPD;
    renderer.setData(morph.toPD);
    // setData resets per-instance selection; re-apply so dimming survives morph.
    if (!store.isEmpty) renderer.setSelection(store.ids);
    // Recompute centroids + legend counts for the layout we just committed to.
    rebuildLegibility();
    if (layoutRow.style.display !== "none") {
      layoutSel.value = morph.toLayout;
      layoutSel.disabled = false;
    }
    morph = null;
  }
}

// --- interaction (left-drag orbit · right-drag pan · wheel dolly) ------------
let dragging = false; // left-button drag → orbit (rotate the 3D scene)
let panning = false; // right-button (or shift+left) drag → pan (flat translate)
let lastX = 0;
let lastY = 0;
// Click-vs-orbit discrimination (reflection-8): a left press+release with
// negligible cursor travel is a CLICK (select the cell), not an orbit-drag.
let downClientX = 0;
let downClientY = 0;
const CLICK_SLOP_PX = 5; // max cursor travel (CSS px) still counted as a click
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

// --- idle "alive" auto-orbit (SPEC §FEATURE 2, 3D-only) ---------------------
// After ~2.5s of no interaction the scene gently auto-orbits: a calm constant
// yaw plus a tiny sinusoidal pitch bob, eased in over ~1s so it starts smoothly
// and never jolts. ANY interaction resets `lastInteract`, which drops the idle
// gate on the very next frame (a clean stop — the user is now driving).
const IDLE_MS = 2500; // quiet time before motion begins
const IDLE_RAMP_MS = 1000; // ease-in window after motion becomes eligible
const IDLE_YAW_DEG_PER_SEC = 6; // calm turntable yaw (~4–8°/s band)
const IDLE_PITCH_AMP_DEG = 3; // gentle up/down drift amplitude
const IDLE_PITCH_PERIOD_MS = 9000; // slow bob period
// Camera3D.rotateByPixels maps 0.008 rad per CSS-px (its private rotateSpeed);
// invert that to turn a desired angle (deg) into the pixel delta it consumes.
const ROTATE_DEG_PER_PX = 0.008 * (180 / Math.PI); // ≈0.4584 deg/px
const ROTATE_PX_PER_DEG = 1 / ROTATE_DEG_PER_PX; // ≈2.182 px/deg

// Motion config (the auto-animation = camera drift + cluster spin):
//   "always" = non-stop (DEFAULT): runs continuously, pausing ONLY during an
//              active drag/pan/lasso/morph. Hovering does NOT stop it.
//   "idle"   = classic: runs only after IDLE_MS of NO interaction (hover pauses it).
//   "off"    = no motion.
type MotionMode = "off" | "idle" | "always";
let motionMode: MotionMode = "always";
let idleActive = false; // true on frames where motion is actually applied
let lastInteract = performance.now(); // reset by ANY interaction → the "idle" clock
let lastManipulate = performance.now(); // reset by ACTIVE drag/wheel → "always" resume ramp
let spinEnabled = true; // per-cluster auto-spin toggle, independent of the camera Motion
let idlePitchPrev = 0; // last applied pitch offset (deg) → bob is a delta
let idleYawPrev = 0; // last applied yaw offset (deg) for the 2D bounded sway

// A flat (2D) layout lifted to z=0 looks wrong when 3D-orbited — it tilts edge-on
// into a line. For those, idle motion is a BOUNDED SWAY (yaw + pitch oscillate on
// different periods, so the map gently floats / circles, always roughly face-on)
// instead of the 3D turntable.
const IDLE_2D_YAW_AMP_DEG = 7;
const IDLE_2D_YAW_PERIOD_MS = 13000;
const IDLE_2D_PITCH_AMP_DEG = 4;
const IDLE_2D_PITCH_PERIOD_MS = 9000;

// Per-cluster idle spin (SPEC "living galaxy"): ON TOP of the camera motion, each
// cell-type cluster slowly rotates about its OWN centroid. A calm rate; eases in
// with the same `ramp`, freezes on interaction (the renderer resets it via setData
// on a layout change/morph). Axis is set per-frame by dimensionality below.
const SPIN_DEG_PER_SEC = 12;

/** True when the resident layout is 2-D (a z=0 plane in the 3D view). The
 *  synthetic fallback is a flat cloud, so treat it as 2-D too. */
function activeIs2D(): boolean {
  if (!spine) return true;
  return spine.manifest.layouts[spine.layout]?.dims === 2;
}

/** Reset the idle clock — called by every interaction; stops motion next frame. */
function markInteract(): void {
  lastInteract = performance.now();
}

// Capture-phase listeners that ONLY reset the idle clock (logic stays in the
// dedicated handlers below). Covers pointer drag/hover, wheel dolly, keys, and —
// because the legend/labels are DOM overlays whose events bubble to window —
// legend hover + lasso too. Passive so they never block the real handlers.
for (const ev of ["pointerdown", "pointermove", "pointerup", "wheel", "keydown"] as const) {
  window.addEventListener(ev, markInteract, { passive: true, capture: true });
}

/** Set the auto-animation mode: sync the select, persist &motion, and reset the
 *  resume ramp so it eases back in cleanly from a mode change. */
function setMotion(m: MotionMode): void {
  motionMode = m;
  if (motionSel.value !== m) motionSel.value = m;
  if (m === "off") idleActive = false;
  lastManipulate = performance.now(); // "always" eases in from rest
  lastInteract = performance.now(); // "idle" waits IDLE_MS before resuming
  const p = new URLSearchParams(window.location.search);
  p.set("motion", m);
  history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

/** Toggle the per-cluster auto-spin (independent of the camera Motion). Off
 *  un-spins the clusters immediately (resets the renderer spin angle) + persists. */
function setSpin(on: boolean): void {
  spinEnabled = on;
  const v = on ? "on" : "off";
  if (spinSel.value !== v) spinSel.value = v;
  if (!on) renderer.spinAngle = 0; // clusters snap back to their un-spun positions
  const p = new URLSearchParams(window.location.search);
  p.set("spin", v);
  history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

/**
 * Per-frame idle motion. Gates on: enabled, >IDLE_MS quiet, not dragging, not
 * mid-lasso, not morphing, not in a camera transition, tool=orbit. When active,
 * applies a constant yaw + a small sinusoidal pitch bob via rotateByPixels, eased
 * in over IDLE_RAMP_MS so the turntable spins up smoothly. dt-based → frame-rate
 * independent. `now`/`dt` are ms from the render clock.
 */
function stepIdle(now: number, dtMs: number): void {
  // An ACTIVE manipulation (drag/pan/lasso/morph/transition) pauses ALL auto-motion
  // — you can't auto-orbit while hand-orbiting. Plain hover is NOT a manipulation.
  const manipulating =
    dragging || panning || lassoing || morph !== null || camera.isTransitioning;
  if (manipulating) lastManipulate = now;

  const dtSec = Math.min(dtMs, 100) / 1000; // clamp huge dt after a tab stall
  // Continuous ease-in: ramp up over IDLE_RAMP_MS after the last manipulation
  // (hover never resets it). Shared by the spin + the "always" camera mode.
  const contLin = clamp((now - lastManipulate) / IDLE_RAMP_MS, 0, 1);
  const contRamp = contLin * contLin * (3 - 2 * contLin);

  // --- Per-cluster auto-spin (INDEPENDENT of the camera Motion): runs whenever
  //     enabled and not manipulating. The GPU rotates each cell about its category
  //     centroid; axis by dimensionality — 2D spins in-plane, 3D turns like tops. ---
  let spinning = false;
  if (spinEnabled && !manipulating) {
    renderer.spinAxis = activeIs2D() ? [0, 0, 1] : [0, 1, 0];
    renderer.spinAngle += SPIN_DEG_PER_SEC * dtSec * contRamp * (Math.PI / 180);
    spinning = true;
  }

  // --- Camera Motion (per motionMode), separate from the spin ---
  let ramp = 0;
  let cameraActive = false;
  if (!manipulating && motionMode !== "off") {
    if (motionMode === "always") {
      ramp = contRamp; // non-stop: hover never pauses it
      cameraActive = true;
    } else {
      // "idle": run only after IDLE_MS of NO interaction at all (hover included).
      const idleFor = now - lastInteract;
      if (idleFor > IDLE_MS) {
        const rl = clamp((idleFor - IDLE_MS) / IDLE_RAMP_MS, 0, 1);
        ramp = rl * rl * (3 - 2 * rl);
        cameraActive = true;
      }
    }
  }

  if (!cameraActive) {
    idlePitchPrev = 0; // resume the bob/sway from rest next time (no jump)
    idleYawPrev = 0;
    idleActive = spinning; // the spin may still be running on its own
    return;
  }

  let dxPx: number;
  let dyPx: number;
  if (activeIs2D()) {
    // Flat layout → bounded sway: yaw AND pitch oscillate (delta-of-sin) on
    // different periods, so the map drifts in a gentle circle/figure-8 and never
    // tilts edge-on. Amplitudes ride the ease-in ramp.
    const yawTargetDeg =
      IDLE_2D_YAW_AMP_DEG * ramp * Math.sin((2 * Math.PI * now) / IDLE_2D_YAW_PERIOD_MS);
    const dYawDeg = yawTargetDeg - idleYawPrev;
    idleYawPrev = yawTargetDeg;
    const pitchTargetDeg =
      IDLE_2D_PITCH_AMP_DEG *
      ramp *
      Math.sin((2 * Math.PI * now) / IDLE_2D_PITCH_PERIOD_MS + Math.PI / 2);
    const dPitchDeg = pitchTargetDeg - idlePitchPrev;
    idlePitchPrev = pitchTargetDeg;
    dxPx = -dYawDeg * ROTATE_PX_PER_DEG;
    dyPx = -dPitchDeg * ROTATE_PX_PER_DEG;
  } else {
    // 3D turntable: constant yaw drift + a small sinusoidal pitch bob (delta).
    const yawDeg = IDLE_YAW_DEG_PER_SEC * dtSec * ramp;
    const pitchTargetDeg =
      IDLE_PITCH_AMP_DEG * ramp * Math.sin((2 * Math.PI * now) / IDLE_PITCH_PERIOD_MS);
    const dPitchDeg = pitchTargetDeg - idlePitchPrev;
    idlePitchPrev = pitchTargetDeg;
    dxPx = -yawDeg * ROTATE_PX_PER_DEG; // sign: drift one steady direction
    dyPx = -dPitchDeg * ROTATE_PX_PER_DEG;
  }

  camera.rotateByPixels(dxPx, dyPx);
  idleActive = true;
}

canvas.addEventListener("pointerdown", (e) => {
  // Right button → PAN (a flat 2D-style translate), in either tool.
  if (e.button === 2) {
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  // Lasso tool: the LEFT button begins a freeform polygon; orbit/dolly suppressed.
  if (tool === "lasso") {
    lassoing = true;
    hoverCard.hide();
    renderer.setHoverId(null);
    lassoOverlay.begin();
    lassoOverlay.addPoint(e.clientX, e.clientY);
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  // Left button (orbit tool) → orbit drag. Record the press point so pointerup
  // can tell a click (select) from an orbit (rotate).
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  downClientX = e.clientX;
  downClientY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
// Right-drag pans, so suppress the browser context menu on the canvas.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
/** Convert a pointer event to device-pixel canvas coords (top-left origin),
 *  accounting for the CSS-size → backing-store-size ratio (dpr + any layout
 *  scaling). These feed renderer.pick directly. */
function eventToDevicePx(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, rect.width);
  const sy = canvas.height / Math.max(1, rect.height);
  return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
}

/** Pick the cell at device-px (devX,devY), drive the highlight + footer + rich
 *  hover card anchored at client (cx,cy). Returns the picked cell_id (-1 miss). */
function hoverAt(devX: number, devY: number, cx: number, cy: number): number {
  const id = renderer.pick(devX, devY);
  renderer.setHoverId(id < 0 ? null : id);
  showCellId(id);
  if (id < 0 || !source) {
    hoverCard.hide();
  } else {
    const rec = source.getCell(id);
    hoverCard.show(
      {
        id,
        cellType: rec.cellType,
        dataset: rec.dataset,
        expr: rec.confidence,
      },
      cx,
      cy,
    );
  }
  return id;
}

/** Pick the cell under the cursor and drive the highlight + readout + card. */
function hover(e: PointerEvent): void {
  const [x, y] = eventToDevicePx(e);
  hoverAt(x, y, e.clientX, e.clientY);
}

canvas.addEventListener("pointermove", (e) => {
  // Lasso gesture: extend the polygon, never orbit or hover.
  if (lassoing) {
    lassoOverlay.addPoint(e.clientX, e.clientY);
    return;
  }
  // Right-button drag → pan/translate (the flat "2D move").
  if (panning) {
    camera.panByPixels((e.clientX - lastX) * dpr(), (e.clientY - lastY) * dpr());
    lastX = e.clientX;
    lastY = e.clientY;
    return;
  }
  if (!dragging) {
    if (tool === "orbit") hover(e);
    return;
  }
  // Left-drag orbits; shift+left-drag also pans (a convenience for trackpads).
  if (e.shiftKey) {
    camera.panByPixels((e.clientX - lastX) * dpr(), (e.clientY - lastY) * dpr());
  } else {
    camera.rotateByPixels((e.clientX - lastX) * dpr(), (e.clientY - lastY) * dpr());
  }
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener("pointerup", (e) => {
  if (lassoing) {
    const poly = lassoOverlay.end();
    lassoing = false;
    runLasso(poly);
    lassoOverlay.clear();
    canvas.releasePointerCapture(e.pointerId);
    return;
  }
  // A left orbit gesture that barely moved is a CLICK → pick + select the cell,
  // flying the HRA body panel to that type's (synthetic) anatomical location.
  // Shift+left is a pan convenience, so it never counts as a click.
  if (dragging && !e.shiftKey) {
    const travel = Math.hypot(e.clientX - downClientX, e.clientY - downClientY);
    if (travel <= CLICK_SLOP_PX) {
      const [dx, dy] = eventToDevicePx(e);
      selectCell(renderer.pick(dx, dy));
    }
  }
  dragging = false;
  panning = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener("pointerleave", () => {
  if (lassoing) return; // keep drawing across a brief leave
  renderer.setHoverId(null);
  showCellId(-1);
  hoverCard.hide();
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    camera.dolly(e.deltaY);
    lastManipulate = performance.now(); // dolly briefly pauses "always" motion
  },
  { passive: false },
);

// --- encoding controls ------------------------------------------------------
modeSel.addEventListener("change", () => {
  mode = modeSel.value as EncodingMode;
  cmapRow.style.display = mode === "continuous" ? "" : "none";
  // The categorical key must appear/disappear with the encoding it describes.
  rebuildLegibility();
});
cmapSel.addEventListener("change", () => {
  userPickedCmap = true; // a manual pick sticks across theme flips
  renderer.setColormap(cmapSel.value as ContinuousColormap);
  colorbar.setColormap(cmapSel.value as ContinuousColormap);
});
densitySel.addEventListener("change", () => setDensity(densitySel.value as DensityMode));

// --- MARK CONTROLS -----------------------------------------------------------
// Mirrored module-side because figureRenderStamp() must state them on the plate: a
// control the caption does not record produces two plates that differ under
// identical provenance, which is exactly what a provenance line exists to prevent.
let densityKeyReady = false;
let markScale = 1;
let inkExposure = 3;
let edlStrength = 0.35;
let blendMode: "sum" | "peak" = "sum";

/** Push every mark value into its widget, and mark controls the CURRENT render path
 *  cannot act on as inert — a slider that silently does nothing is worse than one
 *  that is visibly disabled with a reason. */
function syncMarkUI(): void {
  sizeSlider.value = String(markScale);
  // Report the GEOMETRY, not just the multiplier: "1.00x" hides that a mark is
  // 1.2 CSS px, and that number is what decides whether structure survives
  // rasterisation.
  sizeOut.textContent = `${markScale.toFixed(2)}x`;
  inkSlider.value = String(inkExposure);
  inkOut.textContent = `${inkExposure.toFixed(1)}x`;
  edlSlider.value = String(edlStrength);
  edlOut.textContent = edlStrength.toFixed(2);
  blendSel.value = blendMode;

  // EDL resolves from a DEPTH TEXTURE and is gated on `!densityActive` inside
  // renderCategorical; the continuous pass draws with depth off entirely, so on the
  // default encoding this slider has nothing to act on. Say so rather than lie.
  const edlLive = mode === "categorical" && densityMode === "off";
  edlRow.classList.toggle("inert", !edlLive);
  edlSlider.disabled = !edlLive;
  // Accumulate is read only by the continuous path — the mirror case.
  const blendLive = mode === "continuous";
  blendRow.classList.toggle("inert", !blendLive);
  blendSel.disabled = !blendLive;

  marksNote.textContent = !blendLive
    ? "Accumulate applies to the continuous encoding only."
    : !edlLive
      ? mode !== "categorical"
        ? "Depth cue needs the categorical encoding — the continuous pass draws with depth off."
        : "Depth cue is suspended while the density underlay is on."
      : "";
}

sizeSlider.addEventListener("input", () => {
  markScale = Number(sizeSlider.value);
  renderer.setMarkScale(markScale);
  syncMarkUI();
});
inkSlider.addEventListener("input", () => {
  inkExposure = Number(inkSlider.value);
  renderer.setExposure(inkExposure);
  syncMarkUI();
});
edlSlider.addEventListener("input", () => {
  edlStrength = Number(edlSlider.value);
  renderer.setEdlStrength(edlStrength);
  syncMarkUI();
});
blendSel.addEventListener("change", () => {
  blendMode = blendSel.value === "peak" ? "peak" : "sum";
  renderer.setBlendMode(blendMode);
  syncMarkUI();
});

/** Every mark control a user can touch, in one deterministic clause. Defaults are
 *  deliberately NOT suppressed: an omitted field is indistinguishable from an
 *  unrecorded one, and the point of this line is that a reader can tell two plates
 *  apart. Order is fixed so two stamps diff cleanly. */
function figureRenderStamp(): string {
  const depth =
    mode === "categorical" && densityMode === "off" ? edlStrength.toFixed(2) : "n/a";
  // CAMERA POSE FIRST. Without it two plates of a 3D embedding shot from different
  // angles carry byte-identical provenance, which defeats the whole point of a stamp —
  // and for a 3D scatter the pose changes the picture more than any cosmetic here does.
  const p = camera.getPose();
  const q = p.rotation;
  const pose =
    `pose q[${q.map((v) => v.toFixed(4)).join(",")}]` +
    ` d${camera.distance.toFixed(1)}` +
    ` fov${((camera.fov * 180) / Math.PI).toFixed(0)}` +
    ` ${p.orthographic ? "ortho" : "persp"}`;
  return [
    pose,
    `marks ${markScale.toFixed(2)}x (${renderer.markFloorPx.toFixed(1)} px)`,
    `ink ${inkExposure.toFixed(1)}x`,
    `accum ${blendMode}`,
    `depth-cue ${depth}`,
    `density ${densityMode}`,
    `theme ${renderer.themeValue}`,
    `cmap ${cmapSel.value}`,
  ].join(" · ");
}

// --- tool control (Orbit / Lasso) + clear-selection -------------------------
toolSel.addEventListener("change", () => setTool(toolSel.value as Tool));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (lassoing) {
      lassoing = false;
      lassoOverlay.clear();
    }
    clearFocus();
    clearSelection();
  }
});

// --- data bootstrap ---------------------------------------------------------
async function boot(): Promise<void> {
  try {
    const spineBase = `${import.meta.env.BASE_URL}spine`;
    const manifest = await loadManifest(spineBase);
    // prefer the requested 3D layout; fall back to any 3D layout, else the first.
    const keys = Object.keys(manifest.layouts);
    const layout =
      keys.find((k) => k === requestedLayout) ??
      keys.find((k) => manifest.layouts[k].dims === 3) ??
      keys[0];
    const s = new SpineTileSource(spineBase, manifest, layout);
    await s.ensureLayout(layout);
    s.setLayout(layout);
    clDict = await s.loadDict("CL_label").catch(() => null);
    shortNameCache.clear(); // dict changed -> shortened names must be recomputed
    source = s;
    invalidateDomains(); // new column -> the memoised domain is stale
    spine = s; // module-level handle so startMorph() can reach the layouts

    layoutSel.innerHTML = "";
    for (const key of keys) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${key} · ${manifest.layouts[key].dims}D`;
      layoutSel.appendChild(opt);
    }
    layoutSel.value = s.layout;
    layoutRow.style.display = "";
    // Switching the layout dropdown MORPHS to the picked layout (instant when
    // it's the same). Direct setData would jump-cut; the morph is the feature.
    layoutSel.addEventListener("change", () => {
      const name = layoutSel.value;
      if (name === s.layout || morph) {
        layoutSel.value = s.layout;
        return;
      }
      void startMorph(name);
    });
  } catch {
    source = new SyntheticTileSource({ count: 250_000 });
    invalidateDomains(); // new column -> the memoised domain is stale
    layoutRow.style.display = "none";
  }

  if (!source) source = new SyntheticTileSource({ count: 250_000 });
  applyActive(source);

  // The interaction tool control is a 3D-only affordance — reveal it now.
  toolRow.style.display = "";
  // Mark controls drive Renderer3D, so they are 3D-only. ?size / ?ink / ?edl / ?blend
  // make a tuned plate reproducible from a link, the same way ?density / ?motion do.
  marksGrp.style.display = "";
  const numParam = (k: string, dflt: number, lo: number, hi: number): number => {
    const raw = params.get(k);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };
  markScale = numParam("size", 1, 0.7, 2.5);
  inkExposure = numParam("ink", 3, 0.5, 8);
  edlStrength = numParam("edl", 0.35, 0, 1.2);
  blendMode = params.get("blend") === "peak" ? "peak" : "sum";
  renderer.setMarkScale(markScale);
  renderer.setExposure(inkExposure);
  renderer.setEdlStrength(edlStrength);
  renderer.setBlendMode(blendMode);
  syncMarkUI();
  toolSel.value = tool;

  // The density underlay is also 3D-only — reveal it, honour &density=<mode>.
  densityRow.style.display = "";
  const requestedDensity = params.get("density");
  if (requestedDensity === "underlay" || requestedDensity === "contours") {
    setDensity(requestedDensity);
  } else {
    setDensity("off");
  }

  // Motion config is a 3D-only affordance — reveal it, honour &motion=<mode>
  // (default "always" = non-stop), and wire the select.
  motionRow.style.display = "";
  const reqMotion = params.get("motion");
  setMotion(reqMotion === "off" || reqMotion === "idle" ? reqMotion : "always");
  motionSel.addEventListener("change", () => setMotion(motionSel.value as MotionMode));

  // The per-cluster auto-spin is also 3D-only — reveal it, default On, honour &spin.
  spinRow.style.display = "";
  // Cluster spin ROTATES EACH CELL about its category centroid (core/renderer3d.ts
  // "Per-cluster idle spin"), so the drawn position is the embedding coordinate
  // transformed by a wall-clock angle — within-cluster structure becomes partly an
  // animation artefact and no two captures match. It is a presentation effect, so it
  // is OPT-IN (?spin=on or the Cluster-spin control), never the default.
  setSpin(params.get("spin") === "on");
  spinSel.addEventListener("change", () => setSpin(spinSel.value === "on"));

  // --- morph triggers -------------------------------------------------------
  // Press "m" to fly to umap3d (or back to pca3d once there); the dropdown above
  // also morphs. `&morph=<layout>` auto-flies once after the first frame.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "m" && e.key !== "M") return;
    if (!spine) return;
    const dest = spine.layout === "umap3d" ? "pca3d" : "umap3d";
    void startMorph(dest);
  });

  // Headless/automation surface: drive + inspect the morph deterministically.
  (window as unknown as Record<string, unknown>).__r3d = {
    /** Render one frame at `scale`× and hand back a PNG blob (see exportFigure). */
    exportFigure: (scale?: number) => exportFigure(scale),
    /** Export and trigger a browser download — the one-call path for producing a figure. */
    /** The hero plate as a Blob, for automation that wants the bytes rather than a
     *  download. Same instance-binding argument as exportFacets. */
    exportFigureBlob: (scale = 3) => exportFigure(scale),
    /** The exact provenance clause the next export will print. */
    renderStamp: () => figureRenderStamp(),
    saveFigure: async (scale = 3, filename = "cytolume-figure.png") => {
      const blob = await exportFigure(scale);
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    },
    /** Freeze every time-varying input so two runs render identical pixels, and
     *  hide app chrome. Required for a reproducible figure: motion + idle orbit +
     *  cluster spin all integrate wall-clock time. */
    /** Small-multiples plate: one panel per cell type, grey context + inked type.
     *  This is how 48 identities are conveyed when the colour channel holds 3. */
    /** The facet plate as a Blob, for automation that wants the bytes rather than a
     *  download. Prefer this over `import("/src/main3d.ts")` from a driver script:
     *  after an edit Vite serves the app's copy with an HMR `?t=` query, so a plain
     *  dynamic import instantiates a SECOND app whose `mode`/`activePD` are unset. */
    exportFacets: (scale = 2, cols = 6, max = 48) => exportFacetGrid(scale, cols, max),
    /** Encoding + data state, so a driver can assert readiness instead of sleeping. */
    state: () => ({
      mode,
      hasData: !!activePD,
      count: activePD?.count ?? 0,
      morphing: morph !== null,
      figureMode,
      legendRows: lastLegendRows.length,
    }),
    saveFacets: async (scale = 2, cols = 6, max = 48, filename = "cytolume-facets.png") => {
      const blob = await exportFacetGrid(scale, cols, max);
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    },
    figureMode: (on = true) => setFigureMode(on),
    /** Eye-dome lighting strength (categorical mode). 0 disables the pass. */
    setEdl: (v: number) => renderer.setEdlStrength(v),
    /** Continuous accumulation: "sum" (cell mass) or "peak" (MAX, order-independent). */
    setBlend: (m: "sum" | "peak") => renderer.setBlendMode(m),
    getBlend: () => renderer.blendModeValue,
    getEdl: () => renderer.edlStrengthValue,
    startMorph: (to: string) => startMorph(to),
    getMorphFactor: () => renderer.morphFactor,
    isMorphing: () => morph !== null,
    activeLayout: () => spine?.layout ?? "(synthetic)",
    // pick: device-pixel (top-left origin) → cell_id (-1 = no hit).
    pick: (x: number, y: number) => renderer.pick(x, y),
    setHoverId: (id: number | null) => renderer.setHoverId(id),
    hoveredId: () => renderer.hoveredId,
    setData: (pd: PointData) => {
      activePD = pd;
      renderer.setData(pd);
      fitRobust(pd);
      rebuildLegibility();
    },
    setMode: (m: EncodingMode) => {
      mode = m;
      if (modeSel) modeSel.value = m;
      cmapRow.style.display = m === "continuous" ? "" : "none";
      rebuildLegibility(); // keep the categorical key in sync with the encoding
    },
    // --- theme automation (Wiring) ---
    setTheme: (t: Theme) => setTheme(t),
    getTheme: () => renderer.themeValue,
    canvasSize: () => [canvas.width, canvas.height] as [number, number],
    renderer,
    camera,
    // --- interaction automation (Wiring) ---
    setTool: (t: Tool) => setTool(t),
    // --- HRA body panel automation (reflection-8) ---
    // Pick→map→fly: select a cell_id, returning the synthetic body-node id it
    // mapped to (null on miss). Drives bodyPanel.highlightID + zoomToID.
    selectCell: (id: number) => selectCell(id),
    // The synthetic cellType→body-node mapping (pure; for the verifier).
    getBodyNodeId: (cellType: string) => bodyNodeForCellType(cellType),
    // Body-panel oracles: ready state + the highlight the panel currently holds.
    bodyReady: () => bodyPanel.isReady,
    bodyFailed: () => bodyPanel.isFailed,
    bodyHighlightId: () => bodyPanel.highlightedId,
    bodyElementHighlightID: () => bodyPanel.elementHighlightID,
    bodyPanel,
    // --- idle "alive" auto-orbit automation (Wiring) ---
    // True only on frames where the idle motion is actively orbiting the camera.
    getIdleActive: () => idleActive,
    // Compat shim + the tri-state motion config (off / idle / always = non-stop).
    setIdleEnabled: (b: boolean) => setMotion(b ? "always" : "off"),
    setMotion: (m: MotionMode) => setMotion(m),
    getMotionMode: () => motionMode,
    setSpin: (on: boolean) => setSpin(on),
    getSpinEnabled: () => spinEnabled,
    // --- density underlay automation (Wiring) ---
    // Drive the density underlay mode; also reflects the panel select.
    setDensityMode: (m: DensityMode) => setDensity(m),
    getDensityMode: () => densityMode,
    // Run the full lasso path on a CSS-px polygon; returns the selected count.
    lassoSelectCssPolygon: (points: Array<[number, number]>) => runLasso(points),
    getSelectionIds: () => store.ids,
    getSelectionCount: () => store.count,
    clearSelection: () => clearSelection(),
    // Read-only oracles for the adversarial verifier: the active source (getCell)
    // and the resident PointData, so a test can re-project ids independently.
    getCell: (id: number) => source?.getCell(id),
    activePD: () => activePD,
    // Pick at device-px + show the rich hover card (anchored at the same px,
    // treated as client coords in the headless dpr-1 case). Returns cell_id.
    hoverCellAt: (xDev: number, yDev: number) => hoverAt(xDev, yDev, xDev, yDev),
    getHoverCardText: () => hoverCard.text(),
    // --- map legibility automation (Wiring) ---
    // Drive the renderer focus directly (-1 clears); also reflect the pin/legend.
    setFocusCategory: (cat: number) => {
      pinnedCat = cat >= 0 ? cat : null;
      renderer.setFocusCategory(focusFor());
      legend.setFocus(pinnedCat);
    },
    // The legend rows (incl. color + pct), sorted count desc — what the panel shows.
    getLegendRows: () => lastLegendRows,
    // The decluttered, on-screen labels this frame: {category,text,x,y,opacity} (CSS px).
    getVisibleLabels: () => updateLabels(),
    // A category's projected centroid in CSS px + whether it's on-screen.
    getCentroidScreen: (cat: number): [number, number, boolean] => {
      const c = cachedCentroids.find((x) => x.category === cat);
      if (!c) return [NaN, NaN, false];
      const d = dpr();
      const cssW = canvas.clientWidth || canvas.width / d;
      const cssH = canvas.clientHeight || canvas.height / d;
      const [xDev, yDev, depth] = camera.worldToScreen(c.centroid);
      const x = xDev / d;
      const y = yDev / d;
      return [x, y, depth >= 0 && depth <= 1 && x >= 0 && x <= cssW && y >= 0 && y <= cssH];
    },
  };

  if (requestedMorph) {
    // fire once the first frame has presented (so t=0 is observable).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => void startMorph(requestedMorph));
    });
  }

  // --- render loop ----------------------------------------------------------
  let frames = 0;
  let fpsClock = performance.now();
  let lastClock = performance.now();
  function frame(): void {
    const now = performance.now();
    const dt = now - lastClock;
    camera.step(dt); // advance any in-flight camera transition
    stepMorph(dt); // advance the layout morph in lockstep on the SAME clock
    lastClock = now;

    stepIdle(now, dt); // idle "alive" auto-orbit (no-op until ~2.5s of quiet)

    renderer.render(camera, mode);
    // Re-project the cached centroids every frame so labels track the orbit/dolly.
    updateLabels();
    // Same-task readback: the drawing buffer is still valid here.
    // The density key ticks in cells, and the tau-per-cell scalar only exists once a
    // frame has been drawn (frameStyle derives alpha from the camera and dpr). The
    // key is otherwise built by rebuildLegibility, which runs BEFORE the first
    // render — so refresh it exactly once when the scalar first becomes available.
    if (!densityKeyReady && renderer.tauPerCellValue > 0) {
      densityKeyReady = true;
      rebuildLegibility();
    }
    servicePendingExport();
    // The facet grid drives its OWN render calls (one per panel), so it must run
    // after the normal frame and restore the viewport before the next one.
    servicePendingFacets();

    frames++;
    if (now - fpsClock >= 500) {
      fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsClock))} fps`;
      frames = 0;
      fpsClock = now;
    }
    zoomEl.textContent = "3D";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void boot();
