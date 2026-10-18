/*
 * colorbar.ts — the key for the CONTINUOUS encoding.
 *
 * The categorical legend (ui/legend.ts) names one swatch per cell type; it is
 * meaningless when marks are coloured by a scalar, so main3d hides it in continuous
 * mode. That left the continuous channel with NO key at all — a figure whose colour
 * axis is unlabelled. This supplies the missing half: the active colormap as a ramp,
 * with the channel name and its end values.
 *
 * TICKS: this file used to argue against them, on the grounds that a mid-ramp tick
 * implies a precision the render could not deliver because overlapping marks
 * accumulated into one summed colour. That was TRUE of the old resolve, which
 * recovered hue as hdr/max(hdr) and pinned the red channel of any warm map to 1.0.
 * It is no longer true: the accumulation buffer now carries optical depth in .a and
 * depth-weighted colour in .rgb, so the hue a pixel shows IS the depth-weighted mean
 * cell value (see core/renderer3d.ts). A reader can now legitimately carry a colour
 * back to a number, so the bar owes them the numbers — in DATA units, at round
 * values, never as fractions of the ramp.
 *
 * The DISTRIBUTION strip under the ramp exists so the domain is not just asserted:
 * it shows where the values actually lie inside it, which is how you can see at a
 * glance that a domain is badly chosen or that the producer clipped.
 */
import { CONTINUOUS_STOPS } from "../core/colormaps.ts";
import type { ContinuousColormap } from "../core/types.ts";

export interface ColorbarOpts {
  /** What the scalar means, e.g. "Expression (log1p CP10K)". */
  label: string;
  /** Ramp fraction 0..1 + face, at round DATA values. */
  ticks?: { t: number; text: string }[];
  /** Counts across the domain; drawn as a distribution strip under the ramp. */
  hist?: Uint32Array | null;
  histMax?: number;
  /** Which ramp, and what kind it is — e.g. "magma · perceptually uniform". */
  colormapNote?: string;
  /** Disclosure lines in small type. Each is a fact, not a slogan. */
  note?: string | string[];
  /** The SECOND 1-D key: density, hue-free, ticked in cells along the ray. Two 1-D
   *  keys rather than one 2-D key because the luminance lock makes the two channels
   *  independently invertible — which a bivariate key of a many-to-one map never was. */
  density?: {
    ticks: { t: number; text: string }[];
    swatches: { t: number; color: string }[];
    note: string[];
  } | null;
}

export class Colorbar {
  private el: HTMLElement;
  private ramp: HTMLElement;
  private labelEl: HTMLElement;
  private ticksEl: HTMLElement;
  private densityWrap: HTMLElement;
  private densityLabel: HTMLElement;
  private densityRamp: HTMLElement;
  private densityTicks: HTMLElement;
  private histEl: HTMLCanvasElement;
  private noteEl: HTMLElement;
  private visible = false;

  constructor(parent: HTMLElement = document.body) {
    const el = document.createElement("div");
    el.className = "cyto-colorbar";

    this.labelEl = document.createElement("div");
    this.labelEl.className = "cyto-colorbar-label";
    el.appendChild(this.labelEl);

    this.ramp = document.createElement("div");
    this.ramp.className = "cyto-colorbar-ramp";
    el.appendChild(this.ramp);

    // Distribution strip: sits directly under the ramp and shares its x-axis, so a
    // bar's height reads against the colour immediately above it.
    this.histEl = document.createElement("canvas");
    this.histEl.className = "cyto-colorbar-hist";
    this.histEl.width = 244;
    this.histEl.height = 22;
    el.appendChild(this.histEl);

    this.ticksEl = document.createElement("div");
    this.ticksEl.className = "cyto-colorbar-ticks";
    el.appendChild(this.ticksEl);

    // --- second key: density -------------------------------------------------
    this.densityWrap = document.createElement("div");
    this.densityWrap.className = "cyto-colorbar-density";
    this.densityLabel = document.createElement("div");
    this.densityLabel.className = "cyto-colorbar-label";
    this.densityLabel.textContent = "DENSITY";
    this.densityRamp = document.createElement("div");
    this.densityRamp.className = "cyto-colorbar-ramp";
    this.densityTicks = document.createElement("div");
    this.densityTicks.className = "cyto-colorbar-ticks";
    this.densityWrap.append(this.densityLabel, this.densityRamp, this.densityTicks);
    el.appendChild(this.densityWrap);

    this.noteEl = document.createElement("div");
    this.noteEl.className = "cyto-colorbar-note";
    el.appendChild(this.noteEl);

    parent.appendChild(el);
    this.el = el;
  }

