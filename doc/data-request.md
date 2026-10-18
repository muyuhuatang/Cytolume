# Cytolume — research-data integration guide

The reproducible demo provides a starting point for developing the viewer. This guide
describes the inputs and pipeline changes needed to explore a research dataset and
carry its source information into exported figures.

The reference dataset this was designed against is the ~453k-cell, 10-lung-dataset
concatenation behind [`cns-iu/hra-cell-embeddings`](https://github.com/cns-iu/hra-cell-embeddings)
(453,251 cells × 60,286 genes). The source `.h5ad` is not included in this repository.
The shipped pipeline generates metadata and all four layouts from fixed seeds.

Integration requires adapting `web/spine/export/build_meta.py` and the layout builders
to read the research inputs, keeping the same dense `cell_id` ordering across files.
Update dataset counts in `paths.py`, category dictionaries, and the corresponding checks,
write dataset provenance in the manifest, then regenerate and verify the tiles.
Anatomical links also need a dataset-specific join in `web/src/body/body-map.ts` and
the selection code. The examples below prepare input files for this work; they do not
automatically connect an `.h5ad` file to the showcase.

## What is needed

The expression matrix is **not** required — only coordinates and per-cell labels.

| field | from | why |
|---|---|---|
| **barcode** (per-cell id) | `adata.obs_names` | stable join key / picking id |
| **CL_label** (cell type) | `adata.obs['CL_label']` | categorical colour + legend |
| **X_pca** (n × 200) | `adata.obsm['X_pca']` | **the key enabler** — lets every layout be regenerated locally, including **3D**, matching one pipeline |
| dataset / donor | any `obs` column (`Sample ID` / `prep` / `tissue` / `dataset`) | the donor/batch lens (optional but see below) |
| X_tsne (n × 2) | `adata.obsm['X_tsne_p']` | optional — reproduces the original 2D figures exactly |
| **organ / CCF `rui_location`** | any `obs` organ/tissue column; ideally a CCF SpatialEntity registration per tissue block | **HRA body panel.** Replace the illustrative cell-to-organ map with a join to source metadata and registrations. A representative organ location provides context; a registered tissue block is needed to locate that sample more precisely. |
| **sex / donor gender** | any `obs` sex/gender column | **HRA body panel.** Optional metadata for selecting a reference model during integration. The current Female/Male toggle is manual (default female); automatic donor-based selection requires application changes. |

`X_pca` is what unblocks **3D**: notebook pipelines typically compute 2D only, so the 3D
layout is recreated locally from the PCA.

## Exporting it

```python
import anndata as ad, numpy as np, pandas as pd
import pyarrow as pa, pyarrow.parquet as pq

adata = ad.read_h5ad('<path-to-your>.h5ad')

# 1) small metadata table (~20-40 MB parquet)
df = pd.DataFrame({
    'barcode':  adata.obs_names.astype(str),
    'CL_label': adata.obs['CL_label'].astype(str),
})
for c in ['dataset', 'Sample ID', 'prep', 'tissue', 'donor']:   # whichever exist
    if c in adata.obs: df[c] = adata.obs[c].astype(str)
if 'X_tsne_p' in adata.obsm:                                     # optional
    xy = np.asarray(adata.obsm['X_tsne_p'])[:, :2]
    df['x_tsne'], df['y_tsne'] = xy[:, 0], xy[:, 1]
pq.write_table(pa.Table.from_pandas(df), 'cytolume_meta.parquet')

# 2) the PCA — regenerates every layout, including 3D (~360 MB .npy)
np.save('cytolume_pca200.npy', np.asarray(adata.obsm['X_pca'], dtype=np.float32))
```

Row order must match between the two files (it will, straight from `adata`).

### If the PCA is too large to move

Run the 3D embedding at the source and send three extra columns instead:

```python
import scanpy as sc
sc.pp.neighbors(adata, use_rep='X_pca')
sc.tl.umap(adata, n_components=3)                 # the 3D layout
xyz = np.asarray(adata.obsm['X_umap'])
df['x3'], df['y3'], df['z3'] = xyz[:,0], xyz[:,1], xyz[:,2]
pq.write_table(pa.Table.from_pandas(df), 'cytolume_meta.parquet')   # ~30-50 MB, includes 3D
```

Without either the PCA **or** a 3D run, the **2D** map still builds from
`x_tsne`/`y_tsne` + `CL_label` — but there is no 3D.

## Format notes

- **Parquet preferred** (CSV / `.npy` / raw `.h5ad` all fine).
- One row per cell; the **barcode** is the join key.
- Any extra per-cell field is welcome — Cytolume already has a nullable `confidence`
  column and a per-cell continuous channel ready for one.

## Declaring the data real

The figure exporter treats missing provenance as synthetic and labels the demo
accordingly. For an integrated research dataset, record its actual source and set
`synthetic: false` only after replacing the generated inputs with that dataset.
This keeps the origin of shared figures explicit.

The exporter therefore has to write a `provenance` block into `manifest.json`
(`reflection-9` §6; the optional field already exists on `SpineManifest`):

```jsonc
"provenance": {
  "dataset": "…",
  "source": "…",
  "synthetic": false,          // the flag the plate reads
  "cellTypeOntology": "CL"
}
```

Two further producer-declared fields materially improve the figure. Both currently render
as an honest *absence* on the key:

- **`continuous.<name>.domain` / `.unit` / `.transform`** — the colour key prints
  `domain = stored extent; units not declared by the producer`, because the app refuses to
  invent a scale. With these declared it prints the real one. Record the transform exactly
  as applied (e.g. `log1p(CP10K)`).
- **Real ontology labels.** The shipped `CL_label` dictionary is placeholders
  (`CL:0000000_type00` … `type47`) — fabricated CURIEs that happen to resolve to real Cell
  Ontology terms. Real names also make the map labels readable: the on-map label strips a
  numeric CURIE prefix, which becomes a no-op once the names are genuine.
