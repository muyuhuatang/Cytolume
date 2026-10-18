/*
 * figure-composite.ts — draw the figure's KEY onto the exported raster.
 *
 * `canvas.toBlob()` on the WebGL canvas captures the marks and nothing else: the
 * legend, colorbar, cluster labels and the n/method caption are all DOM sitting on
 * top of the canvas, so a bare export produces a plate whose colour channel and
 * clusters are unlabelled — unusable as a journal figure.
 *
 * These are drawn natively with Canvas2D rather than rasterising the DOM
 * (html2canvas / SVG foreignObject). Reasons that matter here:
 *   - crisp at any export scale, because text is re-rendered at the output
 *     resolution instead of being upscaled from a screenshot;
 *   - no extra dependency and no CSS-support cliff;
 *   - the values come from the same state the plot used, so the key cannot
 *     disagree with the marks.
 *
 * Everything is positioned in CSS-pixel space and multiplied by `scale`, so the
 * composite lines up with the GL render at any resolution.
 */

export interface CompositeLabel {
  text: string;
  /** CSS-pixel position of the label centre, matching the on-screen overlay. */
  x: number;
  y: number;
  opacity: number;
}

export interface CompositeLegendRow {
  name: string;
  color: string;
  count: number;
  pct: number;
}

export interface CompositeColorbar {
  label: string;
  /** Colormap stops, low → high. */
  stops: string[];
  /** Ramp fraction 0..1 + face, at round DATA values. The plate MUST carry the same
   *  ticks the instrument shows: a key that prints a clean 0..1 when the app
   *  explicitly refuses to assert one throws away the honesty work at the exact
   *  moment of publication. */
  ticks?: { t: number; text: string }[];
  /** Distribution of the values across the domain. */
  hist?: Uint32Array | null;
  histMax?: number;
  /** Which ramp, and what kind it is. */
  colormapNote?: string;
  note?: string | string[];
  /** The SECOND 1-D key: density, hue-free, ticked in cells along the ray. It must
   *  reach the PLATE, not just the app — a key the instrument shows and the
   *  deliverable drops is the honesty work discarded at publication. */
  density?: {
    ticks: { t: number; text: string }[];
    swatches: { t: number; color: string }[];
    note: string[];
  } | null;
}

export interface CompositeOpts {
  /** Export scale: 1 = on-screen size. All geometry below is CSS px × scale. */
  scale: number;
  /** Viewport in CSS px (the coordinate space labels were computed in). */
  cssW: number;
  cssH: number;
  theme: "light" | "dark";
  labels: CompositeLabel[];
  /** Categorical key, or null when the encoding is continuous. */
  legend: CompositeLegendRow[] | null;
  /** Continuous key, or null when the encoding is categorical. */
  colorbar: CompositeColorbar | null;
  /** The substrate the renderer actually cleared with. The key used to assume pure
   *  white while the plate behind it was #EEF0F3, so the key read as a card floating
   *  on a dirty grey rectangle. Never re-derived here — see core/substrate.ts. */
  substrate?: string;
  /** Provenance line: n, embedding, and whether the data is synthetic. */
  caption: string;
  /** How the marks were DRAWN: size, ink, accumulation, depth cue, density, theme,
   *  colormap. Without it two plates that differ only in appearance settings carry
   *  identical provenance. Optional so callers predating it still compile. */
  renderStamp?: string;
}

interface Ink {
  text: string;
  dim: string;
  panel: string;
  border: string;
  halo: string;
}

function inkFor(theme: "light" | "dark"): Ink {
  return theme === "light"
    ? {
        text: "#1a1d24",
        dim: "rgba(26,29,36,0.55)",
        panel: "#ffffff",
        border: "rgba(0,0,0,0.12)",
        halo: "rgba(255,255,255,0.9)",
      }
    : {
        text: "#e6e9ef",
        dim: "rgba(230,233,239,0.55)",
        panel: "#12161f",
        border: "rgba(255,255,255,0.1)",
        halo: "rgba(8,10,14,0.9)",
      };
}

/** The figure's type stack. Named explicitly so the plate does not inherit whatever
 *  `system-ui` resolves to on the exporting machine — that would make the figure
 *  non-reproducible across authors. */
