/*
 * Static adapter for the pinned HRA body component. Every response comes from
 * public/vendor/hra; this worker NEVER fetches an upstream API or CDN. The web
 * component still uses its normal HTTP client, so Angular receives real Responses.
 * registration.scope makes the same files work at / and at /Cytolume/ on Pages.
 */
const ROOT = new URL('vendor/hra/', self.registration.scope);
const API_PATH = new URL('api/v1/', ROOT).pathname;
const snapshotId = new URL(self.location.href).searchParams.get('snapshot');
const clientSex = new Map();
let snapshotPromise;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function localUrl(path) {
  const url = new URL(path, ROOT);
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) {
    throw new Error(`Nonlocal HRA resource refused: ${path}`);
  }
  return url;
}

async function readLocal(path) {
  const res = await fetch(localUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Missing local HRA resource: ${path} (${res.status})`);
  return res.json();
}

function snapshot() {
  snapshotPromise ??= readLocal('snapshot.json').then(value => {
    if (value.schemaVersion !== 1 || value.id !== snapshotId) throw new Error('HRA snapshot version mismatch; reload after deployment');
    return value;
  }).catch(error => { snapshotPromise = undefined; throw error; });
  return snapshotPromise;
}

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || data.type !== 'cyto:hra-init') return;
  event.waitUntil((async () => {
    try {
      const manifest = await snapshot();
      if (data.snapshot !== manifest.id) throw new Error('Page and worker use different HRA snapshots');
      if (!event.source?.id) throw new Error('HRA snapshot requires a page client');
      if (data.sex !== 'female' && data.sex !== 'male') throw new Error('Invalid body sex');
      clientSex.set(event.source.id, data.sex);
      await self.clients.claim();
      event.ports[0]?.postMessage({ ok: true, snapshot: manifest.id });
    } catch (error) {
      event.ports[0]?.postMessage({ ok: false, error: String(error) });
    }
  })());
});

async function sexFor(clientId) {
  const saved = clientSex.get(clientId);
  if (saved) return saved;
  // Workers may restart at any time. Recover from the page URL and keep tabs independent.
  const client = await self.clients.get(clientId);
  if (!client) throw new Error('Cannot identify the HRA page client');
  return new URL(client.url).searchParams.get('sex') === 'male' ? 'male' : 'female';
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-cytolume-hra-snapshot': snapshotId ?? '' },
  });
}

async function serveApi(event, url) {
  if (event.request.method !== 'GET') return jsonResponse({ error: 'The offline HRA adapter is read-only' }, 405);
  const manifest = await snapshot();
  const endpoint = url.pathname.slice(API_PATH.length);
  if (endpoint === 'reference-organs') {
    const records = await readLocal(manifest.data.references);
    return jsonResponse(records.map(record => ({ ...record, object: { ...record.object, file: localUrl(record.object.file).href } })));
  }
  const sex = await sexFor(event.clientId);
  let path;
  if (endpoint === 'scene') path = manifest.data.scene;
  else if (endpoint === 'reference-organ-scene') {
    // The component requests this only when both placements target skin.
    const terms = url.searchParams.getAll('ontology-terms').flatMap(term => {
      try { const parsed = JSON.parse(term); return Array.isArray(parsed) ? parsed : [parsed]; }
      catch { return [term]; }
    });
    const model = manifest.models.find(x => x.sex === sex && terms.includes(x.iri));
    path = model && manifest.data.singleOrganScenes[model.iri];
    if (!path) return jsonResponse({ error: 'This organ scene is not included in the pinned snapshot' }, 404);
  } else return jsonResponse({ error: `Unsupported offline HRA endpoint: ${endpoint}` }, 404);

  const nodes = await readLocal(path);
  return jsonResponse(nodes.filter(node => String(node.sex).toLowerCase() === sex).map(node => ({
    ...node, scenegraph: localUrl(node.scenegraph).href,
  })));
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === ROOT.origin && url.pathname.startsWith(API_PATH)) {
    event.respondWith(serveApi(event, url).catch(error => jsonResponse({ error: String(error) }, 503)));
    return;
  }
  // Fail locally if an old component or an unvendored decoder tries an upstream URL.
  const upstream = /(^|\.)humanatlas\.io$/.test(url.hostname) ||
    ['cdn.jsdelivr.net', 'unpkg.com', 'www.gstatic.com', 'hubmapconsortium.github.io'].includes(url.hostname);
  if (upstream && url.origin !== ROOT.origin) {
    event.respondWith(jsonResponse({ error: 'External HRA resources are disabled; use the committed snapshot' }, 502));
  }
});
