// Reviews: things an agent puts in front of the human to look at, review or approve, and what the human says back.
// Everything here is pure: the store reads and writes the files.
//
// A review is one file, .hitl/reviews/<id>.json: a title, an intro, a mode, and a list of items. An item is one thing
// to look at: a project file (or a few lines of one, or its changes since a git revision), raw content (code, text,
// markdown, JSON), a diff, a picture, a diagram, an HTML mockup or a link, with the agent's note on what to look at.
//   mode "review":  the human gives each item a verdict (looks good / needs changes / no) and comments
//   mode "show":    just look; comments welcome, no verdicts asked for
//   mode "approve": one yes or no for the whole thing (a gate: `hitl approve` waits on it)

export const KINDS = ['file', 'code', 'text', 'md', 'json', 'diff', 'image', 'mermaid', 'html', 'link'] as const;
export type Kind = (typeof KINDS)[number];
export const MODES = ['review', 'show', 'approve'] as const;
export type Mode = (typeof MODES)[number];

/** What the agent writes (or passes to the MCP tools). Exactly one content field: file, code, text, md, json, diff, image, mermaid, html or link. */
export interface ItemInput {
  id?: string;
  title?: string;
  /** markdown: what to look at, what changed, what you want to know */
  note?: string;
  /** what you're asking about this item ("Is the spacing right?") */
  ask?: string;
  /** a project file, relative to the project folder */
  file?: string;
  /** with file: just these lines, "10-40" */
  lines?: string | number;
  /** with file: show its changes since this git revision ("HEAD", "main") */
  against?: string;
  /** with file: keep a copy as it is now (default true), so later edits show as "changed since shown" */
  snapshot?: boolean;
  /** raw code (lang: its language; name: a file name to show, and to guess the language from) */
  code?: string;
  lang?: string;
  name?: string;
  /** raw plain text */
  text?: string;
  /** raw markdown */
  md?: string;
  /** any JSON value, shown as a tree */
  json?: unknown;
  /** a unified diff */
  diff?: string;
  /** a picture: a project path, an https: URL, or a data:image/… URL (saved into .hitl/media/) */
  image?: string;
  alt?: string;
  /** before and after: for a picture, the earlier picture (path, URL or data URL); for code or text, the earlier text */
  before?: string;
  mermaid?: string;
  /** a mockup, shown in a sandboxed frame (no scripts) */
  html?: string;
  height?: number;
  link?: string;
  label?: string;
  /** start folded (long items) */
  collapsed?: boolean;
}

export interface ReviewInput {
  $schema?: string;
  title?: string;
  /** markdown at the top: what this is and what you want from the human */
  intro?: string;
  mode?: Mode;
  status?: 'open' | 'closed';
  /** who's asking: an agent session's name, a branch, a tool */
  from?: string;
  created?: string;
  updated?: string;
  items?: ItemInput[];
}

/** A copy of a file as it was when shown (kept in .hitl/media/). */
export interface Snap {
  /** project-relative path of the copy */
  path: string;
  sha: string;
  size: number;
  at: string;
}

export interface Item {
  id: string;
  kind: Kind;
  title: string;
  note: string;
  ask: string;
  collapsed: boolean;
  file?: string;
  lines?: string;
  against?: string;
  snap?: Snap;
  code?: string;
  lang?: string;
  name?: string;
  text?: string;
  md?: string;
  json?: unknown;
  diff?: string;
  image?: string;
  alt?: string;
  before?: string;
  mermaid?: string;
  html?: string;
  height?: number;
  link?: string;
  label?: string;
  /** a fingerprint of the content: a verdict given to an older one is flagged "updated since" */
  rev: string;
}

export interface Review {
  id: string;
  title: string;
  intro: string;
  mode: Mode;
  status: 'open' | 'closed';
  from: string;
  created: string;
  updated: string;
  items: Item[];
}

export interface Normalised {
  review: Review;
  errors: string[];
  warnings: string[];
}

// ── feedback ──

