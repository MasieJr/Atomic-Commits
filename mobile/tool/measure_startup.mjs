import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('Usage: node tool/measure_startup.mjs <app-url> [pairs]');
const pairs = Number(process.argv[3] ?? 5);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('pairs must be between 1 and 20');

const browser = await chromium.launch({
  executablePath: process.env.ATOMIC_BROWSER_EXE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
});
const samples = [];
try {
  for (let index = 0; index < pairs; index++) {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.addInitScript(() => {
      window.addEventListener('flutter-first-frame', () => {
        window.__atomicFirstFrame = performance.now();
      }, { once: true });
    });
    for (const mode of ['cold', 'warm']) {
      const before = errors.length;
      try {
        const response = mode === 'cold'
          ? await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
          : await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForFunction(() => Number.isFinite(window.__atomicFirstFrame), null, { timeout: 90_000 });
        const result = await page.evaluate(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource')
            .filter((entry) => entry.name.includes('main.dart.js'))
            .map((entry) => ({ durationMs: Math.round(entry.duration), transferBytes: entry.transferSize }));
          return {
            firstFrameMs: Math.round(window.__atomicFirstFrame),
            domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
            flutterViews: document.querySelectorAll('flutter-view').length,
            title: document.title,
            mainScript: resources,
          };
        });
        samples.push({ mode, pair: index + 1, status: response?.status(), ...result, errors: errors.slice(before) });
      } catch (error) {
        const pageState = await page.evaluate(() => ({
          readyState: document.readyState,
          title: document.title,
          flutterViews: document.querySelectorAll('flutter-view').length,
          loadedMainScript: performance.getEntriesByType('resource').some((entry) => entry.name.includes('main.dart.js')),
        })).catch(() => null);
        samples.push({ mode, pair: index + 1, error: String(error), pageState, errors: errors.slice(before) });
      }
    }
    await context.close();
  }
  console.log(JSON.stringify({ url, pairs, samples }, null, 2));
} finally {
  await browser.close();
}
