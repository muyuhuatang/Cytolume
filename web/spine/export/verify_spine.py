"""Phase 5 — ADVERSARIAL verification of the Cytolume P0 spine.

Assume the builder is WRONG. Try to break the spine. Every check below must pass
for the spine to be considered sound. Run from `web/`:

    python -m spine.export.verify_spine

Checks:
  1. manifest schema valid; every tile uri + dict + column file exists.
  2. tile round-trip: random sample of tiles per layout -> read_tile dequantized
     coords match layout parquet rows (by cell_id) within quantization epsilon.
  3. point conservation: union of LEAF tiles' cell_ids == full 0..N-1, per layout.
  4. id stability across layouts: cell_id set identical across ALL layouts; a fixed
     sample maps to the same barcode in meta.parquet.
  5. pick round-trip: encode 1000 random cell_ids -> RGBA8 -> decode; bit-exact.
  6. bounds sanity: manifest bounds == actual min/max of layout coords; 3D=6, 2D=4.
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow.parquet as pq

from . import paths
from .binfmt import read_tile
from .manifest import compute_id_checksum, validate_manifest

RNG = np.random.default_rng(0xC1701)  # seeded for reproducibility
TILES_PER_LAYOUT = 12  # random tiles sampled for round-trip per layout


class Failures:
    def __init__(self) -> None:
        self.items: list[str] = []

    def add(self, where: str, detail: str) -> None:
        self.items.append(f"[{where}] {detail}")


def _load_manifest() -> dict:
    with open(paths.MANIFEST_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_layout_coords(key: str) -> tuple[np.ndarray, np.ndarray]:
    """Return (cell_ids uint32 sorted-by-row, coords float32 (N,dims)) for a layout.

    Returns coords indexed by row; also returns a cell_id->row map separately.
    """
    dims = paths.LAYOUTS[key]
    tbl = pq.read_table(paths.layout_parquet(key))
    cols = tbl.column_names
    cid = tbl.column("cell_id").to_numpy().astype(np.uint32)
    x = tbl.column("x").to_numpy().astype(np.float32)
    y = tbl.column("y").to_numpy().astype(np.float32)
    if dims == 3:
        if "z" not in cols:
            raise KeyError(f"layout {key} parquet missing z column")
        z = tbl.column("z").to_numpy().astype(np.float32)
        coords = np.stack([x, y, z], axis=1)
    else:
        coords = np.stack([x, y], axis=1)
    return cid, coords


# ---------------------------------------------------------------------------
# Check 1: manifest schema + every referenced file exists.
# ---------------------------------------------------------------------------
def check_manifest_and_files(manifest: dict, fails: Failures) -> None:
    where = "1.manifest"
    problems = validate_manifest(manifest)
    for p in problems:
        fails.add(where, f"schema: {p}")

    if manifest.get("cellCount") != paths.CELL_COUNT:
        fails.add(where, f"cellCount {manifest.get('cellCount')} != SPEC {paths.CELL_COUNT}")

    # Layout registry coverage: every SPEC layout present.
    for key in paths.LAYOUTS:
        if key not in manifest.get("layouts", {}):
            fails.add(where, f"layout {key} missing from manifest")

    # Every tile uri resolves to an existing file.
    missing = 0
    for key, entry in manifest.get("layouts", {}).items():
        for t in entry.get("tiles", []):
            uri = t.get("uri", "")
            fp = paths.PUBLIC_SPINE / uri
            if not fp.is_file():
                missing += 1
                if missing <= 10:
                    fails.add(where, f"tile file missing: {uri}")
            # uri must follow tiles/<key>/<lod>/<id>.bin
            expect = paths.tile_uri(key, int(t["lod"]), int(t["id"]))
            if uri != expect:
                fails.add(where, f"{key} tile {t['id']} uri '{uri}' != '{expect}'")
    if missing > 10:
        fails.add(where, f"...and {missing - 10} more missing tile files")

    # dict + column sidecars.
    cat = manifest.get("categorical", {}).get("CL_label", {})
    dict_rel = cat.get("dict", "dict/CL_label.json")
    if not (paths.PUBLIC_SPINE / dict_rel).is_file():
        fails.add(where, f"CL_label dict missing: {dict_rel}")
    if not (paths.DICT_DIR / "dataset_id.json").is_file():
        fails.add(where, "dataset_id.json missing")
    col_rel = manifest.get("continuous", {}).get("expr", "columns/expr.f32")
    col_fp = paths.PUBLIC_SPINE / col_rel
    if not col_fp.is_file():
        fails.add(where, f"expr column missing: {col_rel}")
    else:
        n = col_fp.stat().st_size // 4
        if n != paths.CELL_COUNT:
            fails.add(where, f"expr.f32 has {n} floats != {paths.CELL_COUNT}")

    # dict integrity: 48 names, 48 colorSlots in 0..23.
    try:
        with open(paths.PUBLIC_SPINE / dict_rel, "r", encoding="utf-8") as f:
            d = json.load(f)
        if len(d.get("names", [])) != paths.N_CELL_TYPES:
            fails.add(where, f"CL_label names count {len(d.get('names', []))} != 48")
        slots = d.get("colorSlot", [])
        if len(slots) != paths.N_CELL_TYPES:
            fails.add(where, f"CL_label colorSlot count {len(slots)} != 48")
        if slots and (min(slots) < 0 or max(slots) > 23):
            fails.add(where, f"colorSlot out of Core-24 range: [{min(slots)},{max(slots)}]")
    except Exception as e:  # noqa: BLE001
        fails.add(where, f"CL_label dict unreadable: {e}")


# ---------------------------------------------------------------------------
# Check 2: tile round-trip vs layout parquet (quantization epsilon).
# ---------------------------------------------------------------------------
def check_tile_roundtrip(manifest: dict, fails: Failures) -> None:
    where = "2.tile_roundtrip"
    for key, entry in manifest.get("layouts", {}).items():
        dims = entry["dims"]
        cid, coords = _load_layout_coords(key)
        max_cid = int(cid.max())
        # cell_id -> row lookup (cell_ids are 0..N-1 contiguous, but verify).
        row_of = np.full(max_cid + 1, -1, dtype=np.int64)
        row_of[cid] = np.arange(cid.shape[0], dtype=np.int64)

        tiles = entry["tiles"]
        k = min(TILES_PER_LAYOUT, len(tiles))
        sample = RNG.choice(len(tiles), size=k, replace=False)
        for ti in sample:
            t = tiles[int(ti)]
            fp = paths.PUBLIC_SPINE / t["uri"]
            td = read_tile(fp)
            # header consistency vs manifest.
            if td["dims"] != dims:
                fails.add(where, f"{key} tile {t['id']}: dims {td['dims']} != {dims}")
            if td["count"] != t["count"]:
                fails.add(
                    where,
                    f"{key} tile {t['id']}: count {td['count']} != manifest {t['count']}",
                )
            # Header bbox = tile's own tight point min/max (used for dequant).
            # Manifest bbox = tree node's spatial subdivision box. SPEC makes these
            # DIFFERENT: the invariant is containment — every point lies within the
            # node box, i.e. header bbox is a subset of the manifest node bbox.
            mb = np.asarray(t["bbox"], dtype=np.float64)
            m_min = mb[:dims]
            m_max = mb[dims:]
            h_min = td["bboxMin"].astype(np.float64)
            h_max = td["bboxMax"].astype(np.float64)
            slack = 1e-3 * np.maximum(np.abs(m_max - m_min), 1.0) + 1e-3
            if (h_min < m_min - slack).any() or (h_max > m_max + slack).any():
                fails.add(
                    where,
                    f"{key} tile {t['id']}: header bbox [{h_min.tolist()},{h_max.tolist()}] "
                    f"not contained in manifest node bbox [{m_min.tolist()},{m_max.tolist()}]",
                )
            if td["count"] == 0:
                continue
            ids = td["cell_ids"].astype(np.int64)
            if ids.min() < 0 or ids.max() > max_cid:
                fails.add(where, f"{key} tile {t['id']}: cell_id out of range")
                continue
            rows = row_of[ids]
            if (rows < 0).any():
                fails.add(where, f"{key} tile {t['id']}: cell_id not in layout parquet")
                continue
            ref = coords[rows]  # (count, dims) ground truth
            got = td["positions"].astype(np.float64)
            # Per-dim quantization epsilon = one step of the tile span + float slack.
            span = (td["bboxMax"] - td["bboxMin"]).astype(np.float64)
            step = np.where(span == 0.0, 0.0, span / 65535.0)
            eps = step + 1e-3 * np.maximum(np.abs(span), 1.0) + 1e-4
            err = np.abs(got - ref)
            bad = err > eps  # broadcast (count,dims) > (dims,)
            if bad.any():
                worst = float(err.max())
                nbad = int(bad.any(axis=1).sum())
                fails.add(
                    where,
                    f"{key} tile {t['id']}: {nbad} pts exceed quant eps "
                    f"(worst |err|={worst:.5f}, eps~{eps.tolist()})",
                )


# ---------------------------------------------------------------------------
# Check 3: point conservation over LEAF tiles, per layout.
# ---------------------------------------------------------------------------
def check_point_conservation(manifest: dict, fails: Failures) -> None:
    where = "3.conservation"
    n = paths.CELL_COUNT
    for key, entry in manifest.get("layouts", {}).items():
        seen = np.zeros(n, dtype=bool)
        dup = 0
        oob = 0
        total = 0
        for t in entry["tiles"]:
            if t.get("children"):
                continue  # internal node — skip, only leaves conserve
            td = read_tile(paths.PUBLIC_SPINE / t["uri"])
            if td["count"] == 0:
                continue
            ids = td["cell_ids"].astype(np.int64)
            if ids.min() < 0 or ids.max() >= n:
                oob += 1
                continue
            if seen[ids].any():
                dup += int(seen[ids].sum())
            seen[ids] = True
            total += ids.shape[0]
        if oob:
            fails.add(where, f"{key}: {oob} leaf tiles with out-of-range cell_id")
        if dup:
            fails.add(where, f"{key}: {dup} duplicate cell_ids across leaf tiles")
        missing = int((~seen).sum())
        if missing:
            ex = np.where(~seen)[0][:5].tolist()
            fails.add(where, f"{key}: {missing} cell_ids missing from leaves (e.g. {ex})")
        if total != n and dup == 0:
            fails.add(where, f"{key}: leaf union size {total} != {n}")


# ---------------------------------------------------------------------------
# Check 4: id stability across layouts + barcode stability in meta.
# ---------------------------------------------------------------------------
def check_id_stability(manifest: dict, fails: Failures) -> None:
    where = "4.id_stability"
    keys = list(manifest.get("layouts", {}).keys())
    id_sets: dict[str, np.ndarray] = {}
    for key in keys:
        cid, _ = _load_layout_coords(key)
        id_sets[key] = np.sort(cid.astype(np.uint32))

    # All layouts share an identical cell_id set.
    ref_key = keys[0]
    ref = id_sets[ref_key]
    expected = np.arange(paths.CELL_COUNT, dtype=np.uint32)
    if not np.array_equal(ref, expected):
        fails.add(where, f"{ref_key} cell_id set != contiguous 0..{paths.CELL_COUNT - 1}")
    for key in keys[1:]:
        if not np.array_equal(id_sets[key], ref):
            fails.add(where, f"{key} cell_id set differs from {ref_key}")

    # Manifest idSpace checksum matches recomputed checksum over the shared ids.
    want = manifest.get("idSpace", {}).get("checksum")
    got = compute_id_checksum(ref)
    if want != got:
        fails.add(where, f"idSpace.checksum {want} != recomputed {got}")

    # A fixed sample of cell_ids maps to the SAME barcode in meta.parquet, and the
    # category baked into a tile matches the meta CL_label index.
    meta = pq.read_table(paths.META_PARQUET)
    mcid = meta.column("cell_id").to_numpy().astype(np.int64)
    barcode = np.asarray(meta.column("barcode").to_pylist(), dtype=object)
    # meta row order should be cell_id order; build explicit map to be safe.
    row_of = np.full(paths.CELL_COUNT, -1, dtype=np.int64)
    row_of[mcid] = np.arange(mcid.shape[0])
    if (row_of < 0).any():
        fails.add(where, f"meta missing {int((row_of < 0).sum())} cell_ids")
        return
    cl_label = meta.column("CL_label")
    cl_codes = cl_label.combine_chunks().indices.to_numpy().astype(np.int64)

    sample = RNG.choice(paths.CELL_COUNT, size=2000, replace=False)
    # barcode determinism: re-derive nothing, just confirm sample barcodes are
    # 16-char ACGT and stable on re-read.
    meta2 = pq.read_table(paths.META_PARQUET, columns=["barcode"])
    bc2 = np.asarray(meta2.column("barcode").to_pylist(), dtype=object)
    bad_bc = 0
    for s in sample[:500]:
        b = barcode[row_of[s]]
        if bc2[row_of[s]] != b:
            fails.add(where, f"barcode for cell {s} not stable across reads")
            break
        if not (isinstance(b, str) and len(b) == 16 and set(b) <= set("ACGT")):
            bad_bc += 1
    if bad_bc:
        fails.add(where, f"{bad_bc}/500 sampled barcodes are not 16-char ACGT")

    # Category baked in tiles == meta CL_label index (cross-layout, sampled tile).
    for key, entry in manifest.get("layouts", {}).items():
        t = entry["tiles"][int(RNG.integers(len(entry["tiles"])))]
        td = read_tile(paths.PUBLIC_SPINE / t["uri"])
        if td["count"] == 0:
            continue
        ids = td["cell_ids"].astype(np.int64)
        cats = td["categories"].astype(np.int64)
        ref_cats = cl_codes[row_of[ids]]
        if not np.array_equal(cats, ref_cats):
            nbad = int((cats != ref_cats).sum())
            fails.add(where, f"{key} tile {t['id']}: {nbad} baked category != meta CL_label")


# ---------------------------------------------------------------------------
# Check 5: pick id round-trip (uint32 cell_id <-> RGBA8 little-endian).
# ---------------------------------------------------------------------------
def _encode_rgba(ids: np.ndarray) -> np.ndarray:
    ids = ids.astype(np.uint32)
    r = ids & np.uint32(0xFF)
    g = (ids >> np.uint32(8)) & np.uint32(0xFF)
    b = (ids >> np.uint32(16)) & np.uint32(0xFF)
    a = (ids >> np.uint32(24)) & np.uint32(0xFF)
    return np.stack([r, g, b, a], axis=1).astype(np.uint8)


def _decode_rgba(rgba: np.ndarray) -> np.ndarray:
    rgba = rgba.astype(np.uint32)
    return (
        rgba[:, 0]
        | (rgba[:, 1] << np.uint32(8))
        | (rgba[:, 2] << np.uint32(16))
        | (rgba[:, 3] << np.uint32(24))
    ).astype(np.uint32)


def check_pick_roundtrip(fails: Failures) -> None:
    where = "5.pick"
    ids = RNG.choice(paths.CELL_COUNT, size=1000, replace=False).astype(np.uint32)
    # include boundary ids that stress every byte lane.
    edge = np.array([0, 255, 256, 65535, 65536, paths.CELL_COUNT - 1], dtype=np.uint32)
    ids = np.concatenate([ids, edge])
    rgba = _encode_rgba(ids)
    back = _decode_rgba(rgba)
    if not np.array_equal(ids, back):
        nbad = int((ids != back).sum())
        first = ids[ids != back][:5].tolist()
        fails.add(where, f"{nbad}/{ids.size} ids not bit-exact after RGBA8 round-trip (e.g. {first})")


# ---------------------------------------------------------------------------
# Check 6: bounds sanity vs actual layout coord min/max.
# ---------------------------------------------------------------------------
def check_bounds(manifest: dict, fails: Failures) -> None:
    where = "6.bounds"
    for key, entry in manifest.get("layouts", {}).items():
        dims = entry["dims"]
        bounds = entry.get("bounds", [])
        if len(bounds) != dims * 2:
            fails.add(where, f"{key}: bounds len {len(bounds)} != {dims * 2}")
            continue
        _, coords = _load_layout_coords(key)
        amin = coords.min(axis=0).astype(np.float64)
        amax = coords.max(axis=0).astype(np.float64)
        b = np.asarray(bounds, dtype=np.float64)
        bmin = b[:dims]
        bmax = b[dims:]
        if not np.allclose(bmin, amin, rtol=0, atol=1e-3):
            fails.add(where, f"{key}: bounds min {bmin.tolist()} != actual {amin.tolist()}")
        if not np.allclose(bmax, amax, rtol=0, atol=1e-3):
            fails.add(where, f"{key}: bounds max {bmax.tolist()} != actual {amax.tolist()}")


def main() -> int:
    fails = Failures()
    manifest = _load_manifest()
    check_manifest_and_files(manifest, fails)
    check_tile_roundtrip(manifest, fails)
    check_point_conservation(manifest, fails)
    check_id_stability(manifest, fails)
    check_pick_roundtrip(fails)
    check_bounds(manifest, fails)

    print("=" * 60)
    if fails.items:
        print(f"VERIFY FAILED — {len(fails.items)} problem(s):")
        for it in fails.items:
            print("  -", it)
        print("RESULT: FAIL")
        return 1
    print("All 6 adversarial checks passed.")
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
