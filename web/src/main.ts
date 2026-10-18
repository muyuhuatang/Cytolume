/*
 * Cytolume showcase — the thin app over the library core (reflection-0 §8.3).
 * Calm default interface (reflection-1 §11): full-canvas embedding, a compact
 * encoding selector, unobtrusive readouts. Drag to pan, scroll to log-zoom.
 *
 * Data now comes through a TileSource (reflection-2 §6): the real P0 spine via
 * SpineTileSource when `/spine/manifest.json` is present, else the synthetic
 * generator wrapped as SyntheticTileSource. Swapping the source swaps the data,
 * not the pipeline.
 *
 * VIEW ROUTING (integration track) — this module is the single entry point and
 * routes the active layout to one of two rendering SUBSTRATES:
 *   2D view → the regl/WebGL1 PointRenderer (this file, projectTo2D path)
 *   3D view → the raw-WebGL2 Renderer3D boot in ./main3d.ts (stride-3 path)
 * The two substrates cannot share one canvas GL context (WebGL1 vs WebGL2), so
 * the "View" control switches between them by committing the choice to the URL
 * (`?view=2d|3d`) and reloading — a clean context teardown with no leak. The
 * legacy `?r3d=1` shortcut is still honored (treated as view=3d). The View
 * <select> itself is wired here BEFORE the branch, so it works in both modes
 * regardless of which substrate boots. The 3D view is the DEFAULT (the bare URL
 * lands in 3D); only an explicitly-requested 2D layout falls back to the 2D view.
 */
import "./style.css";
import { setupQuickStart } from "./ui/quick-start.ts";
import { PointRenderer, Camera2D } from "./core/index.ts";
import type { EncodingMode, ContinuousColormap, PointData } from "./core/index.ts";
import { loadManifest } from "./data/manifest.ts";
import { SpineTileSource } from "./data/spine-tile-source.ts";
import { SyntheticTileSource } from "./data/synthetic-source.ts";
import type { TileSource } from "./data/tile-source.ts";

/**
 * The 3D interaction seam (SPEC §PICK / §highlight) the future interaction track
 * builds on. The 3D boot (./main3d.ts) publishes this on `window.__r3d` whenever
 * the 3D view is active; it is the ONLY supported surface for picking + hover
 * highlight from outside the renderer. Documented here so the next track has a
 * typed, discoverable contract instead of reaching into Renderer3D directly.
 */
export interface Renderer3DInteractionSeam {
  /** device-pixel (top-left origin) → cell_id, or -1 for a miss. */
  pick(x: number, y: number): number;
  /** highlight a cell (indigo halo + slight scale), or clear with null. */
  setHoverId(id: number | null): void;
  /** the currently highlighted cell_id, or -1 when none. */
  hoveredId(): number;
  /** the live layout name (or "(synthetic)"). */
  activeLayout(): string;
  /** fly the cloud from the resident layout to `to` (cell_id-aligned morph). */
  startMorph(to: string): Promise<boolean>;
}
declare global {
  interface Window {
    /** Present only while the 3D view is active (see {@link Renderer3DInteractionSeam}). */
    __r3d?: Renderer3DInteractionSeam & Record<string, unknown>;
  }
}

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const themeSel = document.getElementById("theme") as HTMLSelectElement | null;
const modeSel = document.getElementById("mode") as HTMLSelectElement;
const cmapSel = document.getElementById("cmap") as HTMLSelectElement;
const cmapRow = document.getElementById("cmap-row") as HTMLElement;
const viewSel = document.getElementById("view") as HTMLSelectElement;
const layoutSel = document.getElementById("layout") as HTMLSelectElement;
const layoutRow = document.getElementById("layout-row") as HTMLElement;
const countEl = document.getElementById("count") as HTMLElement;
const fpsEl = document.getElementById("fps") as HTMLElement;
const zoomEl = document.getElementById("zoom") as HTMLElement;

// --- view routing -----------------------------------------------------------
type ViewKind = "2d" | "3d";
const params = new URLSearchParams(window.location.search);
const layoutParam = params.get("layout");

