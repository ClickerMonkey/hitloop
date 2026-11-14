#!/usr/bin/env node
// hitl — Human In The Loop: an agent asks, shows and asks for approval; you answer, review and browse on your phone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StoreError, ensureReadme } from './hub/atomic.js';
import { start, version } from './server.js';
import { describeSet, readAnswers, FILTERS, type Filter } from './q/agent.js';
import { decisionsText, news, newsCounts, openProject, overviewText, parseDuration, readFeedback, readNotes, waitFor, type ProjectView, type ReviewFilter, type WaitFor } from './agent.js';
import { clearHubState, configDir, ensureHub, forget, hubToken, keyed, links, projects, projectsPath, register, runningHub, normaliseBase, userConfig, userConfigPath, updateUserConfig, writeHubState } from './hub/registry.js';
import { setSchema } from './q/schema.js';
import { reviewSchema } from './r/schema.js';
import { serveMcp, defaultFrom } from './mcp.js';
import { normalise as normaliseSet } from './q/model.js';
import { normalise as normaliseReview } from './r/model.js';
import { Notifier, linkBase, notifyConfig, notifyEnabled, send } from './hub/notify.js';
import { projectSettings } from './settings.js';
import type { ProjectSettings } from './workspace.js';
import type { ItemArg } from './r/store.js';
import { hookStatus, launcher, setHooks } from './hooks.js';

const PORT = 4199;

const HELP = `hitl ${version} — Human In The Loop: an agent asks, shows and asks for approval; you answer, review
and browse the project on your phone or computer, and it reads what you said.

Serve the page:
  hitl [options]                    one server for every project (the hub); adds this folder
  hitl --solo [folder]              just this folder, on its own server
      -p, --port <n>       port to try first (default ${PORT})
      -H, --host <addr>    address to listen on (default 0.0.0.0: your phone can reach it, with a token)
          --local          only this computer (127.0.0.1, no token)
          --base <path>    serve under a URL path, e.g. hitl or team/hitl (behind a proxy; in Git Bash leave
                           off the leading /, or it becomes a Windows path)
          --token <t>      use this token (default: one made once, kept in ${tildeOf(configDir())})
          --no-token       no token (anyone on your network can open it)
          --allow-host <h> accept this host name too (repeatable; * for any)
      -o, --open           open it in your browser
          --read-only      look, don't answer or comment
  File browsing (every project; a project's .hitl/config.json and .hitlignore can add to these):
      -x, --exclude <globs>  never show, serve, search or zip these (comma-separated, repeatable)
          --hide <names>     exact names to hide everywhere (.git always is)
          --show-secrets     show .env*, *.key, *.pem and id_rsa-style files
          --max-file-mb <n>  larger files aren't shown as text or searched (default 5)
          --no-git           don't use git        --no-watch   no live updates
          --author <name>    the name on your notes (default: git user.name)

For agents (and you), in a project folder (or -C <folder>):
  hitl status                                   every review, question set and note, with counts
  hitl news [--peek] [--ids a,b]                everything the human said since you last read (marks it read)
  hitl wait [--any|--done|--all|--blocking] [ids…] [--timeout 30m] [--settle 30s]
                                                exit once the human has said something, printing the news
  hitl show <path…> [--title t] [--intro md] [--note md] [--mode review|show] [--to <review>]
            [--lines 10-40] [--against HEAD] [--lang ts --name x.ts]   ("-" reads stdin as code or text)
                                                put files (or stdin) in front of the human; prints the link
  hitl approve "<question>" [path…] [--details md] [--timeout 10m]
                                                ask yes or no; exits 0 approved, 1 refused or changes asked, 2 no answer yet
  hitl feedback <review> [--new|--all|--open] [--peek] [--json]
  hitl ask <set> --file <questions.json>        add questions to a set (or write .hitl/questions/<set>.json)
  hitl show-set <set> [--full]                  a question set, one line per question
  hitl answers <set> [--new|--all|--unacked|--changed|--blocking|--open] [--ids a,b] [--peek] [--json]
  hitl notes [--new|--open|--all] [--peek]      notes the human wrote on files, lines, pictures
  hitl reply <set> <question> <message…>        write on a question's thread
  hitl reply <review> <comment> <message…>      reply to a review comment (c12)
  hitl reply --note <id> <message…>             reply to a note
  hitl ack <set|review> <id…> --note "…"        answers / verdicts dealt with (the human sees the note)
  hitl resolve [<review>] <id…> --note "…"      resolve review comments, or notes (no review), saying what you did
  hitl close <review|set>                       close it (it drops to the bottom of the list)
  hitl decisions [words…] [--limit n]           what the human decided before, newest first
  hitl validate [id|file…]                      check question sets and reviews against their formats
  hitl schema [questions|reviews]               the formats, as JSON Schema
  hitl url [review|set]                         links to the page (starts the hub if needed)

Setup:
  hitl init [--hook] [--stop-hook] [--no-mcp] [--no-claude-md]
                     set up the folder, the MCP server for Claude Code, and a note in CLAUDE.md
                     --hook: tell Claude about news whenever you send it a message
                     --stop-hook: don't let Claude finish while a blocking question or approval is waiting
  hitl hooks [on|off] [--stop]                  turn those hooks on or off later
  hitl import [folder]                          bring in .questionme/ (questions, answers) and .review/ (notes)
  hitl stop                                     stop the hub
  hitl projects [--forget <folder>]             the folders the hub serves
  hitl notify [ntfy [url]|webhook <url>|link <url>|test|off]
                                                push notifications to your phone (the ntfy app, or a webhook)
  hitl hook [prompt|stop]                       the Claude Code hooks themselves (prompt: news; stop: the gate)
  hitl mcp                                      the MCP server, on stdio

Everything lives in <project>/.hitl/: questions/, reviews/, answers/, notes/, media/.`;

