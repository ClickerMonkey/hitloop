// One project the hub serves: its files (folderview's browsing, search, git and downloads), the human's notes on
// them, and the agent's question sets and reviews. Every route here is under p/<key>/.
//
// Watching a whole folder tree costs something, and a hub may serve dozens of projects, so a project's files are only
// watched while someone has it open (and for a few minutes after). Its .hitl folder is always watched: that's where
// agents' requests arrive.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { NOISE, RAW_TYPES, inside, isHidden, list, readText, serveRaw, toRel, type Scope } from './fs/files.js';
import { excluder, parseRules } from './fs/glob.js';
import { writeZip, ZIP_LIMITS } from './fs/zip.js';
import { Git, type Status } from './fs/git.js';
import { FileIndex } from './fs/search.js';
import { Notes, agentPrompt, type CommentStatus } from './fs/notes.js';
import { watchTree } from './fs/watch.js';
import { Questions } from './q/store.js';
import { Reviews } from './r/store.js';
import { VERDICTS, type Verdict } from './r/model.js';
import type { AnswerInput } from './q/model.js';
import { unifiedDiff } from './diff.js';
import { decisions } from './agent.js';
import { hookStatus, setHooks } from './hooks.js';
import { body, disposition, imageMarks, json, photos, posInt, str, strList, text } from './http.js';
import { StoreError } from './hub/atomic.js';

export interface ProjectSettings {
  exclude: string[];
  hide: string[];
  showSecrets: boolean;
  maxFileMb: number;
  git: boolean;
  watch: boolean;
  author: string;
  readOnly: boolean;
}

export const DEFAULT_SETTINGS: ProjectSettings = { exclude: [], hide: [], showSecrets: false, maxFileMb: 5, git: true, watch: true, author: '', readOnly: false };

export type Emit = (type: string, data: Record<string, unknown>) => void;

/** what a request (question set or review) did, for the hub's log and notifications */
export interface RequestChange {
  kind: 'questions' | 'review' | 'notes';
  id: string;
  /** the agent's side changed (the set or review file), or the human's (answers, notes) */
  side: 'agent' | 'human';
}

const IDLE_MS = 5 * 60_000;

export class Workspace {
  readonly scope: Scope;
  readonly notes: Notes;
  readonly questions: Questions;
  readonly reviews: Reviews;
  readonly index: FileIndex;
  readonly hitlDir: string;
  private gitP: Promise<Git | undefined> | undefined;
  private status: Promise<Status> | undefined;
  private stopTree: (() => void) | undefined;
  private stopHitl: (() => void) | undefined;
  private lastUse = 0;
  private idle: NodeJS.Timeout | undefined;
  private authorP: Promise<string> | undefined;
  private pending = new Map<string, NodeJS.Timeout>();
  private mtimes = new Map<string, number>();

  constructor(
    readonly key: string,
    readonly root: string,
    readonly settings: ProjectSettings,
    private readonly emit: Emit,
    private readonly onRequest: (c: RequestChange) => void = () => undefined,
  ) {
    this.root = path.resolve(root);
    this.hitlDir = path.join(this.root, '.hitl');
    const rules = [...settings.exclude, ...readIgnore(this.root)];
    this.scope = { root: this.root, hidden: new Set(['.git', ...settings.hide]), hideSecrets: !settings.showSecrets, excluded: excluder(parseRules(rules)) };
    this.index = new FileIndex(this.scope, undefined, settings.maxFileMb * 1048576);
    this.notes = new Notes(path.join(this.hitlDir, 'notes'), this.root);
    this.questions = new Questions(this.root);
    this.reviews = new Reviews(this.root);
    this.notes.onChange(() => {
      this.emit('notes', { project: this.key });
      this.onRequest({ kind: 'notes', id: 'notes', side: 'human' });
    });
    this.notes.watch();
    this.watchHitl();
  }

  get name(): string {
    return path.basename(this.root) || this.root;
  }