/* WEIGHTS: only 400 / 600 — never 500. Inter is NOT bundled, so on any machine
 * without it this stack falls back to Helvetica Neue / Arial, neither of which HAS a
 * 500 face. The browser then SYNTHESISES one, and that synthesis is not stable on the
 * first rasterisation: measured, the first exported plate differed from every
 * subsequent one, with the differing pixels confined to exactly the weight-500 runs
 * (the caption's first line and the numeric ticks) while every 400/600 run was
 * byte-identical. Requesting a weight the fallback actually has removes it. */
const FACE = '"Inter", "Helvetica Neue", Arial, sans-serif';

/**
 * Draw the key layers over an already-rendered plot.
 *
 * `ctx` must already contain the GL render, drawn at `scale`.
 */
export function compositeFigure(ctx: CanvasRenderingContext2D, o: CompositeOpts): void {
  const s = o.scale;
  const ink = inkFor(o.theme);
  // The key sits ON the substrate, so its panel and label halo must BE the substrate.
  if (o.substrate) {
    ink.panel = o.substrate;
    ink.halo = o.substrate;
  }
  ctx.save();
  ctx.textBaseline = "alphabetic";

  drawLabels(ctx, o, ink, s);
  if (o.colorbar) drawColorbar(ctx, o.colorbar, ink, s);
  else if (o.legend && o.legend.length) drawLegend(ctx, o.legend, ink, s);
  drawCaption(ctx, o.caption, ink, s, o.cssH, o.renderStamp);

  ctx.restore();
}

/** Cluster labels, with the same halo the on-screen overlay uses so they stay
 *  readable over dense marks. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  o: CompositeOpts,
  ink: Ink,
  s: number,
): void {
  // Must mirror .cyto-label in ui/map-legibility.css — the plate and the screen
  // are the same figure at two resolutions.
  ctx.font = `600 ${11.5 * s}px ${FACE}`;
  ctx.textAlign = "center";
  for (const l of o.labels) {
    if (l.opacity <= 0.02) continue;
    ctx.globalAlpha = l.opacity;
    ctx.lineWidth = 3 * s;
    ctx.strokeStyle = ink.halo;
    ctx.lineJoin = "round";
    // Stroke-then-fill gives the halo without a second text pass.
    ctx.strokeText(l.text, l.x * s, l.y * s);
    ctx.fillStyle = ink.text;
    ctx.fillText(l.text, l.x * s, l.y * s);
  }
  ctx.globalAlpha = 1;
}

/** Rounded panel used by both keys. */
function panel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ink: Ink,
  s: number,
): void {
  const r = 10 * s;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = ink.panel;
  ctx.fill();
  ctx.lineWidth = 1 * s;
  ctx.strokeStyle = ink.border;
  ctx.stroke();
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  rows: CompositeLegendRow[],
  ink: Ink,
  s: number,
): void {
  const padX = 14 * s;
  const padY = 12 * s;
  const rowH = 19 * s;
  const w = 244 * s;
  const h = padY * 2 + 18 * s + rows.length * rowH;
  const x = 20 * s;
  const y = 68 * s;
  panel(ctx, x, y, w, h, ink, s);

  ctx.textAlign = "left";
  ctx.font = `600 ${10 * s}px ${FACE}`;
  ctx.fillStyle = ink.dim;
  ctx.fillText("CELL TYPES", x + padX, y + padY + 10 * s);

  ctx.font = `400 ${11 * s}px ${FACE}`;
  rows.forEach((r, i) => {
    const ry = y + padY + 26 * s + i * rowH;
    // swatch
    ctx.fillStyle = r.color;
    const sw = 9 * s;
    ctx.beginPath();
    ctx.roundRect(x + padX, ry - sw + 1 * s, sw, sw, 2 * s);
    ctx.fill();
    // name
    ctx.fillStyle = ink.text;
    ctx.fillText(r.name, x + padX + sw + 8 * s, ry);
    // count, right-aligned
    ctx.textAlign = "right";
    ctx.fillStyle = ink.dim;
    ctx.fillText(r.count.toLocaleString(), x + w - padX, ry);
    ctx.textAlign = "left";
  });
}

