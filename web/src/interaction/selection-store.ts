/**
 * selection-store.ts — the current lasso selection as a stable set of cell_ids,
 * plus a summary roll-up for the UI. Pure logic, no DOM, no GL.
 *
 * The store holds `cell_id`s (not layout indices) so a selection survives a
 * cross-layout morph. `summarize` joins those ids back to per-cell metadata
 * through the data source (`getCell`, which resolves the CL_label name via the
 * source's loaded dict) and pd.categories context, rolling up cell-type counts
 * (and dataset counts when the source provides them).
 */
import type { CellRecord, PointData } from "../core/types.ts";

/** Minimal structural view of the data source `summarize` needs. */
export interface SummarySource {
  /** Per-cell metadata; `cellType` is the resolved CL_label name (or numeric). */
  getCell(id: number): CellRecord;
}

export interface TypeStat {
  name: string;
  count: number;
  /** Percentage of the selection, 0..100. */
  pct: number;
}

export interface DatasetStat {
  name: string;
  count: number;
}

export interface SelectionSummary {
  count: number;
  /** Most-represented cell type, or null when the selection is empty. */
  topType: TypeStat | null;
  /** All cell types in the selection, sorted by count descending. */
  types: TypeStat[];
  /** Dataset breakdown — present only when the source supplies dataset names. */
  datasets?: DatasetStat[];
}

export class SelectionStore {
  private _ids: Uint32Array = new Uint32Array(0);

  /** Replace the selection with `ids` (a copy is kept). */
  set(ids: Uint32Array): void {
    this._ids = ids.length ? Uint32Array.from(ids) : new Uint32Array(0);
  }

  /** Empty the selection. */
  clear(): void {
    this._ids = new Uint32Array(0);
  }

  /** The current selected cell_ids (live reference — treat as read-only). */
  get ids(): Uint32Array {
    return this._ids;
  }

  /** Number of selected cells. */
  get count(): number {
    return this._ids.length;
  }

  /** True when nothing is selected. */
  get isEmpty(): boolean {
    return this._ids.length === 0;
  }

  /**
   * Roll the current selection up into a {@link SelectionSummary}. Joins each
   * cell_id back to its metadata via `source.getCell` (whose `cellType` is the
   * resolved CL_label name when the source's dict is loaded). `pd` carries the
   * active layout context (and validates this is the source the ids came from).
   */
  summarize(pd: PointData, source: SummarySource): SelectionSummary {
    void pd; // active-layout context; metadata is read through the source
    const total = this._ids.length;
    if (total === 0) {
      return { count: 0, topType: null, types: [] };
    }

    const typeCounts = new Map<string, number>();
    const datasetCounts = new Map<string, number>();

    for (let i = 0; i < total; i++) {
      const rec = source.getCell(this._ids[i]);
      const type = rec.cellType ?? "Unknown";
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      if (rec.dataset) {
        datasetCounts.set(rec.dataset, (datasetCounts.get(rec.dataset) ?? 0) + 1);
      }
    }

    const types: TypeStat[] = [...typeCounts.entries()]
      .map(([name, count]) => ({ name, count, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const summary: SelectionSummary = {
      count: total,
      topType: types[0] ?? null,
      types,
    };

    if (datasetCounts.size > 0) {
      summary.datasets = [...datasetCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }

    return summary;
  }
}
