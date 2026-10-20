/** Capture the live showcase in Chrome, then publish an authentic README GIF + PNG.
 * Run from web/: node scripts/capture-readme.mjs --headful
 * Requires installed playwright-core, Google Chrome, Python and Pillow.
 * --repo chooses the repository receiving the assets (default: this checkout).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: 'string', default: resolve(webRoot, '..') },
  url: { type: 'string', default: 'https://muyuhuatang.github.io/Cytolume/' },
  headful: { type: 'boolean', default: false },
  width: { type: 'string', default: '1120' },
} });
const repo = resolve(values.repo);
const readmePath = resolve(repo, 'README.md');
const readme = await readFile(readmePath, 'utf8');
const heroPattern = /!\[[^\]]*\]\(media\/01-hero-(?:3d-glow\.png|light-anatomy\.gif)\)/;
assert.ok(heroPattern.test(readme), `Cannot identify the README hero in ${readmePath}`);
const width = Number(values.width);
assert.ok(Number.isInteger(width) && width >= 800 && width <= 1280, '--width must be between 800 and 1280');

const python = process.env.PYTHON || 'python';
const encoder = fileURLToPath(new URL('./encode-readme-gif.py', import.meta.url));
function runPython(args) {
  const result = spawnSync(python, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Python encoding failed');
  return result.stdout.trim();
}
console.log(`Encoder: ${runPython(['-c', 'import PIL; print("Pillow " + PIL.__version__)'])}`);

const pageUrl = new URL(values.url);
assert.ok(['http:', 'https:'].includes(pageUrl.protocol), 'Use an HTTP(S) website URL');
for (const [key, value] of Object.entries({ view: '3d', layout: 'umap3d', theme: 'light', motion: 'off', spin: 'off', sex: 'female' })) {
  pageUrl.searchParams.set(key, value);
}
const captureId = new Date().toISOString().replace(/[:.]/g, '-');
const scratch = resolve(webRoot, 'screenshots', `readme-${captureId}`);
await mkdir(scratch, { recursive: true });
const fps = 10, frameCount = 80;
const viewport = { width: 1280, height: 820 };
const framePaths = [];
let browser, recording;
try {
  console.log('Opening an isolated Google Chrome session...');
  browser = await chromium.launch({
    channel: 'chrome', headless: !values.headful, chromiumSandbox: true,
    args: ['--ignore-gpu-blocklist', '--enable-gpu'],
  });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Waiting for cell data and the anatomy models (the first download can take a few minutes)...');
  await page.waitForFunction(() => window.__r3d?.state().hasData && window.__r3d.state().count > 400000, null, { timeout: 180000 });
  await page.locator('#guide-dismiss').click();
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForFunction(() => window.__r3d?.bodyReady() || window.__r3d?.bodyFailed(), null, { timeout: 180000 });
  const selected = await page.evaluate(() => {
    const app = window.__r3d;
    if (app.bodyFailed()) throw new Error('Anatomy initialization failed');
    app.setTheme('light'); app.setMode('continuous'); app.setMotion('off'); app.setSpin(false);
    for (let id = 0; id < app.state().count; id++) {
      const cell = app.getCell(id);
      if (cell && app.getBodyNodeId(cell.cellType) === 'lung') {
        return { id, organ: app.selectCell(id) };
      }
    }
    throw new Error('No cell with a demo lung association was found');
  });
  assert.equal(selected.organ, 'lung');
  await page.waitForFunction(() => window.__r3d.bodyFailed() || document.querySelector('.cyto-body-status')?.hidden, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.__r3d.bodyFailed()), false, 'Anatomy model download failed');
  // Allow GLB parsing and the existing scene-rebuild kick to settle after download.
  await page.waitForTimeout(4000);
  await page.mouse.move(1260, 12);
  const bodyBox = await page.locator('.cyto-body-stage').boundingBox();
  assert.ok(bodyBox && bodyBox.width > 100 && bodyBox.height > 100, 'Anatomy panel is not visible');
  const pose = await page.evaluate(() => Array.from(window.__r3d.camera.rotation));
  console.log(`Capturing ${frameCount} Chrome frames with the lung selected...`);
  for (let index = 0; index < frameCount; index++) {
    // Use the app's own camera controls. A bounded orbit returns smoothly to the
    // initial pose; every frame is rendered by the live page, with the full UI intact.
    const phase = 2 * Math.PI * index / frameCount;
    await page.evaluate(async ({ pose, dx, dy }) => {
      const app = window.__r3d;
      if (app.bodyFailed() || !document.querySelector('.cyto-body-status')?.hidden) throw new Error('Anatomy became unavailable during capture');
      app.camera.setRotation(pose);
      app.camera.rotateByPixels(dx, dy);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { pose, dx: -Math.sin(phase) * 35, dy: -(1 - Math.cos(phase)) * 4 });
    const path = resolve(scratch, `frame-${String(index).padStart(3, '0')}.png`);
    await page.screenshot({ path, animations: 'disabled', type: 'png' });
    framePaths.push(path);
    if ((index + 1) % 20 === 0) console.log(`Captured ${index + 1}/${frameCount}`);
  }
  assert.deepEqual(errors, [], 'The live page reported JavaScript errors');
  recording = {
    capturedAt: new Date().toISOString(), sourceUrl: pageUrl.href,
    browser: browser.version(), viewport, fps, frameCount, selectedCell: selected,
    bodyBox, files: framePaths,
    page: await page.evaluate(() => ({
      count: window.__r3d.state().count, theme: window.__r3d.getTheme(),
      layout: window.__r3d.activeLayout(), bodyLabel: document.querySelector('.cyto-body-caption')?.textContent,
      scripts: [...document.scripts].map(script => script.src).filter(Boolean),
    })),
  };
} finally { await browser?.close(); }

assert.equal(recording.page.theme, 'light');
const capturePath = resolve(scratch, 'capture.json');
await writeFile(capturePath, JSON.stringify(recording, null, 2) + '\n');
const encodedPath = resolve(scratch, 'hero.gif');
const stats = JSON.parse(runPython([encoder, capturePath, encodedPath, '--width', String(width)]));
console.log(`GIF verified: ${stats.frames} frames, ${stats.width} x ${stats.height}, ${(stats.bytes / 1048576).toFixed(2)} MiB`);

// Update the README only after the encoder has verified anatomy in every frame.
const assetName = '01-hero-light-anatomy';
const replacement = `![Cytolume in light mode with a rotating 3D cell map and HRA lung anatomy](media/${assetName}.gif)`;
const currentReadme = await readFile(readmePath, 'utf8');
assert.ok(heroPattern.test(currentReadme), 'The README hero changed during recording; review the captured files before updating it.');
let nextReadme = currentReadme.replace(heroPattern, replacement);
const stillLink = `[View the full-size still image](media/${assetName}.png)`;
if (!nextReadme.includes(stillLink)) nextReadme = nextReadme.replace(replacement, `${replacement}\n\n${stillLink}`);

const destinations = [repo];
const { files, bodyBox, ...publicRecord } = recording;
void files; void bodyBox;
for (const destination of destinations) {
  const media = resolve(destination, 'media');
  await mkdir(media, { recursive: true });
  await copyFile(encodedPath, resolve(media, `${assetName}.gif`));
  await copyFile(framePaths[0], resolve(media, `${assetName}.png`));
  await writeFile(resolve(media, `${assetName}.json`), JSON.stringify({ ...publicRecord, encoding: stats }, null, 2) + '\n');
  const targetReadme = resolve(destination, 'README.md');
  let exists = true;
  try { await access(targetReadme); } catch { exists = false; }
  if (exists) await writeFile(targetReadme, nextReadme);
}
console.log(`README updated: ${readmePath}`);
console.log(`GIF: ${resolve(repo, 'media', `${assetName}.gif`)}`);
console.log('Capture complete. Review the GIF before committing and pushing.');
