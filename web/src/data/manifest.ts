/**
 * Spine manifest — the browser-side mirror of the offline P0 spine descriptor
 * (SPEC §MANIFEST, reflection-2 §4). The loader is dependency-free: it reads
 * ONLY manifest.json over HTTP and never touches Parquet/Arrow in the browser.
 *
 * Shapes here mirror `public/spine/manifest.json` byte-for-byte; they are the
 * single source of truth consumed by {@link SpineTileSource}.
 */

/** One quadtree/octree node in a layout's tile tree. */
export interface SpineTileNode {
  id: number;
  lod: number;
  /** Node bbox: 4 numbers (2D) or 6 (3D), [min…, max…]. */
  bbox: number[];
  count: number;
  /** Child node ids; empty array ⇒ this is a leaf tile. */
  children: number[];
  /** Path relative to the spine baseUrl, e.g. "tiles/tsne2d/0/0.bin". */
  uri: string;
}

export interface SpineLayout {
  dims: 2 | 3;
  /** Whole-layout bounds: 4 numbers (2D) or 6 (3D), [min…, max…]. */
  bounds: number[];
  tree: "quadtree" | "octree";
  leafTarget: number;
  lodLevels: number;
  tiles: SpineTileNode[];
}

export interface SpineCategorical {
  /** Path (relative to baseUrl) to the dict json, e.g. "dict/CL_label.json". */
  dict: string;
  count: number;
}

export interface SpineIdSpace {
  field: string;
  stable: boolean;
  sharedAcrossLayouts: boolean;
  checksum: string;
}

/** A continuous column with its metadata declared by whatever built the spine.
 *  Every field is optional because a producer that does not know a value must be
 *  able to say nothing rather than assert a default — the key renders the ABSENCE
 *  ("units not declared") rather than inventing "normalised". */
export interface ContinuousChannel {
  uri: string;
  label?: string;
  unit?: string;
  transform?: string;
  /** [vmin, vmax] in DATA units. Absent -> the key falls back to the stored extent. */
  domain?: [number, number];
}

export interface SpineManifest {
  version: number;
  cellCount: number;
  layouts: Record<string, SpineLayout>;
  /** Categorical channels (e.g. CL_label) → dict path + cardinality. */
  categorical: Record<string, SpineCategorical>;
  /** Continuous channels (e.g. expr) → raw Float32 column path. */
  /** Continuous columns. The bare-string form is the ORIGINAL contract (uri only)
   *  and stays valid; the object form lets a producer declare what the key needs
   *  to stop guessing — a real domain, a unit, and the transform applied. */
  continuous: Record<string, string | ContinuousChannel>;
  idSpace: SpineIdSpace;

  /**
   * OPTIONAL provenance. ABSENCE IS MEANINGFUL: the app treats a spine with no
   * provenance block as SYNTHETIC and says so on the face of the figure
   * (main3d.isSynthetic). A real spine must assert itself, e.g.
   *   "provenance": { "dataset": "HuBMAP kidney v1.4", "source": "hra",
   *                   "synthetic": false, "cellTypeOntology": "CL" }
   * NEEDS REAL DATA: the shipped public/spine is seeded gaussians with fabricated
   * CL CURIEs (dict/CL_label.json), so it correctly has none.
   */
  provenance?: {
    dataset?: string;
    source?: string;
    synthetic?: boolean;
    cellTypeOntology?: string;
  };
}

/** A categorical dictionary file (SPEC dict/CL_label.json). */
export interface CategoricalDict {
  names: string[];
  /** Core-24 colour slot per category (present for CL_label). */
  colorSlot?: number[];
}

/** Strip a trailing slash so `${baseUrl}/x` never doubles up. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Fetch + minimally validate the spine manifest. Throws on a missing file or a
 * shape that the loader cannot honour (so `main.ts` can cleanly fall back to the
 * synthetic source).
 */
export async function loadManifest(baseUrl: string): Promise<SpineManifest> {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/manifest.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`spine manifest fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const m = (await res.json()) as SpineManifest;

  if (m.version !== 1) throw new Error(`unsupported spine manifest version: ${m.version}`);
  if (typeof m.cellCount !== "number" || m.cellCount <= 0) {
    throw new Error(`invalid manifest cellCount: ${m.cellCount}`);
  }
  if (!m.layouts || Object.keys(m.layouts).length === 0) {
    throw new Error("manifest has no layouts");
  }
  for (const [key, layout] of Object.entries(m.layouts)) {
    if (layout.dims !== 2 && layout.dims !== 3) {
      throw new Error(`layout "${key}" has invalid dims: ${layout.dims}`);
    }
    if (!Array.isArray(layout.tiles) || layout.tiles.length === 0) {
      throw new Error(`layout "${key}" has no tiles`);
    }
    if (layout.bounds.length !== layout.dims * 2) {
      throw new Error(`layout "${key}" bounds length ${layout.bounds.length} != dims*2`);
    }
  }
  return m;
}

/** Leaf tiles (children == []) of a layout, in manifest order. */
export function leafTiles(layout: SpineLayout): SpineTileNode[] {
  return layout.tiles.filter((t) => t.children.length === 0);
}
