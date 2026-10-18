/*
 * LassoOverlay (Foundations A3) — a transparent, pointer-events:none 2D canvas
 * pinned over the WebGL stage that draws the in-progress freeform lasso path.
 * DOM-injected (no index.html edits); positioned by ui/interaction.css
 * (.cyto-lasso-overlay). The stroke is the reserved selection indigo (#5B8DEF)
 * with a faint fill — the lasso IS interactive state, so the accent is earned.
 *
 * It is purely visual: it accumulates CSS-px points and redraws. The actual
 * hit-testing (lassoSelect) lives in interaction/ and runs on pointerup; this
 * overlay just shows the user where they've dragged.
 */

/** Selection indigo — read from the --accent design token so it inverts with the
 *  theme (dark #5B8DEF, light #3B6FD4). Falls back to the dark indigo when the
 *  token is undefined (e.g. a temp driver page without :root tokens). */
const FALLBACK_ACCENT = "#5b8def";
function accentColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return v || FALLBACK_ACCENT;
}

export class LassoOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private points: Array<[number, number]> = [];
  private active = false;
  private readonly onResize = () => this.resize();

  constructor(parent: HTMLElement = document.body) {
    const canvas = document.createElement("canvas");
    canvas.className = "cyto-lasso-overlay";
    parent.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("ui/lasso-overlay: 2D context unavailable");
    this.canvas = canvas;
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", this.onResize);
  }

  /** True while a lasso gesture is being drawn. */
  get isActive(): boolean {
    return this.active;
  }

  /** Current path as CSS-px points (a shallow copy). */
  getPoints(): Array<[number, number]> {
    return this.points.map((p) => [p[0], p[1]] as [number, number]);
  }

  /** Start a fresh gesture (clears any prior path). */
  begin(): void {
    this.points = [];
    this.active = true;
    this.draw();
  }

  /** Append a CSS-px vertex and redraw the open path. */
  addPoint(x: number, y: number): void {
    if (!this.active) return;
    // Skip near-duplicate samples to keep the path light on fast drags.
    const last = this.points[this.points.length - 1];
    if (last && Math.abs(last[0] - x) < 1 && Math.abs(last[1] - y) < 1) return;
    this.points.push([x, y]);
    this.draw();
  }

  /** Finish the gesture, drawing it closed. Returns the captured points. */
  end(): Array<[number, number]> {
    this.active = false;
    this.draw(true);
    return this.getPoints();
  }

  /** Erase the overlay and drop the path. */
  clear(): void {
    this.active = false;
    this.points = [];
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.canvas.remove();
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // Draw in CSS px; the transform maps to backing-store px.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.points.length) this.draw(!this.active);
  }

  private draw(closed = false): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (this.points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(this.points[0][0], this.points[0][1]);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i][0], this.points[i][1]);
    }
    if (closed) ctx.closePath();

    const accent = accentColor();
    ctx.globalAlpha = 0.08; // faint fill — the lasso IS interactive state.
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.lineWidth = 1.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(closed ? [] : [5, 4]);
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