  /** Paint the ramp from the same stop list the renderer's LUT is built from, so the
   *  bar and the marks can never disagree about the colormap. */
  setColormap(name: ContinuousColormap): void {
    const stops = CONTINUOUS_STOPS(name);
    const n = stops.length;
    const parts = stops.map((c, i) => `${c} ${((i / (n - 1)) * 100).toFixed(1)}%`);
    this.ramp.style.background = `linear-gradient(90deg, ${parts.join(", ")})`;
  }

  show(opts: ColorbarOpts): void {
    this.labelEl.textContent = opts.label;
    this.drawTicks(opts.ticks ?? []);
    this.drawHist(opts.hist ?? null, opts.histMax ?? 0);
    const den = opts.density ?? null;
    this.densityWrap.style.display = den ? "" : "none";
    if (den) {
      const parts = den.swatches.map((sw) => `${sw.color} ${(sw.t * 100).toFixed(1)}%`);
      this.densityRamp.style.background = `linear-gradient(90deg, ${parts.join(", ")})`;
      this.densityTicks.textContent = "";
      for (const k of den.ticks) {
        const el = document.createElement("span");
        el.textContent = k.text;
        el.style.left = `${(k.t * 100).toFixed(2)}%`;
        el.style.transform =
          k.t <= 0.02 ? "translateX(0)" : k.t >= 0.98 ? "translateX(-100%)" : "translateX(-50%)";
        this.densityTicks.appendChild(el);
      }
    }
    const lines = Array.isArray(opts.note) ? opts.note : opts.note ? [opts.note] : [];
    if (den) lines.push(...den.note);
    if (opts.colormapNote) lines.unshift(opts.colormapNote);
    this.noteEl.textContent = lines.join(" · ");
    this.noteEl.style.display = lines.length ? "" : "none";
    if (!this.visible) {
      this.el.classList.add("is-visible");
      this.visible = true;
    }
  }

  /** Ticks are positioned as a percentage of the ramp, so they stay aligned with
   *  the gradient at any width. Edge ticks are nudged inside so their text does not
   *  overhang the card. */
  private drawTicks(ticks: { t: number; text: string }[]): void {
    this.ticksEl.textContent = "";
    for (const k of ticks) {
      const s = document.createElement("span");
      s.textContent = k.text;
      s.style.left = `${(k.t * 100).toFixed(2)}%`;
      // < 2% / > 98% would clip against the card edge; pin those to the ends.
      s.style.transform =
        k.t <= 0.02 ? "translateX(0)" : k.t >= 0.98 ? "translateX(-100%)" : "translateX(-50%)";
      this.ticksEl.appendChild(s);
    }
  }

  /** sqrt height scaling: a single mode would otherwise flatten every other bin to
   *  nothing, and the strip is there to show the SHAPE, not to be read off. */
  private drawHist(hist: Uint32Array | null, histMax: number): void {
    const c = this.histEl;
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    if (!hist || !hist.length || histMax <= 0) {
      c.style.display = "none";
      return;
    }
    c.style.display = "";
    const bw = c.width / hist.length;
    g.fillStyle = getComputedStyle(this.el).getPropertyValue("--cyto-text").trim() || "#888";
    g.globalAlpha = 0.45;
    for (let i = 0; i < hist.length; i++) {
      const h = Math.sqrt(hist[i] / histMax) * (c.height - 1);
      g.fillRect(i * bw, c.height - h, Math.max(1, bw - 0.5), h);
    }
    g.globalAlpha = 1;
  }

  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove("is-visible");
    this.visible = false;
  }

  destroy(): void {
    this.el.remove();
  }
}
