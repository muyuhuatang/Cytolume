/** Exercise the real worker against committed files, with ALL network access denied. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { snapshotRoot, verifySnapshot } from './hra-snapshot.mjs';

const manifest = await verifySnapshot();
const workerSource = await readFile(new URL('../public/hra-scene-sw.js', import.meta.url), 'utf8');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

function worker(base, overrides = {}, id = manifest.id) {
  const origin = 'https://example.github.io';
  const scope = origin + base;
  const root = new URL('vendor/hra/', scope);
  const listeners = new Map();
  const clients = new Map([
    ['female-tab', { url: `${scope}?sex=female` }],
    ['male-tab', { url: `${scope}?sex=male` }],
  ]);
  const requested = [];
  const messages = [], lifetimes = [];
  for (const [id, client] of clients) client.postMessage = message => messages.push({ clientId: id, ...structuredClone(message) });
  vm.runInNewContext(workerSource, {
    URL, Request, Response, Map, Set, JSON, Error,
    self: {
      registration: { scope },
      location: { href: `${scope}hra-scene-sw.js?snapshot=${id}` },
      clients: { get: async clientId => clients.get(clientId), claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    fetch: async input => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, origin, 'Worker attempted an external fetch');
      assert.ok(url.pathname.startsWith(root.pathname), 'Worker escaped the snapshot directory');
      const relative = url.pathname.slice(root.pathname.length);
      requested.push(relative);
      if (Object.hasOwn(overrides, relative)) {
        if (typeof overrides[relative] === 'function') return overrides[relative]();
        return overrides[relative] === null ? new Response('missing', { status: 404 }) : Response.json(overrides[relative]);
      }
      return new Response(await readFile(resolve(snapshotRoot, relative)));
    },
  }, { filename: 'hra-scene-sw.js' });

  return {
    requested, messages,
    async settled() { await Promise.all(lifetimes); },
    async init(clientId, sex, snapshot = manifest.id) {
      let result, pending;
      listeners.get('message')({
        data: { type: 'cyto:hra-init', sex, snapshot }, source: { id: clientId },
        ports: [{ postMessage: message => { result = message; } }],
        waitUntil: promise => { pending = promise; },
      });
      await pending;
      return result;
    },
    async request(path, clientId = 'female-tab', method = 'GET') {
      const url = path.startsWith('https:') ? path : new URL(`api/v1/${path}`, root).href;
      let pending;
      listeners.get('fetch')({
        request: new Request(url, { method }), clientId,
        respondWith: value => { pending = Promise.resolve(value); },
        waitUntil: value => lifetimes.push(value),
      });
      assert.ok(pending, `Worker did not handle ${url}`);
      return pending;
    },
  };
}

for (const base of ['/', '/Cytolume/']) {
  const w = worker(base);
  check((await w.init('female-tab', 'female')).ok, 'Female initialization failed');
  check((await w.init('male-tab', 'male')).ok, 'Male initialization failed');
  const references = await (await w.request('reference-organs')).json();
  check(references.length === 22, 'The full supported reference set must be present');
  for (const reference of references) {
    check(reference.object.file.startsWith(`https://example.github.io${base}vendor/hra/models/`), 'Model URL lost the project base');
  }
  for (const sex of ['female', 'male']) {
    const res = await w.request('scene', `${sex}-tab`);
    check(res.status === 200, 'Scene request failed');
    check(res.headers.get('x-cytolume-hra-snapshot') === manifest.id, 'Missing snapshot version');
    const nodes = await res.json();
    const expected = manifest.models.filter(model => model.sex === sex);
    check(nodes.length === expected.length, 'Scene lost a reference organ');
    check(nodes.every(node => node.sex.toLowerCase() === sex), 'Other tab changed the body sex');
    check(nodes.every(node => node.scenegraph.startsWith(`https://example.github.io${base}vendor/hra/models/`)), 'Scene has an upstream model URL');
    const skin = expected.find(model => model.iri.includes(`/skin-${sex}/`));
    for (const encoding of [skin.iri, JSON.stringify([skin.iri])]) {
      const query = new URLSearchParams({ 'ontology-terms': encoding, sex });
      const single = await w.request(`reference-organ-scene?${query}`, `${sex}-tab`);
      check(single.status === 200, 'Single-skin scene failed');
      check((await single.json()).some(node => node.reference_organ === skin.iri), 'Single scene lacks skin');
    }
  }
  await w.init('female-tab', 'male');
  check((await (await w.request('scene')).json()).every(node => node.sex === 'Male'), 'Sex switch was not acknowledged');
  check((await (await w.request('scene', 'male-tab')).json()).every(node => node.sex === 'Male'), 'Sex switch changed another tab');
  check(!(await w.init('female-tab', 'female', 'wrong-version')).ok, 'Mismatched page version was accepted');
  check((await w.request('unsupported')).status === 404, 'Unknown API should fail locally');
  check((await w.request('scene', 'female-tab', 'POST')).status === 405, 'Mutation should fail locally');
  check((await w.request('reference-organ-scene?ontology-terms=missing')).status === 404, 'Unknown model should fail locally');
  const before = w.requested.length;
  for (const upstream of ['https://apps.humanatlas.io/api/v1/scene', 'https://cdn.humanatlas.io/missing.glb', 'https://unpkg.com/@loaders.gl/draco']) {
    check((await w.request(upstream)).status === 502, 'Upstream fallback was not blocked');
  }
  check(w.requested.length === before, 'An upstream fallback caused a fetch');
  // Simulate worker termination: no in-memory sex state survives, but tabs still work.
  const restarted = worker(base);
  check((await (await restarted.request('scene', 'male-tab')).json()).every(node => node.sex === 'Male'), 'Restart lost the URL-selected sex');
  check((await (await restarted.request('scene', 'female-tab')).json()).every(node => node.sex === 'Female'), 'Restart mixed tab state');
  const missing = worker(base, { [manifest.data.scene]: null });
  check((await missing.request('scene')).status === 503, 'Missing snapshot should fail without upstream fallback');
  const corrupt = worker(base, { [manifest.data.scene]: [{ sex: 'Female', scenegraph: 'https://untrusted.example/model.glb' }] });
  check((await corrupt.request('scene')).status === 503, 'External model path was accepted');
  const mismatch = worker(base, {}, '00000000000000000000');
  check((await mismatch.request('scene')).status === 503, 'Worker accepted the wrong snapshot');

  // Reading progress must not cause a second fetch, change bytes, or notify another tab.
  const model = manifest.models.find(model => model.path.includes('heart-female'));
  const bytes = await readFile(resolve(snapshotRoot, model.path));
  const modelUrl = `https://example.github.io${base}vendor/hra/${model.path}`;
  const download = worker(base, { [model.path]: () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 16384));
      controller.enqueue(bytes.subarray(16384));
      controller.close();
    },
  }), { headers: { 'content-type': 'model/gltf-binary', 'etag': 'original-model' } }) });
  const response = await download.request(modelUrl);
  check(response.headers.get('etag') === 'original-model', 'Progress monitoring changed response headers');
  check(bytes.equals(Buffer.from(await response.arrayBuffer())), 'Progress monitoring changed model bytes');
  await download.settled();
  check(download.requested.filter(path => path === model.path).length === 1, 'Progress monitoring fetched a model twice');
  check(download.messages.every(message => message.clientId === 'female-tab' && message.snapshot === manifest.id && message.path === model.path), 'Progress leaked between tabs or versions');
  check(download.messages.some(message => message.phase === 'progress' && message.loaded === 16384), 'Streamed progress was not reported');
  check(download.messages.at(-1).phase === 'complete' && download.messages.at(-1).loaded === bytes.length, 'Download finished with the wrong byte count');
  const lost = worker(base, { [model.path]: null });
  check((await lost.request(modelUrl)).status === 404, 'Missing model status was hidden');
  await lost.settled();
  check(lost.messages.at(-1).phase === 'error', 'Missing model left the page waiting forever');
  const interrupted = worker(base, { [model.path]: () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('connection interrupted')); },
  })) });
  const broken = await interrupted.request(modelUrl, 'male-tab');
  await assert.rejects(broken.arrayBuffer());
  await interrupted.settled();
  check(interrupted.messages.at(-1).phase === 'error' && interrupted.messages.at(-1).clientId === 'male-tab', 'Stream failure was not reported to its tab');
  console.log(`Passed offline worker scenarios at ${base}`);
}
console.log(`${checks} behavioral assertions passed; no network or browser was used.`);
