"""Phase 3 — tile the "umap3d" layout (dims=3) into an octree of .bin tiles.

Reads layouts/umap3d.parquet (cell_id + x/y/z) and meta.parquet (CL_label index
baked as category), builds an octree at ~60000 pts/leaf via tree.build_octree with
id-seeded LOD subsamples, writes every node as a SPEC .bin tile under
    web/public/spine/tiles/umap3d/<lod>/<mortonId>.bin
via binfmt.write_tile, and emits a manifest FRAGMENT describing this layout:
    web/spine/build/manifest_umap3d.json

Point conservation is asserted: union of LEAF tile cell_ids == all N, no dup/missing.

Run from web/:  python -m spine.export.tile_umap3d
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow.parquet as pq

from . import binfmt, manifest, paths, tree

KEY = "umap3d"
DIMS = 3


def main() -> None:
    paths.ensure_dirs()

    # --- Layout coords (cell_id + x/y/z), keyed by cell_id ---
    lay = pq.read_table(paths.layout_parquet(KEY), columns=["cell_id", "x", "y", "z"])
    cell_id = lay.column("cell_id").to_numpy(zero_copy_only=False).astype(np.uint32)
    x = lay.column("x").to_numpy(zero_copy_only=False).astype(np.float32)
    y = lay.column("y").to_numpy(zero_copy_only=False).astype(np.float32)
    z = lay.column("z").to_numpy(zero_copy_only=False).astype(np.float32)

    n = cell_id.shape[0]
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1 (row index == cell_id)"

    # --- Category (CL_label index) from meta, aligned by cell_id (== row order) ---
    meta_tbl = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    meta_cell_id = meta_tbl.column("cell_id").to_numpy(zero_copy_only=False).astype(
        np.uint32
    )
    assert np.array_equal(meta_cell_id, cell_id), "meta cell_id order != layout"
    category = meta_tbl.column("CL_label").combine_chunks().indices.to_numpy(
        zero_copy_only=False
    ).astype(np.int16)

    points = np.column_stack([x, y, z]).astype(np.float64)

    # --- Build octree (~60000 pts/leaf, id-seeded LOD subsamples) ---
    t = tree.build_octree(points, cell_id, paths.LEAF_TARGET)

    # --- Write every node as a .bin tile ---
    tile_count = 0
    leaf_point_sum = 0
    seen = np.zeros(n, dtype=bool)
    for node in t["nodes"].values():
        pidx = node["point_indices"]
        node_pos = points[pidx]
        node_cids = cell_id[pidx]
        node_cats = category[pidx]
        out = paths.tile_path(KEY, int(node["lod"]), int(node["id"]))
        binfmt.write_tile(out, DIMS, node_pos, node_cids, node_cats)
        tile_count += 1
        if node["is_leaf"]:
            leaf_point_sum += int(pidx.shape[0])
            if seen[pidx].any():
                raise AssertionError("duplicate cell_id across leaf tiles")
            seen[pidx] = True

    # --- Assert point conservation over LEAF tiles ---
    conserved = bool(leaf_point_sum == n and seen.all())
    if not conserved:
        missing = int((~seen).sum())
        raise AssertionError(
            f"point conservation violated: {leaf_point_sum}/{n}, missing {missing}"
        )

    # --- Manifest fragment for this layout ---
    entry = manifest.build_layout_entry(KEY, t)
    fragment = {KEY: entry}
    frag_path = paths.BUILD_DIR / f"manifest_{KEY}.json"
    frag_path.write_text(json.dumps(fragment, indent=2), encoding="utf-8")

    print(json.dumps({
        "layout": KEY,
        "tile_count": tile_count,
        "leaf_point_sum": leaf_point_sum,
        "conserved": conserved,
        "lod_levels": int(t["lodLevels"]),
        "bounds": entry["bounds"],
        "tree": entry["tree"],
        "fragment": str(frag_path),
    }, indent=2))


if __name__ == "__main__":
    main()