function tildeOf(p: string): string {
  return p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;
}

function fail(msg: string, code = 1): never {
  console.error(`hitl: ${msg}`);
  process.exit(code);
}

// ── arguments ──

interface Args {
  cmd: string;
  pos: string[];
  flags: Map<string, string | true>;
}

const VALUED = new Set([
  '--base', '-p', '--port', '-H', '--host', '--token', '--allow-host', '-C', '--folder', '--timeout', '--settle', '--ids', '--section', '--limit', '--offset', '--note', '--forget', '--questions',
  '-x', '--exclude', '--hide', '--max-file-mb', '--author', '--title', '--intro', '--mode', '--to', '--lines', '--against', '--lang', '--name', '--details', '--file', '--from',
]);
const BOOLEAN = new Set([
  '-h', '--help', '-v', '--version', '--solo', '--background', '--local', '--no-token', '-o', '--open', '--read-only', '--json', '--full', '--peek', '--all', '--new', '--unacked', '--changed',
  '--blocking', '--any', '--done', '--quiet', '--hook', '--stop-hook', '--stop', '--no-mcp', '--no-claude-md', '--show-secrets', '--no-git', '--no-watch', '--open-only',
]);
const REPEAT = new Set(['--allow-host', '--ids', '-x', '--exclude', '--hide']);
const COMMANDS = new Set([
  'serve', 'init', 'status', 'news', 'wait', 'show', 'review', 'approve', 'feedback', 'ask', 'show-set', 'answers', 'notes', 'reply', 'ack', 'resolve', 'close', 'decisions', 'validate', 'schema', 'url', 'stop',
  'projects', 'notify', 'hook', 'hooks', 'import', 'mcp', 'help', 'list',
]);

function parse(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  let cmd = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (VALUED.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) fail(`${name} needs a value`);
        const prev = flags.get(name);
        flags.set(name, typeof prev === 'string' && REPEAT.has(name) ? `${prev},${v}` : v);
      } else if (BOOLEAN.has(name)) flags.set(name, true);
      else fail(`unknown option ${name} (hitl --help lists every command and option)`);
      continue;
    }
    if (!cmd && !pos.length && COMMANDS.has(a)) cmd = a;
    else pos.push(a);
  }
  return { cmd: cmd || 'serve', pos, flags };
}

