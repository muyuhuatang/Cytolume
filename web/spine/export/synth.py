"""Seeded synthetic data generators (stand-in for the real ~453k-cell predecessor).

All randomness flows through numpy.random.default_rng(seed) for reproducibility.
Nothing here touches disk; callers (later stage scripts) persist the arrays.

  make_meta(n, seed)              -> dict of per-cell arrays (layout-INDEPENDENT).
  make_layout(meta, key, dims, seed) -> tuple of coordinate arrays for one layout.
  make_cl_label_dict(seed)        -> {"names":[48], "colorSlot":[48]} for dict/CL_label.json.
  make_dataset_dict(seed)         -> {"names":[10]} for dict/dataset_id.json.

Cluster identity is shared across layouts: a cell's blob is keyed by its CL_label,
so the same cell type forms a cluster in every layout (enables morph between them).
"""

from __future__ import annotations

import zlib

import numpy as np

from .paths import CELL_COUNT, N_CELL_TYPES, N_DATASETS

_BASES = np.array(list("ACGT"))

# Per-layout arrangement parameters. center_spread = stddev of the 48 blob
# centers (cluster separation); blob_sigma = base per-cell scatter within a blob.
_LAYOUT_CFG: dict[str, dict] = {
    "tsne2d": {"dims": 2, "center_spread": 100.0, "blob_sigma": 3.5, "exaggerate": 1.0},
    "tsne2d_alt": {"dims": 2, "center_spread": 72.0, "blob_sigma": 6.5, "exaggerate": 1.35},
    "umap3d": {"dims": 3, "center_spread": 80.0, "blob_sigma": 4.0, "exaggerate": 1.0},
    "pca3d": {"dims": 3, "center_spread": 34.0, "blob_sigma": 9.0, "exaggerate": 1.0},
}


def _key_seed(seed: int, key: str) -> np.random.Generator:
    """Derive a per-layout generator deterministically from (seed, key)."""
    salt = zlib.crc32(key.encode("utf-8")) & 0xFFFFFFFF
    return np.random.default_rng([int(seed) & 0xFFFFFFFF, salt])


def _powerlaw_probs(k: int, alpha: float, rng: np.random.Generator) -> np.ndarray:
    """Zipf-like population: p_i proportional to 1/(rank+1)^alpha, lightly shuffled."""
    ranks = np.arange(1, k + 1, dtype=np.float64)
    p = 1.0 / np.power(ranks, alpha)
    rng.shuffle(p)  # so the heavy types are not always the low indices
    return p / p.sum()


def make_meta(n: int = CELL_COUNT, seed: int = 0) -> dict:
    """Generate the layout-independent per-cell meta arrays.

    Returns dict with keys:
        cell_id    uint32 (n,)   contiguous 0..n-1
        barcode    <U16   (n,)   seeded ACGT 16-mers
        CL_label   int16  (n,)   cell-type index 0..47 (power-law population)
        dataset_id int8   (n,)   dataset index 0..9
        expr       float32(n,)   continuous channel in [0,1] (correlates w/ CL_label)
    """
    rng = np.random.default_rng(seed)

    cell_id = np.arange(n, dtype=np.uint32)

    # Barcodes: (n,16) ACGT, viewed as fixed-width <U16 strings (fast, vectorized).
    code_idx = rng.integers(0, 4, size=(n, 16), dtype=np.int8)
    chars = np.ascontiguousarray(_BASES[code_idx])  # (n,16) '<U1'
    barcode = chars.view("<U16").reshape(n)

    # CL_label with power-law population over 48 types.
    cl_probs = _powerlaw_probs(N_CELL_TYPES, alpha=1.15, rng=rng)
    CL_label = rng.choice(N_CELL_TYPES, size=n, p=cl_probs).astype(np.int16)

    # dataset_id over 10 datasets, mildly uneven (dirichlet weights).
    ds_probs = rng.dirichlet(np.full(N_DATASETS, 2.0))
    dataset_id = rng.choice(N_DATASETS, size=n, p=ds_probs).astype(np.int8)

    # expr: correlate with CL_label, add noise, arcsinh -> 1-99 pct clamp -> minmax.
    type_base = rng.uniform(0.0, 1.0, size=N_CELL_TYPES) * 12.0
    raw = type_base[CL_label] + rng.normal(0.0, 3.0, size=n)
    t = np.arcsinh(raw)
    lo, hi = np.percentile(t, [1.0, 99.0])
    t = np.clip(t, lo, hi)
    span = hi - lo if hi > lo else 1.0
    expr = ((t - lo) / span).astype(np.float32)

    return {
        "cell_id": cell_id,
        "barcode": barcode,
        "CL_label": CL_label,
        "dataset_id": dataset_id,
        "expr": expr,
    }


def make_layout(meta: dict, key: str, dims: int, seed: int = 0) -> tuple:
    """Place each cell into its CL_label blob, arranged per layout `key`.

    Args:
        meta: dict from make_meta (uses meta['CL_label']).
        key:  one of tsne2d, tsne2d_alt, umap3d, pca3d.
        dims: 2 or 3, must match the layout key.
        seed: base seed (combined with key for a per-layout substream).

    Returns:
        (x, y) for dims==2 or (x, y, z) for dims==3, each float32 (n,), un-normalized.
    """
    if key not in _LAYOUT_CFG:
        raise ValueError(f"unknown layout key {key!r}")
    cfg = _LAYOUT_CFG[key]
    if dims != cfg["dims"]:
        raise ValueError(f"layout {key!r} expects dims={cfg['dims']}, got {dims}")

    cl = np.asarray(meta["CL_label"])
    n = cl.shape[0]
    rng = _key_seed(seed, key)

    # 48 blob centers (cluster separation set by center_spread * exaggerate).
    centers = rng.normal(
        0.0, cfg["center_spread"] * cfg["exaggerate"], size=(N_CELL_TYPES, dims)
    )
    # Per-type anisotropic scatter for organic, non-uniform blobs.
    per_type_sigma = cfg["blob_sigma"] * rng.uniform(0.6, 1.6, size=(N_CELL_TYPES, dims))

    offsets = rng.normal(0.0, 1.0, size=(n, dims)) * per_type_sigma[cl]
    coords = centers[cl] + offsets
    coords = coords.astype(np.float32)

    return tuple(np.ascontiguousarray(coords[:, d]) for d in range(dims))


def make_cl_label_dict(seed: int = 0) -> dict:
    """Build dict/CL_label.json content: 48 type names + a Core-24 color slot each."""
    rng = np.random.default_rng(seed ^ 0xC10001)
    names = [f"CL:{i:07d}_type{i:02d}" for i in range(N_CELL_TYPES)]
    color_slot = rng.integers(0, 24, size=N_CELL_TYPES).astype(int).tolist()
    return {"names": names, "colorSlot": color_slot}


def make_dataset_dict(seed: int = 0) -> dict:
    """Build dict/dataset_id.json content: 10 dataset names."""
    return {"names": [f"dataset_{i:02d}" for i in range(N_DATASETS)]}
