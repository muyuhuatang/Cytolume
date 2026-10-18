"""Manifest assembly / validation + idSpace checksum.

The manifest (public/spine/manifest.json) is the single entry point the
dependency-free browser loader reads first. These helpers turn the in-memory
tree nodes (from tree.py) into the SPEC manifest shape and validate it.
"""

from __future__ import annotations

import hashlib

import numpy as np

from . import paths


def compute_id_checksum(cell_ids: np.ndarray) -> str:
    """SHA-256 (hex) of the sorted cell_ids as little-endian uint32 bytes.

    Stable identity fingerprint shared across all layouts.
    """
    ids = np.sort(np.asarray(cell_ids, dtype=np.uint32))
    h = hashlib.sha256(ids.astype("<u4").tobytes())
    return h.hexdigest()


def build_layout_entry(key: str, tree: dict) -> dict:
    """Convert a tree dict (from build_quadtree/build_octree) to a manifest layout entry."""
    tiles = []
    for node in tree["nodes"].values():
        tiles.append(
            {
                "id": int(node["id"]),
                "lod": int(node["lod"]),
                "bbox": [float(v) for v in node["bbox"]],
                "count": int(node["count"]),
                "children": [int(c) for c in node["children"]],
                "uri": paths.tile_uri(key, int(node["lod"]), int(node["id"])),
            }
        )
    tiles.sort(key=lambda t: (t["lod"], t["id"]))
    return {
        "dims": int(tree["dims"]),
        "bounds": [float(v) for v in tree["bounds"]],
        "tree": tree["tree"],
        "leafTarget": int(tree["leafTarget"]),
        "lodLevels": int(tree["lodLevels"]),
        "tiles": tiles,
    }


def build_manifest(
    cell_count: int,
    layouts: dict[str, dict],
    checksum: str,
    cl_count: int = paths.N_CELL_TYPES,
) -> dict:
    """Assemble the full manifest dict per SPEC."""
    return {
        "version": 1,
        "cellCount": int(cell_count),
        "layouts": layouts,
        "categorical": {
            "CL_label": {"dict": "dict/CL_label.json", "count": int(cl_count)},
        },
        "continuous": {"expr": "columns/expr.f32"},
        "idSpace": {
            "field": "cell_id",
            "stable": True,
            "sharedAcrossLayouts": True,
            "checksum": checksum,
        },
    }


def validate_manifest(manifest: dict) -> list[str]:
    """Return a list of problems (empty == valid). Checks structural SPEC invariants."""
    problems: list[str] = []

    if manifest.get("version") != 1:
        problems.append("version must be 1")
    cell_count = manifest.get("cellCount")
    if not isinstance(cell_count, int) or cell_count <= 0:
        problems.append("cellCount must be a positive int")

    layouts = manifest.get("layouts", {})
    if not layouts:
        problems.append("no layouts present")

    for key, entry in layouts.items():
        dims = entry.get("dims")
        if dims not in (2, 3):
            problems.append(f"{key}: dims must be 2 or 3")
            continue
        bounds = entry.get("bounds", [])
        if len(bounds) != dims * 2:
            problems.append(f"{key}: bounds must have {dims * 2} numbers")
        expected_tree = "quadtree" if dims == 2 else "octree"
        if entry.get("tree") != expected_tree:
            problems.append(f"{key}: tree must be {expected_tree} for dims={dims}")

        tiles = entry.get("tiles", [])
        if not tiles:
            problems.append(f"{key}: no tiles")
            continue
        ids = {t["id"] for t in tiles}
        if len(ids) != len(tiles):
            problems.append(f"{key}: duplicate tile ids")
        leaf_total = 0
        leaf_ids: set[int] = set()
        for t in tiles:
            if len(t.get("bbox", [])) != dims * 2:
                problems.append(f"{key}: tile {t.get('id')} bbox wrong length")
            for c in t.get("children", []):
                if c not in ids:
                    problems.append(f"{key}: tile {t['id']} references missing child {c}")
            if not t.get("children"):
                leaf_total += int(t.get("count", 0))
        # Cross-check: sum of leaf counts == cellCount (point conservation).
        if isinstance(cell_count, int) and leaf_total != cell_count:
            problems.append(
                f"{key}: leaf point sum {leaf_total} != cellCount {cell_count}"
            )
        _ = leaf_ids

    idspace = manifest.get("idSpace", {})
    if not idspace.get("checksum"):
        problems.append("idSpace.checksum missing")
    if idspace.get("field") != "cell_id":
        problems.append("idSpace.field must be 'cell_id'")

    if "expr" not in manifest.get("continuous", {}):
        problems.append("continuous.expr missing")
    if "CL_label" not in manifest.get("categorical", {}):
        problems.append("categorical.CL_label missing")

    return problems
