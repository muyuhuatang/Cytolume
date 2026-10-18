/**
 * declutter.ts — pure, no-DOM label collision resolution + semantic-zoom cap
 * (Cytolume P2 map-legibility, Foundations A2). Given already-projected label
 * candidates in CSS px, keep the most *populous* ones that don't overlap, up to
 * a zoom-derived `maxCount`. This is the "declutter + semantic zoom by
 * population" half of the legibility goal: few labels when zoomed out, more as
 * you push in — and never two labels stacked on top of each other.
 *
 * Greedy + population-sorted: bigger clusters win ties and own their screen
 * neighbourhood, so the map reads as named landmarks rather than confetti.
 */

/** A projected label competing for screen space. `x,y` are CSS px. */
export interface LabelCandidate {
  category: number;
  text: string;
  x: number;
  y: number;
  count: number;
  /** False ⇒ off-screen / behind camera; dropped before any placement. */
  visible: boolean;
  /** Rendered width in CSS px. Supply it (measure once per string and cache) so
   *  collision uses the real box; omitted ⇒ estimated from text length. */
  w?: number;
  /** Rendered height in CSS px; omitted ⇒ `DEFAULT_LABEL_H`. */
  h?: number;
}

/** A label that survived declutter, with a final draw `opacity` in [0,1]. */
export interface PlacedLabel {
  category: number;
  text: string;
  x: number;
  y: number;
  opacity: number;
}

export interface DeclutterOpts {
  /** Min clear gap (CSS px) between two kept label BOXES — not centres. */
  minGapPx: number;
  /** Hard cap on kept labels (semantic zoom: scales with camera distance). */
  maxCount: number;
}

/** Fallback label box height (CSS px) when a candidate omits `h`. */
export const DEFAULT_LABEL_H = 14;
/** Fallback mean glyph advance (CSS px) when a candidate omits `w`. Tuned for the
 *  11px UI face; only a fallback — measured widths are always preferred. */
const EST_CHAR_W = 6.2;

/** Half-extents of a candidate's box, using measured values when available. */
function halfBox(c: LabelCandidate): { hw: number; hh: number } {
  const w = c.w ?? c.text.length * EST_CHAR_W;
  const h = c.h ?? DEFAULT_LABEL_H;
  return { hw: w / 2, hh: h / 2 };
}

/**
 * Drop invisible candidates, sort by `count` desc (stable tiebreak on category
 * for determinism), then greedily keep up to `maxCount` candidates that are at
 * least `minGapPx` from every already-kept label (center-to-center). Labels in
 * the last ~20% of the kept budget ease their opacity down toward the cutoff so
 * the cap doesn't pop labels in/out harshly as you zoom. Returned in kept
 * order (most populous first).
 */
/** What a declutter pass actually did. The plate must be able to state how many
 *  names it dropped: silently omitting half of them is an unstated edit to the data,
 *  and a reader has no way to know the unnamed clusters were ever candidates. */
export interface DeclutterResult {
  labels: PlacedLabel[];
  /** Visible and therefore eligible — the DENOMINATOR the plate prints. */
  considered: number;
  /** Placed. considered - kept is what must be disclosed. */
  kept: number;
  /** Split of the losses, so a caller can tell "no room" from "budget spent". */
  droppedByCap: number;
  droppedByCollision: number;
}

/** Back-compatible wrapper: callers that do not need the stats are unchanged. */
export function declutterLabels(
  cands: LabelCandidate[],
  opts: DeclutterOpts,
): PlacedLabel[] {
  return declutterLabelsWithStats(cands, opts).labels;
}

export function declutterLabelsWithStats(
  cands: LabelCandidate[],
  opts: DeclutterOpts,
): DeclutterResult {
  const { minGapPx, maxCount } = opts;
  let droppedByCap = 0;
  let droppedByCollision = 0;
  const considered = cands.filter((c) => c.visible).length;
  if (maxCount <= 0) {
    return { labels: [], considered, kept: 0, droppedByCap: considered, droppedByCollision: 0 };
  }

  // Visible only, sorted by population desc; deterministic tiebreak.
  const ranked = cands
    .filter((c) => c.visible)
    .sort((a, b) => b.count - a.count || a.category - b.category);

  const kept: PlacedLabel[] = [];
  // Boxes of already-kept labels, parallel to `kept`, for the overlap test.
  const keptBox: { hw: number; hh: number }[] = [];

  for (let ci = 0; ci < ranked.length; ci++) {
    const c = ranked[ci];
    if (kept.length >= maxCount) {
      // Everything from here on is a BUDGET loss, not a geometry loss. The caller
      // needs the split so the plate can say which it was.
      droppedByCap = ranked.length - ci;
      break;
    }
    const cb = halfBox(c);
    let collides = false;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      const kb = keptBox[i];
      // Separating-axis test on two axis-aligned boxes, expanded by minGapPx so
      // labels keep a visible clear gap. A centre-distance test was wrong here:
      // label boxes are very wide and short, so two labels could sit far enough
      // apart by centre while their boxes overlapped almost completely.
      const gapX = Math.abs(c.x - k.x) - (cb.hw + kb.hw);
      const gapY = Math.abs(c.y - k.y) - (cb.hh + kb.hh);
      if (gapX < minGapPx && gapY < minGapPx) {
        collides = true;
        break;
      }
    }
    if (collides) {
      droppedByCollision++;
      continue;
    }
    kept.push({
      category: c.category,
      text: c.text,
      x: c.x,
      y: c.y,
      opacity: 1,
    });
    keptBox.push(cb);
  }

  // Ease opacity for the tail of the budget so the maxCount cutoff fades in
  // rather than popping. Only applies when we're actually near the cap.
  const fadeStart = Math.floor(maxCount * 0.8);
  if (maxCount > 1 && kept.length > fadeStart) {
    const span = maxCount - fadeStart; // slots inside the fade band (>=1)
    for (let i = fadeStart; i < kept.length; i++) {
      // t in (0,1]: the slot at the very cap (i === maxCount-1) is the most
      // faded, so the cutoff dissolves rather than pops as zoom changes.
      const t = (i - fadeStart + 1) / span;
      // The fade band dissolves the maxCount cutoff as zoom changes; it must not
      // make a PLACED label unreadable. A 0.35-alpha name over a dense cloud reads
      // as a rendering artefact, not as a label. 0.75 over the opaque halo stays
      // legible while the tail is still visibly softer than the core.
      kept[i].opacity = Math.max(0.75, 1 - 0.25 * t);
    }
  }

  return {
    labels: kept,
    considered,
    kept: kept.length,
    droppedByCap,
    droppedByCollision,
  };
}
