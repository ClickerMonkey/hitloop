// Files (folderview's part of hitl): paths, filters, git, search, the human's notes, and the page's file routes under
// p/<key>/. Runs against the built dist/ (npm test builds first).
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// a hang (a stuck git or child process) fails its test instead of the whole run
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

// never the real ~/.config/hitl
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-f-')));
process.env.HITL_HOME = path.join(tmp, 'home');
delete process.env.HITL_CONFIG;

const { inside, list, isSecret } = await import('../dist/fs/files.js');
const { FileIndex } = await import('../dist/fs/search.js');
const { pathFilter, excluder, parseRules } = await import('../dist/fs/glob.js');
const { crc32 } = await import('../dist/fs/zip.js');
const { Git } = await import('../dist/fs/git.js');
const { Notes, toMarkdown } = await import('../dist/fs/notes.js');
const { normaliseBase } = await import('../dist/hub/registry.js');
const { projectSettings } = await import('../dist/settings.js');
const { DEFAULT_SETTINGS } = await import('../dist/workspace.js');
const { start } = await import('../dist/server.js');

const cli = path.resolve('dist/cli.js');
const root = path.join(tmp, 'repo');
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' }).toString();
const write = (p, t) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), t);
};

before(() => {
  fs.mkdirSync(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  write('src/a.ts', 'export const a = 1;\nexport const findMe = 2;\n');
  write('src/b.ts', 'const b = 1;\n');
  write('old.txt', 'old\n');
  write('.gitignore', 'build/\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  write('src/a.ts', 'export const a = 10;\nexport const findMe = 2;\nexport const c = 3;\n');
  fs.rmSync(path.join(root, 'old.txt'));
  write('new.md', '# New\n');
  write('build/out.js', 'built\n');
  write('.env', 'SECRET=1\n');
  write('id_rsa', 'key\n');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const scope = (exclude = []) => ({ root, hidden: new Set(['.git']), hideSecrets: true, excluded: excluder(parseRules(exclude)) });
/** a hub serving just this repo, as "t" */
const serve = (extra = {}, s = {}) => start({ mode: 'solo', projects: () => [{ key: 't', root }], port: 0, host: '127.0.0.1', settings: () => ({ ...DEFAULT_SETTINGS, watch: false, ...s }), ...extra });

test('paths stay inside the root and away from hidden and secret files', () => {
  const s = scope();
  assert.equal(inside(s, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
  assert.equal(inside(s, '../outside'), undefined);
  assert.equal(inside(s, 'src/../../x'), undefined);
  assert.equal(inside(s, '.git/config'), undefined);
  assert.equal(inside(s, '.env'), undefined);
  assert.equal(inside(s, 'id_rsa'), undefined);
  assert.ok(isSecret('.env.local') && !isSecret('.env.example') && isSecret('server.pem'));
  const names = list(s, '').map((e) => e.name);
  assert.ok(names.includes('src') && names.includes('new.md'));
  assert.ok(!names.includes('.git') && !names.includes('.env') && !names.includes('id_rsa'));
});

test('include and exclude filters', () => {
  const f = pathFilter('*.ts, !*.test.ts');
  assert.ok(f('src/a.ts'));
  assert.ok(!f('src/a.test.ts'));
  assert.ok(!f('README.md'));
  const g = pathFilter('src/**');
  assert.ok(g('src/deep/x.js') && !g('lib/x.js'));
  assert.ok(pathFilter('')('anything'));
});

test('exclude patterns: names, folders, anchored paths, ** and exceptions', () => {
  const ex = excluder(parseRules(['*.log', 'dist/', '/secret', 'docs/**/*.tmp', '!keep.log']));
  assert.ok(ex('a.log') && ex('deep/b.log'));
  assert.ok(!ex('keep.log'));
  assert.ok(ex('dist', true) && ex('dist/x.js') && ex('pkg/dist/y.js'));
  assert.ok(!ex('dist'), 'dist/ only matches a folder');
  assert.ok(ex('secret') && ex('secret/x') && !ex('a/secret'));
  assert.ok(ex('docs/a/b/c.tmp') && !ex('other/c.tmp'));
  const s = scope(['src/b.ts', '*.md']);
  assert.equal(inside(s, 'src/b.ts'), undefined);
  assert.equal(inside(s, 'new.md'), undefined);
  assert.deepEqual(list(s, 'src').map((e) => e.name), ['a.ts']);
});

test('git status: changed, deleted, new and ignored', async () => {
  const g = await Git.open(root);
  assert.ok(g);
  const s = await g.status();
  assert.equal(s.branch, 'main');
  const by = Object.fromEntries(s.changes.map((c) => [c.path, c]));
  assert.equal(by['src/a.ts'].state, 'modified');
  assert.equal(by['src/a.ts'].add, 2);
  assert.equal(by['src/a.ts'].del, 1);
  assert.equal(by['old.txt'].state, 'deleted');
  assert.equal(by['new.md'].state, 'new');
  assert.ok(s.ignored.includes('build/'));
  assert.match(await g.diff('src/a.ts'), /^\+export const c = 3;$/m);
  assert.match(await g.diff('new.md'), /^\+# New$/m);
  assert.equal(await g.show('old.txt'), 'old\n');
  assert.equal((await g.log('src/a.ts'))[0].subject, 'first');
});

test('search finds lines, names, and respects scope and options', async () => {
  const idx = new FileIndex(scope(), await Git.open(root));
  const q = (o) => idx.search({ scope: '', regex: false, caseSensitive: false, word: false, include: '', ...o });
  const r = await q({ q: 'findme' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, 'src/a.ts');
  assert.equal(r.files[0].matches[0].line, 2);
  assert.deepEqual(r.files[0].matches[0].hits, [[13, 19]]);
  assert.equal((await q({ q: 'findme', caseSensitive: true })).files.length, 0);
  const rx = await q({ q: 'const [ab] =', scope: 'src', regex: true });
  assert.deepEqual(rx.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal((await q({ q: 'built' })).files.length, 0, 'ignored files are not searched');
  assert.equal((await q({ q: 'SECRET', caseSensitive: true })).files.length, 0, 'secret files are not searched');
  assert.ok((await q({ q: '(', regex: true })).error);
});

test('notes: saved, quoted, replied, resolved, read marks, and written as markdown', () => {
  const dir = path.join(tmp, 'notes-test');
  const r = new Notes(dir, root);
  const c = r.add({ path: 'src/a.ts', line: 1, endLine: 2, body: 'Rename these.', author: 'Phil', commit: 'abc1234' });
  assert.equal(c.quote, 'export const a = 10;\nexport const findMe = 2;');
  const free = r.add({ path: '', body: 'Look at the login flow', author: 'Phil' });
  assert.equal(free.line, undefined);
  assert.equal(r.unread(), 2);
  r.reply(c.id, 'agent', 'Done.', 'agent');
  assert.equal(r.unread(), 2, "the agent's own reply isn't news");
  r.update(c.id, { status: 'resolved' });
  const f = r.add({ path: 'new.md', body: 'Whole-file note', author: 'Phil' });
  assert.equal(f.line, undefined);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));
  assert.equal(saved.comments.length, 3);
  const md = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8');
  assert.match(md, /2 open · 1 resolved/);
  assert.match(md, /`src\/a\.ts:1-2` — Phil @ abc1234/);
  assert.match(md, /> \*\*agent\*\*: Done\./);
  assert.match(md, /`new\.md \(whole file\)`/);
  assert.match(md, /\(not about a particular file\)/);
  r.markRead();
  assert.equal(r.unread(), 0);
  // an edit from outside (an agent) is picked up
  saved.comments.find((x) => x.path === 'new.md').status = 'resolved';
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(saved));
  const again = new Notes(dir, root);
  assert.equal(again.all().filter((x) => x.status === 'open').length, 1);
  assert.deepEqual(again.resolve([free.id], 'Looked: it was fine'), [free.id]);
  assert.equal(again.all().find((x) => x.id === free.id).replies.at(-1).from, 'agent');
  assert.ok(again.remove(c.id));
  assert.match(toMarkdown([], 'x.json'), /No notes yet/);
});

test('settings: the user config, then the project .hitl/config.json, then overrides; lists add up', () => {
  fs.mkdirSync(path.join(root, '.hitl'), { recursive: true });
  fs.writeFileSync(path.join(root, '.hitl', 'config.json'), JSON.stringify({ exclude: ['*.project'], readOnly: true, maxFileMb: 2 }));
  try {
    const user = { exclude: ['*.global'], hide: ['tmp'], author: 'Global', maxFileMb: 9, git: false };
    const s = projectSettings(root, { exclude: ['*.flag'], readOnly: false }, user);
    assert.deepEqual(s.exclude, ['*.global', '*.project', '*.flag']);
    assert.deepEqual(s.hide, ['tmp']);
    assert.equal(s.readOnly, false, 'the command line wins');
    assert.equal(s.maxFileMb, 2, 'the project beats the user');
    assert.equal(s.author, 'Global');
    assert.equal(s.git, false);
    assert.equal(s.watch, true, 'defaults fill the rest');
    const none = projectSettings(path.join(tmp, 'nowhere'), {}, {});
    assert.deepEqual(none, { ...DEFAULT_SETTINGS });
  } finally {
    fs.rmSync(path.join(root, '.hitl', 'config.json'));
  }
});

test('the server: pages, raw files, host and origin checks, notes', async () => {
  const s = await serve();
  const base = `http://127.0.0.1:${s.port}`;
  const api = base + '/p/t/api';
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/assets/main.js')).status, 200);
    assert.equal((await fetch(base + '/assets/../package.json')).status, 404);
    const info = await (await fetch(api + '/info')).json();
    assert.equal(info.git, true);
    assert.equal(info.author, 'Tester');
    assert.equal(info.notes.json, '.hitl/notes/notes.json');
    assert.equal(await (await fetch(base + '/p/t/raw/src/b.ts')).text(), 'const b = 1;\n');
    const part = await fetch(base + '/p/t/raw/src/b.ts', { headers: { range: 'bytes=0-4' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'const');
    assert.equal((await fetch(base + '/p/t/raw/.env')).status, 404);
    assert.equal((await fetch(base + '/p/t/raw/..%2f..%2fetc%2fpasswd')).status, 404);
    const listed = await (await fetch(api + '/list?p=src')).json();
    assert.deepEqual(listed.entries.map((e) => e.name).sort(), ['a.ts', 'b.ts']);
    assert.equal((await fetch(api + '/search')).status, 400);
    assert.equal((await (await fetch(api + '/search?q=findMe')).json()).files[0].path, 'src/a.ts');
    // a page on another site that points its name at this machine is refused
    const http = await import('node:http');
    const status = await new Promise((res) => http.get(api + '/info', { headers: { host: 'evil.example' } }, (r) => res(r.statusCode)));
    assert.equal(status, 403);
    // writes from another origin are refused
    const cross = await fetch(api + '/comments', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
    const post = (b) => fetch(api + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const made = await post({ path: 'src/b.ts', line: 1, body: 'Hi' });
    assert.equal(made.status, 201);
    const c = await made.json();
    assert.equal(c.quote, 'const b = 1;');
    assert.equal(c.author, 'Tester');
    assert.ok(fs.existsSync(path.join(root, '.hitl/notes/notes.json')));
    assert.equal((await post({ path: '../x', body: 'Hi' })).status, 400);
    assert.equal((await post({ path: 'src/b.ts', body: '  ' })).status, 400, 'an empty note');
    const free = await post({ body: 'A note on nothing in particular' });
    assert.equal(free.status, 201);
    const replied = await (await fetch(`${api}/comments/${c.id}/replies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'And this' }) })).json();
    assert.equal(replied.replies[0].body, 'And this');
    const patched = await (await fetch(`${api}/comments/${c.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) })).json();
    assert.equal(patched.status, 'resolved');
    assert.equal((await (await fetch(api + '/comments')).json()).comments.length, 2);
    const st = await (await fetch(api + '/git/status')).json();
    assert.ok(!st.changes.some((x) => x.path.startsWith('.hitl/')), "hitl's own files are not listed as changes");
    assert.ok(!(await (await fetch(api + '/files')).json()).files.some((f) => f.startsWith('.hitl/')));
    const md = await (await fetch(api + '/notes.md')).text();
    assert.match(md, /src\/b\.ts:1/);
    assert.equal((await (await fetch(api + '/comments?resolved=1', { method: 'DELETE' })).json()).removed, 1);
  } finally {
    await s.close();
  }
});

test('read-only: looks, but no notes', async () => {
  const s = await serve({}, { readOnly: true });
  try {
    const api = `http://127.0.0.1:${s.port}/p/t/api`;
    assert.equal((await fetch(api + '/info')).status, 200);
    assert.equal((await fetch(api + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }) })).status, 403);
  } finally {
    await s.close();
  }
});

test('history, a commit and its diffs, and notes on an area of a picture', async () => {
  const s = await serve();
  const api = `http://127.0.0.1:${s.port}/p/t/api`;
  const notesDir = path.join(root, '.hitl', 'notes');
  const post = (body) => fetch(api + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const h = await (await fetch(api + '/git/history')).json();
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0].subject, 'first');
    assert.equal(h.commits[0].state, 'unknown', 'no remote, so nothing is pushed or not');
    assert.equal(h.remotes, false);
    assert.equal((await (await fetch(api + '/git/history?q=FIRST')).json()).commits.length, 1, 'search ignores case');
    assert.equal((await (await fetch(api + '/git/history?q=nothing-like-this')).json()).commits.length, 0);
    assert.equal((await (await fetch(api + '/git/history?q=' + h.commits[0].hash)).json()).commits[0].hash, h.commits[0].hash, 'a hash finds its commit');
    const log = await (await fetch(api + '/git/log?p=src/b.ts')).json();
    assert.equal(log.commits.length, 1);
    assert.equal(log.more, false);
    const info = await (await fetch(api + '/git/commit-info?h=' + h.commits[0].hash)).json();
    assert.equal(info.commit.subject, 'first');
    const b = info.files.find((f) => f.path === 'src/b.ts');
    assert.equal(b.state, 'added');
    assert.equal(b.add, 1);
    assert.match(await (await fetch(`${api}/git/commit-diff?h=${info.commit.full}&p=src/b.ts`)).text(), /\+const b = 1;/);
    assert.equal((await fetch(`${api}/git/commit-diff?h=;rm&p=src/b.ts`)).status, 400);
    assert.equal((await fetch(`${api}/git/show?p=src/b.ts&rev=--output=x`)).status, 400);
    assert.equal(await (await fetch(`${api}/git/show?p=old.txt`)).text(), 'old\n');

    // a 1×1 PNG stands in for the marked-up picture
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const made = await post({ path: 'src/b.ts', body: 'This bit', strokes: [[0.1, 0.1, 0.5, 0.5], [2, 'x']], area: { x: 1, y: 2, w: 30, h: 40 }, snapshot: png, photos: [png, 'data:text/html;base64,PGI+'] });
    assert.equal(made.status, 201);
    const c = await made.json();
    assert.deepEqual(c.area, { x: 1, y: 2, w: 30, h: 40 });
    assert.deepEqual(c.strokes, [[0.1, 0.1, 0.5, 0.5]], 'points outside 0–1 are dropped');
    assert.equal(c.image, `images/${c.id}.png`);
    assert.deepEqual(c.photos, [`photos/${c.id}-1.png`], 'only pictures are kept as photos');
    const img = await fetch(`${api}/comments/${c.id}/image.png`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${api}/comments/${c.id}/photo/${c.id}-1.png`)).status, 200);
    assert.ok(fs.existsSync(path.join(notesDir, c.image)));
    const md = fs.readFileSync(path.join(notesDir, 'NOTES.md'), 'utf8');
    assert.match(md, /src\/b\.ts \(marked area\)/);
    assert.match(md, new RegExp(`!\\[The marked area\\]\\(images/${c.id}\\.png\\)`));
    // something that isn't a PNG is not saved
    const bad = await (await post({ path: 'src/b.ts', body: 'x', strokes: [[0.1, 0.1]], snapshot: 'data:image/png;base64,PHN2Zz4=' })).json();
    assert.equal(bad.image, undefined);
    await fetch(`${api}/comments/${c.id}`, { method: 'DELETE' });
    assert.ok(!fs.existsSync(path.join(notesDir, c.image)), 'deleting the note deletes its picture');
    assert.ok(!fs.existsSync(path.join(notesDir, c.photos[0])), 'and its photos');
  } finally {
    await s.close();
  }
});

test('downloads, folder zips, a token and a base path', async () => {
  const s = await serve({ token: 's3cret', base: '/code/' }, { exclude: ['*.md'] });
  const base = `http://127.0.0.1:${s.port}/code/`;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/info`)).status, 404, 'nothing outside the base path');
    assert.equal((await fetch(base + 'api/info')).status, 401, 'no token, no entry');
    const page = await fetch(base + '?token=s3cret', { redirect: 'manual' });
    assert.equal(page.status, 302);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const auth = { headers: { cookie } };
    assert.equal((await fetch(base + 'api/info', auth)).status, 200);
    assert.equal((await fetch(base + 'p/t/api/info', { headers: { authorization: 'Bearer s3cret' } })).status, 200);
    assert.equal((await fetch(base + 'api/info', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const dl = await fetch(base + 'p/t/raw/src/b.ts?download=1', auth);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="b\.ts"/);
    assert.equal((await fetch(base + 'p/t/raw/new.md', auth)).status, 404, 'excluded files are not served');
    const zip = Buffer.from(await (await fetch(base + 'p/t/api/zip?p=src', auth)).arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a zip');
    const names = [];
    for (let i = 0; i < zip.length - 4; i++) if (zip.readUInt32LE(i) === 0x02014b50) names.push(zip.toString('utf8', i + 46, i + 46 + zip.readUInt16LE(i + 28)));
    assert.deepEqual(names.sort(), ['src/a.ts', 'src/b.ts']);
    // the stored CRC matches the file
    const at = zip.indexOf(Buffer.from('src/a.ts')) - 30;
    assert.equal(zip.readUInt32LE(at + 14), crc32(fs.readFileSync(path.join(root, 'src/a.ts'))));
  } finally {
    await s.close();
  }
});

test('a nested base path: the page, its assets and chunks, files, search and live events all live under it', async () => {
  const s = await serve({ base: '/test/path/' }, { watch: true });
  const at = `http://127.0.0.1:${s.port}`;
  try {
    const noSlash = await fetch(at + '/test/path', { redirect: 'manual' });
    assert.equal(noSlash.status, 301);
    assert.equal(noSlash.headers.get('location'), '/test/path/');
    for (const p of ['/', '/test/', '/api/info', '/test/api/info']) assert.equal((await fetch(at + p)).status, 404, p);
    const html = await (await fetch(at + '/test/path/')).text();
    // the page asks for everything relative to itself, so it works under any base
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^(data:|https?:)/.test(m[1])) assert.ok(!m[1].startsWith('/'), `${m[1]} is relative`);
    const main = await (await fetch(at + '/test/path/assets/main.js')).text();
    const chunk = /["'](\.\/chunks\/[^"']+\.js)["']/.exec(main)?.[1];
    assert.ok(chunk, 'main.js loads its chunks by relative path');
    assert.equal((await fetch(at + '/test/path/assets/' + chunk.slice(2))).status, 200, chunk);
    assert.equal((await fetch(at + '/test/path/api/info')).status, 200);
    assert.equal(await (await fetch(at + '/test/path/p/t/raw/src/b.ts')).text(), 'const b = 1;\n');
    assert.equal((await fetch(at + '/test/path/p/t/api/search?q=findMe')).status, 200);
    const ev = await fetch(at + '/test/path/api/events');
    assert.equal(ev.headers.get('content-type'), 'text/event-stream');
    await ev.body.cancel();
  } finally {
    await s.close();
  }
});

test('base paths: with or without slashes, a URL, and a path Git Bash rewrote', () => {
  for (const b of ['test/path', '/test/path', '/test/path/', 'test//path/', 'https://example.com/test/path']) assert.equal(normaliseBase(b), '/test/path/');
  assert.equal(normaliseBase(''), '/');
  assert.equal(normaliseBase('/'), '/');
  assert.throws(() => normaliseBase('C:/Program Files/Git/test/path'), /Git Bash/);
  assert.throws(() => normaliseBase('a/../b'), /\.\./);
  assert.throws(() => normaliseBase('a b'), /URL path/);
});

test('hitl notes prints the new, open or all notes; resolve and reply from the CLI', () => {
  const run = (...a) => execFileSync(process.execPath, [cli, ...a, '-C', root], { encoding: 'utf8', env: { ...process.env } });
  fs.rmSync(path.join(root, '.hitl', 'notes'), { recursive: true, force: true });
  assert.match(run('notes'), /No new notes/);
  const n = new Notes(path.join(root, '.hitl', 'notes'), root);
  const c = n.add({ path: 'src/b.ts', line: 1, body: 'Rename b.', author: 'Phil' });
  const out = run('notes');
  assert.match(out, new RegExp(`note ${c.id} on src/b\\.ts:1: "Rename b\\."`));
  assert.match(out, /lines: "const b = 1;"/);
  assert.match(run('notes'), /No new notes/, 'reading marks them read');
  assert.match(run('reply', '--note', c.id, 'On', 'it'), new RegExp(`Replied on note ${c.id}`));
  assert.match(run('resolve', c.id, '--note', 'Renamed it'), new RegExp(`Resolved ${c.id}`));
  assert.match(run('notes', '--open'), /No open notes/);
  const all = run('notes', '--all');
  assert.match(all, /\[resolved\]/);
  assert.match(all, /you: "Renamed it"/);
  assert.match(run('notes'), /No new notes/, "the agent's own replies aren't news");
});
