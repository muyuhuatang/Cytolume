/*
 * PointRenderer — the Cytolume rendering substrate (reflection-0 §3, §5).
 *
 * The premium feel is a *stack* of GPU choices, not one bloom filter:
 *   - sphere-ish soft sprites with a circular discard (analytic-ish AA),
 *   - HDR additive accumulation into a float buffer, then Reinhard tone-map
 *     over the near-black canvas  → density honestly becomes glow,
 *   - per-point style sampled from a 256-wide LUT texture (recolor = texel
 *     swap, never a CPU pass),
 *   - density-aware opacity recomputed every frame from the camera.
 *
 * The one rule (reflection-0 §4): blending is an encoding and flips by mode.
 *   continuous/density → additive (ONE, ONE)        density-as-glow
 *   categorical        → premultiplied alpha-over    (additive-mixing two
 *                        categories would invent a false third cell type).
 *
 * regl's own generics are intentionally kept loose (`any`) here — the value of
 * this module is in the GPU choices above, not in fighting the binding's types.
 * Domain types (PointData, EncodingMode, Camera2D) stay strict.
 */
import createREGL from "regl";
import type { EncodingMode, PointData } from "./types.ts";
import { buildContinuousLUT, buildCategoricalLUT } from "./colormaps.ts";
import type { Camera2D } from "./camera.ts";

// Theme canvas clears (SPEC §FEATURE 1). Dark = near-black charcoal (today's
// look); light = off-white "paper" (never pure white).
const CANVAS_DARK: [number, number, number] = [11 / 255, 14 / 255, 20 / 255]; // #0B0E14
const CANVAS_LIGHT: [number, number, number] = [238 / 255, 240 / 255, 243 / 255]; // #EEF0F3

interface FrameProps {
  uOffset: [number, number];
  uScale: [number, number];
  pointSize: number;
  alpha: number;
  mode: number;
  framebuffer: unknown | null;
  viewport: { x: number; y: number; width: number; height: number };
}

export class PointRenderer {
  private regl: any;
  private canvas: HTMLCanvasElement;
  private hdr: any = null;
  private hdrSupported: boolean;

  private continuousLUT: any;
  private categoricalLUT: any;

  private positions: any = null;
  private values: any = null;
  private categories: any = null;
  private count = 0;
  private density = 1; // points per data-unit²
  /** Active theme (SPEC §FEATURE 1). "dark" (default) = today's look; "light"
   *  flips the canvas clear + the tonemap composite to ink-on-paper. */
  private theme: "dark" | "light" = "dark";

  private drawAdditive: any;
  private drawCategorical: any;
  private toneMap: any;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.regl = createREGL({
      canvas,
      attributes: {
        alpha: false,
        antialias: false,
        depth: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      },
      optionalExtensions: [
        "OES_texture_half_float",
        "OES_texture_float",
        "EXT_color_buffer_half_float",
      ],
    });

    this.continuousLUT = this.makeLUT(buildContinuousLUT("magma"));
    this.categoricalLUT = this.makeLUT(buildCategoricalLUT());
    this.hdrSupported = this.tryCreateHDR(canvas.width, canvas.height);

    const vert = /* glsl */ `
      precision highp float;
      attribute vec2 aPosition;
      attribute float aValue;
      attribute float aCategory;
      uniform vec2 uOffset, uScale;
      uniform float uPointSize;
      varying float vValue;
      varying float vCategory;
      void main() {
        vec2 ndc = (aPosition - uOffset) * uScale;
        gl_Position = vec4(ndc, 0.0, 1.0);
        gl_PointSize = uPointSize;
        vValue = aValue;
        vCategory = aCategory;
      }
    `;

    const frag = /* glsl */ `
      precision highp float;
      varying float vValue;
      varying float vCategory;
      uniform sampler2D uContinuousLUT;
      uniform sampler2D uCategoricalLUT;
      uniform float uAlpha;
      uniform float uMode; // 0 = continuous (additive), 1 = categorical (over)
      void main() {
        // soft radial sprite with a circular cutout — the sphere-impostor feel
        vec2 pc = gl_PointCoord - 0.5;
        float r2 = dot(pc, pc);
        if (r2 > 0.25) discard;
        float fall = exp(-r2 * 7.0);
        if (uMode < 0.5) {
          vec3 rgb = texture2D(uContinuousLUT, vec2(vValue, 0.5)).rgb;
          gl_FragColor = vec4(rgb * fall * uAlpha, 1.0); // emissive, added in HDR
        } else {
          vec3 rgb = texture2D(uCategoricalLUT, vec2((vCategory + 0.5) / 256.0, 0.5)).rgb;
          float a = uAlpha * fall;
          gl_FragColor = vec4(rgb * a, a);              // premultiplied OVER
        }
      }
    `;