export const VERDICTS = ['ok', 'changes', 'no'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_TEXT: Record<Verdict, string> = { ok: 'looks good', changes: 'needs changes', no: 'no' };
export const APPROVE_TEXT: Record<Verdict, string> = { ok: 'approved', changes: 'not yet (changes asked for)', no: 'refused' };

export interface ItemVerdict {
  verdict: Verdict;
  note?: string;
  /** the item's rev when it was given */
  rev: string;
  at: string;
  seq: number;
  /** the agent's note once it has dealt with it */
  ack?: { at: string; note: string };
}

export interface Reply {
  from: 'owner' | 'agent';
  body: string;
  at: string;
  seq: number;
}

export interface Comment {
  id: string;
  /** the item it's on ("" for the review as a whole) */
  item: string;
  /** lines (of the file, the code, or the diff's new side; side "old" for removed lines) */
  line?: number;
  endLine?: number;
  side?: 'old';
  /** the text it's about: the lines, or what was selected */
  quote?: string;
  /** the quote is text the human selected (not just the lines they tapped) */
  selected?: boolean;
  /** marks on a picture: strokes as [x, y, x, y, …] from 0 to 1, and the area they cover in the picture's pixels */
  strokes?: number[][];
  area?: { x: number; y: number; w: number; h: number };
  /** the picture with the marks drawn on, project-relative (.hitl/media/marks/<review>-<id>.png) */
  marked?: string;
  /** photos the human attached, project-relative (.hitl/media/photos/…) */
  photos?: string[];
  body: string;
  from: 'owner' | 'agent';
  at: string;
  seq: number;
  status: 'open' | 'resolved';
  replies: Reply[];
  /** the item's rev when it was written */
  rev: string;
}

export interface Overall {
  verdict: Verdict;
  note?: string;
  at: string;
  seq: number;
}

export interface Feedback {
  version: 1;
  kind: 'review';
  /** goes up with every change */
  seq: number;
  /** what the agent has read up to */
  readSeq: number;
  /** the human's verdict on the whole review: "done" (for an approval, the answer) */
  overall?: Overall;
  items: Record<string, ItemVerdict>;
  comments: Comment[];
}

export const emptyFeedback = (): Feedback => ({ version: 1, kind: 'review', seq: 0, readSeq: 0, items: {}, comments: [] });

// ── helpers ──

export const REVIEW_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'x'
  );
}

/** A short, stable fingerprint (FNV-1a, 32-bit, base 36). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const CONTENT = ['file', 'code', 'text', 'md', 'json', 'diff', 'image', 'mermaid', 'html', 'link'] as const;
const KNOWN = new Set(['id', 'title', 'note', 'ask', 'lines', 'against', 'snapshot', 'snap', 'lang', 'name', 'alt', 'before', 'height', 'label', 'collapsed', ...CONTENT]);

/** which content field an item has */
export function kindOf(i: ItemInput): Kind | undefined {
  for (const k of CONTENT) if ((i as Record<string, unknown>)[k] !== undefined && (k === 'json' || typeof (i as Record<string, unknown>)[k] === 'string')) return k;
  return undefined;
}

