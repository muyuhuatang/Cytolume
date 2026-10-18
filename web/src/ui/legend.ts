/*
 * Legend (Foundations A3) — the cell-type legend with FOCUS+CONTEXT. A compact,
 * collapsible panel pinned to the LEFT edge that lists every present cell type
 * with its matching Core-24 swatch, count, and percentage. Hovering a row asks
 * the host to focus that category (all others DIM); clicking pins the focus.
 *
 * DOM-injected (no index.html edits); styled by ui/map-legibility.css
 * (.cyto-legend …). The honest answer to "you can't tell 48 hues apart": let the
 * user spotlight one type at a time. The swatch is the type's REAL on-screen
 * color (CORE_24[cat % 24]) so the panel and the plot agree exactly.
 *
 * Wiring calls: new Legend(onHover, onClick, parent?) → show(rows) / setFocus(cat)
 * / hide() / destroy(). Hover/click callbacks carry the RAW category index.
 */

/** One legend entry. `color` must come from the SAME source as the plot's LUT. */
export interface LegendRow {
  category: number;
  name: string;
  color: string;
  count: number;
  pct: number; // 0..100
}

export class Legend {
  readonly el: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly countEl: HTMLSpanElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly onHover: (cat: number | null) => void;
  private readonly onClick: (cat: number) => void;

  /** category → its row element, for O(1) focus marking. */
  private readonly rowEls = new Map<number, HTMLDivElement>();
  private focused: number | null = null;
  private collapsed = false;
  private visible = false;

  /**
   * @param onHover called with a category on row-enter, `null` on row-leave.
   * @param onClick called with a category when a row is clicked (host toggles pin).
   */
  constructor(
    onHover: (cat: number | null) => void,
    onClick: (cat: number) => void,
    parent: HTMLElement = document.body,
  ) {
    this.onHover = onHover;
    this.onClick = onClick;

    const el = document.createElement("div");
    el.className = "cyto-legend";

    // ---- header: title + present-type count + collapse toggle -------------
    const head = document.createElement("div");
    head.className = "cyto-legend-head";

    const title = document.createElement("span");
    title.className = "cyto-legend-title";
    title.textContent = "Cell types";

    const countEl = document.createElement("span");
    countEl.className = "cyto-legend-typecount";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "cyto-legend-toggle";
    toggleBtn.setAttribute("aria-label", "Collapse legend");
    toggleBtn.textContent = "–";
    toggleBtn.addEventListener("click", () => this.setCollapsed(!this.collapsed));

    head.appendChild(title);
    head.appendChild(countEl);
    head.appendChild(toggleBtn);

    // ---- scrollable list of type rows -------------------------------------
    const listEl = document.createElement("div");
    listEl.className = "cyto-legend-list";

    el.appendChild(head);
    el.appendChild(listEl);
    parent.appendChild(el);

    this.el = el;
    this.listEl = listEl;
    this.countEl = countEl;
    this.toggleBtn = toggleBtn;
  }

  /** Render `rows` (host should pre-sort, e.g. count desc) and reveal the panel. */
  show(rows: LegendRow[]): void {
    this.rowEls.clear();
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(this.buildRow(row));
    this.listEl.replaceChildren(frag);
    this.countEl.textContent = String(rows.length);

    // Re-apply focus marking if the previously focused type is still present.
    if (this.focused !== null && !this.rowEls.has(this.focused)) {
      this.focused = null;
    }
    this.applyFocusMarks();

    if (!this.visible) {
      this.el.classList.add("is-visible");
      this.visible = true;
    }
  }

  /**
   * Visually mark `cat` as the focused/pinned row (others recede). `null` clears.
   * Does NOT fire callbacks — this is pure presentation driven by the host.
   */
  setFocus(cat: number | null): void {
    this.focused = cat;
    this.applyFocusMarks();
  }

  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove("is-visible");
    this.visible = false;
  }

  destroy(): void {
    this.rowEls.clear();
    this.el.remove();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Collapse/expand the list (header stays). */
  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.el.classList.toggle("is-collapsed", collapsed);
    this.toggleBtn.textContent = collapsed ? "+" : "–";
    this.toggleBtn.setAttribute(
      "aria-label",
      collapsed ? "Expand legend" : "Collapse legend",
    );
  }

  private buildRow(row: LegendRow): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "cyto-legend-row";
    el.dataset.cat = String(row.category);

    const swatch = document.createElement("span");
    swatch.className = "cyto-legend-swatch";
    swatch.style.background = row.color;

    const name = document.createElement("span");
    name.className = "cyto-legend-name";
    name.textContent = row.name;
    name.title = row.name;

    const count = document.createElement("span");
    count.className = "cyto-legend-count";
    count.textContent = row.count.toLocaleString();

    const pct = document.createElement("span");
    pct.className = "cyto-legend-pct";
    pct.textContent = formatPct(row.pct);

    el.appendChild(swatch);
    el.appendChild(name);
    el.appendChild(count);
    el.appendChild(pct);

    el.addEventListener("mouseenter", () => this.onHover(row.category));
    el.addEventListener("mouseleave", () => this.onHover(null));
    el.addEventListener("click", () => this.onClick(row.category));

    this.rowEls.set(row.category, el);
    return el;
  }

  /** Reflect `this.focused` into the DOM: focused row lit, rest dimmed. */
  private applyFocusMarks(): void {
    const hasFocus = this.focused !== null;
    this.el.classList.toggle("has-focus", hasFocus);
    for (const [cat, el] of this.rowEls) {
      el.classList.toggle("is-focused", hasFocus && cat === this.focused);
    }
  }
}

/** Compact percentage: "<1%" for tiny shares, integer otherwise. */
function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
