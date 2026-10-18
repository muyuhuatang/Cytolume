/*
 * SelectionSummary (Foundations A3) — a bottom-left card that summarizes the
 * current lasso selection: total count, the dominant cell type + its share, a
 * few type rows, and a "Clear" button. DOM-injected (no index.html edits);
 * styled by ui/interaction.css (.cyto-sel-summary …).
 *
 * It consumes the structural shape produced by A2's SelectionStore.summarize —
 * declared locally (below) so this UI module stays decoupled from interaction/.
 * The indigo accent is earned here on the count: a selection IS interactive state.
 */

/** One cell-type tally within a selection. */
export interface SummaryType {
  name: string;
  count: number;
  pct: number; // 0..100
}

/** Structural mirror of SelectionStore.summarize()'s return (A2 contract). */
export interface SelectionSummaryData {
  count: number;
  topType: { name: string; pct: number; count: number } | null;
  types: SummaryType[];
  datasets?: Array<{ name: string; count: number }>;
}

/** How many type rows to list under the headline before truncating. */
const MAX_TYPE_ROWS = 5;

export class SelectionSummary {
  readonly el: HTMLDivElement;
  private readonly countEl: HTMLSpanElement;
  private readonly topEl: HTMLDivElement;
  private readonly typesEl: HTMLDivElement;
  private readonly clearBtn: HTMLButtonElement;
  private visible = false;

  /** @param onClear invoked when the user presses "Clear". */
  constructor(onClear: () => void, parent: HTMLElement = document.body) {
    const el = document.createElement("div");
    el.className = "cyto-sel-summary";

    const head = document.createElement("div");
    head.className = "cyto-sel-head";
    const title = document.createElement("span");
    title.className = "cyto-sel-title";
    title.textContent = "Selection";
    const countEl = document.createElement("span");
    countEl.className = "cyto-sel-count";
    head.appendChild(title);
    head.appendChild(countEl);

    const topEl = document.createElement("div");
    topEl.className = "cyto-sel-top";

    const typesEl = document.createElement("div");
    typesEl.className = "cyto-sel-types";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "cyto-sel-clear";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => onClear());

    el.appendChild(head);
    el.appendChild(topEl);
    el.appendChild(typesEl);
    el.appendChild(clearBtn);
    parent.appendChild(el);

    this.el = el;
    this.countEl = countEl;
    this.topEl = topEl;
    this.typesEl = typesEl;
    this.clearBtn = clearBtn;
  }

  /** Render `data` and reveal the card. An empty selection hides it. */
  show(data: SelectionSummaryData): void {
    if (!data || data.count <= 0) {
      this.hide();
      return;
    }

    this.countEl.replaceChildren(
      document.createTextNode(data.count.toLocaleString()),
      this.unit(data.count === 1 ? "cell" : "cells"),
    );

    if (data.topType) {
      this.topEl.style.display = "";
      this.topEl.replaceChildren(
        document.createTextNode(data.topType.name),
        this.pctSpan(`${formatPct(data.topType.pct)} · ${data.topType.count.toLocaleString()}`),
      );
    } else {
      this.topEl.style.display = "none";
      this.topEl.replaceChildren();
    }

    // Type rows: skip the headline type (already shown) when it leads the list.
    const top = data.topType?.name;
    const rows = data.types
      .filter((t) => t.name !== top)
      .slice(0, MAX_TYPE_ROWS);
    this.typesEl.replaceChildren(...rows.map((t) => this.typeRow(t)));

    if (!this.visible) {
      this.el.classList.add("is-visible");
      this.visible = true;
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove("is-visible");
    this.visible = false;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.el.remove();
  }

  /** Programmatic Clear (e.g. an automated verifier) — same path as the button. */
  triggerClear(): void {
    this.clearBtn.click();
  }

  private unit(text: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = "cyto-sel-count-unit";
    s.textContent = text;
    return s;
  }

  private pctSpan(text: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = "cyto-sel-top-pct";
    s.textContent = text;
    return s;
  }

  private typeRow(t: SummaryType): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "cyto-sel-type-row";
    const name = document.createElement("span");
    name.className = "cyto-sel-type-name";
    name.textContent = t.name;
    name.title = t.name;
    const count = document.createElement("span");
    count.className = "cyto-sel-type-count";
    count.textContent = t.count.toLocaleString();
    const pct = document.createElement("span");
    pct.className = "cyto-sel-type-pct";
    pct.textContent = formatPct(t.pct);
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(pct);
    return row;
  }
}

/** Compact percentage: "<1%" for tiny shares, integer otherwise. */
function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