/** a title for an item without one */
export function defaultTitle(i: ItemInput, kind: Kind): string {
  switch (kind) {
    case 'file':
      return (i.file ?? '') + (i.lines !== undefined ? `:${i.lines}` : '') + (i.against ? ` (since ${i.against})` : '');
    case 'code':
      return i.name || (i.lang ? `Code (${i.lang})` : 'Code');
    case 'text':
      return i.name || 'Text';
    case 'md':
      return i.name || 'Notes';
    case 'json':
      return i.name || 'Data';
    case 'diff':
      return diffFiles(i.diff ?? '').join(', ') || 'Changes';
    case 'image':
      return i.alt || (/^data:/.test(i.image ?? '') ? 'Picture' : (i.image ?? '').replace(/[?#].*$/, '').split('/').pop() || 'Picture');
    case 'mermaid':
      return 'Diagram';
    case 'html':
      return 'Mockup';
    case 'link':
      return i.label || i.link || 'Link';
  }
}

/** the files a unified diff touches */
export function diffFiles(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
    const f = (m[1] ?? '').trim();
    if (f && f !== '/dev/null' && !out.includes(f)) out.push(f);
  }
  return out;
}

function itemRev(i: Item): string {
  const { id: _id, title: _t, note: _n, ask: _a, collapsed: _c, rev: _r, snap, ...content } = i;
  return hash(JSON.stringify({ ...content, snap: snap?.sha }));
}

/** An item id from its title or file: short, readable, unique among `taken`. */
export function itemIdFor(i: ItemInput, taken: Set<string>): string {
  const kind = kindOf(i);
  const base = slug(i.title || (kind === 'file' ? (i.file ?? '').split('/').pop() || 'file' : kind ? defaultTitle(i, kind) : 'item'), 32);
  let id = base,
    n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

export function normalise(id: string, input: unknown): Normalised {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw: ReviewInput = isObj(input) ? (input as ReviewInput) : {};
  if (!isObj(input)) errors.push('A review is a JSON object: { title, intro, mode, items: [...] }');
  const mode: Mode = (MODES as readonly string[]).includes(str(raw.mode)) ? (raw.mode as Mode) : 'review';
  if (raw.mode !== undefined && !(MODES as readonly string[]).includes(str(raw.mode))) errors.push(`mode is one of ${MODES.join(', ')}`);
  const review: Review = {
    id,
    title: str(raw.title) || id,
    intro: str(raw.intro),
    mode,
    status: raw.status === 'closed' ? 'closed' : 'open',
    from: str(raw.from),
    created: str(raw.created),
    updated: str(raw.updated),
    items: [],
  };
  const seen = new Set<string>();
  const list = Array.isArray(raw.items) ? raw.items : [];
  if (raw.items !== undefined && !Array.isArray(raw.items)) errors.push('items must be a list');
  list.forEach((ii, n) => {
    const at = `items[${n}]`;
    if (!isObj(ii)) return void errors.push(`${at}: an item is an object, like { "file": "src/x.ts" } or { "code": "…", "lang": "ts" }`);
    const input = ii as ItemInput & { snap?: Snap };
    const present = CONTENT.filter((k) => (input as Record<string, unknown>)[k] !== undefined);
    const kind = kindOf(input);
    if (!kind) return void errors.push(`${at}: no content (give one of: ${CONTENT.join(', ')})`);
    if (present.length > 1) warnings.push(`${at}: more than one content field (${present.join(', ')}); showing ${kind}`);
    for (const k of Object.keys(input)) if (!KNOWN.has(k)) warnings.push(`${at}: unknown field "${k}"`);
    let iid = str(input.id);
    if (!iid) iid = itemIdFor(input, seen);
    else if (!ITEM_ID.test(iid)) return void errors.push(`${at}: bad id "${iid}" (letters, digits, . _ : -)`);
    if (seen.has(iid)) return void errors.push(`${at}: the id "${iid}" is used twice`);
    seen.add(iid);
    const lines = input.lines === undefined ? undefined : String(input.lines);
    if (lines !== undefined && !/^\d+(-\d+)?$/.test(lines)) errors.push(`${at}: lines is "10" or "10-40"`);
    if (kind === 'file' && /(^|[\\/])\.\.([\\/]|$)/.test(input.file ?? '')) errors.push(`${at}: file must be inside the project`);
    if (kind === 'link' && !/^https?:\/\//i.test(input.link ?? '')) errors.push(`${at}: a link starts with http:// or https://`);
    for (const k of ['image', 'before'] as const) if (/^(javascript|vbscript):/i.test(str(input[k]))) errors.push(`${at}: ${k} isn't a picture`);
    if (input.against !== undefined && (kind !== 'file' || !/^[A-Za-z0-9._/~^@{}-]{1,100}$/.test(str(input.against)) || str(input.against).startsWith('-')))
      errors.push(`${at}: against is a git revision (like HEAD or main), with file`);
    const item: Item = { id: iid, kind, title: str(input.title) || defaultTitle(input, kind), note: str(input.note), ask: str(input.ask), collapsed: input.collapsed === true, rev: '' };
    const set = <K extends keyof Item>(k: K, v: Item[K] | undefined) => {
      if (v !== undefined && v !== '') item[k] = v;
    };
    switch (kind) {
      case 'file':
        set('file', str(input.file).replace(/\\/g, '/').replace(/^\.\//, ''));
        set('lines', lines);
        set('against', input.against ? str(input.against) : undefined);
        if (isObj(input.snap) && typeof input.snap.path === 'string' && typeof input.snap.sha === 'string') item.snap = input.snap;
        break;
      case 'code':
        set('code', input.code);
        set('lang', str(input.lang) || undefined);
        set('name', str(input.name) || undefined);
        set('before', typeof input.before === 'string' ? input.before : undefined);
        break;
      case 'text':
        set('text', input.text);
        set('name', str(input.name) || undefined);
        set('before', typeof input.before === 'string' ? input.before : undefined);
        break;
      case 'md':
        set('md', input.md);
        break;
      case 'json':
        item.json = input.json;
        set('name', str(input.name) || undefined);
        break;
      case 'diff':
        set('diff', input.diff);
        break;
      case 'image':
        set('image', input.image);
        set('alt', str(input.alt) || undefined);
        set('before', typeof input.before === 'string' ? input.before : undefined);
        break;
      case 'mermaid':
        set('mermaid', input.mermaid);
        break;
      case 'html':
        set('html', input.html);
        item.height = typeof input.height === 'number' && input.height > 40 ? Math.min(4000, input.height) : 360;
        break;
      case 'link':
        set('link', input.link);
        set('label', str(input.label) || undefined);
        break;
    }
    item.rev = itemRev(item);
    review.items.push(item);
  });
  if (!review.items.length && mode !== 'approve' && !errors.length) warnings.push('Nothing to look at yet: add items');
  return { review, errors, warnings };
}

// ── summaries ──

export interface Summary {
  id: string;
  kind: 'review';
  title: string;
  mode: Mode;
  status: 'open' | 'closed';
  from: string;
  items: number;
  /** items with a verdict */
  reviewed: number;
  ok: number;
  changes: number;
  no: number;
  /** comments still open */
  open: number;
  comments: number;
  /** the human's verdict on the whole review, if given */
  overall?: Verdict;
  /** the human is done: an overall verdict, or (mode show) marked seen */
  done: boolean;
  /** things the human did since the agent last read */
  unread: number;
  /** verdicts given to an older version of their item */
  stale: number;
  created: string;
  updated: string;
  errors: number;
}

export const isStale = (item: Item | undefined, v: { rev: string } | undefined) => !!item && !!v && v.rev !== item.rev;

export function summarise(review: Review, fb: Feedback, errors = 0): Summary {
  let reviewed = 0,
    ok = 0,
    changes = 0,
    no = 0,
    stale = 0;
  for (const it of review.items) {
    const v = fb.items[it.id];
    if (!v) continue;
    reviewed++;
    if (v.verdict === 'ok') ok++;
    else if (v.verdict === 'changes') changes++;
    else no++;
    if (isStale(it, v)) stale++;
  }
  return {
    id: review.id,
    kind: 'review',
    title: review.title,
    mode: review.mode,
    status: review.status,
    from: review.from,
    items: review.items.length,
    reviewed,
    ok,
    changes,
    no,
    open: fb.comments.filter((c) => c.status === 'open' && c.from === 'owner').length,
    comments: fb.comments.length,
    overall: fb.overall?.verdict,
    done: !!fb.overall,
    unread: countNew(fb),
    stale,
    created: review.created,
    updated: review.updated,
    errors,
  };
}

/** how many things the human did since the agent last read */
export function countNew(fb: Feedback): number {
  let n = 0;
  if (fb.overall && fb.overall.seq > fb.readSeq) n++;
  for (const v of Object.values(fb.items)) if (v.seq > fb.readSeq) n++;
  for (const c of fb.comments) {
    if (c.from === 'owner' && c.seq > fb.readSeq) n++;
    for (const r of c.replies) if (r.from === 'owner' && r.seq > fb.readSeq) n++;
  }
  return n;
}

export function whereText(c: Comment): string {
  if (c.strokes?.length) return c.area ? `marked area ${c.area.w}×${c.area.h} at ${c.area.x},${c.area.y}` : 'marked area';
  if (c.line) return `${c.side === 'old' ? 'removed ' : ''}${c.endLine && c.endLine !== c.line ? `lines ${c.line}-${c.endLine}` : `line ${c.line}`}`;
  return '';
}

export function verdictText(r: Review, v: Verdict): string {
  return r.mode === 'approve' ? APPROVE_TEXT[v] : VERDICT_TEXT[v];
}

/** The feedback as readable markdown, for .hitl/answers/<id>.md */
export function feedbackMarkdown(review: Review, fb: Feedback): string {
  const s = summarise(review, fb);
  const head =
    review.mode === 'approve'
      ? fb.overall
        ? `**${APPROVE_TEXT[fb.overall.verdict]}**${fb.overall.note ? `: ${fb.overall.note}` : ''}`
        : 'Not answered yet.'
      : `${s.reviewed} of ${s.items} items reviewed (${s.ok} good, ${s.changes} need changes, ${s.no} no), ${s.open} open comment${s.open === 1 ? '' : 's'}.${
          fb.overall ? ` Overall: **${VERDICT_TEXT[fb.overall.verdict]}**${fb.overall.note ? `: ${fb.overall.note}` : ''}.` : ''
        }`;
  const out = [`# ${review.title}: feedback`, '', head, '', `Written by hitl; the data is in the .json next to this file. What's new: \`npx hitloop news\`.`, ''];
  const byItem = new Map<string, Comment[]>();
  for (const c of fb.comments) {
    const l = byItem.get(c.item) ?? [];
    l.push(c);
    byItem.set(c.item, l);
  }
  const ids = ['', ...review.items.map((i) => i.id), ...[...byItem.keys(), ...Object.keys(fb.items)].filter((k) => k && !review.items.some((i) => i.id === k))];
  for (const iid of [...new Set(ids)]) {
    const it = review.items.find((i) => i.id === iid);
    const v = fb.items[iid];
    const cs = byItem.get(iid) ?? [];
    if (!v && !cs.length) continue;
    out.push(`## ${iid === '' ? 'The whole review' : it ? it.title : `${iid} (removed)`}`, '');
    if (it?.kind === 'file') out.push(`\`${it.file}${it.lines ? ':' + it.lines : ''}\``, '');
    if (v) out.push(`**${VERDICT_TEXT[v.verdict]}**${v.note ? `: ${v.note}` : ''}${isStale(it, v) ? ' _(given to an earlier version)_' : ''}${v.ack ? ` — done: ${v.ack.note}` : ''}`, '');
    for (const c of cs) {
      const w = whereText(c);
      out.push(`- [${c.status === 'open' ? ' ' : 'x'}] \`${c.id}\`${w ? ` (${w})` : ''}: ${c.body.replace(/\n/g, '\n  ')}`);
      if (c.quote) out.push(`  > ${c.selected ? '(selected) ' : ''}${c.quote.split('\n').slice(0, 12).join('\n  > ')}`);
      if (c.marked) out.push(`  ![marked](../../${c.marked})`);
      for (const p of c.photos ?? []) out.push(`  ![photo](../../${p})`);
      for (const r of c.replies) out.push(`  - ${r.from === 'owner' ? 'human' : 'agent'}: ${r.body.replace(/\n/g, '\n    ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}
