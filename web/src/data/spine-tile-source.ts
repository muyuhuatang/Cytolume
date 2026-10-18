/**
 * SpineTileSource — concrete {@link TileSource} over the dependency-free P0
 * spine served at `/spine`. It fetches the manifest's .bin tiles (DataView) and
 * the raw `columns/expr.f32` over HTTP; it NEVER reads Parquet or pulls in
 * apache-arrow. Parquet stays the offline canonical store only (SPEC).
 *
 * v1 strategy: for the active layout, fetch ALL leaf tiles and concatenate them
 * into one `PointData` (no view-frustum streaming yet — that's a later track).
 * `values` come from `expr.f32` indexed by cell_id; `categories` are baked in
 * the tiles. The default active layout is `tsne2d` (SPEC render target).
 */
import type { CellRecord, PointData } from "../core/types.ts";
import { parseTile } from "./bin-tile.ts";
import {
  leafTiles,
  normalizeBaseUrl,
  type CategoricalDict,
  type SpineManifest,
} from "./manifest.ts";
import type { Region, TileSource } from "./tile-source.ts";

const DEFAULT_LAYOUT = "tsne2d";

export class SpineTileSource implements TileSource {
  readonly manifest: SpineManifest;
  private readonly baseUrl: string;
  private active: string;

  /** Concatenated PointData per layout, built on demand by ensureLayout(). */
  private readonly layoutCache = new Map<string, PointData>();
  /** Continuous columns (e.g. expr) keyed by cell_id, fetched lazily. */
  private readonly columnCache = new Map<string, Float32Array>();
  /** Categorical dicts keyed by channel name (e.g. CL_label). */
  private readonly dictCache = new Map<string, CategoricalDict>();
  /** cell_id → index in the active layout's PointData (rebuilt on setLayout). */
  private idIndex: Map<number, number> | null = null;

  constructor(baseUrl: string, manifest: SpineManifest, layout = DEFAULT_LAYOUT) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.manifest = manifest;
    this.active = manifest.layouts[layout] ? layout : Object.keys(manifest.layouts)[0];
  }

  get layout(): string {
    return this.active;
  }

  /** Set active layout. The layout must already be loaded via ensureLayout(). */
  setLayout(name: string): void {
    if (!this.manifest.layouts[name]) {
      throw new Error(`unknown layout "${name}"`);
    }
    this.active = name;
    this.idIndex = null; // lazily rebuilt for the new active PointData
  }

  getActivePointData(): PointData {
    const pd = this.layoutCache.get(this.active);
    if (!pd) {
      throw new Error(`layout "${this.active}" not loaded — call ensureLayout() first`);
    }
    return pd;
  }

  // --- loading ---------------------------------------------------------------

  /**
   * Fetch + decode + concatenate all leaf tiles of `name` into one PointData and
   * cache it. Also ensures the expr column is resident so `values` can be joined.
   * Idempotent: returns immediately if the layout is already cached.
   */
  async ensureLayout(name = this.active): Promise<PointData> {
    const cached = this.layoutCache.get(name);
    if (cached) return cached;

    const layout = this.manifest.layouts[name];
    if (!layout) throw new Error(`unknown layout "${name}"`);

    const expr = await this.loadColumn("expr").catch(() => null);
    const leaves = leafTiles(layout);
    const dims = layout.dims;

    // Decode every leaf in parallel (point conservation: leaves' union == all N).
    const chunks = await Promise.all(
      leaves.map(async (t) => {
        const buf = await this.fetchArrayBuffer(t.uri);
        return parseTile(buf, { tileId: String(t.id), lod: t.lod });
      }),
    );

    let total = 0;
    for (const c of chunks) total += c.count;

    const positions = new Float32Array(total * dims);
    const values = new Float32Array(total);
    const categories = new Uint16Array(total);
    const ids = new Uint32Array(total);

    let off = 0; // point offset
    for (const c of chunks) {
      positions.set(c.positions, off * dims);
      categories.set(c.categories, off);
      ids.set(c.ids, off);
      for (let i = 0; i < c.count; i++) {
        const id = c.ids[i];
        values[off + i] = expr ? expr[id] : 0;
      }
      off += c.count;
    }

    const pd: PointData = { count: total, dims, positions, values, categories, ids, bounds: layout.bounds };
    this.layoutCache.set(name, pd);
    if (name === this.active) this.idIndex = null;
    return pd;
  }

  /** Lazily fetch a continuous column (raw little-endian Float32, by cell_id). */
  async loadColumn(name: string): Promise<Float32Array> {
    const cached = this.columnCache.get(name);
    if (cached) return cached;
    // Both manifest forms: a bare uri string (original contract) or a channel
    // object carrying label/unit/transform/domain alongside it.
    const entry = this.manifest.continuous[name];
    const uri = typeof entry === "string" ? entry : entry?.uri;
    if (!uri) throw new Error(`unknown continuous column "${name}"`);
    const buf = await this.fetchArrayBuffer(uri);
    const col = new Float32Array(buf); // raw little-endian f32, length N
    this.columnCache.set(name, col);
    return col;
  }

  /** Lazily fetch a categorical dict (names + optional colorSlot). */
  async loadDict(channel: string): Promise<CategoricalDict> {
    const cached = this.dictCache.get(channel);
    if (cached) return cached;
    const entry = this.manifest.categorical[channel];
    if (!entry) throw new Error(`unknown categorical channel "${channel}"`);
    const res = await this.fetch(entry.dict);
    const dict = (await res.json()) as CategoricalDict;
    this.dictCache.set(channel, dict);
    return dict;
  }

  // --- detail / selection ----------------------------------------------------

  getCell(id: number): CellRecord {
    const pd = this.getActivePointData();
    const idx = this.indexOf(id);
    const rec: CellRecord = { id, x: 0, y: 0 };
    if (idx >= 0) {
      rec.x = pd.positions[idx * pd.dims];
      rec.y = pd.positions[idx * pd.dims + 1];
      if (pd.dims === 3) rec.z = pd.positions[idx * pd.dims + 2];
      rec.confidence = pd.values[idx];
      const dict = this.dictCache.get("CL_label");
      const cat = pd.categories[idx];
      rec.cellType = dict?.names[cat] ?? String(cat);
    }
    return rec;
  }

  query(region: Region): Uint32Array {
    const pd = this.getActivePointData();
    const b = region.bounds;
    const dims = pd.dims;
    const minX = b[0];
    const minY = b[1];
    const maxX = b[dims];
    const maxY = b[dims + 1];
    const hit: number[] = [];
    for (let i = 0; i < pd.count; i++) {
      const x = pd.positions[i * dims];
      const y = pd.positions[i * dims + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) hit.push(pd.ids[i]);
    }
    return Uint32Array.from(hit);
  }

  // --- internals -------------------------------------------------------------

  private indexOf(id: number): number {
    if (!this.idIndex) {
      const pd = this.getActivePointData();
      const map = new Map<number, number>();
      for (let i = 0; i < pd.count; i++) map.set(pd.ids[i], i);
      this.idIndex = map;
    }
    return this.idIndex.get(id) ?? -1;
  }

  private async fetch(uri: string): Promise<Response> {
    const url = `${this.baseUrl}/${uri}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`spine fetch failed: ${res.status} (${url})`);
    return res;
  }

  private async fetchArrayBuffer(uri: string): Promise<ArrayBuffer> {
    return (await this.fetch(uri)).arrayBuffer();
  }
}
