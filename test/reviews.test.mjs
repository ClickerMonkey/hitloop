// Reviews and showings (new in hitl), and what joins everything up: news, wait, decisions, the hub's review routes,
// the MCP server and the CLI. Runs against the built dist/ (npm test builds first).
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

// a hang (a stuck git or child process) fails its test instead of the whole run
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

// never the real ~/.config/hitl: set before anything reads the config
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-r-')));
const home = path.join(tmp, 'home');
process.env.HITL_HOME = home;
process.env.HITL_FROM = 'tests';
delete process.env.HITL_CONFIG;

const { Reviews } = await import('../dist/r/store.js');
const { normalise, isStale } = await import('../dist/r/model.js');
const { Questions } = await import('../dist/q/store.js');
const { Notes } = await import('../dist/fs/notes.js');
const { openProject, news, newsCounts, waitFor, decisions, decisionsText, readFeedback } = await import('../dist/agent.js');
const { start } = await import('../dist/server.js');
const { DEFAULT_SETTINGS } = await import('../dist/workspace.js');

const cli = path.resolve('dist/cli.js');
const env = () => ({ ...process.env, HITL_HOME: home, HITL_PORT: '0', HITL_FROM: 'tests' });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const pngBytes = Buffer.from(PNG.split(',')[1], 'base64');
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/** a small git project: src/app.ts and art/pic.png committed */
function makeProject(name) {
  const root = path.join(tmp, name);
  const w = (p, t) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  };
  w('src/app.ts', 'export const greeting = "hello";\nexport const answer = 42;\n');
  w('src/util.ts', 'export const id = (x) => x;\n');
  w('art/pic.png', pngBytes);
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return root;
}

let root;
before(() => {
  root = makeProject('proj');
});
after(() => {
  try {
    execFileSync(process.execPath, [cli, 'stop'], { env: env(), stdio: 'pipe' });
  } catch {
    // not running
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── the store ──

test('two reviews with the same title get their own ids and files, and never take a question set id', () => {
  const r = new Reviews(root);
  const a = r.create({ title: 'Login screen' }, [{ code: 'const a = 1;', lang: 'ts' }]);
  const b = r.create({ title: 'Login screen' }, [{ text: 'Second agent' }]);
  assert.equal(a.id, 'login-screen');
  assert.equal(b.id, 'login-screen-2');
  assert.notEqual(r.reviewPath(a.id), r.reviewPath(b.id));
  assert.ok(fs.existsSync(path.join(root, '.hitl/reviews/login-screen.json')));
  assert.ok(fs.existsSync(path.join(root, '.hitl/reviews/login-screen-2.json')));
  // the first is as it was
  assert.deepEqual(r.load(a.id).review.items.map((i) => i.kind), ['code']);
  assert.deepEqual(r.load(b.id).review.items.map((i) => i.kind), ['text']);
  // a question set's id is taken too (they'd share an answers file)
  new Questions(root).addQuestions('menu-plan', [{ id: 'x', question: 'X?' }]);
  const c = r.create({ title: 'Menu plan' }, [{ md: '# Menu' }]);
  assert.equal(c.id, 'menu-plan-2');
  // asking for an id that's taken is refused, not merged
  assert.throws(() => r.create({ id: a.id, title: 'Again' }, [{ text: 'x' }]), /already a review/);
  assert.throws(() => r.create({ id: '../escape', title: 'x' }, [{ text: 'x' }]), /Bad review id/);
});

test('reviews made at the same moment by different processes never land in one file', async () => {
  const proot = path.join(tmp, 'race');
  fs.mkdirSync(proot);
  const script = (who) => `import { Reviews } from ${JSON.stringify(new URL('../dist/r/store.js', import.meta.url).href)};
const r = new Reviews(${JSON.stringify(proot)});
for (let i = 0; i < 12; i++) r.create({ title: 'Same title' }, [{ text: ${JSON.stringify(who)} + i }]);`;
  const run = (who) =>
    new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script(who)], { stdio: 'inherit' });
      c.on('exit', (code) => (code === 0 ? res() : rej(new Error('exit ' + code))));
    });
  await Promise.all([run('a'), run('b'), run('c')]);
  const r = new Reviews(proot);
  assert.equal(r.ids().length, 36);
  for (const id of r.ids()) assert.equal(r.load(id).review.items.length, 1, `${id} has one agent's item`);
});

