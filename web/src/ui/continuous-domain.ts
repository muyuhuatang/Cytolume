/*
 * continuous-domain.ts — the ONE description of the continuous colour channel.
 *
 * The key used to hardcode `0` / `1` / "normalised" in two places. Nothing in the
 * app normalises anything: values are copied out of `expr.f32`
 * (data/spine-tile-source.ts), uploaded as-is, and merely CLAMPED in the shader.
 * "Normalised" was an assertion, not a fact, and a figure that states a scale it
 * cannot know is worse than one that states none.
 *
 * This replaces it with what is actually knowable: what the producer DECLARED in
 * the manifest, what the column CONTAINS, and — when the producer declared
 * nothing — the absence itself, said out loud.
 */

import type { SpineManifest, ContinuousChannel } from "../data/manifest.ts";

export const HIST_BINS = 48;

export interface ContinuousDomain {
  channel: string;
  label: string;
  unit: string | null;
  transform: string | null;
  /** DATA-unit endpoints. Falls back to the stored extent when undeclared. */
  vmin: number;
  vmax: number;
  /** Where vmin/vmax came from. Drives the note; never invented. */
  domainRule: "declared" | "stored-extent";
  synthetic: boolean;
  storedMin: number;
  storedMax: number;
  /** Counts over the stored scalar, length HIST_BINS. */
  hist: Uint32Array;
  histMax: number;
  n: number;
  /** Cells sitting exactly on an endpoint. A pile-up means the producer clipped. */
  atFloor: number;
  atCeil: number;
}

/** Everything both keys need to render. Built once, in main3d. */
export interface ContinuousKeySpec {
  label: string;
  colormap: string;
  /** e.g. "magma · sequential · perceptually uniform". */
  colormapNote: string;
  stops: string[];
  /** Ramp fraction + face, at ROUND DATA values — never fractions of the ramp. */
  ticks: { t: number; text: string }[];
  hist: Uint32Array | null;
  histMax: number;
  /** Disclosure lines. Each is a fact, not a slogan. */
  note: string[];
}

const cache = new Map<string, ContinuousDomain>();

/** Call when the underlying column changes (new source / reloaded spine). */
export function invalidateDomains(): void {
  cache.clear();
}

/**
 * Build (or return the memoised) domain for a column.
 *
 * COST: exactly one linear pass over `values`. Every layout in a spine contains
 * ALL N cells joined from the SAME expr column, so the value multiset is
 * layout-invariant — the memo key is the COLUMN, not the layout, and switching or
 * morphing layouts never rescans.
 */
export function buildDomain(o: {
  key: string;
  channel: string;
  values: Float32Array;
  count: number;
  manifest: SpineManifest | null;
  synthetic: boolean;
}): ContinuousDomain {
  const hit = cache.get(o.key);
  if (hit) return hit;

  const hist = new Uint32Array(HIST_BINS);
  let lo = Infinity;
  let hi = -Infinity;
  let atFloor = 0;
  let atCeil = 0;
  for (let i = 0; i < o.count; i++) {
    const v = o.values[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (v <= 0) atFloor++;
    if (v >= 1) atCeil++;
    const b = v <= 0 ? 0 : v >= 1 ? HIST_BINS - 1 : (v * HIST_BINS) | 0;
    hist[b]++;
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }

  const ch = channelMeta(o.manifest, o.channel);
  const declared = ch?.domain;
  let histMax = 0;
  for (const c of hist) if (c > histMax) histMax = c;

  const d: ContinuousDomain = {
    channel: o.channel,
    // The axis is named by the CHANNEL, never by whether the data is synthetic.
    // Falling back to "Cell value" when synthetic renamed the axis of the figure as
    // a side effect of a provenance flag — and "Cell value" says less than "expr"
    // does. Synthetic-ness is disclosed in the NOTE, which is where it belongs.
    label: ch?.label ?? o.channel,
    unit: ch?.unit ?? null,
    transform: ch?.transform ?? null,
    vmin: declared ? declared[0] : lo,
    vmax: declared ? declared[1] : hi,
    domainRule: declared ? "declared" : "stored-extent",
    synthetic: o.synthetic,
    storedMin: lo,
    storedMax: hi,
    hist,
    histMax,
    n: o.count,
    atFloor,
    atCeil,
  };
  cache.set(o.key, d);
  return d;
}

/** Read a channel's metadata, tolerating the old `Record<string,string>` form. */
function channelMeta(m: SpineManifest | null, name: string): ContinuousChannel | null {
  const e = m?.continuous?.[name];
  if (!e || typeof e === "string") return null;
  return e;
}

export function toData(d: ContinuousDomain, t: number): number {
  return d.vmin + (d.vmax - d.vmin) * t;
}

export function toFraction(d: ContinuousDomain, v: number): number {
  const s = d.vmax - d.vmin;
  return s === 0 ? 0 : (v - d.vmin) / s;
}

/** Round ticks in DATA units — 1/2/5×10^k. Never fractions of the ramp: a tick at
 *  "0.5 of the way along" tells a reader nothing they can carry to a number. */
export function niceTicks(vmin: number, vmax: number, target = 5): number[] {
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax <= vmin) return [];
  const raw = (vmax - vmin) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n >= 5 ? 5 : n >= 2 ? 2 : n >= 1 ? 1 : 0.5) * mag;
  const out: number[] = [];
  const eps = step * 1e-6;
  for (let v = Math.ceil(vmin / step) * step; v <= vmax + eps; v += step) {
    out.push(Math.abs(v) < eps ? 0 : v);
  }
  return out;
}

