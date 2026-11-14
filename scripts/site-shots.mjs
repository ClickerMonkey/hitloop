// The pictures on the site (docs/screens/): phone and desktop shots of a running hitl with the demo project in it.
//   node scripts/demo.mjs .demo/trailhead && HITL_HOME=.demo/home node dist/cli.js --solo .demo/trailhead --local --port 4321
//   node scripts/site-shots.mjs http://localhost:4321/
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4321/';
const out = path.resolve('docs/screens');
fs.mkdirSync(out, { recursive: true });
const P = '#/p/trailhead';
const shots = [
  ['phone', 'inbox', `${P}`],
  ['phone', 'review', `${P}/r/retry-flaky-trail-lookups`],
  ['phone', 'approve', `${P}/r/deploy-trailhead-1-3-to-production`, async (p) => p.evaluate(() => scrollTo(0, 260))],
  ['phone', 'questions', `${P}/q/weather-plan`, async (p) => p.evaluate(() => scrollTo(0, 330))],
  ['phone', 'compare', `${P}/r/retry-flaky-trail-lookups/the-trail-page-before-and-after`],
  ['phone', 'swipe', `${P}/r/retry-flaky-trail-lookups`, async (p) => {
    await p.click('[data-mode="swipe"]');
    await p.waitForTimeout(500);
    await p.evaluate(() => scrollTo(0, document.querySelector('.swipe-card').getBoundingClientRect().top + scrollY - 170));
  }],
  ['phone', 'notes', `${P}/notes`],
  ['phone', 'file', `${P}/files/src/lib?open=retry.ts`],
  ['desktop', 'review', `${P}/r/retry-flaky-trail-lookups`],
  ['desktop', 'files', `${P}/files/src?open=server.ts&tab=diff`],
  ['desktop', 'inbox', '#/'],
  ['desktop', 'decisions', `${P}/decisions`],
];
const browser = await chromium.launch();
const ctx = {
  phone: await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
  desktop: await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }),
};
// a hub with a token: open it once per context so the cookie is set
if (process.env.HITL_TOKEN) for (const c of Object.values(ctx)) await (await c.newPage()).goto(base + '?token=' + process.env.HITL_TOKEN);
for (const [size, name, hash, then] of shots) {
  const page = await ctx[size].newPage();
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  if (then) await then(page);
  await page.waitForTimeout(900);
  const file = path.join(out, `${size}-${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  await page.close();
  console.log(file);
}
await browser.close();
