/** Capture deliberately; verify offline. Normal builds NEVER refresh upstream data. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const snapshotRoot = fileURLToPath(new URL('../public/vendor/hra/', import.meta.url));
const API = 'https://apps.humanatlas.io/api';
const CDN = 'https://cdn.humanatlas.io';
const originalApi = 'basePath="https://apps.humanatlas.io/api"';
const localApi = 'basePath=globalThis.__cytolumeHraApiBase';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = data => Buffer.from(JSON.stringify(data, null, 2) + '\n');

function localPath(path) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..') || path.startsWith('/')) {
    throw new Error(`Unsafe snapshot path: ${path}`);
  }
  return resolve(snapshotRoot, path);
}

async function requiredOrgans() {
  const source = await readFile(new URL('../src/body/body-map.ts', import.meta.url), 'utf8');
  return [...new Set(source.match(/https:\/\/purl\.humanatlas\.io\/ref-organ\/[a-z-]+\/v[0-9.]+#primary/g))].sort();
}

/** Reject model files that could silently fetch textures, buffers, or codecs. */
export function inspectGlb(bytes, path) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`Invalid GLB v2: ${path}`);
  }
  if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Missing GLB JSON: ${path}`);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  for (const asset of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
    if (asset.uri && !asset.uri.startsWith('data:')) throw new Error(`External model dependency: ${path}: ${asset.uri}`);
  }
  const codecs = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];
  if ((gltf.extensionsUsed ?? []).some(x => codecs.includes(x))) {
    throw new Error(`A decoder must be vendored before accepting this GLB: ${path}`);
  }
  return gltf;
}

async function download(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function pool(items, work, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

async function capture() {
  const capturedAt = new Date().toISOString();
  const files = [];
  async function save(path, bytes, source, upstreamBytes = bytes, changes) {
    await mkdir(dirname(localPath(path)), { recursive: true });
    await writeFile(localPath(path), bytes);
    const record = { path, bytes: bytes.length, sha256: sha256(bytes) };
    if (source) Object.assign(record, { source, upstreamSha256: sha256(upstreamBytes) });
    if (changes) record.changes = changes;
    files.push(record);
  }

  const ids = await requiredOrgans();
  const [referenceRaw, sceneRaw, scriptRaw] = await Promise.all([
    download(`${API}/v1/reference-organs`),
    download(`${API}/v1/scene`),
    download(`${CDN}/ui/ccf-body-ui-wc/wc.js`),
  ]);
  const references = JSON.parse(referenceRaw);
  const scene = JSON.parse(sceneRaw);
  const script = scriptRaw.toString();
  if (script.split(originalApi).length !== 2) {
    throw new Error('Upstream component changed: review its API initialization before refreshing.');
  }
  await save('wc.js', Buffer.from(script.replace(originalApi, localApi)), `${CDN}/ui/ccf-body-ui-wc/wc.js`, scriptRaw,
    'Replace exactly one API basePath initializer with globalThis.__cytolumeHraApiBase. No other component edits.');
  // Keep the upstream original too: rebuilding the small local patch is offline.
  await save('upstream/wc.js', scriptRaw, `${CDN}/ui/ccf-body-ui-wc/wc.js`);
  await pool([
    ['styles.css', `${CDN}/ui/ccf-body-ui-wc/styles.css`],
    ['licenses/hra-ui-MIT.txt', 'https://raw.githubusercontent.com/hubmapconsortium/hra-ui/main/LICENSE'],
    ['licenses/third-party.txt', `${CDN}/ui/ccf-body-ui-wc/3rdpartylicenses.txt`],
    ['licenses/CC-BY-4.0.txt', 'https://creativecommons.org/licenses/by/4.0/legalcode.txt'],
  ], async ([path, url]) => save(path, await download(url), url));

  const models = [];
  const modelPaths = new Map();
  await pool(ids, async iri => {
    const organ = references.find(x => x['@id'] === iri);
    if (!organ?.object?.file) throw new Error(`Upstream lost the pinned organ: ${iri}`);
    const match = iri.match(/\/ref-organ\/([^/]+)\/(v[0-9.]+)#/);
    const [, name, version] = match;
    const path = `models/${name}-${version}.glb`;
    const metadataPath = `metadata/${name}-${version}.jsonld`;
    const metadataUrl = `${CDN}/digital-objects/ref-organ/${name}/${version}/metadata.jsonld`;
    const [bytes, metadata] = await Promise.all([download(organ.object.file), download(metadataUrl)]);
    inspectGlb(bytes, path);
    JSON.parse(metadata); // Refuse an HTML error document masquerading as metadata.
    await save(path, bytes, organ.object.file);
    await save(metadataPath, metadata, metadataUrl);
    modelPaths.set(organ.object.file, path);
    models.push({ iri, sex: organ.sex.toLowerCase(), path, metadata: metadataPath, version, source: organ.object.file });
    console.log(`Captured ${name} ${version} (${(bytes.length / 1048576).toFixed(1)} MiB)`);
  });

  const wanted = new Set(ids);
  const localReferences = references.filter(x => wanted.has(x['@id'])).map(x => ({
    ...x, object: { ...x.object, file: modelPaths.get(x.object.file) },
  }));
  const localScene = nodes => nodes.filter(x => x.scenegraph && wanted.has(x.reference_organ)).map(x => {
    const path = modelPaths.get(x.scenegraph);
    if (!path) throw new Error(`Scene references an uncaptured model: ${x.scenegraph}`);
    return { ...x, scenegraph: path };
  });
  await save('data/reference-organs.json', jsonBytes(localReferences), `${API}/v1/reference-organs`, referenceRaw,
    'Keep the reference organs used by body-map.ts; replace model URLs with snapshot-relative paths.');
  await save('data/scene.json', jsonBytes(localScene(scene)), `${API}/v1/scene`, sceneRaw,
    'Keep supported reference-organ scenegraphs only (omit tissue-block cuboids); use snapshot-relative model paths.');

  // Selecting skin makes the upstream component use the single-organ endpoint.
  const singleOrganScenes = {};
  for (const sex of ['female', 'male']) {
    const organ = references.find(x => x['@id'].includes(`/skin-${sex}/`) && wanted.has(x['@id']));
    const url = new URL(`${API}/v1/reference-organ-scene`);
    url.searchParams.set('organ-iri', organ.representation_of);
    url.searchParams.set('ontology-terms', JSON.stringify([organ.reference_organ]));
    url.searchParams.set('sex', sex);
    const raw = await download(url.href);
    const path = `data/skin-${sex}-scene.json`;
    const nodes = localScene(JSON.parse(raw));
    if (!nodes.some(x => x.reference_organ === organ['@id'])) throw new Error(`Empty ${sex} skin scene`);
    await save(path, jsonBytes(nodes), url.href, raw, 'Keep supported scenegraphs; use snapshot-relative model paths.');
    singleOrganScenes[organ['@id']] = path;
  }

  const attribution = `Cytolume — local Human Reference Atlas snapshot\n\nCaptured: ${capturedAt}\n\nComponent: HuBMAP HRA UI, Copyright (c) 2023 HuBMAP Consortium, MIT.\nSource: https://github.com/hubmapconsortium/hra-ui\nUpstream and patched component bytes are both included. The only patch changes the\nAPI base URL to the local static adapter. Full component and dependency licenses\nare in licenses/hra-ui-MIT.txt and licenses/third-party.txt.\n\nAnatomical models and scene data: Human Reference Atlas / HuBMAP, CC BY 4.0.\nhttps://humanatlas.io/3d-reference-library\nhttps://creativecommons.org/licenses/by/4.0/\nFull license: licenses/CC-BY-4.0.txt\n\nModel geometry is unchanged. Scene data is restricted to the reference organs used\nby this demo, tissue-block cuboids are omitted, and model URLs are made local.\nEach original metadata file in metadata/ preserves that object's creators, DOI,\nlicense and provenance. snapshot.json records source URLs, versions and SHA-256.\n\nThe demo's cell-type-to-organ assignments are SYNTHETIC, not biological evidence.\n\nPinned objects (source identifiers are citations, not runtime network requests):\n${models.sort((a, b) => a.iri.localeCompare(b.iri)).map(x => `${x.iri}\n  Metadata / creators / DOI: ${x.metadata}`).join('\n')}\n`;
  await save('ATTRIBUTION.txt', Buffer.from(attribution));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const id = sha256(jsonBytes(files.map(({ path, sha256 }) => ({ path, sha256 })))).slice(0, 20);
  const manifest = {
    schemaVersion: 1, id, capturedAt,
    description: 'Committed, self-contained HRA body-panel snapshot. Builds verify; refresh is manual.',
    component: { script: 'wc.js', stylesheet: 'styles.css', original: 'upstream/wc.js' },
    data: { references: 'data/reference-organs.json', scene: 'data/scene.json', singleOrganScenes },
    models, files,
  };
  await writeFile(localPath('snapshot.json'), jsonBytes(manifest));
  await verifySnapshot();
}