test('items of every kind normalise; bad ones are refused with a reason', () => {
  const r = new Reviews(root);
  const made = r.create({ title: 'Every kind', intro: 'Look at all of it', from: 'agent-7' }, [
    { file: 'src/app.ts' },
    { file: 'src/app.ts', lines: '1-1', title: 'Just the greeting' },
    { file: 'src/app.ts', against: 'HEAD' },
    { files: ['src/app.ts', 'src/util.ts'], note: 'Both' },
    { code: 'let x = 2;', lang: 'ts', before: 'let x = 1;' },
    { text: 'plain words' },
    { md: '# Heading' },
    { json: { a: [1, 2] } },
    { diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n' },
    { image: 'art/pic.png', alt: 'The picture' },
    { image: 'https://example.com/shot.png?x=1' },
    { mermaid: 'flowchart LR\n A --> B' },
    { html: '<b>Mock</b>', height: 20 },
    { link: 'https://example.com', label: 'The site' },
  ]);
  const l = r.load(made.id);
  assert.deepEqual(l.errors, []);
  const items = l.review.items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ['file', 'file', 'file', 'file', 'file', 'code', 'text', 'md', 'json', 'diff', 'image', 'image', 'mermaid', 'html', 'link'],
  );
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'item ids are unique');
  assert.equal(items[0].id, 'app-ts');
  assert.equal(items[0].title, 'src/app.ts');
  assert.ok(items[0].snap, 'a file is snapshotted');
  assert.equal(items[1].title, 'Just the greeting');
  assert.equal(items[1].lines, '1-1');
  assert.equal(items[2].title, 'src/app.ts (since HEAD)');
  assert.equal(items[2].snap, undefined, 'a diff against git needs no snapshot');
  assert.deepEqual([items[3].file, items[4].file], ['src/app.ts', 'src/util.ts']);
  assert.equal(items[4].note, 'Both');
  assert.equal(items[5].before, 'let x = 1;');
  assert.equal(items[9].title, 'src/app.ts', 'a diff is titled by its files');
  assert.equal(items[10].title, 'The picture');
  assert.equal(items[11].title, 'shot.png');
  assert.equal(items[13].height, 360, 'too small a height becomes the default');
  assert.equal(items[14].title, 'The site');
  assert.equal(l.review.from, 'agent-7');
  assert.equal(l.review.mode, 'review');
  for (const it of items) assert.match(it.rev, /^[0-9a-z]+$/);

  assert.throws(() => r.create({ title: 'Empty' }, [{ title: 'nothing to see' }]), /An item needs content/);
  assert.throws(() => r.create({ title: 'Bad link' }, [{ link: 'ftp://x' }]), /invalid[\s\S]*a link starts with http/);
  assert.throws(() => r.addItems(made.id, [{ id: 'app-ts', text: 'dup' }]), /already in/);
  assert.equal(r.ids().filter((id) => id.startsWith('empty') || id.startsWith('bad-link')).length, 0, 'a refused review leaves no file');

  const n = normalise('x', {
    mode: 'nope',
    items: [{ file: '../outside.txt' }, { code: 'x', lines: 'ten' }, { code: 'x', against: 'HEAD' }, { image: 'javascript:alert(1)' }, { id: 'same', text: 'a' }, { id: 'same', text: 'b' }, { id: 'bad id!', text: 'c' }, 'nope', { text: 'x', file: 'a', extra: 1 }],
  });
  const all = n.errors.join('\n');
  for (const s of ['mode is one of', 'file must be inside the project', 'lines is "10" or "10-40"', 'against is a git revision', "image isn't a picture", 'used twice', 'bad id "bad id!"', 'an item is an object'])
    assert.ok(all.includes(s), `expected an error about ${s}:\n${all}`);
  assert.ok(n.warnings.some((w) => w.includes('more than one content field')));
  assert.ok(n.warnings.some((w) => w.includes('unknown field "extra"')));
  assert.ok(normalise('y', { items: [] }).warnings.some((w) => /Nothing to look at/.test(w)));
  assert.deepEqual(normalise('z', { mode: 'approve' }).warnings, [], 'an approval needs no items');
});

