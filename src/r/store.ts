// A project's reviews on disk:
//   <folder>/.hitl/reviews/<id>.json   what to look at (the agent writes these: the MCP tools, the CLI, or by hand)
//   <folder>/.hitl/answers/<id>.json   the human's verdicts and comments (hitl writes these)
//   <folder>/.hitl/answers/<id>.md     the same, readable
//   <folder>/.hitl/media/              pictures passed as data, snapshots of shown files, marked-up pictures, photos
// Each review is its own file and a new one always gets a fresh id, so one agent's review never replaces another's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StoreError, ensureReadme, stripBom, withLock, writeAtomic } from '../hub/atomic.js';
import {
  REVIEW_ID,
  VERDICTS,
  emptyFeedback,
  feedbackMarkdown,
  itemIdFor,
  kindOf,
  normalise,
  slug,
  summarise,
  type Comment,
  type Feedback,
  type ItemInput,
  type Normalised,
  type Reply,
  type ReviewInput,
  type Summary,
  type Verdict,
} from './model.js';

export const DIR = '.hitl';
export const SCHEMA_URL = 'https://unpkg.com/hitloop/schema/reviews.schema.json';
const SNAP_MAX = 5 * 1048576;
const PHOTO_MAX = 12 * 1048576;

export interface LoadedReview extends Normalised {
  raw: ReviewInput;
  mtime: number;
}

/** An item as the agent may pass it: also `files: [...]` for several files at once. */
export type ItemArg = ItemInput & { files?: string[] };

export interface CommentInput {
  item?: string;
  line?: number;
  endLine?: number;
  side?: 'old';
  quote?: string;
  /** the quote is what the human selected */
  selected?: boolean;
  strokes?: number[][];
  area?: { x: number; y: number; w: number; h: number };
  /** the marked-up picture, a PNG data URL */
  snapshot?: string;
  /** photos, as data URLs */
  photos?: string[];
  body: string;
}

const IMG_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/heic': 'heic' };

export class Reviews {
  readonly dir: string;
  readonly reviewsDir: string;
  readonly answersDir: string;
  readonly mediaDir: string;
  private cache = new Map<string, { mtime: number; size: number; loaded: LoadedReview }>();

