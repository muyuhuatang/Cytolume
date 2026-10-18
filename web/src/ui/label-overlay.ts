/*
 * LabelOverlay (Foundations A3) — the auto cluster-label layer. Renders a quiet
 * span at each cell-type centroid (already projected to CSS px + decluttered by
 * the labels/ logic). "Structure first, labels second": restrained Inter, semi-
 * transparent, NEVER glowing — a subtle dark shadow only for legibility on the
 * dark canvas. pointer-events:none so it never steals orbit/lasso input.
 *
 * DOM-injected (no index.html edits); styled by ui/map-legibility.css
 * (.cyto-label-overlay …). Spans are keyed by text so update() reuses/moves
 * existing nodes instead of thrashing the DOM every frame.
 *
 * Wiring calls: new LabelOverlay(parent?) → update(labels) per frame /
 * clear() / destroy(). Labels are keyed by `text`; if two centroids share text,
 * pass disambiguated text (the decluttered set is already unique per category).
 */

/** One placed label. `x`,`y` are CSS px (overlay top-left origin). */
export interface PlacedLabel {
  text: string;
  x: number;
  y: number;
  opacity: number; // 0..1
}

export class LabelOverlay {
  readonly el: HTMLDivElement;
  /** text → its span, for reuse across frames. */
  private readonly spans = new Map<string, HTMLSpanElement>();

  constructor(parent: HTMLElement = document.body) {
    const el = document.createElement("div");
    el.className = "cyto-label-overlay";
    parent.appendChild(el);
    this.el = el;
  }

  /**
   * Reconcile the overlay to exactly `labels`: move/restyle survivors, create
   * newcomers, remove the absent. Cheap enough to call every RAF at ~48 labels.
   */
  update(labels: PlacedLabel[]): void {
    const seen = new Set<string>();

    for (const label of labels) {
      seen.add(label.text);
      let span = this.spans.get(label.text);
      if (!span) {
        span = document.createElement("span");
        span.className = "cyto-label";
        span.textContent = label.text;
        this.el.appendChild(span);
        this.spans.set(label.text, span);
      }
      // translate(-50%,-50%) centers the span on the point (set in CSS).
      span.style.transform = `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`;
      span.style.opacity = clamp01(label.opacity).toFixed(3);
    }

    // Drop labels no longer present.
    for (const [text, span] of this.spans) {
      if (!seen.has(text)) {
        span.remove();
        this.spans.delete(text);
      }
    }
  }

  /** Remove every label span (overlay element stays mounted). */
  clear(): void {
    for (const span of this.spans.values()) span.remove();
    this.spans.clear();
  }

  destroy(): void {
    this.clear();
    this.el.remove();
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
