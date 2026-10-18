"""Phase 3 — tile the "pca3d" layout (dims=3) into an octree of .bin tiles.

Reads:
  - web/spine/build/layouts/pca3d.parquet   (cell_id + x,y,z, raw un-normalized)
  - web/spine/build/meta.parquet            (cell_id + CL_label -> category index)

Builds an octree at ~60000 pts/leaf (tree.build_octree, id-seeded LOD subsamples
at internal nodes so a cell shown at a coarse LOD also appears at its leaf), then
writes EVERY node as a SPEC .bin tile under:
  web/public/spine/tiles/pca3d/<lod>/<mortonId>.bin   (binfmt.write_tile)

Also writes a manifest FRAGMENT describing this layout's tiles + bounds + lodLevels:
  web/spine/build/manifest_pca3d.json   -> { "pca3d": <layout entry> }

Point conservation is asserted: sum of LEAF tile points == 453251, no duplicate /
missing cell_id across leaves.

Run from web/:  python -m spine.export.tile_pca3d
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow.parquet as pq

from . import binfmt, manifest, paths, tree

KEY = "pca3d"
DIMS = 3


def main() -> None:
    paths.ensure_dirs()

    # --- Read layout coordinates (keyed by cell_id) ---
    lt = pq.read_table(paths.layout_parquet(KEY), columns=["cell_id", "x", "y", "z"])
    cell_id = np.asarray(lt.column("cell_id").to_numpy(zero_copy_only=False), dtype=np.uint32)
    x = np.asarray(lt.column("x").to_numpy(zero_copy_only=False), dtype=np.float32)
    y = np.asarray(lt.column("y").to_numpy(zero_copy_only=False), dtype=np.float32)
    z = np.asarray(lt.column("z").to_numpy(zero_copy_only=False), dtype=np.float32)
    n = cell_id.shape[0]

    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        np.sort(cell_id), np.arange(n, dtype=np.uint32)
    ), "cell_id must be the dense set 0..N-1, each exactly once"

    # --- Read category (CL_label index) from meta, aligned to cell_id ---
    mt = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    meta_cell_id = np.asarray(mt.column("cell_id").to_numpy(zero_copy_only=False), dtype=np.uint32)
    codes = mt.column("CL_label").combine_chunks().indices.to_numpy(zero_copy_only=False)
    meta_cat = np.asarray(codes, dtype=np.int16)

    # Align meta -> layout order via cell_id (both dense, but do not assume same order).
    cat = np.empty(n, dtype=np.int16)
    cat[meta_cell_id] = meta_cat  # cell_id is dense 0..N-1, usable as index
    category = cat[cell_id]

    # --- Build octree (~60000 pts/leaf) ---
    points = np.stack([x, y, z], axis=1).astype(np.float64)
    t = tree.build_octree(points, cell_id, paths.LEAF_TARGET)

    # --- Write every node as a .bin tile ---
    positions_f = points  # un-normalized; write_tile quantizes per-tile bbox
    tile_count = 0
    leaf_point_sum = 0
    seen = np.zeros(n, dtype=bool)
    for node in t["nodes"].values():
        idx = node["point_indices"]
        out_path = paths.tile_path(KEY, int(node["lod"]), int(node["id"]))
        binfmt.write_tile(
            out_path,
            DIMS,
            positions_f[idx],
            cell_id[idx],
            category[idx],
        )
        tile_count += 1
        if node["is_leaf"]:
            leaf_ids = cell_id[idx]
            assert not seen[leaf_ids].any(), "duplicate cell_id across leaves"
            seen[leaf_ids] = True
            leaf_point_sum += int(idx.shape[0])

    conserved = bool(leaf_point_sum == n and seen.all())
    assert conserved, (
        f"point conservation violated: leaf sum {leaf_point_sum}/{n}, "
        f"missing {(~seen).sum()}"
    )

    # --- Manifest fragment for this layout ---
    entry = manifest.build_layout_entry(KEY, t)
    fragment = {KEY: entry}
    frag_path = paths.BUILD_DIR / f"manifest_{KEY}.json"
    frag_path.write_text(json.dumps(fragment, indent=2), encoding="utf-8")

    lod_levels = int(t["lodLevels"])

    print(json.dumps({
        "layout": KEY,
        "tree": t["tree"],
        "tile_count": tile_count,
        "leaf_point_sum": leaf_point_sum,
        "conserved": conserved,
        "lodLevels": lod_levels,
        "bounds": [float(v) for v in t["bounds"]],
        "fragment_path": str(frag_path),
    }, indent=2))


if __name__ == "__main__":
    main()