  constructor(readonly root: string) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, DIR);
    this.reviewsDir = path.join(this.dir, 'reviews');
    this.answersDir = path.join(this.dir, 'answers');
    this.mediaDir = path.join(this.dir, 'media');
  }

  get exists(): boolean {
    return fs.existsSync(this.reviewsDir);
  }

  ensure(): void {
    fs.mkdirSync(this.reviewsDir, { recursive: true });
    fs.mkdirSync(this.answersDir, { recursive: true });
    ensureReadme(this.dir);
  }

  reviewPath(id: string): string {
    checkId(id);
    return path.join(this.reviewsDir, id + '.json');
  }
  answersPath(id: string): string {
    checkId(id);
    return path.join(this.answersDir, id + '.json');
  }
  markdownPath(id: string): string {
    checkId(id);
    return path.join(this.answersDir, id + '.md');
  }
  /** project-relative, forward slashes */
  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  ids(): string[] {
    try {
      return fs
        .readdirSync(this.reviewsDir)
        .filter((f) => f.endsWith('.json') && REVIEW_ID.test(f.slice(0, -5)))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  has(id: string): boolean {
    return REVIEW_ID.test(id) && fs.existsSync(this.reviewPath(id));
  }

  load(id: string): LoadedReview | undefined {
    if (!REVIEW_ID.test(id)) return undefined;
    const file = this.reviewPath(id);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return undefined;
    }
    const hit = this.cache.get(id);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.loaded;
    let raw: unknown;
    let parseError = '';
    try {
      raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      parseError = `${path.basename(file)} isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`;
      raw = {};
    }
    const n = normalise(id, raw);
    if (parseError) n.errors.unshift(parseError);
    const loaded: LoadedReview = { ...n, raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ReviewInput) : {}, mtime: st.mtimeMs };
    this.cache.set(id, { mtime: st.mtimeMs, size: st.size, loaded });
    return loaded;
  }

  feedback(id: string): Feedback {
    try {
      const d = JSON.parse(stripBom(fs.readFileSync(this.answersPath(id), 'utf8'))) as Partial<Feedback>;
      if (!d || typeof d !== 'object') return emptyFeedback();
      return {
        version: 1,
        kind: 'review',
        seq: typeof d.seq === 'number' ? d.seq : 0,
        readSeq: typeof d.readSeq === 'number' ? d.readSeq : 0,
        ...(d.overall && typeof d.overall === 'object' ? { overall: d.overall } : {}),
        items: d.items && typeof d.items === 'object' ? d.items : {},
        comments: Array.isArray(d.comments) ? d.comments.map((c) => ({ ...c, replies: Array.isArray(c.replies) ? c.replies : [] })) : [],
      };
    } catch {
      return emptyFeedback();
    }
  }

  summary(id: string): Summary | undefined {
    const l = this.load(id);
    return l ? summarise(l.review, this.feedback(id), l.errors.length) : undefined;
  }

  summaries(): Summary[] {
    return this.ids()
      .map((id) => this.summary(id))
      .filter((s): s is Summary => !!s);
  }

  // ── writing reviews ──

  /** A fresh id from the title: never one already used by a review, a question set or an answers file. */
  freshId(title: string): string {
    const base = slug(title || 'review', 48);
    const used = (id: string) => ['reviews', 'questions', 'answers'].some((d) => fs.existsSync(path.join(this.dir, d, id + '.json')));
    let id = base,
      n = 2;
    while (used(id)) id = `${base}-${n++}`;
    return id;
  }

  private mutate<T>(id: string, fn: (raw: ReviewInput) => T, opts: { create?: ReviewInput; force?: boolean; fresh?: boolean } = {}): { result: T; normalised: Normalised } {
    checkId(id);
    this.ensure();
    const file = this.reviewPath(id);
    return withLock(file, () => {
      let raw: ReviewInput;
      // a new review: another process may have taken this id since it was picked
      if (opts.fresh && fs.existsSync(file)) throw TAKEN;
      if (fs.existsSync(file)) {
        try {
          raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) as ReviewInput;
        } catch (e) {
          throw new StoreError(`${path.basename(file)} isn't valid JSON (${e instanceof Error ? e.message : String(e)}); fix it by hand first`);
        }
      } else if (opts.create) raw = { $schema: SCHEMA_URL, ...opts.create, created: new Date().toISOString(), items: [] };
      else throw new StoreError(`No review "${id}"`);
      const before = normalise(id, raw).errors.length;
      const result = fn(raw);
      raw.updated = new Date().toISOString();
      const n = normalise(id, raw);
      if (n.errors.length > before && !opts.force) throw new StoreError('That would make the review invalid:\n' + n.errors.map((e) => '  ' + e).join('\n'));
      writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
      this.cache.delete(id);
      return { result, normalised: n };
    });
  }

  /**
   * Make a review (always a new file, with a fresh id unless `id` is given and new), or, with `to`, add items to an
   * existing one. Returns its id, the new items' ids, and any problems.
   */
  create(head: Omit<ReviewInput, 'items'> & { id?: string }, items: ItemArg[]): { id: string; ids: string[]; normalised: Normalised } {
    const { id: wanted, ...rest } = head;
    if (wanted && this.has(wanted)) throw new StoreError(`There's already a review "${wanted}": add to it (to: "${wanted}") or leave out the id for a new one`);
    for (let tries = 0; ; tries++) {
      const id = wanted ? (checkId(wanted), wanted) : this.freshId(head.title ?? '');
      try {
        const { result, normalised } = this.mutate(id, (raw) => this.append(id, raw, items), { create: { title: head.title || id, ...rest }, fresh: true });
        return { id, ids: result, normalised };
      } catch (e) {
        if (e !== TAKEN) throw e;
        if (wanted || tries >= 100) throw new StoreError(`There's already a review "${id}"`);
      }
    }
  }

  addItems(id: string, items: ItemArg[], patch: Partial<Pick<ReviewInput, 'title' | 'intro' | 'from'>> = {}): { ids: string[]; normalised: Normalised } {
    const { result, normalised } = this.mutate(id, (raw) => {
      for (const [k, v] of Object.entries(patch)) if (v) (raw as Record<string, unknown>)[k] = v;
      if (raw.status === 'closed') raw.status = 'open';
      return this.append(id, raw, items);
    });
    return { ids: result, normalised };
  }

  private append(id: string, raw: ReviewInput, items: ItemArg[]): string[] {
    raw.items ??= [];
    const taken = new Set(raw.items.map((i) => i.id).filter((x): x is string => !!x));
    const ids: string[] = [];
    const expanded = items.flatMap((i) => (Array.isArray(i.files) ? i.files.map((f) => ({ ...i, files: undefined, file: f, title: i.files && i.files.length > 1 ? undefined : i.title })) : [i]));
    for (const it of expanded) {
      const copy: ItemInput & { files?: unknown; snap?: unknown } = { ...it };
      delete copy.files;
      if (!kindOf(copy)) throw new StoreError(`An item needs content: file, code, text, md, json, diff, image, mermaid, html or link (got ${Object.keys(it).join(', ') || 'nothing'})`);
      if (!copy.id) copy.id = itemIdFor(copy, taken);
      if (taken.has(copy.id)) throw new StoreError(`The item id "${copy.id}" is already in "${id}" (update_item changes it)`);
      taken.add(copy.id);
      for (const k of ['image', 'before'] as const) {
        const v = copy[k];
        if (typeof v === 'string' && v.startsWith('data:')) copy[k] = this.saveData(v, `items/${id}-${copy.id}${k === 'before' ? '-before' : ''}`);
      }
      if (copy.file && copy.snapshot !== false && !copy.against) {
        const snap = this.snapshot(id, copy.id, copy.file);
        if (snap) copy.snap = snap;
      }
      delete copy.snapshot;
      raw.items.push(copy);
      ids.push(copy.id);
    }
    return ids;
  }

  /** a data: URL saved as a file in media/; returns its project-relative path */
  private saveData(url: string, name: string): string {
    const m = /^data:([a-z]+\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(url);
    if (!m) throw new StoreError('A data URL looks like data:image/png;base64,…');
    const type = (m[1] ?? '').toLowerCase();
    const ext = IMG_EXT[type];
    if (!ext) throw new StoreError(`Pictures only (png, jpeg, gif, webp, avif, svg), not ${type}`);
    const buf = m[2] ? Buffer.from(m[3] ?? '', 'base64') : Buffer.from(decodeURIComponent(m[3] ?? ''), 'utf8');
    if (buf.length > PHOTO_MAX) throw new StoreError('That picture is too big (12 MB at most)');
    const abs = path.join(this.mediaDir, name + '.' + ext);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    return this.rel(abs);
  }

  /** a copy of a project file as it is now, so later edits show as "changed since shown" */
  private snapshot(id: string, iid: string, rel: string): { path: string; sha: string; size: number; at: string } | undefined {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep) || abs.startsWith(this.dir + path.sep)) return undefined;
    let buf: Buffer;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > SNAP_MAX) return undefined;
      buf = fs.readFileSync(abs);
    } catch {
      return undefined;
    }
    const sha = crypto.createHash('sha1').update(buf).digest('hex');
    const ext = path.extname(rel).slice(0, 12);
    const out = path.join(this.mediaDir, 'snaps', id, `${iid}-${sha.slice(0, 8)}${ext}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
    return { path: this.rel(out), sha, size: buf.length, at: new Date().toISOString() };
  }

  /** Change one item: the patch's fields replace the item's (null removes one). A changed file is snapshotted again. */
  updateItem(id: string, iid: string, patch: Record<string, unknown>): Normalised {
    return this.mutate(id, (raw) => {
      const it = (raw.items ?? []).find((i) => i.id === iid) as (ItemInput & { snap?: unknown }) | undefined;
      if (!it) throw new StoreError(`No item "${iid}" in "${id}"`);
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id') continue;
        if (v === null) delete (it as Record<string, unknown>)[k];
        else (it as Record<string, unknown>)[k] = typeof v === 'string' && v.startsWith('data:') && (k === 'image' || k === 'before') ? this.saveData(v, `items/${id}-${iid}${k === 'before' ? '-before' : ''}-${Date.now().toString(36)}`) : v;
      }
      if (it.file && it.snapshot !== false && !it.against) {
        const snap = this.snapshot(id, iid, it.file);
        if (snap) it.snap = snap;
      }
      delete it.snapshot;
    }).normalised;
  }

  removeItems(id: string, iids: string[]): string[] {
    return this.mutate(
      id,
      (raw) => {
        const removed = (raw.items ?? []).filter((i) => i.id && iids.includes(i.id)).map((i) => i.id ?? '');
        raw.items = (raw.items ?? []).filter((i) => !i.id || !iids.includes(i.id));
        return removed;
      },
      { force: true },
    ).result;
  }

  update(id: string, patch: Partial<Pick<ReviewInput, 'title' | 'intro' | 'status' | 'mode' | 'from'>>): Normalised {
    return this.mutate(id, (raw) => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (raw as Record<string, unknown>)[k] = v;
    }).normalised;
  }

  /** Delete a review and its feedback (not its media). */
  remove(id: string): boolean {
    if (!this.has(id)) return false;
    fs.rmSync(this.reviewPath(id), { force: true });
    fs.rmSync(this.answersPath(id), { force: true });
    fs.rmSync(this.markdownPath(id), { force: true });
    this.cache.delete(id);
    return true;
  }

  // ── writing feedback ──

  mutateFeedback<T>(id: string, fn: (fb: Feedback) => T): T {
    if (!this.has(id)) throw new StoreError(`No review "${id}"`);
    fs.mkdirSync(this.answersDir, { recursive: true });
    return withLock(this.answersPath(id), () => {
      const fb = this.feedback(id);
      const result = fn(fb);
      writeAtomic(this.answersPath(id), JSON.stringify(fb, null, 2) + '\n');
      const l = this.load(id);
      if (l) writeAtomic(this.markdownPath(id), feedbackMarkdown(l.review, fb));
      return result;
    });
  }

  private mustLoad(id: string): LoadedReview {
    const l = this.load(id);
    if (!l) throw new StoreError(`No review "${id}"`);
    return l;
  }

  /** The human's verdict on an item (null clears it). */
  verdict(id: string, iid: string, verdict: Verdict | null, note = ''): Feedback['items'][string] | null {
    const l = this.mustLoad(id);
    const it = l.review.items.find((i) => i.id === iid);
    if (!it) throw new StoreError(`No item "${iid}" in "${id}"`);
    if (verdict !== null && !VERDICTS.includes(verdict)) throw new StoreError(`A verdict is ${VERDICTS.join(', ')}`);
    return this.mutateFeedback(id, (fb) => {
      if (verdict === null) {
        if (fb.items[iid]) {
          delete fb.items[iid];
          fb.seq++;
        }
        return null;
      }
      const prev = fb.items[iid];
      const v = { verdict, ...(note.trim() ? { note: note.trim().slice(0, 20000) } : {}), rev: it.rev, at: new Date().toISOString(), seq: ++fb.seq };
      fb.items[iid] = prev?.ack && prev.verdict === verdict && prev.rev === it.rev ? { ...v, ack: prev.ack } : v;
      return fb.items[iid] ?? null;
    });
  }

  /** The human's verdict on the whole review (for an approval: the answer). null takes it back. */
  overall(id: string, verdict: Verdict | null, note = ''): Feedback['overall'] | null {
    this.mustLoad(id);
    if (verdict !== null && !VERDICTS.includes(verdict)) throw new StoreError(`A verdict is ${VERDICTS.join(', ')}`);
    return this.mutateFeedback(id, (fb) => {
      if (verdict === null) {
        delete fb.overall;
        fb.seq++;
        return null;
      }
      fb.overall = { verdict, ...(note.trim() ? { note: note.trim().slice(0, 20000) } : {}), at: new Date().toISOString(), seq: ++fb.seq };
      return fb.overall;
    });
  }

  comment(id: string, input: CommentInput, from: Comment['from'] = 'owner'): Comment {
    const l = this.mustLoad(id);
    const iid = input.item ?? '';
    const it = iid ? l.review.items.find((i) => i.id === iid) : undefined;
    if (iid && !it) throw new StoreError(`No item "${iid}" in "${id}"`);
    if (!input.body.trim() && !input.photos?.length) throw new StoreError('The comment is empty');
    return this.mutateFeedback(id, (fb) => {
      const seq = ++fb.seq;
      const cid = `c${seq}`;
      const c: Comment = { id: cid, item: iid, body: input.body.trim().slice(0, 20000), from, at: new Date().toISOString(), seq, status: 'open', replies: [], rev: it?.rev ?? '' };
      if (input.line && input.line > 0) {
        c.line = Math.round(input.line);
        if (input.endLine && input.endLine > c.line) c.endLine = Math.round(input.endLine);
        if (input.side === 'old') c.side = 'old';
      }
      if (input.quote) {
        c.quote = input.quote.slice(0, 4000);
        if (input.selected) c.selected = true;
      }
      if (input.strokes?.length) {
        c.strokes = input.strokes;
        if (input.area) c.area = input.area;
        if (input.snapshot) c.marked = this.saveData(input.snapshot, `marks/${id}-${cid}`);
      }
      const photos = (input.photos ?? []).slice(0, 8).map((p, n) => this.saveData(p, `photos/${id}-${cid}-${n + 1}`));
      if (photos.length) c.photos = photos;
      fb.comments.push(c);
      return c;
    });
  }

  reply(id: string, cid: string, from: Reply['from'], body: string): Comment {
    if (!body.trim()) throw new StoreError('The reply is empty');
    return this.mutateFeedback(id, (fb) => {
      const c = fb.comments.find((x) => x.id === cid);
      if (!c) throw new StoreError(`No comment "${cid}" in "${id}"`);
      c.replies.push({ from, body: body.trim().slice(0, 20000), at: new Date().toISOString(), seq: ++fb.seq });
      return c;
    });
  }

  /** Resolve or reopen comments; with a note, it's added as a reply from whoever did it. */
  setStatus(id: string, cids: string[], status: Comment['status'], from: Reply['from'], note = ''): string[] {
    return this.mutateFeedback(id, (fb) => {
      const done: string[] = [];
      for (const cid of cids) {
        const c = fb.comments.find((x) => x.id === cid);
        if (!c) continue;
        c.status = status;
        if (note.trim()) c.replies.push({ from, body: note.trim().slice(0, 20000), at: new Date().toISOString(), seq: ++fb.seq });
        else fb.seq++;
        done.push(cid);
      }
      return done;
    });
  }

  editComment(id: string, cid: string, body: string): Comment {
    return this.mutateFeedback(id, (fb) => {
      const c = fb.comments.find((x) => x.id === cid);
      if (!c) throw new StoreError(`No comment "${cid}"`);
      c.body = body.trim().slice(0, 20000);
      c.seq = ++fb.seq;
      return c;
    });
  }

  deleteComment(id: string, cid: string): boolean {
    return this.mutateFeedback(id, (fb) => {
      const n = fb.comments.length;
      fb.comments = fb.comments.filter((c) => c.id !== cid);
      if (fb.comments.length !== n) fb.seq++;
      return fb.comments.length !== n;
    });
  }

  /** The agent dealt with these items' verdicts: a note the human sees. */
  ack(id: string, iids: string[], note: string): string[] {
    return this.mutateFeedback(id, (fb) => {
      const done: string[] = [];
      for (const iid of iids) {
        const v = fb.items[iid];
        if (!v) continue;
        v.ack = { at: new Date().toISOString(), note: note.slice(0, 2000) };
        done.push(iid);
      }
      if (done.length) fb.seq++;
      return done;
    });
  }

  markRead(id: string, upTo?: number): void {
    this.mutateFeedback(id, (fb) => {
      fb.readSeq = Math.max(fb.readSeq, Math.min(upTo ?? fb.seq, fb.seq));
    });
  }
}

/** thrown inside the lock when a new review's id was taken meanwhile: create picks the next one */
const TAKEN = new Error('taken');

function checkId(id: string): void {
  if (!REVIEW_ID.test(id)) throw new StoreError(`Bad review id "${id}": letters, digits, . _ - (up to 80)`);
}
