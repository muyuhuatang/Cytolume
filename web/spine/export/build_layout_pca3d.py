"""Phase 2 — generate the "pca3d" layout (dims=3, cheap 3D baseline).

Reads meta.parquet (cell_id + CL_label), calls synth.make_layout to place each
cell into its CL_label blob with the pca3d arrangement (broad gaussian, little
cluster separation), and persists:

  - web/spine/build/layouts/pca3d.parquet
        cell_id uint32 | x float32 | y float32 | z float32   (raw, un-normalized)

Every cell_id is present exactly once; all coordinates are finite. Keyed to the
SAME cell_id as every other layout (enables morph).

Run from web/:  python -m spine.export.build_layout_pca3d
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import paths, synth

SEED = 0
KEY = "pca3d"
DIMS = 3


def main() -> None:
    paths.ensure_dirs()

    # Read canonical identity from meta.parquet (cell_id + CL_label only).
    table = pq.read_table(paths.META_PARQUET, columns=["cell_id", "CL_label"])
    cell_id = np.asarray(table.column("cell_id").to_numpy(zero_copy_only=False), dtype=np.uint32)

    # CL_label is dictionary-encoded; recover the integer codes (index == type id).
    codes = table.column("CL_label").combine_chunks().indices.to_numpy(zero_copy_only=False)
    CL_label = np.asarray(codes, dtype=np.int16)

    n = cell_id.shape[0]

    # --- Invariants on input identity ---
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        np.sort(cell_id), np.arange(n, dtype=np.uint32)
    ), "cell_id must be the dense set 0..N-1, each exactly once"

    # --- Generate coordinates ---
    meta = {"CL_label": CL_label}
    x, y, z = synth.make_layout(meta, key=KEY, dims=DIMS, seed=SEED)
    x = np.ascontiguousarray(x, dtype=np.float32)
    y = np.ascontiguousarray(y, dtype=np.float32)
    z = np.ascontiguousarray(z, dtype=np.float32)

    # --- Invariants on output ---
    assert x.shape == y.shape == z.shape == (n,)
    for name, arr in (("x", x), ("y", y), ("z", z)):
        assert np.all(np.isfinite(arr)), f"{name} contains non-finite values"

    bounds = [
        float(x.min()), float(y.min()), float(z.min()),
        float(x.max()), float(y.max()), float(z.max()),
    ]

    # --- Write layouts/pca3d.parquet ---
    out = pa.table(
        {
            "cell_id": pa.array(cell_id, type=pa.uint32()),
            "x": pa.array(x, type=pa.float32()),
            "y": pa.array(y, type=pa.float32()),
            "z": pa.array(z, type=pa.float32()),
        }
    )
    out_path = paths.layout_parquet(KEY)
    pq.write_table(out, out_path, compression="zstd")

    # --- Report ---
    print(json.dumps({
        "layout_key": KEY,
        "row_count": int(n),
        "dims": DIMS,
        "bounds": bounds,  # [xmin, ymin, zmin, xmax, ymax, zmax]
        "file_path": str(out_path),
        "file_bytes": out_path.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
