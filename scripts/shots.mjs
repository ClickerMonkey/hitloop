// Screenshots of a running hitl, for checking the look: node scripts/shots.mjs <base url> <out dir> [phone|desktop|both]
// Each page is taken at phone size (390 × 844) and/or desktop size (1440 × 900), and console errors are printed.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4321/';
const out = path.resolve(process.argv[3] ?? '.demo/shots');
const which = process.argv[4] ?? 'both';
const pages = (process.env.SHOTS ?? 'inbox=#/,project=#/p/trailhead,review=#/p/trailhead/r/retry-flaky-trail-lookups,approve=#/p/trailhead/r/deploy-trailhead-1-3-to-production,show=#/p/trailhead/r/screenshots-of-the-new-trail-page,questions=#/p/trailhead/q/weather-plan,files=#/p/trailhead/files/,file=#/p/trailhead/files/src/lib?open=retry.ts,changes=#/p/trailhead/files/?m=changes,notes=#/p/trailhead/notes,decisions=#/p/trailhead/decisions')
  .split(',')
  .map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const sizes = [];
if (which !== 'desktop') sizes.push(['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }]);
if (which !== 'phone') sizes.push(['desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }]);
for (const [size, opts] of sizes) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log(`[${size}] console: ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[${size}] error: ${e.message}`));
  for (const [name, hash] of pages) {
    await page.goto(base + hash, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const file = path.join(out, `${size}-${name}.png`);
    await page.screenshot({ path: file, fullPage: process.env.FULL === '1' });
    console.log(file);
  }
  await ctx.close();
}
await browser.close();
