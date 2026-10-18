"""Phase 1 — canonical identity + metadata.

Generates the 453251-cell layout-independent metadata via synth.make_meta and
persists the canonical identity that EVERYTHING downstream keys off:

  - web/spine/build/meta.parquet
        cell_id uint32 | barcode utf8 | CL_label dict<int16,utf8> |
        dataset_id dict<int8,utf8> | expr float32
  - web/public/spine/dict/CL_label.json   (names + Core-24 colorSlot)
  - web/public/spine/dict/dataset_id.json (names)
  - web/public/spine/columns/expr.f32     (raw LE Float32Array, order == cell_id)

Run from web/:  python -m spine.export.build_meta
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import paths, synth

SEED = 0


def main() -> None:
    paths.ensure_dirs()

    meta = synth.make_meta(n=paths.CELL_COUNT, seed=SEED)
    cl_dict = synth.make_cl_label_dict(seed=SEED)
    ds_dict = synth.make_dataset_dict(seed=SEED)

    cell_id = np.asarray(meta["cell_id"], dtype=np.uint32)
    barcode = np.asarray(meta["barcode"])
    CL_label = np.asarray(meta["CL_label"], dtype=np.int16)
    dataset_id = np.asarray(meta["dataset_id"], dtype=np.int8)
    expr = np.asarray(meta["expr"], dtype=np.float32)

    n = cell_id.shape[0]

    # --- Assertions: canonical invariants ---
    assert n == paths.CELL_COUNT, f"row count {n} != {paths.CELL_COUNT}"
    assert np.array_equal(
        cell_id, np.arange(n, dtype=np.uint32)
    ), "cell_id must be dense 0..N-1"
    assert int(CL_label.min()) >= 0 and int(CL_label.max()) <= paths.N_CELL_TYPES - 1
    cl_card = int(np.unique(CL_label).size)
    assert cl_card == paths.N_CELL_TYPES, f"CL_label cardinality {cl_card} != 48"
    assert len(cl_dict["names"]) == paths.N_CELL_TYPES
    assert len(cl_dict["colorSlot"]) == paths.N_CELL_TYPES
    assert len(ds_dict["names"]) == paths.N_DATASETS
    assert int(dataset_id.min()) >= 0 and int(dataset_id.max()) <= paths.N_DATASETS - 1
    assert float(expr.min()) >= 0.0 and float(expr.max()) <= 1.0, "expr out of [0,1]"

    # --- meta.parquet ---
    # Dictionary-encode CL_label (int16 indices) and dataset_id (int8 indices)
    # so the parquet dictionary order == the JSON `names` order (index == code).
    cl_names = pa.array(cl_dict["names"], type=pa.utf8())
    ds_names = pa.array(ds_dict["names"], type=pa.utf8())

    cl_dict_arr = pa.DictionaryArray.from_arrays(
        pa.array(CL_label, type=pa.int16()), cl_names
    )
    ds_dict_arr = pa.DictionaryArray.from_arrays(
        pa.array(dataset_id, type=pa.int8()), ds_names
    )

    table = pa.table(
        {
            "cell_id": pa.array(cell_id, type=pa.uint32()),
            "barcode": pa.array(barcode.tolist(), type=pa.utf8()),
            "CL_label": cl_dict_arr,
            "dataset_id": ds_dict_arr,
            "expr": pa.array(expr, type=pa.float32()),
        }
    )

    pq.write_table(table, paths.META_PARQUET, compression="zstd")

    # --- dict JSONs ---
    cl_path = paths.dict_json("CL_label")
    ds_path = paths.dict_json("dataset_id")
    cl_path.write_text(json.dumps(cl_dict), encoding="utf-8")
    ds_path.write_text(json.dumps(ds_dict), encoding="utf-8")

    # --- expr.f32 (raw little-endian Float32, order == cell_id) ---
    expr_le = np.ascontiguousarray(expr.astype("<f4"))
    expr_path = paths.COLUMNS_DIR / "expr.f32"
    expr_path.write_bytes(expr_le.tobytes())

    # --- Report ---
    print(json.dumps({
        "row_count": n,
        "cl_label_cardinality": cl_card,
        "cl_dict_size": len(cl_dict["names"]),
        "dataset_dict_size": len(ds_dict["names"]),
        "expr_min": float(expr.min()),
        "expr_max": float(expr.max()),
        "files_written": {
            "meta_parquet": str(paths.META_PARQUET),
            "meta_parquet_bytes": paths.META_PARQUET.stat().st_size,
            "CL_label_json": str(cl_path),
            "dataset_id_json": str(ds_path),
            "expr_f32": str(expr_path),
            "expr_f32_bytes": expr_path.stat().st_size,
        },
    }, indent=2))


if __name__ == "__main__":
    main()
