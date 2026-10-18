"""Phase 4 - assemble the final browser manifest.

Merges the per-layout fragments (spine/build/manifest_*.json) into the single
SPEC manifest at public/spine/manifest.json, embedding cellCount, all layouts,
categorical (CL_label), continuous (expr), and idSpace with a real SHA-256
checksum over the sorted cell_ids. Validates every tile `uri` resolves to an
existing file under public/spine, and runs the structural validator.

Run from web/:  python -m spine.export.build_manifest
"""

from __future__ import annotations

import json

import pyarrow.parquet as pq

from . import manifest as manifest_mod
from . import paths


def _load_fragment(key: str) -> dict:
    """Load one per-layout fragment and return its layout entry.

    Two fragment shapes exist in the build dir:
      {"layout": <key>, "entry": <entry>}   (tsne2d)
      {<key>: <entry>}                       (tsne2d_alt, umap3d, pca3d)
    """
    frag_path = paths.BUILD_DIR / f"manifest_{key}.json"
    if not frag_path.exists():
        raise FileNotFoundError(f"missing manifest fragment: {frag_path}")
    with open(frag_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    if "entry" in data and data.get("layout") == key:
        return data["entry"]
    if key in data:
        return data[key]
    raise ValueError(f"unrecognized fragment shape for {key}: keys={list(data)}")


def _read_cell_ids():
    """Read the canonical cell_id column from meta.parquet."""
    table = pq.read_table(paths.META_PARQUET, columns=["cell_id"])
    return table.column("cell_id").to_numpy()


def main() -> dict:
    # 1. Merge per-layout fragments in the SPEC layout-registry order.
    layouts: dict[str, dict] = {}
    for key in paths.LAYOUTS:
        layouts[key] = _load_fragment(key)

    # 2. Real idSpace checksum over the sorted canonical cell_ids.
    cell_ids = _read_cell_ids()
    checksum = manifest_mod.compute_id_checksum(cell_ids)
    cell_count = int(cell_ids.shape[0])
    assert cell_count == paths.CELL_COUNT, (
        f"meta cellCount {cell_count} != SPEC {paths.CELL_COUNT}"
    )

    # 3. Assemble the full manifest.
    manifest = manifest_mod.build_manifest(
        cell_count=cell_count,
        layouts=layouts,
        checksum=checksum,
    )

    # 4. Structural validation (version/bounds/tree/conservation/etc.).
    problems = manifest_mod.validate_manifest(manifest)

    # 5. Validate referenced sidecar files + every tile uri resolves on disk.
    cl_dict = paths.PUBLIC_SPINE / "dict" / "CL_label.json"
    expr_col = paths.PUBLIC_SPINE / "columns" / "expr.f32"
    if not cl_dict.exists():
        problems.append(f"missing categorical dict file: {cl_dict}")
    if not expr_col.exists():
        problems.append(f"missing continuous column file: {expr_col}")

    total_tiles = 0
    missing_uris: list[str] = []
    for key, entry in layouts.items():
        for tile in entry["tiles"]:
            total_tiles += 1
            uri = tile["uri"]
            fpath = paths.PUBLIC_SPINE / uri
            if not fpath.exists():
                missing_uris.append(uri)
    if missing_uris:
        problems.append(
            f"{len(missing_uris)} tile uri(s) do not resolve, e.g. {missing_uris[:3]}"
        )

    if problems:
        raise SystemExit("manifest validation failed:\n  - " + "\n  - ".join(problems))

    # 6. Write the final manifest.
    paths.ensure_dirs()
    with open(paths.MANIFEST_JSON, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, separators=(",", ":"))

    result = {
        "ok": True,
        "manifest": str(paths.MANIFEST_JSON),
        "layouts": list(layouts.keys()),
        "cellCount": cell_count,
        "checksum": checksum,
        "tilesValidated": total_tiles,
        "bytes": paths.MANIFEST_JSON.stat().st_size,
    }
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    main()