  git(): Promise<Git | undefined> {
    if (!this.settings.git) return Promise.resolve(undefined);
    return (this.gitP ??= Git.open(this.root).then((g) => {
      if (g) (this.index as unknown as { git: Git | undefined }).git = g;
      return g;
    }));
  }

  author(): Promise<string> {
    return (this.authorP ??= (async () => this.settings.author || (await (await this.git())?.userName().catch(() => '')) || os.userInfo().username || 'reviewer')());
  }

  private visible(rel: string): boolean {
    return !rel.split('/').some((p) => isHidden(this.scope, p)) && !this.scope.excluded(rel);
  }

  gitStatus(): Promise<Status> {
    return (this.status ??= this.git().then((git) => {
      if (!git) throw new Error('not a git repository');
      return git.status().then((s) => ({
        ...s,
        // hitl's own files are ours, not the project's: keep them out of the changes
        changes: s.changes.filter((c) => !c.path.startsWith('.hitl/') && this.visible(c.path)),
        ignored: s.ignored.filter((i) => this.visible(i.replace(/\/$/, ''))),
      }));
    }));
  }

  /** someone is looking at this project's files: watch them (until it's been quiet a while) */
  touch(): void {
    this.lastUse = Date.now();
    if (!this.stopTree && this.settings.watch) {
      void this.git().then((git) => {
        if (this.stopTree) return;
        this.stopTree = watchTree(this.root, git ? path.join(git.top, '.git') : undefined, (b) => {
          if (b.git) this.status = undefined;
          if (b.folders.length || b.files.length) this.index.invalidate();
          const files = b.files.filter((f) => !f.startsWith('.hitl/'));
          const folders = b.folders.filter((f) => f !== '.hitl' && !f.startsWith('.hitl/'));
          if (files.length || folders.length || b.git) this.emit('change', { project: this.key, folders, files, git: b.git });
        });
      });
    }
    if (!this.idle) {
      this.idle = setInterval(() => {
        if (Date.now() - this.lastUse < IDLE_MS) return;
        this.stopTree?.();
        this.stopTree = undefined;
        this.status = undefined;
        if (this.idle) clearInterval(this.idle);
        this.idle = undefined;
      }, 60_000);
      this.idle.unref();
    }
  }

  /** .hitl/questions, reviews and answers: tell the page (and the hub) what changed */
  private watchHitl(): void {
    const start = () => {
      if (this.stopHitl) return;
      try {
        const w = fs.watch(this.hitlDir, { recursive: true }, (_e, name) => {
          const rel = String(name ?? '').split(path.sep).join('/');
          const m = /^(questions|reviews|answers)\/([^/]+)\.json$/.exec(rel);
          if (m && m[1] && m[2]) this.check(m[1], m[2]);
        });
        w.on('error', () => undefined);
        this.stopHitl = () => w.close();
      } catch {
        this.stopHitl = () => undefined;
      }
      for (const id of this.questions.ids()) this.mtimes.set('questions/' + id, mtime(this.questions.setPath(id)));
      for (const id of this.reviews.ids()) this.mtimes.set('reviews/' + id, mtime(this.reviews.reviewPath(id)));
      for (const f of safeList(path.join(this.hitlDir, 'answers'))) if (f.endsWith('.json')) this.mtimes.set('answers/' + f.slice(0, -5), mtime(path.join(this.hitlDir, 'answers', f)));
    };
    if (fs.existsSync(this.hitlDir)) start();
    else {
      const t = setInterval(() => {
        if (!fs.existsSync(this.hitlDir)) return;
        clearInterval(t);
        start();
        for (const id of this.questions.ids()) this.check('questions', id, true);
        for (const id of this.reviews.ids()) this.check('reviews', id, true);
      }, 2000);
      t.unref();
    }
  }