const args = parse(process.argv.slice(2));
const flag = (...names: string[]) => names.some((n) => args.flags.has(n));
const value = (...names: string[]) => {
  for (const n of names) {
    const v = args.flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
};
const folder = () => path.resolve(value('-C', '--folder') ?? process.cwd());
const project = (): ProjectView => openProject(folder());
const need = (v: string | undefined, what: string) => v || fail(`which ${what}? (see hitl --help)`);

if (flag('-h', '--help') || args.cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}
if (flag('-v', '--version')) {
  console.log(version);
  process.exit(0);
}

async function run(): Promise<void> {
  switch (args.cmd) {
    case 'serve':
      return serve();
    case 'mcp':
      return serveMcp();
    case 'init':
      return init();
    case 'status':
    case 'list':
      if (flag('--json')) {
        const p = project();
        return void console.log(JSON.stringify({ folder: p.root, reviews: p.reviews.summaries(), questions: p.questions.summaries(), notes: { open: p.notes.all().filter((c) => c.status === 'open').length, total: p.notes.all().length }, news: newsCounts(p) }, null, 2));
      }
      return void console.log(overviewText(project()));
    case 'news':
      return void console.log(news(project(), { peek: flag('--peek'), ids: list(value('--ids')) }).text);
    case 'wait':
      return wait();
    case 'show':
    case 'review':
      return show();
    case 'approve':
      return approve();
    case 'feedback': {
      const filter: ReviewFilter = flag('--all') ? 'all' : flag('--open') ? 'open' : 'new';
      const r = readFeedback(project().reviews, need(args.pos[0], 'review'), { filter, peek: flag('--peek') });
      return void console.log(flag('--json') ? JSON.stringify(r.data, null, 2) : r.text);
    }
    case 'ask':
      return ask();
    case 'show-set':
      return void console.log(describeSet(project().questions, need(args.pos[0], 'set'), { full: flag('--full'), section: value('--section'), limit: num(value('--limit')), offset: num(value('--offset')), ids: list(value('--ids')) }));
    case 'answers': {
      const filter = (FILTERS.find((f) => flag('--' + f)) ?? 'new') as Filter;
      const r = readAnswers(project().questions, need(args.pos[0], 'set'), {
        filter,
        ids: list(value('--ids')),
        section: value('--section'),
        limit: num(value('--limit')),
        offset: num(value('--offset')),
        peek: flag('--peek'),
        questions: (['none', 'short', 'full'].includes(value('--questions') ?? '') ? value('--questions') : undefined) as 'none' | undefined,
      });
      return void console.log(flag('--json') ? JSON.stringify(r.data, null, 2) : r.text);
    }
    case 'notes': {
      const f = flag('--open') ? 'open' : flag('--all') ? 'all' : 'new';
      const r = readNotes(project().notes, { filter: f, peek: flag('--peek') });
      return void console.log(r.count ? r.text : f === 'new' ? 'No new notes.' : `No ${f} notes.`);
    }
    case 'reply':
      return reply();
    case 'ack': {
      const [id, ...ids] = args.pos;
      const p = project();
      const target = need(id, 'set or review');
      const done = p.reviews.has(target) ? p.reviews.ack(target, ids, value('--note') ?? '') : p.questions.ack(target, ids, value('--note') ?? '');
      return void console.log(done.length ? `Marked ${done.length} done: ${done.join(', ')}` : 'None of those have answers or verdicts.');
    }
    case 'resolve': {
      const p = project();
      const [first, ...rest] = args.pos;
      const status = flag('--open') ? 'open' : 'resolved';
      const done = first && p.reviews.has(first) ? p.reviews.setStatus(first, rest, status, 'agent', value('--note') ?? '') : p.notes.resolve(args.pos, value('--note') ?? '', status);
      return void console.log(done.length ? `${status === 'open' ? 'Reopened' : 'Resolved'} ${done.join(', ')}.` : 'None of those ids were found.');
    }
    case 'close': {
      const p = project();
      const id = need(args.pos[0], 'review or set');
      if (p.reviews.has(id)) p.reviews.update(id, { status: 'closed' });
      else if (p.questions.has(id)) p.questions.updateSet(id, { status: 'closed' });
      else fail(`no review or question set "${id}"`);
      return void console.log(`Closed ${id}.`);
    }
    case 'decisions':
      return void console.log(decisionsText(project(), { q: args.pos.join(' '), limit: num(value('--limit')) ?? 100 }));
    case 'validate':
      return validate();
    case 'schema': {
      const which = args.pos[0] ?? 'questions';
      if (which !== 'questions' && which !== 'reviews') fail('hitl schema questions | reviews');
      return void console.log(JSON.stringify(which === 'reviews' ? reviewSchema : setSchema, null, 2));
    }
    case 'url': {
      const root = folder();
      if (fs.existsSync(path.join(root, '.hitl'))) register(root);
      const hub = await ensureHub();
      const key = keyed(projects()).find((k) => same(k.root, root))?.key;
      const id = args.pos[0];
      const p = project();
      const where = id ? (p.reviews.has(id) ? `/r/${encodeURIComponent(id)}` : `/q/${encodeURIComponent(id)}`) : '';
      const hash = key ? `#/p/${encodeURIComponent(key)}${where}` : '';
      for (const l of links(hub.port, hub.host, hub.token, hash, hub.base)) console.log(l);
      return;
    }
    case 'stop': {
      const hub = await runningHub();
      if (!hub) return void console.log('The hitl hub is not running.');
      try {
        process.kill(hub.pid);
        console.log(`Stopped the hitl hub (pid ${hub.pid}, port ${hub.port}).`);
      } catch (e) {
        fail(`couldn't stop pid ${hub.pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    case 'projects': {
      const f = value('--forget');
      if (f) return void console.log(forget(path.resolve(f)) ? `Forgot ${path.resolve(f)}.` : `${path.resolve(f)} wasn't in the list.`);
      const all = keyed(projects());
      if (!all.length) return void console.log(`No projects yet (${tildeOf(projectsPath())}).`);
      for (const p of all) {
        const v = fs.existsSync(p.root) ? openProject(p.root) : undefined;
        const n = v ? `${v.reviews.ids().length} reviews, ${v.questions.ids().length} question sets` : '(missing)';
        console.log(`${p.key.padEnd(20)} ${tildeOf(p.root)}  ${n}`);
      }
      return;
    }
    case 'hook':
      return hook();
    case 'hooks':
      return hooks();
    case 'notify':
      return notify();
    case 'import':
      return importOld();
  }
}

// ── serve ──

async function serve(): Promise<void> {
  const cfg = userConfig();
  const solo = flag('--solo');
  const background = flag('--background');
  const local = flag('--local');
  const port = num(value('-p', '--port') ?? process.env['HITL_PORT']) ?? cfg.port ?? PORT;
  const host = value('-H', '--host') ?? process.env['HITL_HOST'] ?? (local ? '127.0.0.1' : (cfg.host ?? '0.0.0.0'));
  const token = flag('--no-token') || (local && !value('--token')) ? '' : (value('--token') ?? process.env['HITL_TOKEN'] ?? (cfg.token === false ? '' : (cfg.token ?? hubToken())));
  const allowHosts = [...(cfg.allowHosts ?? []), ...list(value('--allow-host'))];
  const base = normaliseBase(value('--base') ?? process.env['HITL_BASE'] ?? cfg.base ?? '/', value('--base') ? 'command line' : process.env['HITL_BASE'] ? 'HITL_BASE' : 'config.json');
  const root = path.resolve(args.pos[0] ?? value('-C', '--folder') ?? process.cwd());
  const overrides: Partial<ProjectSettings> = {};
  if (value('-x', '--exclude')) overrides.exclude = list(value('-x', '--exclude'));
  if (value('--hide')) overrides.hide = list(value('--hide'));
  if (flag('--show-secrets')) overrides.showSecrets = true;
  if (value('--max-file-mb')) overrides.maxFileMb = num(value('--max-file-mb')) ?? 5;
  if (flag('--no-git')) overrides.git = false;
  if (flag('--no-watch')) overrides.watch = false;
  if (value('--author')) overrides.author = value('--author') ?? '';
  if (flag('--read-only')) overrides.readOnly = true;

  if (!solo) {
    if (args.pos[0] || !isHome(root)) register(root);
    const running = await runningHub();
    if (running) {
      if (background) return;
      const key = keyed(projects()).find((k) => same(k.root, root))?.key;
      console.log(`hitl is already running (pid ${running.pid}):`);
      for (const l of links(running.port, running.host, running.token, key ? `#/p/${encodeURIComponent(key)}` : '', running.base)) console.log('  ' + l);
      if ((running.base ?? '/') !== base) console.log(`  (it serves under ${running.base ?? '/'}, not ${base}: hitl stop, then start it again to change that)`);
      console.log('  (hitl stop to stop it)');
      return;
    }
  }

  const time = () => new Date().toLocaleTimeString();
  const served = solo ? () => [{ key: keyFor(root), root }] : () => keyed(projects()).filter((p) => fs.existsSync(p.root));
  let listening = port;
  const views = new Map<string, ProjectView>();
  const viewOf = (key: string) => {
    const p = served().find((x) => x.key === key);
    if (!p) return undefined;
    let v = views.get(key);
    if (!v || v.root !== path.resolve(p.root)) views.set(key, (v = openProject(p.root)));
    return v;
  };
  const notifier = new Notifier(viewOf, () => listening, token, base, (line) => console.log(`[${time()}] ${line}`));
  for (const p of served()) notifier.baseline(p.key);
  const running = await start({
    mode: solo ? 'solo' : 'hub',
    projects: served,
    ...(solo ? {} : { watchList: projectsPath() }),
    port,
    host,
    base,
    token,
    allowHosts,
    settings: (r) => projectSettings(r, overrides),
    onRequest: (key, c) => {
      const v = viewOf(key);
      if (c.side === 'human' && v) {
        const n = newsCounts(v);
        if (n.total) console.log(`[${time()}] ${key}: ${n.total} new from the human (${[n.reviews && `${n.reviews} on reviews`, n.questions && `${n.questions} answers`, n.notes && `${n.notes} notes`].filter(Boolean).join(', ')})  → npx hitloop news`);
      } else if (c.side === 'agent') console.log(`[${time()}] ${key}: ${c.kind === 'review' ? 'review' : 'questions'} ${c.id} changed`);
      notifier.observe(key, c.kind, c.id);
    },
    onProject: (key) => notifier.baseline(key),
  });
  listening = running.port;
  if (!solo) writeHubState({ pid: process.pid, port: running.port, host, token, base, version, started: new Date().toISOString() });

  const key = solo ? keyFor(root) : keyed(projects()).find((k) => same(k.root, root))?.key;
  const hash = key ? `#/p/${encodeURIComponent(key)}` : '';
  console.log(`hitl ${version} (Human In The Loop) — ${solo ? root : `${projects().length} project${projects().length === 1 ? '' : 's'} (${tildeOf(projectsPath())})`}`);
  for (const l of links(running.port, host, token, hash, base)) console.log('  ' + l);
  if (host === '127.0.0.1') console.log('  (only this computer: drop --local to use it from your phone)');
  if (!token && host !== '127.0.0.1') console.log('  (no token: anyone on your network can open it)');
  if (!background && fs.existsSync(path.join(root, '.hitl'))) console.log('  ' + overviewText(openProject(root)).split('\n').join('\n  '));
  const n = notifyConfig(cfg);
  console.log(notifyEnabled(n) ? `  notifications: ${[n.ntfy ? 'ntfy' : '', n.webhook ? 'webhook' : ''].filter(Boolean).join(' + ')} (hitl notify test)` : '  notifications: off (hitl notify ntfy puts them on your phone)');
  console.log('  every command and option: npx hitloop --help');
  if (flag('-o', '--open')) openBrowser(links(running.port, host, token, hash, base)[0] ?? '');

  const stop = () => {
    if (!solo) clearHubState(process.pid);
    void running.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => !solo && clearHubState(process.pid));
}

function keyFor(root: string): string {
  return (
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

const isHome = (p: string) => same(p, os.homedir());

function same(a: string, b: string): boolean {
  const n = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url.replace(/&/g, '^&')] : [url];
  spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
}

async function linkLines(root: string, where: string): Promise<string[]> {
  register(root);
  try {
    const hub = await ensureHub();
    const key = keyed(projects()).find((k) => same(k.root, root))?.key ?? '';
    return links(hub.port, hub.host, hub.token, key ? `#/p/${encodeURIComponent(key)}${where}` : '', hub.base);
  } catch (e) {
    return [`(couldn't start the hitl server: ${e instanceof Error ? e.message : String(e)})`];
  }
}

// ── show / approve / ask ──

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function itemsFromArgs(): ItemArg[] {
  const note = value('--note');
  const items: ItemArg[] = [];
  for (const a of args.pos.slice(args.cmd === 'approve' ? 1 : 0)) {
    if (a === '-') {
      const text = readStdin();
      const lang = value('--lang');
      const name = value('--name');
      items.push(lang || name ? { code: text, ...(lang ? { lang } : {}), ...(name ? { name } : {}) } : /^(---|diff --git) /m.test(text) && /^@@ /m.test(text) ? { diff: text } : { text });
      continue;
    }
    if (/^https?:\/\//.test(a)) {
      items.push(/\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(a) ? { image: a } : { link: a });
      continue;
    }
    const abs = path.resolve(a);
    if (!fs.existsSync(abs)) fail(`no such file: ${a}`);
    const rel = path.relative(folder(), abs).split(path.sep).join('/');
    if (rel.startsWith('..')) fail(`${a} is outside the project (${folder()})`);
    if (fs.statSync(abs).isDirectory()) fail(`${a} is a folder: name the files (or use a glob your shell expands)`);
    items.push({ file: rel, ...(value('--lines') ? { lines: value('--lines') } : {}), ...(value('--against') ? { against: value('--against') } : {}) });
  }
  if (note && items[0]) items[0].note = note;
  return items;
}

async function show(): Promise<void> {
  const p = project();
  const items = itemsFromArgs();
  if (!items.length) fail('what should it show? hitl show <path…> (or - for stdin)');
  const to = value('--to');
  const from = value('--from') ?? defaultFrom(p.root);
  let id: string;
  if (to) {
    const r = p.reviews.addItems(to, items);
    id = to;
    console.log(`Added ${r.ids.length} to "${to}": ${r.ids.join(', ')}`);
  } else {
    const mode = value('--mode') === 'show' || (args.cmd === 'show' && value('--mode') !== 'review') ? 'show' : 'review';
    const r = p.reviews.create({ title: value('--title') ?? (items.length === 1 ? (items[0]?.file ?? 'Review') : `${items.length} things to review`), ...(value('--intro') ? { intro: value('--intro') } : {}), mode, ...(from ? { from } : {}) }, items);
    id = r.id;
    console.log(`Made ${mode === 'show' ? 'a showing' : 'a review'} "${r.id}": ${r.ids.join(', ')}`);
    for (const e of [...r.normalised.errors, ...r.normalised.warnings]) console.log('  ' + e);
  }
  for (const l of await linkLines(p.root, `/r/${encodeURIComponent(id)}`)) console.log('  ' + l);
  console.log(`Read what they say: npx hitloop feedback ${id}   (wait: npx hitloop wait --done ${id})`);
}

async function approve(): Promise<void> {
  const p = project();
  const question = need(args.pos[0], 'question');
  const from = value('--from') ?? defaultFrom(p.root);
  const r = p.reviews.create({ title: question, ...(value('--details') ? { intro: value('--details') } : {}), mode: 'approve', ...(from ? { from } : {}) }, itemsFromArgs());
  console.log(`Asked "${r.id}": ${question}`);
  for (const l of await linkLines(p.root, `/r/${encodeURIComponent(r.id)}`)) console.log('  ' + l);
  const ctl = new AbortController();
  process.on('SIGINT', () => ctl.abort());
  const ok = await waitFor(p, { until: 'done', ids: [r.id], timeoutMs: parseDuration(value('--timeout'), 0), signal: ctl.signal });
  const fb = p.reviews.feedback(r.id);
  if (!ok || !fb.overall) {
    console.log(`No answer yet. Wait again: npx hitloop wait --done ${r.id}`);
    process.exit(2);
  }
  p.reviews.markRead(r.id);
  const v = fb.overall.verdict;
  console.log(`${v === 'ok' ? 'APPROVED' : v === 'no' ? 'REFUSED' : 'NOT YET: changes asked for'}${fb.overall.note ? ` — "${fb.overall.note}"` : ''}`);
  process.exit(v === 'ok' ? 0 : 1);
}

async function ask(): Promise<void> {
  const p = project();
  const set = need(args.pos[0], 'set');
  if (p.reviews.has(set)) fail(`"${set}" is a review's id; pick another set id`);
  const file = value('--file');
  const raw = file === '-' || !file ? readStdin() : fs.readFileSync(file, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail(`not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const qs = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { questions?: unknown }).questions) ? (data as { questions: unknown[] }).questions : [data];
  const from = value('--from') ?? defaultFrom(p.root);
  const { ids, normalised } = p.questions.addQuestions(set, qs as never[], value('--section'), { title: value('--title'), from });
  console.log(`Added ${ids.length} question${ids.length === 1 ? '' : 's'} to "${set}": ${ids.join(', ')}`);
  for (const e of [...normalised.errors, ...normalised.warnings]) console.log('  ' + e);
  for (const l of await linkLines(p.root, `/q/${encodeURIComponent(set)}`)) console.log('  ' + l);
}

function reply(): void {
  const p = project();
  const note = value('--note');
  if (note) {
    const c = p.notes.reply(note, 'agent', args.pos.join(' '), 'agent');
    return void console.log(c ? `Replied on note ${note}.` : `No note "${note}".`);
  }
  const [target, id, ...words] = args.pos;
  const t = need(target, 'set or review');
  const msg = words.join(' ');
  if (!msg) fail('what should the reply say?');
  if (p.reviews.has(t)) {
    if (id && /^c\d+$/.test(id)) p.reviews.reply(t, id, 'agent', msg);
    else p.reviews.comment(t, { item: id ?? '', body: msg }, 'agent');
  } else p.questions.message(t, need(id, 'question'), 'agent', msg);
  console.log(`Replied on ${id}.`);
}

// ── wait ──

async function wait(): Promise<void> {
  const p = project();
  const until: WaitFor = flag('--done') ? 'done' : flag('--all') ? 'all' : flag('--blocking') ? 'blocking' : 'any';
  const ids = [...args.pos, ...list(value('--ids'))];
  const timeoutMs = parseDuration(value('--timeout'), 0);
  const settleMs = parseDuration(value('--settle'), until === 'any' ? 30_000 : 0);
  const ctl = new AbortController();
  process.on('SIGINT', () => ctl.abort());
  process.on('SIGTERM', () => ctl.abort());
  if (!flag('--quiet')) console.log(`Waiting for ${until === 'any' ? 'anything new' : until === 'done' ? 'the human to finish' : until === 'all' ? 'every item and question' : 'the blocking questions'}${ids.length ? ` on ${ids.join(', ')}` : ' in ' + p.root}…`);
  const ok = await waitFor(p, { until, ids, timeoutMs, settleMs, signal: ctl.signal });
  if (!ok) {
    console.log(ctl.signal.aborted ? 'Stopped waiting.' : `Still waiting after ${value('--timeout')}.`);
    console.log(news(p, { peek: true, ids }).text);
    process.exit(2);
  }
  console.log('The human has spoken. New since you last read:');
  console.log(news(p, { peek: flag('--peek'), ids }).text);
}

// ── validate ──

function validate(): void {
  const p = project();
  const targets = args.pos.length ? args.pos : [...p.questions.ids(), ...p.reviews.ids()];
  if (!targets.length) return void console.log(`Nothing in ${path.join(p.root, '.hitl')} to check.`);
  let bad = 0;
  for (const t of targets) {
    const isFile = t.endsWith('.json') && fs.existsSync(t);
    const id = isFile ? path.basename(t, '.json') : t;
    let errors: string[] = [],
      warnings: string[] = [],
      what = '';
    const asReview = isFile ? /[\\/]reviews[\\/]/.test(path.resolve(t)) || (() => { try { return 'items' in JSON.parse(fs.readFileSync(t, 'utf8')); } catch { return false; } })() : p.reviews.has(id);
    try {
      if (asReview) {
        const n = isFile ? normaliseReview(id, JSON.parse(fs.readFileSync(t, 'utf8'))) : p.reviews.load(id);
        if (!n) throw new Error('no such review');
        ({ errors, warnings } = n);
        what = `review, ${n.review.items.length} items`;
      } else {
        const n = isFile ? normaliseSet(id, JSON.parse(fs.readFileSync(t, 'utf8'))) : p.questions.load(id);
        if (!n) throw new Error('no such question set or review');
        ({ errors, warnings } = n);
        what = `questions, ${n.set.sections.reduce((s, x) => s + x.questions.length, 0)} of them`;
      }
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
    }
    console.log(`${errors.length ? '✗' : '✓'} ${id}${what ? ` (${what})` : ''}: ${errors.length} errors, ${warnings.length} warnings`);
    for (const e of errors) console.log('  error: ' + e);
    for (const w of warnings) console.log('  warning: ' + w);
    if (errors.length) bad++;
  }
  if (bad) process.exit(1);
}

// ── notify ──

async function notify(): Promise<void> {
  const [what, arg] = args.pos;
  const hubPort = () => readHub()?.port ?? PORT;
  const show = () => {
    const n = notifyConfig();
    console.log(`Notifications (${tildeOf(userConfigPath())}):`);
    console.log(`  ntfy:    ${n.ntfy ?? '(off)'}`);
    console.log(`  webhook: ${n.webhook ?? '(off)'}`);
    console.log(`  links:   ${linkBase(n, hubPort(), '', readHub()?.base)}  (hitl notify link <url> to change)`);
    console.log(`  batched: sent once agents have been quiet for ${n.quietSeconds ?? 20} s (approvals: at once)`);
    if (!notifyEnabled(n)) console.log('\nTurn them on: hitl notify ntfy   (then subscribe in the ntfy app)');
  };
  const test = async () => {
    const n = notifyConfig();
    if (!notifyEnabled(n)) fail('notifications are off: hitl notify ntfy (or webhook <url>) first');
    await send(n, { title: 'hitl: notifications work', message: "You'll get one when an agent asks you something, shows you something, or waits for your OK.", url: linkBase(n, hubPort(), '', readHub()?.base), project: '', request: '', kind: 'test', newQuestions: 0, newItems: 0, approval: false, blocking: 0, replies: 0 });
    console.log('Sent a test notification.');
  };
  switch (what) {
    case undefined:
      return show();
    case 'ntfy': {
      const url = arg ?? `https://ntfy.sh/hitl-${crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (!/^https?:\/\/[^/]+\/[^/]+/.test(url)) fail('an ntfy topic URL looks like https://ntfy.sh/your-topic');
      updateUserConfig((c) => (c.notify = { ...c.notify, ntfy: url }));
      console.log(`✓ ntfy topic: ${url}`);
      console.log('  On your phone: install the ntfy app (Android or iOS), tap +, and subscribe to');
      console.log(`  the topic "${new URL(url).pathname.slice(1)}"${new URL(url).host === 'ntfy.sh' ? '' : ` on the server ${new URL(url).origin}`}.`);
      console.log('  Anyone who knows the topic can read it: notifications say what is waiting, never your answers.');
      return test();
    }
    case 'webhook':
      if (!arg || !/^https?:\/\//.test(arg)) fail('hitl notify webhook <https://…>');
      updateUserConfig((c) => (c.notify = { ...c.notify, webhook: arg }));
      console.log(`✓ webhook: ${arg}`);
      return test();
    case 'link':
      if (!arg || !/^https?:\/\//.test(arg)) fail('hitl notify link <http://host:port> (where your phone opens hitl)');
      updateUserConfig((c) => (c.notify = { ...c.notify, link: arg }));
      return show();
    case 'test':
      return test();
    case 'off':
      updateUserConfig((c) => {
        if (c.notify) {
          delete c.notify.ntfy;
          delete c.notify.webhook;
        }
      });
      return void console.log('Notifications are off.');
  }
  fail('hitl notify [ntfy [url]|webhook <url>|link <url>|test|off]');
}

function readHub() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), 'hub.json'), 'utf8')) as { port: number; base?: string };
  } catch {
    return undefined;
  }
}

