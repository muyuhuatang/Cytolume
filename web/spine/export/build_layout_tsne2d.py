"""Phase 2 — layout 'tsne2d' (dims=2): the primary 2D clustered embedding.

Reads the canonical meta.parquet (cell_id + CL_label), places each cell into its
CL_label blob via synth.make_layout(key='tsne2d', dims=2), and persists the raw,
un-normalized coordinates keyed by cell_id:

  - web/spine/build/layouts/tsne2d.parquet
        cell_id uint32 | x float32 | y float32

Every cell_id appears exactly once; all coordinates finite.

Run from web/:  python -m spine.export.build_layout_tsne2d
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import paths, synth

SEED = 0
KEY = "tsne2d"
DIMS = 2


def main() -> None:
    paths.ensure_dirs()

    # Read canonical identity: cell_id + CL_label drive the cluster assignment.
    meta_tbl = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    cell_id = meta_tbl.column("cell_id").to_numpy().astype(np.uint32)
    # CL_label is dictionary-encoded; indices() are the int16 codes (index == type).
    CL_label = meta_tbl.column("CL_label").combine_chunks().indices.to_numpy().astype(np.int16)

    n = cell_id.shape[0]
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1"

    x, y = synth.make_layout({"CL_label": CL_label}, key=KEY, dims=DIMS, seed=SEED)
    x = np.ascontiguousarray(x, dtype=np.float32)
    y = np.ascontiguousarray(y, dtype=np.float32)

    # --- Assertions ---
    assert x.shape[0] == n and y.shape[0] == n, "coord length mismatch"
    assert np.isfinite(x).all() and np.isfinite(y).all(), "non-finite coords"
    assert np.unique(cell_id).size == n, "cell_id not unique"

    bounds = [float(x.min()), float(y.min()), float(x.max()), float(y.max())]

    # --- layouts/tsne2d.parquet ---
    table = pa.table(
        {
            "cell_id": pa.array(cell_id, type=pa.uint32()),
            "x": pa.array(x, type=pa.float32()),
            "y": pa.array(y, type=pa.float32()),
        }
    )
    out_path = paths.layout_parquet(KEY)
    pq.write_table(table, out_path, compression="zstd")

    # --- Report ---
    print(json.dumps({
        "layout_key": KEY,
        "row_count": int(n),
        "dims": DIMS,
        "bounds": {
            "x_min": bounds[0], "y_min": bounds[1],
            "x_max": bounds[2], "y_max": bounds[3],
        },
        "file": str(out_path),
        "file_bytes": out_path.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