/* A plate must be byte-identical on any machine, so the tick face is pinned to a
 * fixed locale — a bare toLocaleString() prints "2.000" in de-DE and "2,000" in
 * en-US, and the exporting author's locale is not a figure parameter. */
const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function formatTick(v: number, step: number): string {
  if (Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3)) return v.toExponential(1);
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.abs(step) || 1))));
  return NUM.format(Number(v.toFixed(decimals)));
}

/**
 * Perceptual character of each shipped ramp, stated honestly.
 *
 * "perceptually uniform" is a MEASURED property (monotone, near-linear lightness
 * in CAM02-UCS), not a compliment. The matplotlib family was designed and
 * verified for it; the ColorBrewer sequential ramps are ordered in lightness but
 * were built for print legibility, not uniform ΔE, so they are named as ordered
 * rather than uniform. Saying "uniform" of a ramp that is not would be exactly
 * the kind of unearned claim this module exists to remove.
 */
const RAMP_CHARACTER: Record<string, string> = {
  magma: "sequential · perceptually uniform",
  inferno: "sequential · perceptually uniform",
  viridis: "sequential · perceptually uniform",
  cividis: "sequential · perceptually uniform · CVD-safe",
  coolwarm: "diverging · uniform lightness ramp",
  ylorrd: "sequential · ordered lightness (ColorBrewer)",
  emerald: "sequential · ordered lightness",
  plum: "sequential · ordered lightness",
  amber: "sequential · ordered lightness",
  rose: "sequential · ordered lightness",
};

export function colormapNote(name: string): string {
  const c = RAMP_CHARACTER[name];
  return c ? `${name} · ${c}` : name;
}

/** The disclosure lines for a domain. Facts only — no slogans, no percentiles
 *  invented for data that has none. */
export function domainNote(d: ContinuousDomain): string[] {
  const out: string[] = [];
  if (d.domainRule === "stored-extent") {
    // The producer declared nothing, so the ONLY defensible endpoints are what the
    // column contains. Say that, rather than calling the range "normalised".
    out.push("domain = stored extent; units not declared by the producer");
  } else if (d.unit) {
    out.push(`units: ${d.unit}${d.transform ? ` · ${d.transform}` : ""}`);
  } else if (d.transform) {
    out.push(d.transform);
  }
  const clipped = d.atFloor + d.atCeil;
  if (clipped > d.n * 0.001) {
    const pct = (100 * clipped) / Math.max(1, d.n);
    out.push(`${pct.toFixed(1)}% of cells sit on an endpoint (producer clipped)`);
  }
  if (d.synthetic) {
    // Must NOT be phrased as a percentile or a measured scale: that would dignify
    // seeded gaussian noise as if it were expression.
    out.push("SYNTHETIC — generator output, not measured expression");
  }
  return out;
}