// ── hooks for Claude Code (opt-in) ──

/** `hitl hook` (or `hook prompt`): news for Claude when you send a message. `hook stop`: the gate before it finishes. */
function hook(): void {
  const p = project();
  if (!fs.existsSync(path.join(p.root, '.hitl'))) return;
  if (args.pos[0] === 'stop') return stopHook(p);
  const c = newsCounts(p);
  if (!c.total) return;
  const parts = [c.reviews && `${c.reviews} on reviews`, c.questions && `${c.questions} answers`, c.notes && `${c.notes} notes`].filter(Boolean);
  console.log(`hitl: the human has said ${c.total} new thing${c.total === 1 ? '' : 's'} (${parts.join(', ')}). Read them with the news tool or \`npx hitloop news\`.`);
}

function stopHook(p: ProjectView): void {
  let input: { stop_hook_active?: boolean } = {};
  try {
    input = JSON.parse(readStdin() || '{}') as typeof input;
  } catch {
    input = {};
  }
  // already kept going once because of this hook: let it stop, so it can't loop
  if (input.stop_hook_active) return;
  const reasons: string[] = [];
  const c = newsCounts(p);
  if (c.total) reasons.push(`the human said ${c.total} new thing${c.total === 1 ? '' : 's'} you haven't read (npx hitloop news)`);
  const gates = p.reviews.summaries().filter((s) => s.mode === 'approve' && s.status === 'open' && !s.done);
  if (gates.length) reasons.push(`${gates.length} approval${gates.length === 1 ? ' is' : 's are'} still waiting (${gates.map((g) => g.id).join(', ')}): wait for ${gates.length === 1 ? 'it' : 'them'} with \`npx hitloop wait --done ${gates.map((g) => g.id).join(' ')}\` before doing what needs the OK`);
  const blocking = p.questions.summaries().filter((s) => s.status === 'open' && s.blocking > 0);
  if (blocking.length) reasons.push(`blocking questions are unanswered in ${blocking.map((s) => s.id).join(', ')}: wait with \`npx hitloop wait --blocking ${blocking.map((s) => s.id).join(' ')}\``);
  if (!reasons.length) return;
  console.log(JSON.stringify({ decision: 'block', reason: `hitl: before you finish, ${reasons.join('; and ')}.` }));
}