export async function verifySnapshot() {
  const manifest = JSON.parse(await readFile(localPath('snapshot.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported HRA snapshot');
  const paths = new Set();
  let total = 0;
  for (const record of manifest.files) {
    if (paths.has(record.path)) throw new Error(`Duplicate snapshot path: ${record.path}`);
    paths.add(record.path);
    const bytes = await readFile(localPath(record.path));
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`Snapshot checksum mismatch: ${record.path}`);
    if (record.path.endsWith('.glb')) inspectGlb(bytes, record.path);
    total += bytes.length;
  }
  const id = sha256(jsonBytes(manifest.files.map(({ path, sha256 }) => ({ path, sha256 })))).slice(0, 20);
  if (id !== manifest.id) throw new Error('Snapshot manifest ID mismatch');
  const original = await readFile(localPath(manifest.component.original), 'utf8');
  const patched = await readFile(localPath(manifest.component.script), 'utf8');
  if (original.split(originalApi).length !== 2 || original.replace(originalApi, localApi) !== patched) {
    throw new Error('Vendored component differs from the documented local-API patch');
  }
  const byId = new Map(manifest.models.map(x => [x.iri, x]));
  for (const iri of await requiredOrgans()) {
    if (!byId.has(iri)) throw new Error(`body-map.ts uses an uncaptured organ: ${iri}`);
  }
  const references = JSON.parse(await readFile(localPath(manifest.data.references), 'utf8'));
  for (const model of manifest.models) {
    if (!paths.has(model.path) || !paths.has(model.metadata)) throw new Error(`Missing model resources: ${model.iri}`);
    if (!references.some(x => x['@id'] === model.iri && x.object.file === model.path)) throw new Error(`Missing reference record: ${model.iri}`);
  }
  for (const path of [manifest.data.scene, ...Object.values(manifest.data.singleOrganScenes)]) {
    if (!paths.has(path)) throw new Error(`Unverified scene: ${path}`);
    const nodes = JSON.parse(await readFile(localPath(path), 'utf8'));
    if (!nodes.length) throw new Error(`Empty scene: ${path}`);
    for (const node of nodes) {
      if (!paths.has(node.scenegraph) || !byId.has(node.reference_organ)) throw new Error(`Uncaptured scene dependency: ${path}`);
      if (node.transformMatrix?.length !== 16 || !node.transformMatrix.every(Number.isFinite)) throw new Error(`Invalid transform: ${path}`);
    }
  }
  console.log(`HRA snapshot ${manifest.id}: ${manifest.models.length} models, ${paths.size} files, ${(total / 1048576).toFixed(1)} MiB; all SHA-256 checks passed (no network).`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--refresh') await capture();
  else if (mode === '--verify') await verifySnapshot();
  else { console.error('Usage: node scripts/hra-snapshot.mjs --verify | --refresh'); process.exitCode = 1; }
}
