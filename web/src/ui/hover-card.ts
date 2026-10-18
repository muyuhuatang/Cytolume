/*
 * HoverCard (Foundations A3) — a small, cursor-anchored detail card for the
 * cell under the pointer in the 3D view. DOM-injected (no index.html edits);
 * styled by ui/interaction.css (.cyto-hover-card …). Design tokens only:
 * flat panel chrome, IBM Plex Mono + tabular-nums for the id, no glow.
 *
 * The card follows the cursor WITHOUT covering it: it sits offset down-right of
 * the pointer, flipping to the opposite side near the viewport edges so it never
 * clips or hides the very cell being inspected.
 */

/** The fields the wiring feeds in (from TileSource.getCell). All optional bar id;
 *  `expr` is the continuous channel value in [0,1] (a.k.a. confidence). */
export interface HoverFields {
  id: number;
  cellType?: string;
  dataset?: string;
  expr?: number;
}

/** Gap between the cursor and the nearest card corner, in CSS px. */
const CURSOR_GAP = 16;
/** Viewport margin kept clear so the card never bleeds off-screen. */
const EDGE_MARGIN = 8;

export class HoverCard {
  readonly el: HTMLDivElement;
  private readonly idEl: HTMLDivElement;
  private readonly rowsEl: HTMLDivElement;
  private visible = false;

  constructor(parent: HTMLElement = document.body) {
    const el = document.createElement("div");
    el.className = "cyto-hover-card";

    const idEl = document.createElement("div");
    idEl.className = "cyto-hover-id";

    const rowsEl = document.createElement("div");
    rowsEl.className = "cyto-hover-rows";
    rowsEl.style.display = "contents"; // rows are direct flex children of the card

    el.appendChild(idEl);
    el.appendChild(rowsEl);
    parent.appendChild(el);

    this.el = el;
    this.idEl = idEl;
    this.rowsEl = rowsEl;
  }

  /** Render `fields` and anchor the card near (clientX, clientY) without covering it. */
  show(fields: HoverFields, clientX: number, clientY: number): void {
    this.idEl.textContent = `cell #${fields.id}`;

    // Rebuild the detail rows from whatever fields are present.
    this.rowsEl.replaceChildren();
    if (fields.cellType) this.addRow("Type", fields.cellType, false);
    if (fields.dataset) this.addRow("Dataset", fields.dataset, false);
    if (fields.expr !== undefined && Number.isFinite(fields.expr)) {
      this.addRow("Expr", fields.expr.toFixed(3), true);
    }

    if (!this.visible) {
      this.el.classList.add("is-visible");
      this.visible = true;
    }
    this.position(clientX, clientY);
  }

  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove("is-visible");
    this.visible = false;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Plain-text snapshot of the card — used by the automation/verifier surface. */
  text(): string {
    if (!this.visible) return "";
    const lines = [this.idEl.textContent ?? ""];
    for (const row of Array.from(this.rowsEl.children)) {
      const k = row.querySelector(".cyto-hover-key")?.textContent ?? "";
      const v = row.querySelector(".cyto-hover-val")?.textContent ?? "";
      lines.push(`${k}: ${v}`);
    }
    return lines.join("\n");
  }

  destroy(): void {
    this.el.remove();
  }

  private addRow(key: string, value: string, numeric: boolean): void {
    const row = document.createElement("div");
    row.className = "cyto-hover-row";
    const k = document.createElement("span");
    k.className = "cyto-hover-key";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = numeric ? "cyto-hover-val is-num" : "cyto-hover-val";
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    this.rowsEl.appendChild(row);
  }

  /** Place the card offset from the cursor, flipping near edges so it never covers it. */
  private position(clientX: number, clientY: number): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Measure after content is in the DOM (display:flex via is-visible).
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;

    // Prefer down-right of the cursor; flip to the left / up when it would clip.
    let x = clientX + CURSOR_GAP;
    if (x + w + EDGE_MARGIN > vw) x = clientX - CURSOR_GAP - w;
    if (x < EDGE_MARGIN) x = EDGE_MARGIN;

    let y = clientY + CURSOR_GAP;
    if (y + h + EDGE_MARGIN > vh) y = clientY - CURSOR_GAP - h;
    if (y < EDGE_MARGIN) y = EDGE_MARGIN;

    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