    const shared = {
      vert,
      frag,
      attributes: {
        aPosition: () => this.positions,
        aValue: () => this.values,
        aCategory: () => this.categories,
      },
      uniforms: {
        uOffset: (_: unknown, p: FrameProps) => p.uOffset,
        uScale: (_: unknown, p: FrameProps) => p.uScale,
        uPointSize: (_: unknown, p: FrameProps) => p.pointSize,
        uAlpha: (_: unknown, p: FrameProps) => p.alpha,
        uMode: (_: unknown, p: FrameProps) => p.mode,
        uContinuousLUT: () => this.continuousLUT,
        uCategoricalLUT: () => this.categoricalLUT,
      },
      // dynamic target: HDR buffer for the additive pass, screen (null) otherwise
      framebuffer: (_: unknown, p: FrameProps) => p.framebuffer ?? null,
      // explicit viewport every frame — regl caches gl.viewport at construction
      // (300×150) and only refreshes it via regl.frame()/poll(), which we don't use.
      viewport: (_: unknown, p: FrameProps) => p.viewport,
      count: () => this.count,
      primitive: "points" as const,
      depth: { enable: false },
    };

    this.drawAdditive = this.regl({
      ...shared,
      blend: { enable: true, func: { src: "one", dst: "one" }, equation: "add" },
    });

    this.drawCategorical = this.regl({
      ...shared,
      blend: {
        enable: true,
        func: {
          srcRGB: "one",
          dstRGB: "one minus src alpha",
          srcAlpha: "one",
          dstAlpha: "one minus src alpha",
        },
        equation: "add",
      },
    });

