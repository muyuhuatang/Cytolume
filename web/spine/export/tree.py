"""Spatial tree builders: quadtree (2D) and octree (3D).

Each builder returns a flat node registry plus the root id. Every node has:
    id            : global morton-based id (unique across the whole tree).
    lod           : tree level (0 == root/coarsest).
    bbox          : [min_0..min_{d-1}, max_0..max_{d-1}] (node's spatial box).
    children      : list of child node ids ([] for leaves).
    point_indices : np.ndarray of indices into the input arrays. For LEAVES this
                    is every point in the box. For INTERNAL nodes it is an
                    id-seeded uniform subsample (~leaf_target) used for coarse LOD.
    is_leaf       : bool.

Invariants (asserted in build):
  * union of leaf point_indices == all input indices, with no duplicate and
    nothing missing ("point conservation is sacred").
  * every internal-node subsample is a subset of points present in descendant
    leaves -> a cell shown at a coarse LOD also appears at the leaf (no popping).

Morton id scheme: a node's local index at level L is parent_local*branch + child,
so it encodes the full child-index path (base-`branch` morton code). The global
id offsets that by the number of nodes in all shallower levels, giving a unique,
deterministic id per node:
    quadtree: id = (4**L - 1)//3 + local      (branch=4)
    octree:   id = (8**L - 1)//7 + local       (branch=8)
"""

from __future__ import annotations

import numpy as np

_MAX_DEPTH = 16  # safety cap; real data needs only ~2-3 levels at leaf_target=60000


def _id_hash(ids: np.ndarray) -> np.ndarray:
    """Stable 32-bit mix (Murmur-style) of cell ids -> uint32 priorities.

    Deterministic and independent of node, so the same cell selects identically
    everywhere -> coarse-LOD subsamples are a stable subset of the full set.
    """
    x = ids.astype(np.uint32, copy=True)
    with np.errstate(over="ignore"):
        x ^= x >> np.uint32(16)
        x *= np.uint32(0x7FEB352D)
        x ^= x >> np.uint32(15)
        x *= np.uint32(0x846CA68B)
        x ^= x >> np.uint32(16)
    return x


def _subsample(indices: np.ndarray, ids: np.ndarray, k: int) -> np.ndarray:
    """Pick min(k, len) indices by lowest id-hash priority (uniform, id-seeded)."""
    if indices.shape[0] <= k:
        return indices
    h = _id_hash(ids)
    order = np.argsort(h, kind="stable")
    return indices[order[:k]]


def _level_offset(level: int, branch: int) -> int:
    return (branch**level - 1) // (branch - 1)


def _build(points: np.ndarray, ids: np.ndarray, leaf_target: int, dims: int) -> dict:
    if points.ndim != 2 or points.shape[1] != dims:
        raise ValueError(f"points must be (N, {dims}), got {points.shape}")
    if ids.shape[0] != points.shape[0]:
        raise ValueError("ids and points length mismatch")

    branch = 1 << dims  # 4 for quad, 8 for octree
    n = points.shape[0]
    all_idx = np.arange(n, dtype=np.int64)

    root_min = points.min(axis=0).astype(np.float64) if n else np.zeros(dims)
    root_max = points.max(axis=0).astype(np.float64) if n else np.zeros(dims)

    nodes: dict[int, dict] = {}
    max_level = 0

    # Iterative stack: (level, local_index, bbox_min, bbox_max, point_indices)
    stack = [(0, 0, root_min.copy(), root_max.copy(), all_idx)]

    while stack:
        level, local, bmin, bmax, idx = stack.pop()
        node_id = _level_offset(level, branch) + local
        max_level = max(max_level, level)
        count = idx.shape[0]

        center = (bmin + bmax) / 2.0

        # Decide whether to split.
        split = count > leaf_target and level < _MAX_DEPTH

        children_ids: list[int] = []
        if split:
            # Assign each point to a child octant/quadrant by midpoint.
            bits = (points[idx] >= center).astype(np.int64)  # (count, dims) 0/1
            child_of = np.zeros(count, dtype=np.int64)
            for d in range(dims):
                child_of |= bits[:, d] << d

            # Detect degenerate split (all points fall in one child) -> stop.
            buckets = [idx[child_of == c] for c in range(branch)]
            non_empty = [b for b in buckets if b.shape[0] > 0]
            if len(non_empty) <= 1:
                split = False
            else:
                for c in range(branch):
                    cidx = buckets[c]
                    if cidx.shape[0] == 0:
                        continue
                    cmin = bmin.copy()
                    cmax = bmax.copy()
                    for d in range(dims):
                        if (c >> d) & 1:
                            cmin[d] = center[d]
                        else:
                            cmax[d] = center[d]
                    child_local = local * branch + c
                    children_ids.append(_level_offset(level + 1, branch) + child_local)
                    stack.append((level + 1, child_local, cmin, cmax, cidx))

        if split and children_ids:
            # Internal node: store an id-seeded subsample for coarse LOD.
            pidx = _subsample(idx, ids[idx], leaf_target)
            is_leaf = False
        else:
            # Leaf node: store ALL points (point conservation).
            pidx = idx
            is_leaf = True
            children_ids = []

        bbox = [float(v) for v in bmin] + [float(v) for v in bmax]
        nodes[node_id] = {
            "id": int(node_id),
            "lod": int(level),
            "bbox": bbox,
            "children": children_ids,
            "point_indices": pidx,
            "is_leaf": is_leaf,
            "count": int(pidx.shape[0]),
        }

    _verify_conservation(nodes, n)

    bounds = [float(v) for v in root_min] + [float(v) for v in root_max]
    return {
        "dims": dims,
        "tree": "quadtree" if dims == 2 else "octree",
        "branch": branch,
        "bounds": bounds,
        "leafTarget": int(leaf_target),
        "lodLevels": int(max_level + 1),
        "root": 0,
        "nodes": nodes,
    }


def _verify_conservation(nodes: dict[int, dict], n: int) -> None:
    """Assert leaf union == all ids, no dup, no missing."""
    seen = np.zeros(n, dtype=bool)
    total = 0
    for node in nodes.values():
        if not node["is_leaf"]:
            continue
        pi = node["point_indices"]
        if pi.shape[0] == 0:
            continue
        if seen[pi].any():
            raise AssertionError("duplicate point across leaves")
        seen[pi] = True
        total += pi.shape[0]
    if total != n or not seen.all():
        missing = int((~seen).sum())
        raise AssertionError(
            f"point conservation violated: covered {total}/{n}, missing {missing}"
        )


def build_quadtree(points2d: np.ndarray, ids: np.ndarray, leaf_target: int) -> dict:
    """Build a quadtree over 2D points. See module docstring for the node schema."""
    return _build(np.asarray(points2d, dtype=np.float64), np.asarray(ids), leaf_target, 2)


def build_octree(points3d: np.ndarray, ids: np.ndarray, leaf_target: int) -> dict:
    """Build an octree over 3D points. See module docstring for the node schema."""
    return _build(np.asarray(points3d, dtype=np.float64), np.asarray(ids), leaf_target, 3)