function drawColorbar(
  ctx: CanvasRenderingContext2D,
  cb: CompositeColorbar,
  ink: Ink,
  s: number,
): void {
  const notes = Array.isArray(cb.note) ? cb.note.slice() : cb.note ? [cb.note] : [];
  if (cb.colormapNote) notes.unshift(cb.colormapNote);
  const hasHist = !!(cb.hist && cb.hist.length && (cb.histMax ?? 0) > 0);
  const den = cb.density ?? null;
  if (den) notes.push(...den.note);
  const padX = 14 * s;
  const w = 244 * s;
  // Wrap the notes first so the panel is sized to what it will actually contain.
  const noteLines: string[] = [];
  ctx.font = `400 ${9.5 * s}px ${FACE}`;
  for (const n of notes) noteLines.push(...wrapText(ctx, n, w - padX * 2));
  const h =
    (46 + (hasHist ? 20 : 0) + 14) * s +
    (den ? 44 : 0) * s +
    noteLines.length * 11.5 * s +
    10 * s;
  const x = 20 * s;
  const y = 68 * s;
  panel(ctx, x, y, w, h, ink, s);

  ctx.textAlign = "left";
  ctx.font = `600 ${10 * s}px ${FACE}`;
  ctx.fillStyle = ink.dim;
  ctx.fillText(cb.label.toUpperCase(), x + padX, y + 20 * s);

  // ramp, built from the same stop list the GPU LUT uses
  const rx = x + padX;
  const ry = y + 28 * s;
  const rw = w - padX * 2;
  const rh = 10 * s;
  const grad = ctx.createLinearGradient(rx, 0, rx + rw, 0);
  cb.stops.forEach((c, i) => grad.addColorStop(i / Math.max(1, cb.stops.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.lineWidth = 1 * s;
  ctx.strokeStyle = ink.border;
  ctx.strokeRect(rx, ry, rw, rh);

  let cy = ry + rh;

  // Distribution strip, sharing the ramp's x-axis. sqrt heights so a single mode does
  // not flatten every other bin to nothing — the strip shows SHAPE, it is not read off.
  if (hasHist) {
    const hh = 16 * s;
    const bins = cb.hist as Uint32Array;
    const bw = rw / bins.length;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = ink.text;
    for (let i = 0; i < bins.length; i++) {
      const bh = Math.sqrt(bins[i] / (cb.histMax as number)) * hh;
      ctx.fillRect(rx + i * bw, cy + 2 * s + (hh - bh), Math.max(1, bw - 0.5 * s), bh);
    }
    ctx.restore();
    cy += hh + 2 * s;
  }

  // Ticks at round DATA values — never fractions of the ramp.
  ctx.font = `400 ${10 * s}px ${FACE}`;
  ctx.fillStyle = ink.dim;
  const ticks = cb.ticks ?? [];
  for (const k of ticks) {
    const tx = rx + k.t * rw;
    ctx.textAlign = k.t <= 0.02 ? "left" : k.t >= 0.98 ? "right" : "center";
    ctx.fillText(k.text, tx, cy + 12 * s);
  }
  ctx.textAlign = "left";
  cy += 14 * s;

  // --- second key: DENSITY, hue-free, ticked in cells along the ray ------------
  // Two 1-D keys rather than one 2-D key: a bivariate key was measured against this
  // resolve and rejected because the forward map was many-to-one. The luminance lock
  // is what makes two independent axes legitimate.
  if (den) {
    cy += 10 * s;
    ctx.strokeStyle = ink.border;
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    ctx.moveTo(rx, cy);
    ctx.lineTo(rx + rw, cy);
    ctx.stroke();
    cy += 10 * s;

    ctx.font = `600 ${10 * s}px ${FACE}`;
    ctx.fillStyle = ink.dim;
    ctx.fillText("DENSITY", rx, cy);
    cy += 8 * s;

    const dg = ctx.createLinearGradient(rx, 0, rx + rw, 0);
    for (const sw of den.swatches) dg.addColorStop(Math.min(1, Math.max(0, sw.t)), sw.color);
    ctx.fillStyle = dg;
    ctx.fillRect(rx, cy, rw, rh);
    ctx.lineWidth = 1 * s;
    ctx.strokeStyle = ink.border;
    ctx.strokeRect(rx, cy, rw, rh);
    cy += rh;

    ctx.font = `400 ${10 * s}px ${FACE}`;
    ctx.fillStyle = ink.dim;
    for (const k of den.ticks) {
      const tx = rx + k.t * rw;
      ctx.textAlign = k.t <= 0.02 ? "left" : k.t >= 0.98 ? "right" : "center";
      ctx.fillText(k.text, tx, cy + 12 * s);
    }
    ctx.textAlign = "left";
    cy += 14 * s;
  }

  ctx.font = `400 ${9.5 * s}px ${FACE}`;
  for (const line of noteLines) {
    cy += 11.5 * s;
    ctx.fillText(line, rx, cy);
  }
}

/** Greedy wrap. The plate has a fixed key width, and a provenance clause that runs
 *  off the card is worse than none — the reader cannot tell it was ever there. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxW || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Provenance line. A figure that does not state n and the embedding method is not
 *  reportable, and one built on synthetic data must say so on its face. */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  caption: string,
  ink: Ink,
  s: number,
  cssH: number,
  renderStamp?: string,
): void {
  ctx.textAlign = "left";
  ctx.fillStyle = ink.dim;
  if (renderStamp) {
    // TWO LINES, not one appended string: this draw has no width guard, so a
    // concatenated caption would simply run off the plate — and provenance that
    // falls off the edge is worse than none, because the reader cannot tell it was
    // ever there. It also keeps the two kinds of provenance visually separate:
    // what the data IS, and how it was drawn.
    ctx.font = `400 ${10.5 * s}px ${FACE}`;
    ctx.fillText(caption, 20 * s, (cssH - 30) * s);
    ctx.font = `400 ${9 * s}px ${FACE}`;
    ctx.fillText(renderStamp, 20 * s, (cssH - 16) * s);
    return;
  }
  ctx.font = `400 ${10.5 * s}px ${FACE}`;
  ctx.fillText(caption, 20 * s, (cssH - 16) * s);
}

/* ---------------------------------------------------------------------------
 * SMALL-MULTIPLES CHROME
 *
 * A facet grid moves cell-type identity out of the colour channel (which holds
 * only `seriesCap` separable hues) and into position within a grid. That only
 * works if every panel names itself, so these draw the per-panel header and the
 * plate's shared caption. Geometry is in CSS px × scale, matching the rest of
 * this module, so a panel's chrome lines up with its GL raster at any resolution.
 * ------------------------------------------------------------------------- */

export interface FacetChromeOpts {
  /** Panel origin and size, in DEVICE px within the plate. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  theme: "light" | "dark";
  name: string;
  count: number;
  pct: number;
  /** The hue this panel's cells were actually drawn in — neutral for folded types. */
  color: string;
}

export function drawFacetChrome(ctx: CanvasRenderingContext2D, o: FacetChromeOpts): void {
  const s = o.scale;
  const ink = inkFor(o.theme);
  ctx.save();
  ctx.textBaseline = "alphabetic";

  // Hairline panel divider. Recessive by design: the grid must read as one object,
  // and a heavy box per panel would fight the marks for attention.
  ctx.strokeStyle = ink.border;
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(o.x + 0.5 * s, o.y + 0.5 * s, o.w - 1 * s, o.h - 1 * s);

  const padX = 8 * s;
  const baseY = o.y + 15 * s;

  // Swatch: states the ink this panel used. For a folded type that is the shared
  // neutral, which is the honest reading — the panel's identity comes from its
  // POSITION and title, not from a hue the colour channel never assigned it.
  const sw = 7 * s;
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.roundRect(o.x + padX, baseY - sw, sw, sw, 1.5 * s);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.font = `600 ${9.5 * s}px ${FACE}`;
  ctx.fillStyle = ink.text;
  const nameX = o.x + padX + sw + 5 * s;
  ctx.fillText(fitText(ctx, o.name, o.w - (nameX - o.x) - padX - 46 * s), nameX, baseY);

  ctx.textAlign = "right";
  ctx.font = `400 ${9 * s}px ${FACE}`;
  ctx.fillStyle = ink.dim;
  ctx.fillText(
    `${o.count.toLocaleString()} · ${o.pct.toFixed(1)}%`,
    o.x + o.w - padX,
    baseY,
  );

  ctx.restore();
}

/** Plate-level provenance for the facet grid, drawn once under the whole grid. */
export function drawFacetCaption(
  ctx: CanvasRenderingContext2D,
  plateW: number,
  plateH: number,
  scale: number,
  theme: "light" | "dark",
  caption: string,
): void {
  const s = scale;
  const ink = inkFor(theme);
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `400 ${10 * s}px ${FACE}`;
  ctx.fillStyle = ink.dim;
  ctx.fillText(fitText(ctx, caption, plateW - 24 * s), 12 * s, plateH - 8 * s);
  ctx.restore();
}

/** Ellipsise to fit. A cell-type name overflowing into its neighbour's panel would
 *  mislabel that panel, which is worse than truncating this one. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0 || ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "";
}
