/** Verify the committed font snapshot without downloading anything. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../public/vendor/inter/', import.meta.url);
const snapshot = JSON.parse(await readFile(new URL('snapshot.json', root), 'utf8'));
assert.equal(snapshot.family, 'Inter');
assert.equal(snapshot.version, '4.1');
assert.deepEqual(snapshot.files.map(file => file.path).sort(), ['InterVariable.woff2', 'LICENSE.txt']);
for (const file of snapshot.files) {
  const bytes = await readFile(new URL(file.path, root));
  assert.equal(bytes.length, file.bytes, `Font resource size changed: ${file.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Font resource hash changed: ${file.path}`);
  if (file.path.endsWith('.woff2')) assert.equal(bytes.toString('ascii', 0, 4), 'wOF2');
}
console.log(`Inter ${snapshot.version}: font and license SHA-256 checks passed (no network).`);