function hooks(): void {
  const root = folder();
  const what = args.pos[0];
  if (what !== 'on' && what !== 'off') {
    const h = hookStatus(root);
    console.log(`News hook: ${h.prompt ? 'on' : 'off'}`);
    console.log(`Stop hook: ${h.stop ? 'on' : 'off'}`);
    console.log('Turn on: hitl hooks on [--stop]   off: hitl hooks off [--stop]');
    return;
  }
  const on = what === 'on';
  for (const l of setHooks(root, flag('--stop') ? { stop: on } : { prompt: on })) console.log(l);
}

// ── init ──

const MARK_START = '<!-- hitl -->';
const MARK_END = '<!-- /hitl -->';
const SNIPPET = `${MARK_START}
## The human in the loop: hitl

Use hitl (Human In The Loop: the hitl MCP tools, or \`npx hitloop\`) to put things in front of the user on their phone
or computer instead of asking in chat:

- **More than about 4 questions**, or ones that need thought or pictures: \`add_questions\` (each with options, one
  recommended, and \`why\`; mark what you can't go on without as \`blocking\`).
- **Something to look at or review** (files, diffs, screenshots, mockups): \`show\` (mode "review" asks a verdict per
  item). Each call makes its own review.
- **A yes or no before something risky** (deploy, delete, spend): \`approve\`; it waits for the answer.
- Give the user the link the tool returns. Keep working on what doesn't depend on the answer; to wait, run
  \`npx hitloop wait --any\` (or \`--done <id>\`) in the background.
- Read what they said with \`news\` (or \`npx hitloop news\`): answers, verdicts, comments on lines and pictures, and notes
  they wrote on files. Then \`ack\` / \`resolve\` with a short note. Put their words into docs word for word.
- Check \`decisions\` before asking something they may have decided already. Say who's asking with \`from\`.
- \`npx hitloop --help\` lists every command and option; check it rather than guessing at flags.
${MARK_END}`;

