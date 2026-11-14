// Notes from the human to the agent: on a file, on lines of it, on an area of a picture, or on nothing in particular
// ("look at the login flow"), with photos if they like. Kept in .hitl/notes/notes.json, with NOTES.md beside it
// written for an agent to work through. (These are folderview's review comments, grown up.)
//
// Several processes write here (the page through the hub, an agent through the MCP server or the CLI), so every change
// re-reads the file under a lock, changes it, and writes it back atomically. Each change gets a number (seq), so an
// agent can read just what's new.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLock, writeAtomic } from '../hub/atomic.js';

export type CommentStatus = 'open' | 'resolved';

export interface Reply {
  id: string;
  author: string;
  /** "agent" for the agent's replies */
  from?: 'owner' | 'agent';
  body: string;
  at: string;
  seq?: number;
}

export interface Comment {
  id: string;
  /** project-relative file (or folder) the note is on; "" for a note on nothing in particular */
  path: string;
  /** 1-based first line; absent for a note on the whole file */
  line?: number;
  endLine?: number;
  /** the lines as they were when the note was left */
  quote?: string;
  body: string;
  author: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt?: string;
  /** a picture note: the marked area, in the picture's own pixels */
  area?: Area;
  /** the hand-drawn marks, each a run of points [x0, y0, x1, y1, …] as fractions (0–1) of the picture's size */
  strokes?: number[][];
  /** the picture with the marks drawn on it, relative to the notes folder (images/<id>.png) */
  image?: string;
  /** photos the human attached, relative to the notes folder (photos/<id>-1.jpg …) */
  photos?: string[];
  /** the commit the file was at (short hash), when in git */
  commit?: string;
  replies?: Reply[];
  /** the change number when it was written or last changed by the human */
  seq?: number;
}

export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Store {
  version: 1;
  seq: number;
  /** what the agent has read up to */
  readSeq: number;
  comments: Comment[];
}

const QUOTE_LINES = 12;
const PHOTO = /^data:image\/(png|jpeg|webp|gif|heic|avif);base64,([A-Za-z0-9+/=]+)$/;

export class Notes {
  readonly jsonPath: string;
  readonly mdPath: string;
  private comments: Comment[] = [];
  private seq = 0;
  private readSeq = 0;
  private lastWritten = '';
  private listeners = new Set<() => void>();
  private watcher: fs.FSWatcher | undefined;

  constructor(
    readonly dir: string,
    private readonly root: string,
  ) {
    this.jsonPath = path.join(dir, 'notes.json');
    this.mdPath = path.join(dir, 'NOTES.md');
    this.load();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** watch notes.json for edits from outside (an agent resolving a note) */
  watch(): void {
    if (this.watcher) return;
    const start = () => {
      try {
        this.watcher = fs.watch(this.dir, (_e, name) => {
          if (name && String(name) !== 'notes.json') return;
          setTimeout(() => this.reloadIfChanged(), 60);
        });
        this.watcher.on('error', () => undefined);
      } catch {
        this.watcher = undefined;
      }
    };
    if (fs.existsSync(this.dir)) start();
    else {
      const t = setInterval(() => {
        if (fs.existsSync(this.dir)) {
          clearInterval(t);
          start();
          this.reloadIfChanged();
        }
      }, 2000);
      t.unref();
    }
  }

  close(): void {
    this.watcher?.close();
  }

  private reloadIfChanged(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.jsonPath, 'utf8');
    } catch {
      text = '';
    }
    if (text === this.lastWritten) return;
    this.load();
    this.writeMarkdown();
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private load(): void {
    try {
      const text = fs.readFileSync(this.jsonPath, 'utf8');
      this.lastWritten = text;
      const data = JSON.parse(text) as Partial<Store>;
      this.comments = Array.isArray(data.comments) ? data.comments.filter(isComment) : [];
      this.seq = typeof data.seq === 'number' ? data.seq : this.comments.length;
      this.readSeq = typeof data.readSeq === 'number' ? data.readSeq : 0;
    } catch {
      // no file yet, or a half-written hand edit: keep what we had
    }
  }

  /** re-read, change, write: safe with other processes writing too */
  private change<T>(fn: () => T): T {
    fs.mkdirSync(this.dir, { recursive: true });
    return withLock(this.jsonPath, () => {
      this.load();
      const r = fn();
      this.save();
      return r;
    });
  }

  all(): Comment[] {
    return this.comments;
  }

  /** the change number now, and what the agent has read up to */
  marks(): { seq: number; readSeq: number } {
    this.load();
    return { seq: this.seq, readSeq: this.readSeq };
  }

  /** notes and human replies since the agent last read */
  unread(): number {
    let n = 0;
    for (const c of this.comments) {
      if (c.author !== 'agent' && (c.seq ?? 0) > this.readSeq) n++;
      for (const r of c.replies ?? []) if (r.from !== 'agent' && r.author !== 'agent' && (r.seq ?? 0) > this.readSeq) n++;
    }
    return n;
  }