    this.toneMap = this.regl({
      vert: /* glsl */ `
        precision highp float;
        attribute vec2 aXy;
        varying vec2 vUv;
        void main() {
          vUv = aXy * 0.5 + 0.5;
          gl_Position = vec4(aXy, 0.0, 1.0);
        }
      `,
      frag: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uHDR;
        uniform float uExposure;
        uniform float uTheme;    // 0 = dark (glow), 1 = light (ink on paper)
        uniform vec3  uCanvas;   // paper color for the light theme
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
        void main() {
          vec3 hdr = texture2D(uHDR, vUv).rgb * uExposure;
          vec3 mapped = hdr / (hdr + vec3(1.0));   // Reinhard
          mapped = pow(mapped, vec3(1.0 / 1.6));    // gentle gamma lift
          if (uTheme > 0.5) {
            // LIGHT: density DARKENS the paper toward a LUT-tinted ink. amount =
            // reinhard(hdr luma); ink = the darkened colormap hue. Opaque (blend
            // off) so the paper shows where emission is ~0.
            float hl  = dot(hdr, LUMA);
            float amt = hl / (hl + 1.0);
            amt = pow(amt, 1.0 / 1.6);
            // Recover the colormap HUE from the pre-whitened HDR so dense cores
            // read as coloured ink, not gray (Reinhard whitens, white*0.42=gray).
            float mx = max(hdr.r, max(hdr.g, hdr.b));
            vec3 ink = (hdr / max(mx, 1e-4)) * 0.45;
            gl_FragColor = vec4(mix(uCanvas, ink, amt), 1.0);
          } else {
            // DARK: glow ADDED over the near-black canvas — current behaviour.
            gl_FragColor = vec4(mapped, 1.0);
          }
        }
      `,
      attributes: { aXy: [-4, -4, 4, -4, 0, 4] }, // oversized fullscreen tri
      uniforms: {
        uHDR: () => this.hdr,
        uExposure: 1.15,
        uTheme: () => (this.theme === "light" ? 1 : 0),
        uCanvas: () => CANVAS_LIGHT,
      },
      viewport: (_: unknown, p: { viewport: FrameProps["viewport"] }) => p.viewport,
      count: 3,
      depth: { enable: false },
      // DARK adds the glow over the cleared canvas; LIGHT's frag already composites
      // ink over the paper, so blending is disabled there (opaque overwrite).
      blend: {
        enable: () => this.theme !== "light",
        func: { src: "one", dst: "one" },
        equation: "add",
      },
    });
  }

  private makeLUT(data: Uint8Array): any {
    return this.regl.texture({
      data,
      width: 256,
      height: 1,
      format: "rgba",
      type: "uint8",
      min: "linear",
      mag: "linear",
      wrapS: "clamp",
      wrapT: "clamp",
    });
  }

  private tryCreateHDR(w: number, h: number): boolean {
    try {
      this.hdr = this.regl.framebuffer({
        width: Math.max(1, w),
        height: Math.max(1, h),
        colorType: "half float",
        depth: false,
        stencil: false,
      });
      return true;
    } catch {
      this.hdr = null;
      return false;
    }
  }

  setData(data: PointData): void {
    this.count = data.count;
    this.positions = this.regl.buffer(data.positions);
    this.values = this.regl.buffer(data.values);
    const catF = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) catF[i] = data.categories[i];
    this.categories = this.regl.buffer(catF);

    const [minX, minY, maxX, maxY] = data.bounds;
    const area = Math.max(1e-6, (maxX - minX) * (maxY - minY));
    this.density = data.count / area;
  }

  /**
   * Switch the visual theme (SPEC §FEATURE 1). "dark" (default) keeps today's
   * glow-over-near-black look; "light" flips the canvas clear to off-white paper
   * and branches the Reinhard tonemap to ink-on-paper (density darkens the page
   * toward a LUT-tinted ink). The additive HDR accumulation pass is theme-agnostic.
   */
  setTheme(t: "dark" | "light"): void {
    this.theme = t === "light" ? "light" : "dark";
  }

  /** The current theme. */
  get themeValue(): "dark" | "light" {
    return this.theme;
  }

  /** Active canvas clear color for the current theme. */
  private canvasRgb(): [number, number, number] {
    return this.theme === "light" ? CANVAS_LIGHT : CANVAS_DARK;
  }

  setColormap(name: string): void {
    this.continuousLUT({
      data: buildContinuousLUT(name),
      width: 256,
      height: 1,
      format: "rgba",
      type: "uint8",
    });
  }

  /** Recompute point size + per-frame opacity from the camera (density-aware). */
  private frameStyle(camera: Camera2D, mode: EncodingMode): { pointSize: number; alpha: number } {
    const ppdu = camera.pixelsPerDataUnit();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ppp = Math.max(1e-5, this.density / (ppdu * ppdu)); // points / px²
    const pointSize = clamp(1.4 + 3.0 / Math.sqrt(ppp), 1.4, 10) * dpr;
    const coverage = Math.max(1, ppp * pointSize * pointSize);
    // Fixed global alpha is banned (reflection-0 §5) — adapt to local density.
    const alpha =
      mode === "continuous"
        ? clamp(1.2 / coverage, 0.03, 1.0)
        : clamp(0.9 / Math.sqrt(coverage), 0.18, 0.95);
    return { pointSize, alpha };
  }

  render(camera: Camera2D, mode: EncodingMode): void {
    const { width, height } = this.canvas;
    camera.setViewport(width, height);
    const { uOffset, uScale } = camera.uniforms();
    const { pointSize, alpha } = this.frameStyle(camera, mode);
    const viewport = { x: 0, y: 0, width, height };
    const base = { uOffset, uScale, pointSize, alpha, viewport };

    if (mode === "continuous" && this.hdrSupported && this.hdr) {
      this.hdr.resize(width, height);
      this.regl.clear({ color: [0, 0, 0, 1], framebuffer: this.hdr });
      this.drawAdditive({ ...base, mode: 0, framebuffer: this.hdr } as FrameProps);
      this.regl.clear({ color: [...this.canvasRgb(), 1] });
      this.toneMap({ viewport });
    } else {
      this.regl.clear({ color: [...this.canvasRgb(), 1] });
      const props = { ...base, framebuffer: null };
      if (mode === "continuous") this.drawAdditive({ ...props, mode: 0 } as FrameProps);
      else this.drawCategorical({ ...props, mode: 1 } as FrameProps);
    }
  }

  get pointCount(): number {
    return this.count;
  }

  destroy(): void {
    this.regl.destroy();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
