/*
 * Camera2D — isotropic 2D pan/zoom with logarithmic zoom feel (reflection-0 §5).
 *
 * "Most of the premium feel" comes from the camera: zoom is exponential in the
 * scroll delta (constant perceived speed at every scale), and it zooms about the
 * cursor, not the origin. The renderer consumes `uOffset` (data-space center)
 * and `uScale` (per-axis data→NDC factors), so the GPU maps points with a single
 * MAD — no CPU transform of the point buffer, ever.
 */
export class Camera2D {
  /** Data-space coordinate currently at screen center. */
  cx = 0;
  cy = 0;
  /** NDC units per data unit on the Y axis (X is derived via aspect). */
  s = 1;

  private width = 1;
  private height = 1;

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  private get aspect(): number {
    return this.width / this.height;
  }

  /**
   * Frame the given data bounds with a little breathing room. Accepts a 2D
   * bounds tuple [minX,minY,maxX,maxY]; callers framing a 3D layout in the 2D
   * view must pass the XY sub-bounds (minX,minY,maxX,maxY), not the raw 6-tuple.
   */
  fit(bounds: number[], pad = 1.08): void {
    const [minX, minY, maxX, maxY] = bounds;
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    const w = Math.max(1e-6, maxX - minX) * pad;
    const h = Math.max(1e-6, maxY - minY) * pad;
    // fit whichever axis is the binding constraint (NDC spans 2 units)
    const sForWidth = (2 / w) * this.aspect; // NDC-per-data on Y to fit width
    const sForHeight = 2 / h;
    this.s = Math.min(sForWidth, sForHeight);
  }

  /** Drag pan, in CSS pixels. Screen-down maps to data-up. */
  panByPixels(dxPx: number, dyPx: number): void {
    const dataPerPixel = 2 / (this.height * this.s);
    this.cx -= dxPx * dataPerPixel;
    this.cy += dyPx * dataPerPixel;
  }

  /**
   * Logarithmic zoom about a cursor position given in NDC ([-1,1], y-up).
   * `delta` is the raw wheel deltaY; positive (scroll down) zooms out.
   */
  zoomAt(delta: number, ndcX: number, ndcY: number): void {
    const factor = Math.exp(-delta * 0.0015); // exponential → constant feel
    const aspect = this.aspect;
    // data point under the cursor before the zoom
    const dataX = this.cx + (ndcX * aspect) / this.s;
    const dataY = this.cy + ndcY / this.s;
    this.s = clamp(this.s * factor, 1e-4, 1e6);
    // pin that data point back under the cursor
    this.cx = dataX - (ndcX * aspect) / this.s;
    this.cy = dataY - ndcY / this.s;
  }

  /** Uniforms for the vertex shader: ndc = (data - uOffset) * uScale. */
  uniforms(): { uOffset: [number, number]; uScale: [number, number] } {
    return {
      uOffset: [this.cx, this.cy],
      uScale: [this.s / this.aspect, this.s],
    };
  }

  /** Approximate screen pixels per data unit — drives density-aware opacity. */
  pixelsPerDataUnit(): number {
    return (this.s * this.height) / 2;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