function init(): void {
  const root = path.resolve(args.pos[0] ?? value('-C', '--folder') ?? process.cwd());
  const dir = path.join(root, '.hitl');
  for (const d of ['questions', 'reviews', 'answers']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  ensureReadme(dir);
  register(root);
  console.log(`✓ ${tildeOf(dir)}: questions/, reviews/, answers/ (the hub serves this folder now)`);

  if (!flag('--no-claude-md')) {
    const candidates = ['CLAUDE.md', 'AGENTS.md'].map((f) => path.join(root, f));
    const file = candidates.find((f) => fs.existsSync(f)) ?? path.join(root, 'CLAUDE.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
    const next = re.test(text) ? text.replace(re, SNIPPET) : (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + SNIPPET + '\n';
    if (next !== text) {
      fs.writeFileSync(file, next);
      console.log(`✓ ${path.basename(file)}: how to use hitl ${re.test(text) ? 'updated' : 'added'}`);
    } else console.log(`✓ ${path.basename(file)}: already says how to use hitl`);
  }

  const l = launcher();
  if (!flag('--no-mcp')) {
    const shell = process.platform === 'win32';
    const has = spawnSync('claude', ['mcp', 'get', 'hitl'], { stdio: 'pipe', shell, timeout: 30_000 });
    if (has.error || has.status === null) console.log(`- Claude Code not found. Add the MCP server yourself: claude mcp add --scope user hitl -- ${l.line} mcp`);
    else if (has.status === 0) console.log('✓ MCP server: hitl is already set up in Claude Code');
    else {
      const add = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'hitl', '--', ...[l.command, ...l.args, 'mcp'].map((a) => (shell && /\s/.test(a) ? `"${a}"` : a))], { stdio: 'pipe', shell, timeout: 30_000 });
      if (add.status === 0) console.log('✓ MCP server: added to Claude Code for all your projects (restart Claude Code to load it)');
      else console.log(`✗ MCP server: claude mcp add failed (${String(add.stderr || add.stdout).trim()}). Run: claude mcp add --scope user hitl -- ${l.line} mcp`);
    }
  }
  if (flag('--hook') || flag('--stop-hook')) for (const line of setHooks(root, { ...(flag('--hook') ? { prompt: true } : {}), ...(flag('--stop-hook') ? { stop: true } : {}) })) console.log(line);
  else console.log('- Hooks: off (hitl hooks on: news when you send a message; hitl hooks on --stop: a gate before Claude finishes)');
  if (fs.existsSync(path.join(root, '.questionme')) || fs.existsSync(path.join(root, '.review'))) console.log('- Found .questionme/ or .review/: hitl import brings them in');
  console.log('\nOpen it on your phone: npx hitloop  (or: hitl url)');
}

// ── import: questionme and folderview folders ──

function importOld(): void {
  const root = path.resolve(args.pos[0] ?? value('-C', '--folder') ?? process.cwd());
  const dir = path.join(root, '.hitl');
  let n = 0;
  const copyDir = (from: string, to: string, filter: (f: string) => boolean) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      if (!filter(f)) continue;
      const dest = path.join(to, f);
      if (fs.existsSync(dest)) {
        console.log(`  skipped ${path.relative(root, dest)} (already there)`);
        continue;
      }
      fs.copyFileSync(path.join(from, f), dest);
      n++;
    }
  };
  const qm = path.join(root, '.questionme');
  copyDir(path.join(qm, 'sets'), path.join(dir, 'questions'), (f) => f.endsWith('.json'));
  copyDir(path.join(qm, 'answers'), path.join(dir, 'answers'), (f) => f.endsWith('.json') || f.endsWith('.md'));
  const rv = path.join(root, '.review');
  const old = path.join(rv, 'comments.json');
  if (fs.existsSync(old)) {
    const notesDir = path.join(dir, 'notes');
    const target = path.join(notesDir, 'notes.json');
    let mine: { comments?: unknown[]; seq?: number; readSeq?: number } = {};
    try {
      mine = JSON.parse(fs.readFileSync(target, 'utf8')) as typeof mine;
    } catch {
      mine = {};
    }
    const theirs = (JSON.parse(fs.readFileSync(old, 'utf8')) as { comments?: { id: string }[] }).comments ?? [];
    const have = new Set((mine.comments ?? []).map((c) => (c as { id: string }).id));
    const add = theirs.filter((c) => !have.has(c.id));
    fs.mkdirSync(notesDir, { recursive: true });
    const comments = [...(mine.comments ?? []), ...add];
    fs.writeFileSync(target, JSON.stringify({ version: 1, seq: (mine.seq ?? 0) + add.length, readSeq: mine.readSeq ?? 0, comments }, null, 2) + '\n');
    copyDir(path.join(rv, 'images'), path.join(notesDir, 'images'), () => true);
    n += add.length;
    console.log(`  ${add.length} note${add.length === 1 ? '' : 's'} from .review/comments.json`);
  }
  ensureReadme(dir);
  register(root);
  console.log(n ? `✓ Imported ${n} file${n === 1 ? '' : 's'} and notes into ${tildeOf(dir)}. The old folders are untouched: delete them when you're happy.` : 'Nothing to import (no .questionme/ or .review/ here).');
}

// ── small helpers ──

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`not a number: ${v}`);
  return n;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}


// run last, once every helper above is defined
try {
  await run();
} catch (e) {
  fail(e instanceof StoreError || e instanceof Error ? e.message : String(e));
}
