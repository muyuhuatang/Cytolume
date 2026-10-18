"""Phase 3 — tile ONE layout: "tsne2d_alt" (dims=2, quadtree).

Reads the canonical layout coords (layouts/tsne2d_alt.parquet) + meta.parquet
(for category == CL_label index), builds a quadtree at ~60000 pts/leaf with
id-seeded LOD subsamples (tree.py), writes every node as a SPEC .bin tile under
  web/public/spine/tiles/tsne2d_alt/<lod>/<mortonId>.bin   (binfmt.write_tile)
and writes a manifest FRAGMENT describing this layout's tiles + bounds +
lodLevels:
  web/spine/build/manifest_tsne2d_alt.json   ->  { "tsne2d_alt": <layout entry> }

Point conservation is asserted: sum of LEAF tile points == 453251, with no
duplicate or missing cell_id.

Run from web/:  python -m spine.export.tile_tsne2d_alt
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow.parquet as pq

from . import binfmt, manifest, paths, tree

KEY = "tsne2d_alt"
DIMS = 2


def main() -> None:
    paths.ensure_dirs()

    # --- Layout coords (the geometry we tile) ---
    lay = pq.read_table(paths.layout_parquet(KEY), columns=["cell_id", "x", "y"])
    lay_cell_id = lay.column("cell_id").to_numpy().astype(np.uint32)
    x = lay.column("x").to_numpy().astype(np.float32)
    y = lay.column("y").to_numpy().astype(np.float32)

    n = lay_cell_id.shape[0]
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        lay_cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1 in layout"

    # --- Categories: CL_label index, keyed to the SAME cell_id (dense order) ---
    meta = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    meta_cell_id = meta.column("cell_id").to_numpy().astype(np.uint32)
    assert np.array_equal(
        meta_cell_id, np.arange(n, dtype=np.uint32)
    ), "meta cell_id must be dense 0..N-1"
    cl_col = meta.column("CL_label").combine_chunks()
    category = cl_col.indices.to_numpy(zero_copy_only=False).astype(np.int16)
    assert category.shape[0] == n, "category length mismatch"

    points = np.column_stack([x, y]).astype(np.float64)
    cell_ids = lay_cell_id  # dense; index == cell_id

    # --- Build quadtree (tree.py asserts point conservation internally) ---
    qt = tree.build_quadtree(points, cell_ids, paths.LEAF_TARGET)

    # --- Write every node as a .bin tile ---
    tile_count = 0
    leaf_point_sum = 0
    seen = np.zeros(n, dtype=bool)
    for node in qt["nodes"].values():
        idx = np.asarray(node["point_indices"], dtype=np.int64)
        out_path = paths.tile_path(KEY, int(node["lod"]), int(node["id"]))
        binfmt.write_tile(
            out_path,
            DIMS,
            points[idx],
            cell_ids[idx],
            category[idx],
        )
        tile_count += 1
        if node["is_leaf"]:
            leaf_ids = cell_ids[idx]
            assert not seen[leaf_ids].any(), "duplicate cell_id across leaf tiles"
            seen[leaf_ids] = True
            leaf_point_sum += idx.shape[0]

    conserved = bool(leaf_point_sum == n and seen.all())
    assert conserved, (
        f"point conservation violated: {leaf_point_sum}/{n}, "
        f"missing {int((~seen).sum())}"
    )

    # --- Manifest fragment (just this layout's entry) ---
    entry = manifest.build_layout_entry(KEY, qt)
    fragment = {KEY: entry}
    fragment_path = paths.BUILD_DIR / f"manifest_{KEY}.json"
    fragment_path.write_text(json.dumps(fragment, indent=2), encoding="utf-8")

    print(json.dumps({
        "layout": KEY,
        "tileCount": tile_count,
        "leafPointSum": leaf_point_sum,
        "conserved": conserved,
        "lodLevels": int(qt["lodLevels"]),
        "bounds": entry["bounds"],
        "tree": entry["tree"],
        "leafTarget": entry["leafTarget"],
        "fragment": str(fragment_path),
        "tilesDir": str(paths.TILES_DIR / KEY),
    }, indent=2))


if __name__ == "__main__":
    main()