  markRead(upTo?: number): void {
    this.change(() => {
      this.readSeq = Math.max(this.readSeq, Math.min(upTo ?? this.seq, this.seq));
    });
  }

  add(input: { path: string; line?: number; endLine?: number; body: string; author: string; commit?: string; area?: Area; strokes?: number[][]; snapshot?: Buffer; photos?: string[] }): Comment {
    return this.change(() => {
      const c: Comment = {
        id: crypto.randomBytes(4).toString('hex'),
        path: input.path,
        body: input.body.trim(),
        author: input.author || 'reviewer',
        status: 'open',
        createdAt: new Date().toISOString(),
        seq: ++this.seq,
      };
      if (input.line && input.path) {
        c.line = input.line;
        if (input.endLine && input.endLine > input.line) c.endLine = input.endLine;
        const quote = this.quote(input.path, input.line, c.endLine ?? input.line);
        if (quote !== undefined) c.quote = quote;
      }
      if (input.area) c.area = input.area;
      if (input.strokes?.length) c.strokes = input.strokes;
      if (input.snapshot) {
        fs.mkdirSync(path.join(this.dir, 'images'), { recursive: true });
        c.image = `images/${c.id}.png`;
        fs.writeFileSync(path.join(this.dir, c.image), input.snapshot);
      }
      const photos: string[] = [];
      for (const p of (input.photos ?? []).slice(0, 8)) {
        const m = PHOTO.exec(p);
        if (!m) continue;
        const buf = Buffer.from(m[2] ?? '', 'base64');
        if (buf.length > 12 * 1048576) continue;
        fs.mkdirSync(path.join(this.dir, 'photos'), { recursive: true });
        const rel = `photos/${c.id}-${photos.length + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
        fs.writeFileSync(path.join(this.dir, rel), buf);
        photos.push(rel);
      }
      if (photos.length) c.photos = photos;
      if (input.commit) c.commit = input.commit;
      this.comments.push(c);
      return c;
    });
  }

  update(id: string, patch: { body?: string; status?: CommentStatus }): Comment | undefined {
    return this.change(() => {
      const c = this.comments.find((x) => x.id === id);
      if (!c) return undefined;
      if (typeof patch.body === 'string' && patch.body.trim()) {
        c.body = patch.body.trim();
        c.seq = ++this.seq;
      }
      if (patch.status === 'open' || patch.status === 'resolved') {
        c.status = patch.status;
        this.seq++;
      }
      c.updatedAt = new Date().toISOString();
      return c;
    });
  }

  reply(id: string, author: string, body: string, from: 'owner' | 'agent' = 'owner'): Comment | undefined {
    return this.change(() => {
      const c = this.comments.find((x) => x.id === id);
      if (!c || !body.trim()) return undefined;
      (c.replies ??= []).push({ id: crypto.randomBytes(3).toString('hex'), author: author || 'reviewer', from, body: body.trim(), at: new Date().toISOString(), seq: ++this.seq });
      c.updatedAt = new Date().toISOString();
      return c;
    });
  }

  /** The agent resolved these notes, saying what it did. */
  resolve(ids: string[], note: string, status: CommentStatus = 'resolved'): string[] {
    return this.change(() => {
      const done: string[] = [];
      for (const id of ids) {
        const c = this.comments.find((x) => x.id === id);
        if (!c) continue;
        c.status = status;
        if (note.trim()) (c.replies ??= []).push({ id: crypto.randomBytes(3).toString('hex'), author: 'agent', from: 'agent', body: note.trim(), at: new Date().toISOString(), seq: ++this.seq });
        else this.seq++;
        c.updatedAt = new Date().toISOString();
        done.push(id);
      }
      return done;
    });
  }

  remove(id: string): boolean {
    return this.change(() => {
      const gone = this.comments.find((c) => c.id === id);
      if (!gone) return false;
      this.comments = this.comments.filter((c) => c.id !== id);
      this.dropFiles(gone);
      this.seq++;
      return true;
    });
  }

  clearResolved(): number {
    return this.change(() => {
      const n = this.comments.length;
      for (const c of this.comments) if (c.status === 'resolved') this.dropFiles(c);
      this.comments = this.comments.filter((c) => c.status !== 'resolved');
      this.seq++;
      return n - this.comments.length;
    });
  }

  /** a note's marked-up picture or photo, as a path inside the notes folder (or undefined) */
  filePath(id: string, which: string): string | undefined {
    const c = this.comments.find((x) => x.id === id);
    const rel = which === 'image' ? c?.image : c?.photos?.find((p) => p.endsWith('/' + which) || p === 'photos/' + which);
    if (!rel || !/^(images|photos)\/[0-9a-f]+(-\d+)?\.(png|jpg|webp|gif|heic|avif)$/.test(rel)) return undefined;
    const abs = path.join(this.dir, rel);
    return fs.existsSync(abs) ? abs : undefined;
  }

  private dropFiles(c: Comment): void {
    for (const rel of [c.image, ...(c.photos ?? [])]) if (rel && /^(images|photos)\/[0-9a-f]+(-\d+)?\.[a-z]+$/.test(rel)) fs.rmSync(path.join(this.dir, rel), { force: true });
  }

  private quote(rel: string, from: number, to: number): string | undefined {
    try {
      const abs = path.join(this.root, rel);
      if (fs.statSync(abs).size > 5_000_000) return undefined;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const end = Math.min(to, from + QUOTE_LINES - 1);
      const got = lines.slice(from - 1, end).map((l) => l.replace(/\r$/, ''));
      if (!got.length) return undefined;
      return got.join('\n') + (to > end ? '\n…' : '');
    } catch {
      return undefined;
    }
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const sorted = [...this.comments].sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.createdAt.localeCompare(b.createdAt));
    const text = JSON.stringify({ version: 1, seq: this.seq, readSeq: this.readSeq, comments: sorted } satisfies Store, null, 2) + '\n';
    writeAtomic(this.jsonPath, text);
    this.lastWritten = text;
    this.writeMarkdown();
    this.emit();
  }

  private writeMarkdown(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.mdPath, toMarkdown(this.comments, path.relative(this.root, this.jsonPath).split(path.sep).join('/')));
    } catch {
      // the folder went away; the next save makes it again
    }
  }
}

/** What to tell an agent: where the notes are, and how to answer them. */
export function agentPrompt(mdRel: string): string {
  return (
    `Read ${mdRel}: notes from me on files in this project (path:line, the quoted code, and what I said), on areas of pictures, or on nothing in particular. ` +
    `Work through each open note: make the change it asks for, then resolve it with a short reply saying what you did (\`npx hitloop resolve <id> --note "…"\`, or the resolve tool). ` +
    `If you can't or shouldn't act on one, leave it open and reply with why. (\`npx hitloop news\` shows what's new.)`
  );
}

export function toMarkdown(comments: Comment[], jsonRel: string, { openOnly = false } = {}): string {
  const open = comments.filter((c) => c.status === 'open');
  const done = openOnly ? [] : comments.filter((c) => c.status === 'resolved');
  const out: string[] = [
    '# Notes from the human',
    '',
    openOnly ? `${open.length} open` : `${open.length} open · ${done.length} resolved · updated ${new Date().toISOString()}`,
    '',
    '<!-- Written by hitl. Do not edit this file: it is made from ' + jsonRel + '. -->',
    '',
    '## How to work through these (for an agent)',
    '',
    '- Each note is on a file, on lines of it (`path:line`), on an area of a picture (marked by hand; `images/<id>.png` beside this file shows the marks), or on nothing in particular. Paths are relative to the project.',
    '- The quoted code is what the lines said when the note was left; the file may have moved on since, so find the code, not just the line number.',
    '- When a note is dealt with, resolve it with a reply saying what you did: `npx hitloop resolve <id> --note "Done: …"` (or the MCP tool `resolve`). The human sees it live.',
    '- Leave notes you could not act on open, with a reply that says why (`npx hitloop reply <id> "…"`).',
    '',
  ];
  const section = (title: string, list: Comment[]) => {
    if (!list.length) return;
    out.push(`## ${title}`, '');
    let file: string | undefined;
    for (const c of list) {
      if (c.path !== file) {
        file = c.path;
        out.push(`### ${file || '(not about a particular file)'}`, '');
      }
      const where = !c.path ? 'note' : c.line ? `${c.path}:${c.line}${c.endLine ? '-' + c.endLine : ''}` : c.area ? `${c.path} (marked area)` : `${c.path} (whole file)`;
      out.push(`#### \`${where}\` — ${c.author}${c.commit ? ` @ ${c.commit}` : ''} · id \`${c.id}\``, '');
      if (c.quote) out.push('```' + langOf(c.path), c.quote, '```', '');
      if (c.area) out.push(`Marked area: x ${c.area.x}, y ${c.area.y}, ${c.area.w} × ${c.area.h} px of the picture.` + (c.image ? ` The marks are drawn on a copy: ${c.image} (beside this file).` : ''), '');
      if (c.image) out.push(`![The marked area](${c.image})`, '');
      for (const p of c.photos ?? []) out.push(`![A photo](${p})`, '');
      out.push(c.body, '');
      for (const r of c.replies ?? []) out.push(`> **${r.author}**: ${r.body.replace(/\n/g, '\n> ')}`, '');
    }
  };
  const order = (a: Comment, b: Comment) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0);
  section('Open', [...open].sort(order));
  section('Resolved', [...done].sort(order));
  if (!comments.length) out.push('No notes yet.', '');
  else if (openOnly && !open.length) out.push('No open notes.', '');
  return out.join('\n');
}

function langOf(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) && p.includes('.') ? ext : '';
}

function isComment(x: unknown): x is Comment {
  if (!x || typeof x !== 'object') return false;
  const c: Partial<Record<keyof Comment, unknown>> = x;
  return typeof c.id === 'string' && typeof c.path === 'string' && typeof c.body === 'string' && (c.status === 'open' || c.status === 'resolved');
}
