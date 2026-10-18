"""Phase 3 — tile layout 'tsne2d' (dims=2) into the SPEC quadtree .bin tiles.

Reads the canonical layout coords (layouts/tsne2d.parquet) and meta.parquet
(for the CL_label category baked into each tile), builds a quadtree at
~LEAF_TARGET points/leaf via tree.build_quadtree (id-seeded LOD subsamples at
internal nodes), writes every node as a .bin tile under

    web/public/spine/tiles/tsne2d/<lod>/<mortonId>.bin   (binfmt.write_tile)

and emits a manifest FRAGMENT describing this layout's tiles + bounds + lodLevels:

    web/spine/build/manifest_tsne2d.json

Point conservation is asserted: sum of LEAF tile points == CELL_COUNT, with no
duplicate or missing cell_id.

Run from web/:  python -m spine.export.tile_tsne2d
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow.parquet as pq

from . import binfmt, manifest, paths, tree

KEY = "tsne2d"
DIMS = 2


def main() -> None:
    paths.ensure_dirs()

    # --- Read layout coords (keyed by cell_id) ---
    lay = pq.read_table(paths.layout_parquet(KEY), columns=["cell_id", "x", "y"])
    lay_cell_id = lay.column("cell_id").to_numpy().astype(np.uint32)
    x = lay.column("x").to_numpy().astype(np.float32)
    y = lay.column("y").to_numpy().astype(np.float32)

    n = lay_cell_id.shape[0]
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        lay_cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1 (row index == cell_id)"

    # --- Read CL_label category (dictionary indices == type id) keyed by cell_id ---
    meta = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    meta_cell_id = meta.column("cell_id").to_numpy().astype(np.uint32)
    assert np.array_equal(meta_cell_id, lay_cell_id), "meta/layout cell_id misaligned"
    category = (
        meta.column("CL_label").combine_chunks().indices.to_numpy().astype(np.int16)
    )
    assert category.shape[0] == n, "category length mismatch"

    points = np.column_stack([x, y]).astype(np.float64)
    cell_ids = lay_cell_id

    # --- Build quadtree (conservation asserted inside _build) ---
    qt = tree.build_quadtree(points, cell_ids, paths.LEAF_TARGET)

    # --- Write every node as a .bin tile ---
    tile_count = 0
    leaf_point_sum = 0
    seen = np.zeros(n, dtype=bool)
    for node in qt["nodes"].values():
        pidx = node["point_indices"]
        out = paths.tile_path(KEY, int(node["lod"]), int(node["id"]))
        binfmt.write_tile(
            out,
            DIMS,
            points[pidx],
            cell_ids[pidx],
            category[pidx],
        )
        tile_count += 1
        if node["is_leaf"]:
            leaf_point_sum += pidx.shape[0]
            if seen[pidx].any():
                raise AssertionError("duplicate cell_id across leaf tiles")
            seen[pidx] = True

    # --- Assert point conservation across LEAF tiles ---
    conserved = bool(leaf_point_sum == n and seen.all())
    if not conserved:
        missing = int((~seen).sum())
        raise AssertionError(
            f"conservation violated: leaf sum {leaf_point_sum}/{n}, missing {missing}"
        )

    # --- Manifest fragment for this layout ---
    entry = manifest.build_layout_entry(KEY, qt)
    fragment = {"layout": KEY, "entry": entry}
    frag_path = paths.BUILD_DIR / f"manifest_{KEY}.json"
    frag_path.write_text(json.dumps(fragment, indent=2), encoding="utf-8")

    # --- Report ---
    print(json.dumps({
        "layout": KEY,
        "tileCount": tile_count,
        "leafPointSum": int(leaf_point_sum),
        "conserved": conserved,
        "lodLevels": int(qt["lodLevels"]),
        "bounds": [float(v) for v in qt["bounds"]],
        "manifestFragmentFile": str(frag_path),
    }, indent=2))


if __name__ == "__main__":
    main()