test('pictures passed as data: URLs are saved into .hitl/media', () => {
  const r = new Reviews(root);
  const made = r.create({ title: 'Screens' }, [{ id: 'shot', image: PNG, before: PNG }]);
  const it = r.load(made.id).review.items[0];
  assert.equal(it.image, `.hitl/media/items/${made.id}-shot.png`);
  assert.equal(it.before, `.hitl/media/items/${made.id}-shot-before.png`);
  assert.deepEqual(fs.readFileSync(path.join(root, it.image)), pngBytes);
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(r.reviewPath(made.id), 'utf8'))).includes('base64'), 'the review file holds the path, not the data');
  assert.throws(() => r.create({ title: 'Not a picture' }, [{ image: 'data:text/html;base64,PGI+' }]), /Pictures only/);
  const svg = r.create({ title: 'Svg' }, [{ id: 's', image: 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E' }]);
  assert.equal(fs.readFileSync(path.join(root, r.load(svg.id).review.items[0].image), 'utf8'), '<svg></svg>');
});

test('verdicts, overall, comments with lines, marks and photos, replies, resolve, ack, and a changed item flagged', () => {
  const r = new Reviews(root);
  const { id } = r.create({ title: 'Feedback flow' }, [{ id: 'code', code: 'a\nb\nc', lang: 'js' }, { id: 'pic', image: 'art/pic.png' }]);
  assert.throws(() => r.verdict(id, 'nope', 'ok'), /No item "nope"/);
  assert.throws(() => r.verdict(id, 'code', 'maybe'), /A verdict is ok, changes, no/);
  const v = r.verdict(id, 'code', 'changes', ' Rename b ');
  assert.equal(v.verdict, 'changes');
  assert.equal(v.note, 'Rename b');
  r.verdict(id, 'pic', 'ok');
  let s = r.summary(id);
  assert.deepEqual([s.reviewed, s.ok, s.changes, s.done], [2, 1, 1, false]);

  const lineC = r.comment(id, { item: 'code', line: 2, endLine: 3, quote: 'b\nc', body: 'These two' });
  assert.deepEqual([lineC.id, lineC.line, lineC.endLine, lineC.quote], ['c3', 2, 3, 'b\nc']);
  const mark = r.comment(id, { item: 'pic', strokes: [[0.1, 0.2, 0.3, 0.4]], area: { x: 1, y: 2, w: 3, h: 4 }, snapshot: PNG, photos: [PNG], body: 'This corner' });
  assert.equal(mark.marked, `.hitl/media/marks/${id}-${mark.id}.png`);
  assert.deepEqual(mark.photos, [`.hitl/media/photos/${id}-${mark.id}-1.png`]);
  assert.ok(fs.existsSync(path.join(root, mark.marked)) && fs.existsSync(path.join(root, mark.photos[0])));
  const whole = r.comment(id, { body: 'Overall nice' });
  assert.equal(whole.item, '');
  assert.throws(() => r.comment(id, { item: 'nope', body: 'x' }), /No item/);
  assert.throws(() => r.comment(id, { item: 'code', body: '  ' }), /empty/);
  r.reply(id, lineC.id, 'owner', 'Also d');
  r.reply(id, lineC.id, 'agent', 'Will do');
  assert.throws(() => r.reply(id, 'c999', 'agent', 'x'), /No comment/);

  let text = readFeedback(r, id, { filter: 'new' }).text;
  assert.match(text, /code \(js\)|code \(Code \(js\)\)/);
  assert.match(text, /needs changes — "Rename b"/);
  assert.match(text, /comment c3 on code .*lines 2-3: "These two"/);
  assert.match(text, /about: "b\\nc"/);
  assert.match(text, /marked area 3×4 at 1,2: "This corner"/);
  assert.match(text, /marked-up picture: \.hitl\/media\/marks\//);
  assert.match(text, /photo: \.hitl\/media\/photos\//);
  assert.match(text, /human: "Also d"/);
  assert.doesNotMatch(text, /Will do/, "the agent's own reply isn't news");
  assert.match(readFeedback(r, id).text, /Nothing new since you last read/);

  // the agent deals with things
  assert.deepEqual(r.setStatus(id, [lineC.id, 'c999'], 'resolved', 'agent', 'Renamed'), [lineC.id]);
  assert.equal(r.feedback(id).comments.find((c) => c.id === lineC.id).status, 'resolved');
  assert.deepEqual(r.ack(id, ['code', 'missing'], 'Renamed b to beta'), ['code']);
  assert.equal(r.feedback(id).items.code.ack.note, 'Renamed b to beta');
  assert.equal(r.summary(id).unread, 0, 'resolving and acking are not news');
  // the same verdict again keeps the ack; a different one drops it
  r.verdict(id, 'code', 'changes', 'Rename b');
  assert.ok(r.feedback(id).items.code.ack);
  r.verdict(id, 'code', 'no');
  assert.equal(r.feedback(id).items.code.ack, undefined);

  // the agent changes the item: the verdict was given to an earlier version
  r.updateItem(id, 'code', { code: 'a\nbeta\nc' });
  const l = r.load(id);
  assert.ok(isStale(l.review.items.find((i) => i.id === 'code'), r.feedback(id).items.code));
  assert.equal(r.summary(id).stale, 1);
  assert.match(readFeedback(r, id, { filter: 'all' }).text, /code .*: no \(given to an earlier version\)/);

  // overall, then take it back
  r.overall(id, 'ok', 'Ship it');
  s = r.summary(id);
  assert.equal(s.done, true);
  assert.equal(s.overall, 'ok');
  assert.match(readFeedback(r, id).text, /OVERALL: LOOKS GOOD — "Ship it"/);
  r.overall(id, null);
  assert.equal(r.summary(id).done, false);
  assert.ok(r.editComment(id, whole.id, 'Edited').body === 'Edited');
  assert.equal(r.deleteComment(id, whole.id), true);
  assert.equal(r.deleteComment(id, whole.id), false);
  const md = fs.readFileSync(r.markdownPath(id), 'utf8');
  assert.match(md, /# Feedback flow: feedback/);
  assert.match(md, /\*\*no\*\* _\(given to an earlier version\)_/);
  assert.match(md, /- \[x\] `c3` \(lines 2-3\): These two/);
  assert.match(md, /!\[marked\]\(\.\.\/\.\.\/\.hitl\/media\/marks\//);
});

// ── the feed, waiting and decisions ──

test('news: one feed across reviews, questions and notes; read once; the agent’s own replies are not news', () => {
  const proot = makeProject('newsy');
  const p = openProject(proot);
  const { id } = p.reviews.create({ title: 'Header' }, [{ id: 'h', file: 'src/app.ts' }]);
  p.questions.addQuestions('colours', [{ id: 'colour', question: 'Which colour?', options: ['Red', 'Navy'] }]);
  assert.match(news(p).text, /Nothing new from the human/);

  p.reviews.verdict(id, 'h', 'changes', 'Bigger');
  const c = p.reviews.comment(id, { item: 'h', line: 1, body: 'This line' });
  p.questions.answer('colours', 'colour', { picked: ['navy'] });
  const note = p.notes.add({ path: 'src/util.ts', line: 1, body: 'Is this used?', author: 'Phil' });
  const counts = newsCounts(openProject(proot));
  assert.deepEqual(counts, { questions: 1, reviews: 2, notes: 1, total: 4 });

  const peek = news(openProject(proot), { peek: true });
  assert.equal(peek.counts.total, 4);
  assert.equal(newsCounts(openProject(proot)).total, 4, 'peek marks nothing read');
  const only = news(openProject(proot), { peek: true, ids: ['colours'] }).text;
  assert.match(only, /## Questions colours/);
  assert.doesNotMatch(only, /## Review/);

  const n = news(openProject(proot)).text;
  assert.match(n, /## Review header .*: 1 of 1 items reviewed/);
  assert.match(n, /h \(src\/app\.ts\): needs changes — "Bigger"/);
  assert.match(n, new RegExp(`comment ${c.id} on h .*line 1: "This line"`));
  assert.match(n, /## Questions colours/);
  assert.match(n, /colour \(Which colour\?\): Navy/);
  assert.match(n, /## Notes from the human \(1;/);
  assert.match(n, new RegExp(`note ${note.id} on src/util\\.ts:1: "Is this used\\?"`));
  assert.match(news(openProject(proot)).text, /^Nothing new from the human since you last read\.$/);

  // the agent writes back everywhere: none of it is news to the agent
  const a = openProject(proot);
  a.reviews.reply(id, c.id, 'agent', 'Made it bigger');
  a.reviews.comment(id, { item: 'h', body: 'Also look at this' }, 'agent');
  a.reviews.setStatus(id, [c.id], 'resolved', 'agent', 'Done');
  a.questions.message('colours', 'colour', 'agent', 'Navy it is');
  a.notes.reply(note.id, 'agent', 'Yes, in app.ts', 'agent');
  a.notes.resolve([note.id], 'Kept it');
  assert.equal(newsCounts(openProject(proot)).total, 0);
  assert.match(news(openProject(proot)).text, /^Nothing new from the human since you last read\.$/);
  // but the human answering back is
  openProject(proot).notes.reply(note.id, 'Phil', 'Thanks');
  assert.equal(newsCounts(openProject(proot)).notes, 1);
  assert.match(news(openProject(proot)).text, /human: "Thanks"/);
});

test('waitFor: until done, all, any; times out; stops on abort', async () => {
  const proot = makeProject('waity');
  const p = openProject(proot);
  const { id } = p.reviews.create({ title: 'Gate', mode: 'approve' }, []);
  const rv = p.reviews.create({ title: 'Two things' }, [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }]).id;
  setTimeout(() => new Reviews(proot).overall(id, 'ok'), 150);
  const t0 = Date.now();
  assert.equal(await waitFor(p, { until: 'done', ids: [id], pollMs: 30, timeoutMs: 4000 }), true);
  assert.ok(Date.now() - t0 >= 100);
  assert.equal(await waitFor(p, { until: 'done', ids: [rv], pollMs: 30, timeoutMs: 150 }), false);
  p.reviews.verdict(rv, 'a', 'ok');
  assert.equal(await waitFor(p, { until: 'all', ids: [rv], pollMs: 30, timeoutMs: 150 }), false);
  p.reviews.verdict(rv, 'b', 'no');
  assert.equal(await waitFor(p, { until: 'all', ids: [rv], pollMs: 30, timeoutMs: 150 }), true);
  news(p);
  assert.equal(await waitFor(p, { until: 'any', ids: ['notes'], pollMs: 30, timeoutMs: 120 }), false);
  setTimeout(() => new Notes(path.join(proot, '.hitl', 'notes'), proot).add({ path: '', body: 'Hello', author: 'Phil' }), 100);
  assert.equal(await waitFor(p, { until: 'any', ids: ['notes'], pollMs: 30, timeoutMs: 3000 }), true);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 80);
  assert.equal(await waitFor(p, { until: 'done', ids: [rv], pollMs: 30, signal: ctl.signal }), false);
  await assert.rejects(() => waitFor(p, { until: 'done', ids: ['no-such'], pollMs: 10, timeoutMs: 50 }), /No review or question set "no-such"/);
});

test('dismissed: a closed approval is not waited on any more, and reopening waits again', async () => {
  const proot = makeProject('dismissed');
  const p = openProject(proot);
  const { id } = p.reviews.create({ title: 'Deploy?', mode: 'approve' }, []);
  assert.equal(await waitFor(p, { until: 'done', ids: [id], pollMs: 30, timeoutMs: 150 }), false);
  // the human no longer wants it: a wait for it is over, with no answer
  p.reviews.update(id, { status: 'closed' });
  assert.equal(await waitFor(p, { until: 'done', ids: [id], pollMs: 30, timeoutMs: 150 }), true);
  assert.equal(p.reviews.feedback(id).overall, undefined);
  p.reviews.update(id, { status: 'open' });
  assert.equal(await waitFor(p, { until: 'done', ids: [id], pollMs: 30, timeoutMs: 150 }), false);
});

test('decisions: answers, verdicts and approvals, newest first, narrowed by words', async () => {
  const proot = makeProject('decided');
  const p = openProject(proot);
  p.questions.addQuestions('look', [{ id: 'colour', question: 'Which colour for the header?', options: ['Red', 'Navy'] }], undefined, { title: 'The look' });
  p.questions.answer('look', 'colour', { picked: ['navy'], note: 'darker' });
  await new Promise((r) => setTimeout(r, 5));
  const { id } = p.reviews.create({ title: 'Header layout', from: 'agent-3' }, [{ id: 'logo', title: 'Logo size', code: 'x' }]);
  p.reviews.verdict(id, 'logo', 'changes', 'smaller');
  await new Promise((r) => setTimeout(r, 5));
  const gate = p.reviews.create({ title: 'Deploy to production?', mode: 'approve' }, []).id;
  p.reviews.overall(gate, 'ok', 'go');
  const all = decisions(p);
  assert.equal(all.total, 3);
  assert.deepEqual(all.decisions.map((d) => d.kind), ['approval', 'verdict', 'answer']);
  assert.equal(all.decisions[0].decision, 'approved');
  assert.equal(all.decisions[1].from, 'agent-3');
  const hits = decisions(p, { q: 'HEADER navy' });
  assert.equal(hits.total, 1);
  assert.equal(hits.decisions[0].request, 'look');
  assert.equal(hits.decisions[0].decision, 'Navy');
  assert.equal(decisions(p, { q: 'logo smaller' }).decisions[0].id, 'logo');
  assert.equal(decisions(p, { limit: 1 }).decisions.length, 1);
  assert.match(decisionsText(p, { q: 'nothing like this' }), /No decisions match/);
  assert.match(decisionsText(p, { q: 'deploy' }), /1 decision matching "deploy":\n- \d{4}-\d\d-\d\d deploy-to-production — Deploy to production\?: approved \("go"\)/);
});

// ── the hub ──

function request(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('the hub: a review, files changed since shown and their diffs, verdicts, comments, replies, status, token and origin', async () => {
  const proot = makeProject('served');
  const r = new Reviews(proot);
  const { id } = r.create({ title: 'Served' }, [
    { id: 'app', file: 'src/app.ts' },
    { id: 'since', file: 'src/util.ts', against: 'HEAD' },
    { id: 'code', code: 'let x = 2;\n', before: 'let x = 1;\n' },
    { id: 'pic', image: 'art/pic.png' },
    { id: 'gone', file: 'src/missing.ts' },
  ]);
  const running = await start({ mode: 'solo', projects: () => [{ key: 's', root: proot }], port: 0, host: '127.0.0.1', token: 'tok', settings: () => ({ ...DEFAULT_SETTINGS, watch: false }) });
  const port = running.port;
  const auth = { authorization: 'Bearer tok' };
  const api = `/p/s/api/r/${id}`;
  const post = (action, body, headers = {}) => request(port, `${api}/${action}`, { method: 'POST', headers: { ...auth, ...headers }, body });
  try {
    assert.equal((await request(port, api)).status, 401, 'no token, no entry');
    assert.equal((await request(port, '/p/s/api/r/no-such', { headers: auth })).status, 404);
    const info = (await request(port, '/api/info', { headers: auth })).json();
    assert.ok(info.projects[0].reviews.some((s) => s.id === id));

    let got = (await request(port, api, { headers: auth })).json();
    assert.equal(got.review.items.length, 5);
    assert.deepEqual(got.files.app, { exists: true, changed: false, size: fs.statSync(path.join(proot, 'src/app.ts')).size });
    assert.equal(got.files.gone.exists, false);
    assert.equal(got.files.code, undefined, 'only file items are checked');

    // the file changes after it was shown
    fs.writeFileSync(path.join(proot, 'src/app.ts'), 'export const greeting = "hi";\nexport const answer = 42;\n');
    fs.writeFileSync(path.join(proot, 'src/util.ts'), 'export const id = (x) => x;\nexport const two = 2;\n');
    got = (await request(port, api, { headers: auth })).json();
    assert.equal(got.files.app.changed, true);
    const snapDiff = await request(port, `${api}/diff?item=app`, { headers: auth });
    assert.equal(snapDiff.status, 200);
    assert.match(snapDiff.body, /^-export const greeting = "hello";$/m);
    assert.match(snapDiff.body, /^\+export const greeting = "hi";$/m);
    assert.match(snapDiff.body, /src\/app\.ts \(as shown\)/);
    assert.match((await request(port, `${api}/diff?item=since`, { headers: auth })).body, /^\+export const two = 2;$/m);
    assert.match((await request(port, `${api}/diff?item=code`, { headers: auth })).body, /^-let x = 1;\n\+let x = 2;$/m);
    assert.equal((await request(port, `${api}/diff?item=pic`, { headers: auth })).status, 400);
    assert.equal((await request(port, `${api}/diff?item=nope`, { headers: auth })).status, 404);

    // the human's side
    assert.equal((await post('verdict', { item: 'app', verdict: 'ok' }, { origin: 'http://evil.example' })).status, 403, 'cross-origin writes are refused');
    assert.equal((await post('verdict', { item: 'app', verdict: 'maybe' })).status, 400);
    assert.equal((await post('verdict', { item: 'nope', verdict: 'ok' })).status, 400);
    const v = (await post('verdict', { item: 'app', verdict: 'changes', note: 'Say hello' }, { origin: `http://127.0.0.1:${port}` })).json();
    assert.equal(v.verdict.verdict, 'changes');
    assert.equal(v.summary.changes, 1);
    const cm = await post('comment', { item: 'app', line: 1, endLine: 2, quote: 'greeting', body: 'This one', side: 'old' });
    assert.equal(cm.status, 201);
    const c = cm.json().comment;
    assert.deepEqual([c.line, c.endLine, c.side, c.quote], [1, 2, 'old', 'greeting']);
    const marked = (await post('comment', { item: 'pic', body: 'Here', strokes: [[0.1, 0.1, 0.9, 0.9], [5, 5]], area: { x: 0, y: 0, w: 1, h: 1 }, snapshot: PNG, photos: [PNG, 'data:text/plain;base64,aGk='] })).json().comment;
    assert.deepEqual(marked.strokes, [[0.1, 0.1, 0.9, 0.9]]);
    assert.ok(fs.existsSync(path.join(proot, marked.marked)));
    assert.equal(marked.photos.length, 1, 'only pictures are kept as photos');
    assert.equal((await post('comment', { item: 'app', body: '' })).status, 400);
    const rep = (await post('reply', { cid: c.id, body: 'And the next line' })).json();
    assert.equal(rep.comment.replies[0].from, 'owner');
    assert.equal((await post('status', { cid: [c.id], status: 'done' })).status, 400);
    assert.deepEqual((await post('status', { cid: [c.id], status: 'resolved' })).json().done, [c.id]);
    assert.equal((await post('edit', { cid: marked.id, body: 'Here, exactly' })).json().comment.body, 'Here, exactly');
    const ov = (await post('overall', { verdict: 'changes', note: 'Nearly' })).json();
    assert.equal(ov.overall.verdict, 'changes');
    assert.equal(ov.summary.done, true);
    assert.equal((await post('delete', { cid: marked.id })).json().ok, true);
    assert.equal((await request(port, api, { method: 'PUT', headers: auth, body: {} })).status, 405);
    assert.equal((await post('nope', {})).status, 404);

    got = (await request(port, api, { headers: auth })).json();
    assert.equal(got.feedback.overall.note, 'Nearly');
    assert.equal(got.feedback.comments.length, 1);
    const fb = new Reviews(proot).feedback(id);
    assert.equal(fb.items.app.note, 'Say hello');
    // the decision log, through the hub
    const d = (await request(port, '/p/s/api/decisions?q=hello', { headers: auth })).json();
    assert.equal(d.decisions[0].id, 'app');
  } finally {
    await running.close();
  }
});

test('the hub: a read-only project refuses verdicts', async () => {
  const proot = makeProject('readonly');
  const { id } = new Reviews(proot).create({ title: 'RO' }, [{ id: 'a', text: 'a' }]);
  const running = await start({ mode: 'solo', projects: () => [{ key: 'ro', root: proot }], port: 0, host: '127.0.0.1', settings: () => ({ ...DEFAULT_SETTINGS, watch: false, readOnly: true }) });
  try {
    assert.equal((await request(running.port, `/p/ro/api/r/${id}`)).status, 200);
    assert.equal((await request(running.port, `/p/ro/api/r/${id}/verdict`, { method: 'POST', body: { item: 'a', verdict: 'ok' } })).status, 403);
  } finally {
    await running.close();
  }
});

// ── the MCP server ──

function mcp(cwd) {
  const child = spawn(process.execPath, [cli, 'mcp'], { cwd, env: env(), stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result;
  const close = async () => {
    child.stdin.end();
    if (child.exitCode === null) await new Promise((r) => child.on('exit', r));
  };
  return { child, call, tool, close };
}

test('the MCP server: tools, show then news, approve answered while it waits', async () => {
  const proot = makeProject('mcpproj');
  const m = mcp(proot);
  try {
    const init = await m.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'hitl');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.match(init.result.instructions, /approve/);
    m.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = (await m.call('tools/list', {})).result.tools;
    const names = list.map((t) => t.name);
    for (const t of ['show', 'approve', 'news', 'wait', 'add_questions', 'get_feedback', 'decisions', 'resolve', 'notes']) assert.ok(names.includes(t), t);
    for (const t of list) assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal((await m.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await m.call('no/such', {})).error.code, -32601);

    const shown = await m.tool('show', { title: 'Greeting', intro: 'Is it friendly?', items: [{ file: 'src/app.ts', note: 'The greeting' }, { code: 'hi()', lang: 'js' }] });
    assert.ok(!shown.isError, shown.content[0].text);
    assert.match(shown.content[0].text, /Made a review "greeting" with 2 items: app-ts, /);
    assert.match(shown.content[0].text, /http:\/\/localhost:\d+\/\?token=[^#\s]+#\/p\/mcpproj\/r\/greeting/);
    const r = new Reviews(proot);
    assert.equal(r.load('greeting').review.from, 'tests');
    const again = await m.tool('show', { title: 'Greeting', items: [{ text: 'another agent' }] });
    assert.match(again.content[0].text, /Made a review "greeting-2"/);
    assert.equal((await m.tool('show', { items: [] })).isError, true);

    r.verdict('greeting', 'app-ts', 'changes', 'Say hello properly');
    const n1 = (await m.tool('news', {})).content[0].text;
    assert.match(n1, /app-ts \(src\/app\.ts\): needs changes — "Say hello properly"/);
    assert.match((await m.tool('news', {})).content[0].text, /Nothing new/);
    assert.match((await m.tool('ack', { review: 'greeting', ids: ['app-ts'], note: 'Fixed' })).content[0].text, /Marked 1 done/);

    // approve waits; the human answers while it does
    const pending = m.tool('approve', { question: 'Deploy now?', details: 'Version 2', timeout_seconds: 20 });
    let gate;
    for (let i = 0; i < 200 && !gate; i++) {
      gate = new Reviews(proot).ids().find((id) => new Reviews(proot).load(id)?.review.mode === 'approve');
      if (!gate) await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(gate, 'deploy-now');
    new Reviews(proot).overall(gate, 'ok', 'Go ahead');
    const approved = await pending;
    assert.match(approved.content[0].text, /^APPROVED — "Go ahead" \(deploy-now\)$/);
    // a short wait with no answer says so
    const unanswered = await m.tool('approve', { question: 'Delete the data?', timeout_seconds: 1 });
    assert.match(unanswered.content[0].text, /no answer yet/);
    assert.match((await m.tool('decisions', { q: 'deploy' })).content[0].text, /approved \("Go ahead"\)/);

    // a message to the human: a note the agent started, on lines of a file; it isn't news until they reply
    const sent = await m.tool('send_message', { message: 'Done: **greeting** says hello now.', path: 'src/app.ts', line: 1, end_line: 2 });
    assert.ok(!sent.isError, sent.content[0].text);
    const mid = /Sent message ([0-9a-f]+) on src\/app\.ts:1-2/.exec(sent.content[0].text)?.[1];
    assert.ok(mid, sent.content[0].text);
    assert.match(sent.content[0].text, /#\/p\/mcpproj\/notes/);
    const notes = new Notes(path.join(proot, '.hitl', 'notes'), proot);
    const note = notes.all().find((c) => c.id === mid);
    assert.equal(note.from, 'agent');
    assert.equal(note.author, 'tests');
    assert.match(note.quote, /greeting = "hello"/);
    assert.match((await m.tool('news', {})).content[0].text, /Nothing new/, "the agent's own message isn't news");
    notes.reply(mid, 'Phil', 'Nice, thanks');
    const heard = (await m.tool('news', {})).content[0].text;
    assert.ok(heard.includes(`your message ${mid} on src/app.ts:1-2`), heard);
    assert.match(heard, /human: "Nice, thanks"/);
    assert.equal((await m.tool('send_message', { message: 'x', path: '../outside.txt' })).isError, true);
    assert.equal((await m.tool('send_message', { message: 'x', path: 'src/nope.ts' })).isError, true);
    assert.equal((await m.tool('send_message', { message: '  ' })).isError, true);
    assert.match((await m.tool('send_message', { message: 'Heads-up: CI is slow today', from: 'bot' })).content[0].text, /Sent message [0-9a-f]+\. /);
  } finally {
    await m.close();
  }
});

// ── the CLI ──

test('the CLI: show, news, approve with a timeout, hooks, the stop gate', () => {
  const proot = makeProject('cliproj');
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { cwd: proot, env: env(), encoding: 'utf8' });
  const out = run('show', 'src/app.ts', '--title', 'The app', '--note', 'Look at line 1');
  assert.match(out, /Made a showing "the-app": app-ts/);
  assert.match(out, /#\/p\/cliproj\/r\/the-app/);
  const r = new Reviews(proot);
  assert.equal(r.load('the-app').review.mode, 'show');
  assert.equal(r.load('the-app').review.items[0].note, 'Look at line 1');
  assert.match(run('show', 'src/util.ts', '--mode', 'review', '--title', 'The app'), /Made a review "the-app-2"/);
  assert.match(run('show', 'src/util.ts', '--to', 'the-app'), /Added 1 to "the-app": util-ts/);
  const piped = spawnSync(process.execPath, [cli, 'show', '-', '--title', 'Piped', '--lang', 'ts'], { cwd: proot, env: env(), input: 'const piped = 1;\n', encoding: 'utf8' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(new Reviews(proot).load('piped').review.items[0].code, 'const piped = 1;\n');
  assert.throws(() => run('show', 'no/such/file.ts'), (e) => /no such file/.test(e.stderr));

  assert.match(run('news'), /Nothing new from the human/);
  r.comment('the-app', { item: 'app-ts', line: 2, body: 'Why 42?' });
  assert.match(run('news', '--peek'), /comment c1 on app-ts .*line 2: "Why 42\?"/);
  assert.match(run('status'), /the-app \(show, "The app", from tests\): 2 items shown, 1 open comment, 1 new/);
  assert.match(run('news'), /Why 42/);
  assert.match(run('news'), /Nothing new/);
  assert.match(run('feedback', 'the-app', '--all'), /Why 42/);
  assert.match(run('reply', 'the-app', 'c1', 'It', 'is', 'the', 'answer'), /Replied on c1/);
  assert.equal(new Reviews(proot).feedback('the-app').comments[0].replies[0].body, 'It is the answer');
  assert.match(run('resolve', 'the-app', 'c1', '--note', 'Explained'), /Resolved c1/);
  const msg = run('message', 'Stuck:', 'the', 'key', 'is', 'missing', '--path', 'src/util.ts', '--lines', '1');
  assert.match(msg, /Sent message [0-9a-f]+ on src\/util\.ts:1\./);
  assert.match(msg, /#\/p\/cliproj\/notes/);
  assert.equal(new Notes(path.join(proot, '.hitl', 'notes'), proot).all()[0].body, 'Stuck: the key is missing');

  // approve with nobody answering: exit code 2
  const t0 = Date.now();
  const ap = spawnSync(process.execPath, [cli, 'approve', 'Ship it?', '--timeout', '2s'], { cwd: proot, env: env(), encoding: 'utf8' });
  assert.equal(ap.status, 2, ap.stdout + ap.stderr);
  assert.ok(Date.now() - t0 >= 2000);
  assert.match(ap.stdout, /Asked "ship-it"/);
  assert.match(ap.stdout, /No answer yet/);
  // while it waits, the stop hook keeps the agent from finishing
  const gate = spawnSync(process.execPath, [cli, 'hook', 'stop'], { cwd: proot, env: env(), input: '{}', encoding: 'utf8' });
  const decision = JSON.parse(gate.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /approval is still waiting \(ship-it\)/);
  assert.equal(spawnSync(process.execPath, [cli, 'hook', 'stop'], { cwd: proot, env: env(), input: '{"stop_hook_active":true}', encoding: 'utf8' }).stdout, '', 'it never loops');
  // answered now: approve says so at once, exit 0
  new Reviews(proot).overall('ship-it', 'ok');
  const later = spawnSync(process.execPath, [cli, 'wait', '--done', 'ship-it', '--timeout', '5s'], { cwd: proot, env: env(), encoding: 'utf8' });
  assert.equal(later.status, 0, later.stdout + later.stderr);
  assert.match(later.stdout, /OVERALL: APPROVED/);
  const refused = spawnSync(process.execPath, [cli, 'approve', 'Drop the table?', '--timeout', '3s'], { cwd: proot, env: env(), encoding: 'utf8' });
  assert.equal(refused.status, 2);
  new Reviews(proot).overall('drop-the-table', 'no', 'Never');

  // hooks are opt-in
  assert.match(run('hooks'), /News hook: off\nStop hook: off/);
  assert.match(run('hooks', 'on', '--stop'), /Stop hook .*: on/);
  assert.match(run('hooks'), /News hook: off\nStop hook: on/);
  assert.match(run('hooks', 'on'), /News hook .*: on/);
  assert.match(run('hooks', 'on', '--stop'), /already on/);
  const settings = JSON.parse(fs.readFileSync(path.join(proot, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(settings.hooks.Stop[0].hooks[0].command, / hook stop$/);
  assert.match(run('hooks', 'off', '--stop'), /Stop hook .*: off/);
  assert.match(run('hooks'), /News hook: on\nStop hook: off/);
  assert.match(run('decisions', 'table'), /refused \("Never"\)/);
});
