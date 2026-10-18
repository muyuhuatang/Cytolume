/**
 * SyntheticTileSource — the synthetic generator wrapped as a {@link TileSource},
 * so `main.ts` can fall back to it (no spine present / fetch failed) by swapping
 * a source, not a pipeline (reflection-2 §6). It exposes a single 2D layout
 * ("synthetic") with ids 0..N-1 and a minimal stub manifest.
 */
import type { CellRecord, PointData } from "../core/types.ts";
import { makeSyntheticEmbedding, type SyntheticOptions } from "./synthetic.ts";
import type { SpineManifest } from "./manifest.ts";
import type { Region, TileSource } from "./tile-source.ts";

const LAYOUT = "synthetic";

export class SyntheticTileSource implements TileSource {
  readonly manifest: SpineManifest;
  readonly layout = LAYOUT;
  private readonly data: PointData;
  private idIndex: Map<number, number> | null = null;

  constructor(opts: SyntheticOptions = {}) {
    this.data = makeSyntheticEmbedding(opts);
    let maxCat = 0;
    for (let i = 0; i < this.data.count; i++) {
      if (this.data.categories[i] > maxCat) maxCat = this.data.categories[i];
    }
    // Minimal but valid manifest stub so the TileSource contract holds.
    this.manifest = {
      version: 1,
      cellCount: this.data.count,
      layouts: {
        [LAYOUT]: {
          dims: 2,
          bounds: this.data.bounds,
          tree: "quadtree",
          leafTarget: this.data.count,
          lodLevels: 1,
          tiles: [
            { id: 0, lod: 0, bbox: this.data.bounds, count: this.data.count, children: [], uri: "" },
          ],
        },
      },
      categorical: { CL_label: { dict: "", count: maxCat + 1 } },
      continuous: { expr: "" },
      idSpace: {
        field: "cell_id",
        stable: true,
        sharedAcrossLayouts: true,
        checksum: "synthetic",
      },
    };
  }

  setLayout(_name: string): void {
    // Only one synthetic layout exists; nothing to switch.
  }

  getActivePointData(): PointData {
    return this.data;
  }

  async loadColumn(_name: string): Promise<Float32Array> {
    return this.data.values;
  }

  getCell(id: number): CellRecord {
    if (!this.idIndex) {
      const map = new Map<number, number>();
      for (let i = 0; i < this.data.count; i++) map.set(this.data.ids[i], i);
      this.idIndex = map;
    }
    const idx = this.idIndex.get(id) ?? -1;
    const rec: CellRecord = { id, x: 0, y: 0 };
    if (idx >= 0) {
      rec.x = this.data.positions[idx * 2];
      rec.y = this.data.positions[idx * 2 + 1];
      rec.confidence = this.data.values[idx];
      rec.cellType = String(this.data.categories[idx]);
    }
    return rec;
  }

  query(region: Region): Uint32Array {
    const [minX, minY, maxX, maxY] = region.bounds;
    const hit: number[] = [];
    for (let i = 0; i < this.data.count; i++) {
      const x = this.data.positions[i * 2];
      const y = this.data.positions[i * 2 + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) hit.push(this.data.ids[i]);
    }
    return Uint32Array.from(hit);
  }
}