// --- theme bootstrap (SPEC §FEATURE 1) --------------------------------------
// Read &theme=light|dark (default dark = today's look). Apply the chrome token
// theme HERE (top-level, before the substrate branch) so the page is correct on
// boot in BOTH the 2D and 3D paths; the renderer.setTheme + change listener are
// wired per-substrate (boot2D below / main3d.ts).
type Theme = "dark" | "light";
const initialTheme: Theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = initialTheme;
if (themeSel) themeSel.value = initialTheme;
/** Persist the active theme onto the URL without a reload (the renderer flips live). */
function persistTheme(t: Theme): void {
  const p = new URLSearchParams(window.location.search);
  p.set("theme", t);
  history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}
const viewParam = params.get("view"); // "2d" | "3d" | null (explicit user pin)
const r3dFlag = params.get("r3d") === "1"; // legacy shortcut, still honored

/** Spine layouts encode their dimensionality in the name (…2d / …3d). Used only
 *  for the INITIAL route from URL params (the manifest isn't loaded yet); the
 *  in-session layout switcher below re-checks the real manifest dims. */
function layoutIs3D(name: string | null): boolean {
  return !!name && /3d$/i.test(name);
}

// Precedence: explicit ?view= wins, then legacy ?r3d=1, then DEFAULT TO 3D —
// the signature experience. Only an explicitly-requested 2D layout (?layout=…2d
// with no view pin) falls back to the 2D substrate; the bare URL lands in 3D.
const view: ViewKind =
  viewParam === "2d" || viewParam === "3d"
    ? viewParam
    : r3dFlag
      ? "3d"
      : layoutParam && !layoutIs3D(layoutParam)
        ? "2d"
        : "3d";

// Reflect the resolved view in the control, then wire the toggle. This runs for
// BOTH substrates (before the branch) so switching works in either mode.
setupQuickStart(view);
viewSel.value = view;
viewSel.addEventListener("change", () => {
  const next = viewSel.value as ViewKind;
  const p = new URLSearchParams(window.location.search);
  p.set("view", next);
  // Preserve whatever layout is currently on screen across the substrate swap
  // (layoutSel is the shared DOM both boots populate).
  if (layoutSel.value) p.set("layout", layoutSel.value);
  p.delete("r3d"); // normalize onto ?view= (r3d stays recognized on direct load)
  window.location.search = p.toString(); // reload into the chosen substrate
});

if (view === "3d") {
  // Hand off to the raw-WebGL2 Renderer3D boot. It claims the SAME canvas, drives
  // an orbit Camera3D, uploads stride-3 positions (z kept, never projected away),
  // wires mode + colormap, and publishes window.__r3d (the interaction seam). The
  // regl context below is never created, so the two substrates never fight.
  void import("./main3d.ts");
} else {
  void boot2D();
}

