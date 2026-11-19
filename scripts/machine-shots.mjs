// The machine dashboard's pictures for the README (docs/screens/*-machine*.jpg), from a running hub with the
// dashboard on. The tool call lists (latest and running) are left out: commands can carry paths and secrets.
//   npm run screens:machine -- http://localhost:4199/ <token> [session-with-a-workflow]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [base = 'http://localhost:4199/', token = process.env.HITL_TOKEN ?? '', session = ''] = process.argv.slice(2);
const out = path.resolve('docs/screens');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = {
  desktop: await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }),
  phone: await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
};
if (token) for (const c of Object.values(ctx)) await (await c.newPage()).goto(base + '?token=' + token);
const to = (sel, above = 120) => (p) => p.evaluate(([s, a]) => scrollTo(0, document.querySelector(s).getBoundingClientRect().top + scrollY - a), [sel, above]);
const shots = [
  ['desktop', 'machine', '#/machine?r=1h'],
  ['desktop', 'machine-claude', '#/machine?r=30d', to('#m-claude')],
  ['desktop', 'machine-tokens', '#/machine?r=30d', to('#c-tok-in', 150)],
  ['desktop', 'machine-heat', '#/machine?r=30d', to('#c-models', 150)],
  ['desktop', 'machine-tools', '#/machine?r=30d', to('#m-tools')],
  ...(session ? [['desktop', 'machine-session', `#/machine/s/${encodeURIComponent(session)}?r=30d`, to('.mach-tree', 160)]] : []),
  ['phone', 'machine', '#/machine?r=1h'],
];
for (const [size, name, hash, then] of shots) {
  const page = await ctx[size].newPage();
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  // the tool call lists show the commands themselves: not in the pictures
  await page.evaluate(() => ['c-recent', 'c-running', 'c-srun'].forEach((id) => document.getElementById(id)?.closest('.mach-card')?.remove()));
  // the tool calls graph takes the room the running list left
  await page.evaluate(() => {
    document.getElementById('c-tcalls')?.closest('.mach-card')?.classList.add('wide');
    dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(400);
  if (then) await then(page);
  await page.waitForTimeout(600);
  const file = path.join(out, `${size}-${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  await page.close();
  console.log(file);
}
await browser.close();
