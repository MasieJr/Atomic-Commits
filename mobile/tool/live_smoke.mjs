import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.argv[2]);
if (url.protocol !== 'https:') throw new Error('The live application URL must use HTTPS.');
const browserPath = process.env.ATOMIC_BROWSER_EXE ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(response.status(), 200);
  await page.waitForSelector('flutter-view', { state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await page.locator('flt-semantics-placeholder').dispatchEvent('click');
  await page.getByText('Join the colony.', { exact: true }).last().waitFor({ timeout: 30_000 });
  const frame = await page.locator('.phone-frame').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, left: bounds.left };
  });
  assert.ok(frame.width < 430 && frame.left > 0, 'The desktop phone frame must be visible.');
  if (process.env.ATOMIC_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.ATOMIC_SMOKE_SCREENSHOT });
  await page.getByText('Sign up', { exact: true }).last().click();
  await page.getByText('Create an account', { exact: true }).last().waitFor({ timeout: 15_000 });
  if (process.env.ATOMIC_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.ATOMIC_SMOKE_SCREENSHOT });
  console.log('PASS: live HTTPS app loads the framed welcome and signup screens');
} finally {
  await browser.close();
}
