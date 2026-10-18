/** Selection/race accounting without a browser, network, or additional dependencies (Node 24). */
import assert from 'node:assert/strict';
import { ModelDownloads } from '../src/body/model-progress.ts';

const manifest = {
  id: 'test-snapshot',
  models: [
    { iri: 'skin', path: 'models/skin.glb' },
    { iri: 'lung', path: 'models/lung.glb' },
    { iri: 'heart', path: 'models/heart.glb' },
  ],
  files: [
    { path: 'models/skin.glb', bytes: 100 },
    { path: 'models/lung.glb', bytes: 200 },
    { path: 'models/heart.glb', bytes: 50 },
  ],
};
const progress = new ModelDownloads(manifest);
const send = (organ, loaded, phase = 'progress') => progress.accept({
  type: 'cyto:hra-model', snapshot: manifest.id, path: `models/${organ}.glb`, loaded, phase,
});

progress.expect(['skin', 'lung']);
assert.deepEqual(progress.read(), { loaded: 0, total: 300, complete: false, error: false });
send('skin', 100, 'complete'); send('lung', 50);
assert.equal(progress.read().loaded, 150);
send('lung', 0); send('lung', 25); // Duplicate/rebuilt scene cannot regress progress.
assert.equal(progress.read().loaded, 150);
progress.expect(['skin', 'heart']);
assert.equal(send('lung', 200, 'complete'), false, 'Old selection must not update the visible status');
assert.deepEqual(progress.read(), { loaded: 100, total: 150, complete: false, error: false });
send('heart', 50, 'complete');
assert.equal(progress.read().complete, true);
progress.expect(['skin', 'lung']);
assert.equal(progress.read().complete, true, 'Returning to completed models must not wait for a new request');
send('lung', 0, 'error');
assert.equal(progress.read().complete, true, 'A redundant request cannot invalidate already loaded bytes');
progress.expect(['skin', 'skin']);
assert.equal(progress.read().total, 100, 'Skin-only selection must count the shared model once');

const partial = new ModelDownloads(manifest);
partial.expect(['lung']);
const message = { type: 'cyto:hra-model', snapshot: manifest.id, path: 'models/lung.glb', loaded: 10, phase: 'complete' };
partial.accept(message);
assert.equal(partial.read().error, true, 'A truncated model is not a completed download');
assert.equal(partial.read().complete, false);
partial.accept({ ...message, phase: 'progress', loaded: 100 });
assert.equal(partial.read().error, false, 'Retrying a model clears its error');
partial.accept({ ...message, loaded: 200 });
assert.equal(partial.read().complete, true);
for (const invalid of [
  null, {}, { ...message, snapshot: 'old-snapshot' }, { ...message, path: 'models/untracked.glb' },
  { ...message, loaded: NaN }, { ...message, loaded: -1 }, { ...message, phase: 'unknown' },
]) assert.equal(partial.accept(invalid), false, 'Invalid/foreign progress should be ignored');
assert.throws(() => partial.expect(['unbundled-organ']), /Missing reference model/);
console.log('Model progress passed: duplicate fetches, fast scene changes, completed models, truncation, retries and invalid messages.');
