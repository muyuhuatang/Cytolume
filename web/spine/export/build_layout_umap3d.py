"""Phase 2 — generate the "umap3d" layout (dims=3, primary 3D clustered in volume).

Reads the canonical meta.parquet (cell_id + CL_label), places every cell into its
CL_label blob via synth.make_layout, and persists the un-normalized coordinates:

  - web/spine/build/layouts/umap3d.parquet
        cell_id uint32 | x float32 | y float32 | z float32

Every cell_id appears exactly once; all coordinates are finite.

Run from web/:  python -m spine.export.build_layout_umap3d
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import paths

KEY = "umap3d"
DIMS = 3
SEED = 0


def main() -> None:
    paths.ensure_dirs()

    # Read canonical identity: cell_id (order) + CL_label (cluster assignment).
    meta_tbl = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    cell_id = meta_tbl.column("cell_id").to_numpy(zero_copy_only=False).astype(np.uint32)
    # CL_label is dictionary-encoded; indices() recovers the int16 codes (index == code).
    cl_codes = meta_tbl.column("CL_label").combine_chunks().indices.to_numpy(
        zero_copy_only=False
    ).astype(np.int16)

    n = cell_id.shape[0]
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1 (synth.make_layout keys by row order)"

    # Lazy import so the module loads even if synth changes; synth is the source of truth.
    from . import synth

    x, y, z = synth.make_layout({"CL_label": cl_codes}, key=KEY, dims=DIMS, seed=SEED)
    x = np.ascontiguousarray(x, dtype=np.float32)
    y = np.ascontiguousarray(y, dtype=np.float32)
    z = np.ascontiguousarray(z, dtype=np.float32)

    # --- Assertions: invariants ---
    assert x.shape == y.shape == z.shape == (n,), "coord arrays must be length N"
    for name, arr in (("x", x), ("y", y), ("z", z)):
        assert np.all(np.isfinite(arr)), f"{name} contains non-finite values"
    # Every cell_id present exactly once (dense 0..N-1 already verified above).
    assert np.unique(cell_id).size == n, "cell_id must be unique"

    # --- layouts/umap3d.parquet ---
    table = pa.table(
        {
            "cell_id": pa.array(cell_id, type=pa.uint32()),
            "x": pa.array(x, type=pa.float32()),
            "y": pa.array(y, type=pa.float32()),
            "z": pa.array(z, type=pa.float32()),
        }
    )
    out_path = paths.layout_parquet(KEY)
    pq.write_table(table, out_path, compression="zstd")

    bounds = {
        "x": [float(x.min()), float(x.max())],
        "y": [float(y.min()), float(y.max())],
        "z": [float(z.min()), float(z.max())],
    }

    # --- Report ---
    print(json.dumps({
        "layout_key": KEY,
        "row_count": int(n),
        "dims": DIMS,
        "bounds": bounds,
        "file": str(out_path),
        "file_bytes": out_path.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
