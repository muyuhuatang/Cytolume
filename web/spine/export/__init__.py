"""Cytolume P0 spine export package.

Shared, layout-independent modules used by every later pipeline stage:
  - paths    : canonical filesystem locations (SPEC).
  - binfmt   : .bin tile reader/writer (byte-for-byte SPEC, must match the TS reader).
  - tree     : quadtree / octree builders with morton ids + id-seeded LOD subsamples.
  - synth    : seeded synthetic meta + per-layout coordinate generators.
  - manifest : manifest assembly / validation + idSpace checksum.

Nothing here generates the full dataset; these are the reusable primitives.
"""
