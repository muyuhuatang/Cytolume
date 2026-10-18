"""Phase 2 — generate ONE layout: "tsne2d_alt" (dims=2, alt 2D).

Same cells as every other layout (keyed to cell_id), different cluster
exaggeration/jitter. Reads the canonical meta.parquet for cell_id + CL_label,
places each cell into its CL_label blob via synth.make_layout, and writes:

  - web/spine/build/layouts/tsne2d_alt.parquet
        cell_id uint32 | x float32 | y float32   (raw, un-normalized)

Run from web/:  python -m spine.export.build_layout_tsne2d_alt
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import paths, synth

KEY = "tsne2d_alt"
DIMS = 2
SEED = 0


def main() -> None:
    paths.ensure_dirs()

    # Read canonical identity: cell_id + CL_label drive blob assignment.
    table = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    cell_id = table.column("cell_id").to_numpy().astype(np.uint32)
    # CL_label is dictionary<int16,utf8>; recover the integer codes (index == type).
    cl_col = table.column("CL_label").combine_chunks()
    CL_label = cl_col.indices.to_numpy(zero_copy_only=False).astype(np.int16)

    n = cell_id.shape[0]
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1"

    coords = synth.make_layout({"CL_label": CL_label}, key=KEY, dims=DIMS, seed=SEED)
    x, y = coords

    # --- Assertions: invariants ---
    assert x.shape[0] == n and y.shape[0] == n, "coord length mismatch"
    assert np.isfinite(x).all() and np.isfinite(y).all(), "non-finite coords"
    assert np.unique(cell_id).size == n, "cell_id not unique"

    out = pa.table(
        {
            "cell_id": pa.array(cell_id, type=pa.uint32()),
            "x": pa.array(np.ascontiguousarray(x, dtype=np.float32), type=pa.float32()),
            "y": pa.array(np.ascontiguousarray(y, dtype=np.float32), type=pa.float32()),
        }
    )
    out_path = paths.layout_parquet(KEY)
    pq.write_table(out, out_path, compression="zstd")

    bounds = [float(x.min()), float(y.min()), float(x.max()), float(y.max())]

    print(json.dumps({
        "layout_key": KEY,
        "row_count": n,
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
