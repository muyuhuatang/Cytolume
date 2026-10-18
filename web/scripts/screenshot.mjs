/*
 * Headless screenshot harness for the Cytolume showcase.
 *
 * Cytolume is a WebGL app — an agent (or CI) can't open a browser window, so
 * "see the demo" means driving headless Chromium/Edge against the dev server and
 * producing screenshots. Uses playwright-core with the system Edge channel (no
 * browser download); on this dev machine that yields real GPU WebGL via ANGLE.
 *
 * Usage:
 *   npm run dev            # in one terminal
 *   npm run shot           # in another → writes screenshots/ + prints diagnostics
 *
 * Env: URL (default http://localhost:5173/), OUT (default ./screenshots),
 *      CHANNEL (msedge | chrome), HEADFUL=1 to watch it run.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const URL = process.env.URL || "http://localhost:5173/"; // vite default
const OUT = process.env.OUT || "screenshots";
const CHANNEL = process.env.CHANNEL || "msedge";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: CHANNEL,
  headless: !process.env.HEADFUL,
  args: [
    "--no-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-gpu",
    "--enable-unsafe-swiftshader", // WebGL fallback when no HW GPU is present
    "--use-angle=default",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("#stage", { timeout: 10000 });
await page.waitForTimeout(2000);

const webgl = await page.evaluate(() => {
  const c = document.getElementById("stage");
  const gl =
    c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
  if (!gl) return { ok: false, reason: "no WebGL context" };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return { ok: true, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "(masked)" };
});
const readout = await page.evaluate(() => ({
  count: document.getElementById("count")?.textContent,
  fps: document.getElementById("fps")?.textContent,
}));

await page.screenshot({ path: `${OUT}/continuous-magma.png` });

await page.selectOption("#cmap", "viridis");
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/continuous-viridis.png` });

await page.selectOption("#mode", "categorical");
await page.dispatchEvent("#mode", "change");
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/categorical.png` });

console.log(JSON.stringify({ webgl, readout, consoleErrors, out: OUT }, null, 2));
await browser.close();
