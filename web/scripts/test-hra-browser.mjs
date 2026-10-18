/** Real-browser check of the body panel with outside HTTP blocked, at / and /Cytolume/. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { verifySnapshot } from './hra-snapshot.mjs';

await verifySnapshot();
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'screenshots/hra-offline');
await mkdir(output, { recursive: true });

// A small fixture serves the actual TypeScript panel without a Vite subprocess.
// It also permits checking a Pages subpath without a second production build.
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const base = pathname.startsWith('/Cytolume/') ? '/Cytolume/' : '/';
    const path = pathname.slice(base.length);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:");
    if (!path) {
      response.setHeader('content-type', 'text/html');
      return response.end(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Local HRA verification</title><link rel="stylesheet" href="${base}src/body/body-panel.css"></head><body><script type="module" src="${base}test-body-entry.js"></script></body></html>`);
    }
    if (path === 'test-body-entry.js') {
      response.setHeader('content-type', 'text/javascript');
      return response.end(`import { BodyPanel } from '${base}src/body/body-panel.ts'; window.panel = new BodyPanel();`);
    }
    if (path === 'favicon.ico') { response.writeHead(204); return response.end(); }
    const file = resolve(root, path.startsWith('src/') ? path : `public/${path}`);
    if (relative(root, file).startsWith('..')) throw new Error('Invalid fixture path');
    let data = await readFile(file);
    let mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.txt': 'text/plain' }[extname(file)] ?? 'application/octet-stream';
    if (file.endsWith('.ts')) {
      data = ts.transpileModule(data.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
        .replaceAll('import.meta.env.BASE_URL', JSON.stringify(base));
      mime = 'text/javascript';
    }
    response.setHeader('content-type', mime);
    response.end(data);
  } catch (error) { response.writeHead(404); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Count rendered anatomy, excluding the flat background and a black failed canvas. */
function paintedPixels(png) {
  const chunks = [];
  let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[12], 0);
      channels = { 2: 3, 6: 4 }[data[9]]; assert.ok(channels, 'Expected RGB/RGBA screenshot');
    }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels, pixels = new Uint8Array(height * stride);
  let input = 0, ink = 0;
  const colors = new Set();
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? pixels[i - channels] : 0;
      const b = y ? pixels[i - stride] : 0, c = y && x >= channels ? pixels[i - stride - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      assert.notEqual(predictor, undefined);
      pixels[i] = (raw[input++] + predictor) & 255;
    }
  }
  for (let i = 0; i < pixels.length; i += channels) {
    const [r, g, b] = pixels.subarray(i, i + 3);
    const fromBackground = Math.abs(r - 238) + Math.abs(g - 240) + Math.abs(b - 243);
    if (fromBackground > 35 && Math.max(r, g, b) > 25) {
      ink++; colors.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
    }
  }
  return { ink, colors: colors.size };
}

async function expectPainted(page, name) {
  await page.waitForFunction(() => document.querySelector('.cyto-body-status')?.hidden, null, { timeout: 60000 });
  const deadline = Date.now() + 60000;
  let stats;
  do {
    const png = await page.locator('.cyto-body-stage').screenshot();
    stats = paintedPixels(png);
    if (stats.ink > 600 && stats.colors > 20) {
      await page.locator('.cyto-body').screenshot({ path: resolve(output, `${name}.png`) });
      return stats;
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  throw new Error(`Body canvas did not paint anatomy: ${name}: ${JSON.stringify(stats)}`);
}

let browser;
try {
  browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
  for (const base of ['/', '/Cytolume/']) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 850 }, serviceWorkers: 'allow' });
    const errors = [], outside = [], badResponses = [], completedModels = new Set();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.protocol.startsWith('http') && url.origin !== origin) { outside.push(url.href); return route.abort(); }
      return route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http') && url.origin !== origin) outside.push(url.href);
    });
    context.on('response', response => {
      if (!response.ok()) badResponses.push(`${response.status()} ${response.url()}`);
      if (response.ok() && response.url().endsWith('.glb')) completedModels.add(response.url());
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    const prefix = base === '/' ? 'root' : 'pages';
    await page.goto(origin + base);
    await page.waitForFunction(() => window.panel?.isReady || window.panel?.isFailed, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.panel.isFailed), false, 'Local panel initialization failed');
    for (const sex of ['female', 'male']) {
      await page.evaluate(sex => window.panel.setSex(sex), sex);
      for (const organ of ['lung', 'heart', 'skin']) {
        await page.evaluate(organ => window.panel.highlight(organ), organ);
        // Allow the upstream scene-rebuild kick to finish before checking the frame.
        await page.waitForTimeout(2800);
        const stats = await expectPainted(page, `${prefix}-${sex}-${organ}`);
        const state = await page.evaluate(() => ({ ready: window.panel.isReady, selected: window.panel.highlightedId, caption: document.querySelector('.cyto-body-caption')?.textContent }));
        assert.equal(state.ready, true); assert.equal(state.selected, organ);
        assert.ok(state.caption.startsWith('Demo link:'));
        console.log(`${base} ${sex} ${organ}: ${JSON.stringify(stats)}`);
      }
    }
    await page.reload();
    await page.waitForFunction(() => window.panel?.isReady, null, { timeout: 60000 });
    await expectPainted(page, `${prefix}-reload`);
    assert.deepEqual(outside, [], 'The panel attempted outside HTTP');
    assert.deepEqual(errors, [], 'Uncaught browser errors');
    assert.deepEqual(badResponses, [], 'A snapshot resource or static API request failed');
    assert.ok(completedModels.size >= 6, 'Female/male skin, lung and heart models were not all loaded');
    await context.close();
  }
  console.log(`Body rendering and local-only requests passed at both bases. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