  private check(dir: string, id: string, force = false): void {
    const k = dir + '/' + id;
    if (this.pending.has(k)) return;
    this.pending.set(
      k,
      setTimeout(() => {
        this.pending.delete(k);
        const file = path.join(this.hitlDir, dir, id + '.json');
        const now = mtime(file);
        if (!force && this.mtimes.get(k) === now) return;
        this.mtimes.set(k, now);
        const isReview = dir === 'reviews' || (dir === 'answers' && this.reviews.has(id));
        const kind = isReview ? 'review' : 'questions';
        const summary = isReview ? this.reviews.summary(id) : this.questions.summary(id);
        this.emit('request', { project: this.key, kind, id, summary: summary ?? null });
        this.onRequest({ kind, id, side: dir === 'answers' ? 'human' : 'agent' });
      }, 120),
    );
  }

  /** everything waiting, for the inbox and the project's home */
  overview(): Record<string, unknown> {
    const notes = this.notes.all();
    return {
      key: this.key,
      name: this.name,
      root: tilde(this.root),
      questions: this.questions.summaries(),
      reviews: this.reviews.summaries(),
      notes: { open: notes.filter((c) => c.status === 'open').length, total: notes.length, unread: this.notes.unread() },
    };
  }

  close(): void {
    this.stopTree?.();
    this.stopHitl?.();
    this.notes.close();
    if (this.idle) clearInterval(this.idle);
    for (const t of this.pending.values()) clearTimeout(t);
  }

  // ── routes (p is the path after p/<key>, starting with /) ──

  async handle(p: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const q = (k: string) => url.searchParams.get(k) ?? '';
    const method = req.method ?? 'GET';
    const write = method !== 'GET' && method !== 'HEAD';
    if (write && this.settings.readOnly) return json(res, 403, { error: 'This hitl is read-only' });

    if (p.startsWith('/raw/')) {
      this.touch();
      const rel = decodeURIComponent(p.slice(5));
      if (q('download') === '1') res.setHeader('content-disposition', disposition(path.basename(rel)));
      return serveRaw(this.scope, rel, req, res, q('as') === 'page');
    }
    if (p === '/api/zip') return this.zipFolder(q('p'), res);
    if (p === '/api/info') {
      const git = await this.git();
      return json(res, 200, {
        key: this.key,
        name: this.name,
        root: tilde(this.root),
        git: !!git,
        gitPrefix: git?.prefix ?? '',
        author: await this.author(),
        readOnly: this.settings.readOnly,
        notes: { json: toRel(this.scope, this.notes.jsonPath), md: toRel(this.scope, this.notes.mdPath), dir: '.hitl/notes', prompt: agentPrompt(toRel(this.scope, this.notes.mdPath)) },
        maxFile: this.settings.maxFileMb * 1048576,
      });
    }
    if (p === '/api/overview') return json(res, 200, this.overview());
    if (p === '/api/list') {
      this.touch();
      const entries = list(this.scope, q('p'));
      return entries ? json(res, 200, { entries }) : json(res, 404, { error: 'No such folder' });
    }
    if (p === '/api/stat') {
      const abs = inside(this.scope, q('p'));
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
      const st = fs.statSync(abs);
      return json(res, 200, { type: st.isDirectory() ? 'folder' : 'file', size: st.size, mtime: st.mtimeMs });
    }
    if (p === '/api/text') {
      const r = readText(this.scope, q('path'), q('lines'), this.settings.maxFileMb * 1048576);
      return 'error' in r ? json(res, r.status, { error: r.error }) : json(res, 200, r);
    }
    if (p === '/api/files') {
      await this.git();
      return json(res, 200, { files: (await this.index.files()).filter((f) => !f.startsWith('.hitl/')) });
    }
    if (p === '/api/search') {
      if (!q('q')) return json(res, 400, { error: 'Nothing to search for' });
      await this.git();
      const result = await this.index.search({ q: q('q'), scope: q('scope'), regex: q('regex') === '1', caseSensitive: q('case') === '1', word: q('word') === '1', include: q('include') });
      // hitl's own files would match every word that was asked or said: leave them out
      result.files = result.files.filter((f) => !f.path.startsWith('.hitl/'));
      return json(res, 200, result);
    }
    if (p.startsWith('/api/git/')) return this.gitRoute(p, q, res);
    if (p === '/api/hooks') {
      if (method === 'POST') {
        const b = await body(req);
        setHooks(this.root, { ...(typeof b['prompt'] === 'boolean' ? { prompt: b['prompt'] } : {}), ...(typeof b['stop'] === 'boolean' ? { stop: b['stop'] } : {}) });
      }
      return json(res, 200, hookStatus(this.root));
    }
    if (p === '/api/decisions') return json(res, 200, decisions(this, { q: q('q'), limit: Number(q('limit')) || 200 }));

    // notes (folderview's comments): /api/comments…
    if (p === '/api/notes.md') return text(res, fs.existsSync(this.notes.mdPath) ? fs.readFileSync(this.notes.mdPath, 'utf8') : 'No notes yet.\n', 'text/markdown; charset=utf-8');
    if (p.startsWith('/api/comments')) return this.notesRoute(p, method, q, req, res);
    if (p.startsWith('/api/q/')) return this.questionsRoute(p.slice(7), method, req, res);
    if (p.startsWith('/api/r/')) return this.reviewsRoute(p.slice(7), method, q, req, res);
    return json(res, 404, { error: 'not found' });
  }