// ---------------------------------------------------------------------------
// 2D substrate (regl PointRenderer) — the legacy projectTo2D path, unchanged
// except that the layout switcher now defers 3D layouts to the 3D view.
// ---------------------------------------------------------------------------
async function boot2D(): Promise<void> {
  const renderer = new PointRenderer(canvas);
  const camera = new Camera2D();

  let mode: EncodingMode = "continuous";
  let sFit = 1;

  // --- theme (SPEC §FEATURE 1) ----------------------------------------------
  renderer.setTheme(initialTheme);
  themeSel?.addEventListener("change", () => {
    const t = themeSel.value as Theme;
    document.documentElement.dataset.theme = t;
    renderer.setTheme(t);
    persistTheme(t);
  });

  // --- sizing ---------------------------------------------------------------
  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  resize();
  camera.setViewport(canvas.width, canvas.height);
  new ResizeObserver(resize).observe(canvas);

  /**
   * Project a (possibly 3D) layout's PointData down to what the 2D PointRenderer
   * consumes: stride-2 XY positions + a 4-number XY bounds. The z axis is dropped
   * for this view only — the 3D view (Renderer3D) reads all three components
   * straight from the source and never calls this.
   */
  function projectTo2D(pd: PointData): PointData {
    if (pd.dims === 2) return pd;
    const xy = new Float32Array(pd.count * 2);
    for (let i = 0; i < pd.count; i++) {
      xy[i * 2] = pd.positions[i * 3];
      xy[i * 2 + 1] = pd.positions[i * 3 + 1];
    }
    const [minX, minY, , maxX, maxY] = pd.bounds; // 6-tuple: [minX,minY,minZ,maxX,maxY,maxZ]
    return {
      count: pd.count,
      dims: 2,
      positions: xy,
      values: pd.values,
      categories: pd.categories,
      ids: pd.ids,
      bounds: [minX, minY, maxX, maxY],
    };
  }

  /** Push the active layout into the renderer + refit the camera. */
  function applyActive(source: TileSource): void {
    const pd = projectTo2D(source.getActivePointData());
    renderer.setData(pd);
    camera.setViewport(canvas.width, canvas.height);
    camera.fit(pd.bounds);
    sFit = camera.s;
    countEl.textContent = `${pd.count.toLocaleString()} cells`;
  }

  // --- interaction ----------------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    camera.panByPixels((e.clientX - lastX) * dpr(), (e.clientY - lastY) * dpr());
    lastX = e.clientX;
    lastY = e.clientY;
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      camera.zoomAt(e.deltaY, ndcX, ndcY);
    },
    { passive: false },
  );

  // --- encoding controls ----------------------------------------------------
  modeSel.addEventListener("change", () => {
    mode = modeSel.value as EncodingMode;
    cmapRow.style.display = mode === "continuous" ? "" : "none";
  });
  cmapSel.addEventListener("change", () => {
    renderer.setColormap(cmapSel.value as ContinuousColormap);
  });

  // --- data bootstrap -------------------------------------------------------
  let source: TileSource;
  try {
    const spineBase = `${import.meta.env.BASE_URL}spine`;
    const manifest = await loadManifest(spineBase);
    // Honor ?layout= (e.g. viewing a 3D layout in 2D via projectTo2D); else the
    // SpineTileSource default (tsne2d).
    const initial = layoutParam && manifest.layouts[layoutParam] ? layoutParam : undefined;
    const spine = new SpineTileSource(spineBase, manifest, initial);
    await spine.ensureLayout(spine.layout);
    await spine.loadDict("CL_label").catch(() => undefined); // best-effort for getCell()
    source = spine;

    // Populate + wire the layout dropdown (only meaningful for the real spine).
    const keys = Object.keys(manifest.layouts);
    layoutSel.innerHTML = "";
    for (const key of keys) {
      const opt = document.createElement("option");
      opt.value = key;
      const dims = manifest.layouts[key].dims;
      opt.textContent = `${key} · ${dims}D`;
      layoutSel.appendChild(opt);
    }
    layoutSel.value = spine.layout;
    layoutRow.style.display = "";
    layoutSel.addEventListener("change", async () => {
      const name = layoutSel.value;
      const dims = manifest.layouts[name]?.dims ?? 2;
      // "Default 3D layouts to the 3D view": picking a 3D layout from the 2D view
      // hands off to the 3D substrate — UNLESS the user explicitly pinned 2D
      // (?view=2d), in which case we keep showing it projected to XY.
      if (dims === 3 && viewParam !== "2d") {
        const p = new URLSearchParams(window.location.search);
        p.set("layout", name);
        p.delete("view"); // unpinned → router resolves to 3D by dims
        p.delete("r3d");
        window.location.search = p.toString();
        return;
      }
      layoutSel.disabled = true;
      await spine.ensureLayout(name); // 3D layouts (when 2D is pinned) are projected to XY
      spine.setLayout(name);
      applyActive(spine);
      layoutSel.disabled = false;
    });
  } catch {
    // No spine (or fetch/parse failed) → synthetic fallback. Same TileSource API.
    source = new SyntheticTileSource({ count: 250_000 });
    layoutRow.style.display = "none";
  }

  applyActive(source);

  // --- render loop ----------------------------------------------------------
  let frames = 0;
  let fpsClock = performance.now();
  function frame(): void {
    renderer.render(camera, mode);

    frames++;
    const now = performance.now();
    if (now - fpsClock >= 500) {
      fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsClock))} fps`;
      frames = 0;
      fpsClock = now;
    }
    zoomEl.textContent = `${(camera.s / sFit).toFixed(1)}×`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
