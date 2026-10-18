"""Canonical paths from the SPEC.

Everything is anchored at the `web/` directory so the layout is identical no
matter where python is invoked from. Browser-served artifacts live under
`web/public/spine/` (Vite serves `public/` at `/spine/`); the offline canonical
Apache Parquet store lives under `web/spine/build/` (gitignored, regenerable).
"""

from __future__ import annotations

from pathlib import Path

# .../web/spine/export/paths.py  -> parents[2] == .../web
WEB_ROOT: Path = Path(__file__).resolve().parents[2]

# Offline canonical store (gitignored, regenerable): Apache Parquet.
BUILD_DIR: Path = WEB_ROOT / "spine" / "build"
META_PARQUET: Path = BUILD_DIR / "meta.parquet"
LAYOUTS_DIR: Path = BUILD_DIR / "layouts"  # layouts/<key>.parquet

# Browser-served artifacts (gitignored, regenerable).
PUBLIC_SPINE: Path = WEB_ROOT / "public" / "spine"
MANIFEST_JSON: Path = PUBLIC_SPINE / "manifest.json"
DICT_DIR: Path = PUBLIC_SPINE / "dict"  # dict/<field>.json
COLUMNS_DIR: Path = PUBLIC_SPINE / "columns"  # columns/expr.f32
TILES_DIR: Path = PUBLIC_SPINE / "tiles"  # tiles/<layoutKey>/<lod>/<mortonId>.bin

# TypeScript loader directory (committed source consumed by the renderer).
TS_DATA_DIR: Path = WEB_ROOT / "src" / "data"

# SPEC constants.
CELL_COUNT: int = 453251
N_CELL_TYPES: int = 48
N_DATASETS: int = 10
LEAF_TARGET: int = 60000

# Layout registry: key -> dims. All keyed to the SAME cell_id (enables morph).
LAYOUTS: dict[str, int] = {
    "tsne2d": 2,
    "tsne2d_alt": 2,
    "umap3d": 3,
    "pca3d": 3,
}


def layout_parquet(key: str) -> Path:
    """Path to layouts/<key>.parquet in the offline store."""
    return LAYOUTS_DIR / f"{key}.parquet"


def dict_json(field: str) -> Path:
    """Path to dict/<field>.json under the browser-served spine."""
    return DICT_DIR / f"{field}.json"


def tile_path(layout_key: str, lod: int, morton_id: int) -> Path:
    """Path to tiles/<layoutKey>/<lod>/<mortonId>.bin under the browser-served spine."""
    return TILES_DIR / layout_key / str(lod) / f"{morton_id}.bin"


def tile_uri(layout_key: str, lod: int, morton_id: int) -> str:
    """Manifest-relative URI (POSIX separators) for a tile, e.g.
    'tiles/<layoutKey>/<lod>/<mortonId>.bin'. Relative to public/spine/.
    """
    return f"tiles/{layout_key}/{lod}/{morton_id}.bin"


def ensure_dirs() -> None:
    """Create all output directories (idempotent)."""
    for d in (BUILD_DIR, LAYOUTS_DIR, PUBLIC_SPINE, DICT_DIR, COLUMNS_DIR, TILES_DIR):
        d.mkdir(parents=True, exist_ok=True)