  private async gitRoute(p: string, q: (k: string) => string, res: http.ServerResponse): Promise<void> {
    const git = await this.git();
    if (!git) return json(res, 404, { error: 'Not a git repository' });
    const rel = q('p');
    if (p !== '/api/git/status' && p !== '/api/git/history' && inside(this.scope, rel) === undefined) return json(res, 404, { error: 'not found' });
    switch (p) {
      case '/api/git/status':
        this.touch();
        return json(res, 200, await this.gitStatus());
      case '/api/git/diff':
        return text(res, await git.diff(rel));
      case '/api/git/show': {
        const rev = q('rev') || 'HEAD';
        if (!isRev(rev)) return json(res, 400, { error: 'bad revision' });
        return text(res, await git.show(rel, rev));
      }
      case '/api/git/raw': {
        const rev = q('rev') || 'HEAD';
        if (!isRev(rev)) return json(res, 400, { error: 'bad revision' });
        const buf = await git.showRaw(rel, rev);
        const ext = path.extname(rel).slice(1).toLowerCase();
        res.writeHead(200, { 'content-type': RAW_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
        return void res.end(buf);
      }
      case '/api/git/log': {
        const all = await git.log(rel, 31, Math.max(0, Number(q('skip')) || 0));
        return json(res, 200, { commits: all.slice(0, 30), more: all.length > 30 });
      }
      case '/api/git/history':
        return json(res, 200, await git.history(Math.max(0, Number(q('skip')) || 0), 50, q('q').trim().slice(0, 200)));
      case '/api/git/commit-info': {
        const h = q('h');
        if (!isRev(h)) return json(res, 400, { error: 'bad revision' });
        const info = await git.commitInfo(h);
        info.files = info.files.filter((f) => this.visible(f.path) && !f.path.startsWith('.hitl/'));
        return json(res, 200, info);
      }
      case '/api/git/commit-diff': {
        const h = q('h');
        const from = q('from');
        if (!isRev(h)) return json(res, 400, { error: 'bad revision' });
        if (from && inside(this.scope, from) === undefined) return json(res, 404, { error: 'not found' });
        return text(res, await git.commitFileDiff(h, rel, from || undefined));
      }
      case '/api/git/commit': {
        const h = q('h');
        if (!isRev(h)) return json(res, 400, { error: 'bad revision' });
        return text(res, await git.commitDiff(rel, h));
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  private async notesRoute(p: string, method: string, q: (k: string) => string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const notes = this.notes;
    if (p === '/api/comments' && method === 'GET') return json(res, 200, { comments: notes.all() });
    const file = /^\/api\/comments\/([0-9a-f]+)\/(image\.png|photo\/[\w.-]+)$/.exec(p);
    if (file) {
      const which = file[2] === 'image.png' ? 'image' : (file[2] ?? '').slice(6);
      const abs = notes.filePath(file[1] ?? '', which);
      if (!abs) return json(res, 404, { error: 'not found' });
      const ext = path.extname(abs).slice(1);
      res.writeHead(200, { 'content-type': RAW_TYPES[ext] ?? 'image/png', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      return void fs.createReadStream(abs).pipe(res);
    }
    if (p === '/api/comments' && method === 'POST') {
      const b = await body(req, 60_000_000);
      const rel = str(b['path']);
      if (rel && inside(this.scope, rel) === undefined) return json(res, 400, { error: 'No such file' });
      const ph = photos(b);
      if (!str(b['body']).trim() && !ph.length) return json(res, 400, { error: 'The note is empty' });
      const line = posInt(b['line']),
        endLine = posInt(b['endLine']);
      const marks = imageMarks(b);
      const git = await this.git();
      const c = notes.add({
        path: rel,
        body: str(b['body']),
        author: str(b['author']) || (await this.author()),
        ...(line ? { line } : {}),
        ...(endLine ? { endLine } : {}),
        ...(marks.area ? { area: marks.area } : {}),
        ...(marks.strokes ? { strokes: marks.strokes } : {}),
        ...(marks.snapshot ? { snapshot: marks.snapshot } : {}),
        ...(ph.length ? { photos: ph } : {}),
        ...(git && rel ? { commit: (await this.gitStatus().catch(() => undefined))?.head ?? '' } : {}),
      });
      return json(res, 201, c);
    }
    if (p === '/api/comments' && method === 'DELETE' && q('resolved') === '1') return json(res, 200, { removed: notes.clearResolved() });
    const m = /^\/api\/comments\/([0-9a-f]+)(\/replies)?$/.exec(p);
    if (m) {
      const id = m[1] ?? '';
      if (m[2] && method === 'POST') {
        const b = await body(req);
        const c = notes.reply(id, str(b['author']) || (await this.author()), str(b['body']));
        return c ? json(res, 200, c) : json(res, 404, { error: 'not found' });
      }
      if (method === 'PATCH') {
        const b = await body(req);
        const s = str(b['status']);
        const patch: { body?: string; status?: CommentStatus } = {};
        if (typeof b['body'] === 'string') patch.body = b['body'];
        if (s === 'open' || s === 'resolved') patch.status = s;
        const c = notes.update(id, patch);
        return c ? json(res, 200, c) : json(res, 404, { error: 'not found' });
      }
      if (method === 'DELETE') return notes.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
    }
    return json(res, 404, { error: 'not found' });
  }

  private async questionsRoute(rest: string, method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sm = /^([^/]+)(\/[a-z]+)?$/.exec(rest);
    if (!sm) return json(res, 404, { error: 'not found' });
    const setId = decodeURIComponent(sm[1] ?? '');
    const action = sm[2] ?? '';
    const qs = this.questions;
    if (!qs.has(setId)) return json(res, 404, { error: `No question set "${setId}"` });
    if (!action && method === 'GET') {
      const l = qs.load(setId);
      if (!l) return json(res, 404, { error: `No question set "${setId}"` });
      return json(res, 200, { set: l.set, errors: l.errors, warnings: l.warnings, answers: qs.answers(setId), summary: qs.summary(setId) });
    }
    if (method !== 'POST') return json(res, 405, { error: 'POST' });
    const b = await body(req);
    const qid = str(b['id']);
    switch (action) {
      case '/answer': {
        if (b['clear'] === true) {
          qs.clear(setId, qid);
          return json(res, 200, { answer: null, summary: qs.summary(setId) });
        }
        const a = qs.answer(setId, qid, answerInput(b));
        return json(res, 200, { answer: a, summary: qs.summary(setId) });
      }
      case '/accept': {
        const taken = qs.acceptRecommended(setId, strList(b['ids']));
        return json(res, 200, { taken, answers: qs.answers(setId), summary: qs.summary(setId) });
      }
      case '/message':
        return json(res, 200, { message: qs.message(setId, qid, 'owner', str(b['body'])) });
    }
    return json(res, 404, { error: 'not found' });
  }

  private async reviewsRoute(rest: string, method: string, q: (k: string) => string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rm = /^([^/]+)(\/[a-z]+)?$/.exec(rest);
    if (!rm) return json(res, 404, { error: 'not found' });
    const id = decodeURIComponent(rm[1] ?? '');
    const action = rm[2] ?? '';
    const rv = this.reviews;
    const l = rv.load(id);
    if (!l) return json(res, 404, { error: `No review "${id}"` });
    if (method === 'GET' && !action) {
      // each file item: is it still as it was shown?
      const files: Record<string, { exists: boolean; changed: boolean; size?: number }> = {};
      for (const it of l.review.items) {
        if (it.kind !== 'file' || !it.file) continue;
        const abs = inside(this.scope, it.file);
        let st: fs.Stats | undefined;
        try {
          st = abs ? fs.statSync(abs) : undefined;
        } catch {
          st = undefined;
        }
        files[it.id] = { exists: !!st, changed: !!it.snap && !!st && (st.size !== it.snap.size || sha1(abs ?? '') !== it.snap.sha), ...(st ? { size: st.size } : {}) };
      }
      return json(res, 200, { review: l.review, errors: l.errors, warnings: l.warnings, feedback: rv.feedback(id), summary: rv.summary(id), files });
    }
    if (method === 'GET' && action === '/diff') {
      // a diff for an item: its file against a git revision, its file now against its snapshot, or before → after text
      const it = l.review.items.find((i) => i.id === q('item'));
      if (!it) return json(res, 404, { error: 'No such item' });
      if (it.kind === 'file' && it.file && it.against) {
        const git = await this.git();
        if (!git) return json(res, 400, { error: 'Not a git repository' });
        if (inside(this.scope, it.file) === undefined) return json(res, 404, { error: 'not found' });
        return text(res, await git.diffAgainst(it.file, it.against));
      }
      if (it.kind === 'file' && it.file && it.snap) {
        const now = readText(this.scope, it.file, '', 20 * 1048576);
        const then = readText({ ...this.scope, hidden: new Set(['.git']), excluded: () => false }, it.snap.path, '', 20 * 1048576);
        if ('error' in now || 'error' in then) return json(res, 400, { error: 'error' in now ? now.error : 'The snapshot is gone' });
        return text(res, unifiedDiff(then.text, now.text, it.file + ' (as shown)', it.file + ' (now)'));
      }
      if ((it.kind === 'code' || it.kind === 'text') && typeof it.before === 'string') return text(res, unifiedDiff(it.before, it.code ?? it.text ?? '', it.name || 'before', it.name || 'after'));
      return json(res, 400, { error: 'Nothing to compare' });
    }
    if (method !== 'POST') return json(res, 405, { error: 'POST' });
    const b = await body(req, 60_000_000);
    const verdictOf = (v: unknown): Verdict | null => {
      if (v === null || v === '' || v === undefined) return null;
      if (!(VERDICTS as readonly string[]).includes(String(v))) throw new StoreError(`A verdict is ${VERDICTS.join(', ')}`);
      return v as Verdict;
    };
    switch (action) {
      case '/verdict':
        return json(res, 200, { verdict: rv.verdict(id, str(b['item']), verdictOf(b['verdict']), str(b['note'])), summary: rv.summary(id) });
      case '/overall':
        return json(res, 200, { overall: rv.overall(id, verdictOf(b['verdict']), str(b['note'])), summary: rv.summary(id) });
      case '/comment': {
        const marks = imageMarks(b);
        const c = rv.comment(id, {
          item: str(b['item']),
          body: str(b['body']),
          ...(posInt(b['line']) ? { line: posInt(b['line']) } : {}),
          ...(posInt(b['endLine']) ? { endLine: posInt(b['endLine']) } : {}),
          ...(b['side'] === 'old' ? { side: 'old' as const } : {}),
          ...(str(b['quote']) ? { quote: str(b['quote']) } : {}),
          ...(marks.strokes ? { strokes: marks.strokes } : {}),
          ...(marks.area ? { area: marks.area } : {}),
          ...(marks.snapshotUrl ? { snapshot: marks.snapshotUrl } : {}),
          photos: photos(b),
        });
        return json(res, 201, { comment: c, summary: rv.summary(id) });
      }
      case '/reply':
        return json(res, 200, { comment: rv.reply(id, str(b['cid']), 'owner', str(b['body'])) });
      case '/status': {
        const s = str(b['status']);
        if (s !== 'open' && s !== 'resolved') return json(res, 400, { error: 'status is open or resolved' });
        return json(res, 200, { done: rv.setStatus(id, strList(b['cid']), s, 'owner') });
      }
      case '/edit':
        return json(res, 200, { comment: rv.editComment(id, str(b['cid']), str(b['body'])) });
      case '/delete':
        return json(res, 200, { ok: rv.deleteComment(id, str(b['cid'])) });
    }
    return json(res, 404, { error: 'not found' });
  }

  /** a folder as a zip: what the listing shows (no hidden, excluded or noise folders), within the zip limits */
  private async zipFolder(rel: string, res: http.ServerResponse): Promise<void> {
    const abs = inside(this.scope, rel);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return json(res, 404, { error: 'No such folder' });
    const name = rel ? path.basename(abs) : path.basename(this.root) || 'folder';
    const files: { abs: string; name: string }[] = [];
    let bytes = 0;
    const stack = [rel];
    while (stack.length) {
      const dir = stack.pop() ?? '';
      for (const e of list(this.scope, dir) ?? []) {
        const child = dir ? dir + '/' + e.name : e.name;
        if (e.type === 'folder') {
          if (!NOISE.has(e.name)) stack.push(child);
          continue;
        }
        bytes += e.size;
        files.push({ abs: path.join(this.root, child), name: path.posix.join(name, rel ? child.slice(rel.length + 1) : child) });
      }
      if (files.length > ZIP_LIMITS.files || bytes > ZIP_LIMITS.bytes) return json(res, 413, { error: `Too big to zip here (${files.length.toLocaleString()} files, ${Math.round(bytes / 1048576)} MB so far)` });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': disposition(name + '.zip'), 'cache-control': 'no-store' });
    await writeZip(res, files);
    res.end();
  }
}

function answerInput(b: Record<string, unknown>): AnswerInput {
  const out: AnswerInput = {};
  if (typeof b['status'] === 'string') out.status = b['status'] as AnswerInput['status'];
  if (Array.isArray(b['picked'])) out.picked = b['picked'].map(String);
  if (typeof b['other'] === 'string') out.other = b['other'];
  if (typeof b['text'] === 'string') out.text = b['text'];
  if (typeof b['number'] === 'number') out.number = b['number'];
  if (Array.isArray(b['order'])) out.order = b['order'].map(String);
  if (typeof b['note'] === 'string') out.note = b['note'];
  return out;
}

function isRev(r: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(r) || /^HEAD(~\d{1,4}|\^)?$/.test(r);
}

function mtime(f: string): number {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

function safeList(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

function sha1(abs: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return '';
  }
}

/** .hitlignore (and folderview's .folderviewignore): one pattern per line, # for comments */
function readIgnore(root: string): string[] {
  const out: string[] = [];
  for (const f of ['.hitlignore', '.folderviewignore']) {
    try {
      out.push(...fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/));
    } catch {
      // none
    }
  }
  return out.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);
