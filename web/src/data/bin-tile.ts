/**
 * Binary tile decoder (SPEC §BINARY TILE FORMAT). This MUST stay byte-for-byte
 * compatible with the python writer in `spine/export`. Everything is read with a
 * DataView in little-endian; there are no dependencies.
 *
 * HEADER:
 *   magic    u32  = ascii 'CYTL'  (bytes 0x43 0x59 0x54 0x4C)
 *   version  u16  = 1
 *   dims     u8   (2 or 3)
 *   flags    u8   = 0
 *   pointCount u32
 *   bboxMin  float32 × dims
 *   bboxMax  float32 × dims
 * BODY (each a contiguous typed array of length pointCount):
 *   positions int16  × dims × pointCount   (interleaved per point)
 *   cell_id   uint32 × pointCount
 *   category  int16  × pointCount
 *
 * Dequant per dim d:  v = min_d + (q + 32768) / 65535 * (max_d - min_d)
 */
import type { PointData } from "../core/types.ts";

const MAGIC = 0x4c545943; // 'CYTL' read as little-endian u32
const QUANT_OFFSET = 32768;
const QUANT_RANGE = 65535;

/** A decoded tile: PointData plus its tree provenance. */
export interface TileChunk extends PointData {
  tileId: string;
  lod: number;
}

export interface TileInfo {
  tileId?: string;
  lod?: number;
}

/**
 * Decode one .bin tile. `values` is left zero-filled — the continuous channel is
 * layout-independent and is joined in by the source from `columns/expr.f32`
 * (keyed by cell_id), not stored per tile.
 */
export function parseTile(buffer: ArrayBuffer, info: TileInfo = {}): TileChunk {
  const view = new DataView(buffer);
  let off = 0;

  const magic = view.getUint32(off, true);
  off += 4;
  if (magic !== MAGIC) {
    throw new Error(`bad tile magic 0x${magic.toString(16)} (expected 'CYTL')`);
  }
  const version = view.getUint16(off, true);
  off += 2;
  if (version !== 1) throw new Error(`unsupported tile version ${version}`);

  const dims = view.getUint8(off);
  off += 1;
  if (dims !== 2 && dims !== 3) throw new Error(`bad tile dims ${dims}`);
  off += 1; // flags (unused)

  const count = view.getUint32(off, true);
  off += 4;

  const min = new Array<number>(dims);
  const max = new Array<number>(dims);
  for (let d = 0; d < dims; d++) {
    min[d] = view.getFloat32(off, true);
    off += 4;
  }
  for (let d = 0; d < dims; d++) {
    max[d] = view.getFloat32(off, true);
    off += 4;
  }

  // BODY — positions (int16, interleaved), then cell_id (u32), then category (i16).
  const positions = new Float32Array(count * dims);
  const span = new Array<number>(dims);
  for (let d = 0; d < dims; d++) span[d] = (max[d] - min[d]) / QUANT_RANGE;
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < dims; d++) {
      const q = view.getInt16(off, true);
      off += 2;
      positions[i * dims + d] = min[d] + (q + QUANT_OFFSET) * span[d];
    }
  }

  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    ids[i] = view.getUint32(off, true);
    off += 4;
  }

  const categories = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    categories[i] = view.getInt16(off, true);
    off += 2;
  }

  const bounds = [...min, ...max];

  return {
    count,
    dims,
    positions,
    values: new Float32Array(count), // joined later from the expr column
    categories,
    ids,
    bounds,
    tileId: info.tileId ?? "",
    lod: info.lod ?? 0,
  };
}
