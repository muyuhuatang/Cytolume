/** Per-page download accounting. Scene changes reuse completed models without double counting. */
export interface ModelSnapshot {
  id: string;
  models: Array<{ iri: string; path: string }>;
  files: Array<{ path: string; bytes: number }>;
}

export interface ModelDownloadState {
  loaded: number;
  total: number;
  complete: boolean;
  error: boolean;
}

export class ModelDownloads {
  private readonly snapshot: ModelSnapshot;
  private readonly records = new Map<string, { bytes: number; loaded: number; complete: boolean; error: boolean }>();
  private targets: string[] = [];

  constructor(snapshot: ModelSnapshot) {
    this.snapshot = snapshot;
    for (const model of snapshot.models) {
      const bytes = snapshot.files.find(file => file.path === model.path)?.bytes;
      if (!bytes || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Missing model size: ${model.path}`);
      this.records.set(model.path, { bytes, loaded: 0, complete: false, error: false });
    }
  }

  expect(iris: string[]): void {
    this.targets = [...new Set(iris.map(iri => {
      const model = this.snapshot.models.find(item => item.iri === iri);
      if (!model) throw new Error(`Missing reference model: ${iri}`);
      return model.path;
    }))];
  }

  accept(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const data = value as Record<string, unknown>;
    if (data.type !== 'cyto:hra-model' || data.snapshot !== this.snapshot.id || typeof data.path !== 'string') return false;
    const record = this.records.get(data.path);
    if (!record || typeof data.loaded !== 'number' || !Number.isSafeInteger(data.loaded) || data.loaded < 0 ||
        !['progress', 'complete', 'error'].includes(String(data.phase))) return false;
    // The component may request a model again when rebuilding the scene. Never add
    // two copies of the same file, or regress a model that already finished.
    if (!record.complete) {
      record.loaded = Math.min(record.bytes, Math.max(record.loaded, data.loaded));
      record.complete = data.phase === 'complete' && data.loaded === record.bytes;
      record.error = data.phase === 'error' || (data.phase === 'complete' && data.loaded !== record.bytes);
    }
    return this.targets.includes(data.path);
  }

  read(): ModelDownloadState {
    const records = this.targets.map(path => this.records.get(path)!);
    return {
      loaded: records.reduce((sum, record) => sum + record.loaded, 0),
      total: records.reduce((sum, record) => sum + record.bytes, 0),
      complete: records.length > 0 && records.every(record => record.complete),
      error: records.some(record => record.error),
    };
  }
}
