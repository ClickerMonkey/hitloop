// The machine dashboard's pictures for the README (docs/screens/*-machine*.jpg), from a running hub with the
// dashboard on. The tool call lists (latest and running) are left out: commands can carry paths and secrets.
//   npm run screens:machine -- http://localhost:4199/ <token> [session-with-a-workflow]
// The session and conversation pictures come from a made-up Claude home, so nothing real is in them:
//   node scripts/demo-claude.mjs .demo/claude; HITL_HOME=.demo/home CLAUDE_CONFIG_DIR=.demo/claude node dist/cli.js -p 4320 -H 127.0.0.1
//   SHOTS=session,chat,agent npm run screens:machine -- http://localhost:4320/ '' 5d1c0a52-7be4-4d52-9a0b-3a6f8f0c2b11
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
// the session pages, best from the made-up home (node scripts/demo-claude.mjs): its conversations are harmless
const open = (sel, n = 0) => (p) => p.evaluate(([q, i]) => { const e = document.querySelectorAll(q)[i]; if (e) e.open = true; }, [sel, n]);
const mid = (sel, n = 0) => (p) => p.evaluate(([q, i]) => document.querySelectorAll(q)[i]?.scrollIntoView({ block: 'center' }), [sel, n]);
const sessionShots = (s) => {
  const h = (tail) => `#/machine/s/${encodeURIComponent(s)}${tail}`;
  return [
    // finished workflows start folded, the newest first
    ['desktop', 'machine-session', h('?r=30d'), to('.mach-tree', 160)],
    ['desktop', 'machine-session-open', h('?r=30d'), async (p) => { await p.evaluate(() => document.querySelector('.mach-wf.is-folded .mach-fold')?.click()); await to('.mach-tree', 160)(p); }],
    ['desktop', 'machine-chat', h('/c'), async (p) => { await open('.chat-tool', 0)(p); await p.evaluate(() => scrollTo(0, 0)); }],
    ['desktop', 'machine-chat-image', h('/c'), async (p) => { await mid('.chat-img')(p); await p.waitForSelector('.chat-img img', { timeout: 8000 }); await mid('.chat-img')(p); await p.waitForTimeout(500); }],
    ['desktop', 'machine-chat-error', h('/c'), async (p) => { await p.evaluate(() => document.querySelector('.chat-tool.is-error')?.setAttribute('open', '')); await mid('.chat-tool.is-error')(p); }],
    ['desktop', 'machine-agent', h('/a/agent-review0a'), open('.chat-tool', 0)],
    ['phone', 'machine-chat', h('/c'), async (p) => { await open('.chat-tool', 0)(p); await p.evaluate(() => scrollTo(0, 0)); }],
  ];
};
// a real computer's pictures never show its host name, session titles, project names or branches: they're swapped
// for made-up ones in the page, and again whenever the page redraws
const anonymise = () => {
  const titles = ['Add a pear-picking game', 'Fix the flaky timer test', 'Why is the build slow?', 'Review the inbox layout', 'Update the README pictures', 'Polish the settings page', 'Pick artwork for the pears', 'Tidy the score animation'];
  const projects = ['orchard', 'website', 'api', 'docs', 'scripts', 'notes', 'tools', 'demo'];
  const set = (el, t) => el.textContent !== t && (el.textContent = t);
  const run = () => {
    document.querySelectorAll('.mach-table td:first-child a b').forEach((b, i) => set(b, titles[i % titles.length]));
    document.querySelectorAll('.mach-table td:first-child small').forEach((sm) => {
      const parts = sm.textContent.split(' · ');
      const model = /opus|sonnet|haiku/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : '';
      set(sm, ['orchard', 'main', model].filter(Boolean).join(' · '));
    });
    document.querySelectorAll('#c-projects .viz-bar-label').forEach((l, i) => set(l, projects[i % projects.length]));
    document.querySelectorAll('#c-projects .viz-bar-row').forEach((l, i) => l.setAttribute('title', projects[i % projects.length]));
    document.querySelectorAll('.mach-title p').forEach((e) => set(e, e.textContent.replace(/^[^·]*·/, 'workstation ·')));
  };
  run();
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true, characterData: true });
};
const shots = [
  ['desktop', 'machine', '#/machine?r=1h'],
  ['desktop', 'machine-claude', '#/machine?r=30d', to('#m-claude')],
  ['desktop', 'machine-tokens', '#/machine?r=30d', to('#c-tok-in', 150)],
  ['desktop', 'machine-heat', '#/machine?r=30d', to('#c-models', 150)],
  ['desktop', 'machine-tools', '#/machine?r=30d', to('#m-tools')],
  ...(session ? sessionShots(session) : []),
  ['phone', 'machine', '#/machine?r=1h'],
];
// SHOTS=session,chat only takes the pictures whose names contain one of these
const only = (process.env.SHOTS ?? '').split(',').filter(Boolean);
for (const [size, name, hash, then] of shots) {
  if (only.length && !only.some((o) => (o.startsWith('=') ? name === o.slice(1) : name.includes(o)))) continue;
  const page = await ctx[size].newPage();
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.waitForTimeout(hash.includes('/c') || hash.includes('/a/') ? 5000 : 3500);
  if (!hash.includes('/s/')) await page.evaluate(anonymise);
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
