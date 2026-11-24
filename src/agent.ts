// What an agent reads: one feed of everything the human said since it last read (answers, verdicts, comments, notes),
// compact so hundreds of answers don't flood its context; waiting until the human has said something; and the
// decision log. Shared by the MCP tools and the CLI.
import path from 'node:path';
import { Questions, StoreError } from './q/store.js';
import { readAnswers, summaryLine as questionsLine } from './q/agent.js';
import { allQuestions, answerText, isDone, type Answer } from './q/model.js';
import { Reviews } from './r/store.js';
import { VERDICT_TEXT, isStale, summarise, verdictText, whereText, type Comment, type Summary as ReviewSummary } from './r/model.js';
import fs from 'node:fs';
import { Notes, byAgent, type Comment as Note } from './fs/notes.js';

/** A project as the agent side sees it: its files on disk, no watching. */
export interface ProjectView {
  root: string;
  questions: Questions;
  reviews: Reviews;
  notes: Notes;
}

export function openProject(root: string): ProjectView {
  const r = path.resolve(root);
  return { root: r, questions: new Questions(r), reviews: new Reviews(r), notes: new Notes(path.join(r, '.hitl', 'notes'), r) };
}

// ── reviews ──

export function reviewLine(s: ReviewSummary): string {
  const bits: string[] = [];
  if (s.mode === 'approve') bits.push(s.overall ? (s.overall === 'ok' ? 'APPROVED' : s.overall === 'no' ? 'REFUSED' : 'changes asked for') : 'waiting for a yes or no');
  else {
    if (s.mode === 'review') bits.push(`${s.reviewed} of ${s.items} items reviewed`);
    else bits.push(`${s.items} item${s.items === 1 ? '' : 's'} shown`);
    if (s.ok) bits.push(`${s.ok} good`);
    if (s.changes) bits.push(`${s.changes} need changes`);
    if (s.no) bits.push(`${s.no} no`);
    if (s.open) bits.push(`${s.open} open comment${s.open === 1 ? '' : 's'}`);
    if (s.overall) bits.push(`overall: ${VERDICT_TEXT[s.overall]}`);
  }
  if (s.stale) bits.push(`${s.stale} verdict${s.stale === 1 ? '' : 's'} on an earlier version`);
  if (s.unread) bits.push(`${s.unread} new`);
  if (s.status === 'closed') bits.push('closed');
  if (s.errors) bits.push(`${s.errors} error${s.errors === 1 ? '' : 's'} in the file`);
  return `${s.id} (${s.mode}, "${s.title}"${s.from ? `, from ${s.from}` : ''}): ${bits.join(', ')}`;
}

export const REVIEW_FILTERS = ['new', 'all', 'open'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

/** The human's feedback on a review, as text and data. "new" marks it read unless peek. */
export function readFeedback(reviews: Reviews, id: string, opts: { filter?: ReviewFilter; peek?: boolean } = {}): { text: string; data: unknown } {
  const l = reviews.load(id);
  if (!l) throw new StoreError(`No review "${id}"${reviews.ids().length ? ` (there are: ${reviews.ids().join(', ')})` : ''}`);
  const fb = reviews.feedback(id);
  const r = l.review;
  const filter = opts.filter ?? 'new';
  const since = filter === 'new' ? fb.readSeq : -1;
  const s = summarise(r, fb, l.errors.length);
  const lines = [reviewLine(s)];
  if (fb.overall && fb.overall.seq > since) lines.push(`- OVERALL: ${verdictText(r, fb.overall.verdict).toUpperCase()}${fb.overall.note ? ` — "${fb.overall.note}"` : ''}`);
  const label = (iid: string) => {
    const it = r.items.find((i) => i.id === iid);
    return iid === '' ? '(the whole review)' : it ? `${iid} (${it.title})` : `${iid} (removed)`;
  };
  for (const it of r.items) {
    const v = fb.items[it.id];
    if (v && v.seq > since) lines.push(`- ${label(it.id)}: ${VERDICT_TEXT[v.verdict]}${v.note ? ` — "${v.note}"` : ''}${isStale(it, v) ? ' (given to an earlier version)' : ''}${v.ack && filter !== 'new' ? ` [done: ${v.ack.note}]` : ''}`);
  }
  const show = (c: Comment) => {
    const fresh = c.seq > since || c.replies.some((x) => x.seq > since && x.from === 'owner');
    if (filter === 'open') return c.status === 'open' && c.from === 'owner';
    return fresh;
  };
  for (const c of fb.comments.filter(show)) {
    const w = whereText(c);
    lines.push(`- comment ${c.id} on ${label(c.item)}${w ? `, ${w}` : ''}${c.status === 'resolved' ? ' [resolved]' : ''}: "${c.body}"`);
    if (c.quote) lines.push(`  ${c.selected ? 'selected text' : 'about'}: ${JSON.stringify(c.quote.length > 300 ? c.quote.slice(0, 297) + '…' : c.quote)}`);
    if (c.marked) lines.push(`  marked-up picture: ${c.marked}`);
    for (const p of c.photos ?? []) lines.push(`  photo: ${p}`);
    for (const x of c.replies) if (filter !== 'new' || (x.seq > since && x.from === 'owner')) lines.push(`  ${x.from === 'owner' ? 'human' : 'you'}: "${x.body}"`);
  }
  if (lines.length === 1) lines.push(filter === 'new' ? 'Nothing new since you last read.' : filter === 'open' ? 'No open comments.' : 'No feedback yet.');
  if (filter === 'new' && !opts.peek && fb.seq > fb.readSeq) reviews.markRead(id, fb.seq);
  return { text: lines.join('\n'), data: { summary: s, feedback: fb } };
}

// ── notes ──

export function readNotes(notes: Notes, opts: { filter?: 'new' | 'open' | 'all'; peek?: boolean } = {}): { text: string; count: number } {
  const { seq, readSeq } = notes.marks();
  const filter = opts.filter ?? 'new';
  const list = notes.all().filter((c) => {
    if (filter === 'open') return c.status === 'open';
    if (filter === 'all') return true;
    return (!byAgent(c) && (c.seq ?? 0) > readSeq) || (c.replies ?? []).some((r) => r.from !== 'agent' && (r.seq ?? 0) > readSeq);
  });
  const lines: string[] = [];
  for (const c of list) {
    const where = !c.path ? 'a note' : c.line ? `${c.path}:${c.line}${c.endLine ? '-' + c.endLine : ''}` : c.area ? `${c.path} (marked area ${c.area.w}×${c.area.h} at ${c.area.x},${c.area.y})` : c.path;
    lines.push(`- ${byAgent(c) ? 'your message' : 'note'} ${c.id} on ${where}${c.status === 'resolved' ? ' [resolved]' : ''}: "${c.body}"`);
    if (c.quote) lines.push(`  ${c.selected ? 'selected text' : 'lines'}: ${JSON.stringify(c.quote.length > 300 ? c.quote.slice(0, 297) + '…' : c.quote)}`);
    if (c.image) lines.push(`  marked-up picture: .hitl/notes/${c.image}`);
    for (const p of c.photos ?? []) lines.push(`  photo: .hitl/notes/${p}`);
    for (const r of c.replies ?? []) if (filter !== 'new' || ((r.seq ?? 0) > readSeq && r.from !== 'agent' && r.author !== 'agent')) lines.push(`  ${r.from === 'agent' || r.author === 'agent' ? 'you' : 'human'}: "${r.body}"`);
  }
  if (filter === 'new' && !opts.peek && seq > readSeq) notes.markRead(seq);
  return { text: lines.join('\n'), count: list.length };
}

/** The agent writes to the human: a new thread on the Notes page (on a file, lines of it, or nothing in particular)
 * that notifies them and that they can reply to; their replies come back in news. */
export function sendMessage(p: ProjectView, m: { message: string; path?: string; line?: number; endLine?: number; from?: string }): Note {
  const body = m.message.trim();
  if (!body) throw new StoreError('What should the message say? Pass "message".');
  let rel = '';
  if (m.path) {
    const abs = path.resolve(p.root, m.path);
    rel = path.relative(p.root, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) throw new StoreError(`"${m.path}" is not in the project (${p.root}).`);
    if (!fs.existsSync(abs)) throw new StoreError(`No file "${rel}" in the project.`);
  }
  const line = rel && m.line && m.line > 0 ? Math.floor(m.line) : undefined;
  const endLine = line && m.endLine && m.endLine > line ? Math.floor(m.endLine) : undefined;
  return p.notes.add({ path: rel, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), body, author: m.from?.trim() || 'agent', from: 'agent' });
}

// ── the feed ──

export interface NewsCounts {
  questions: number;
  reviews: number;
  notes: number;
  total: number;
}

/** How much is new for the agent, per kind (cheap: nothing is marked read). */
export function newsCounts(p: ProjectView): NewsCounts {
  let questions = 0,
    reviews = 0;
  for (const s of p.questions.summaries()) questions += s.unread + s.unreadMessages;
  for (const s of p.reviews.summaries()) reviews += s.unread;
  const notes = p.notes.unread();
  return { questions, reviews, notes, total: questions + reviews + notes };
}

/** Everything the human said since the agent last read, across every question set, review and note. */
export function news(p: ProjectView, opts: { peek?: boolean; ids?: string[] } = {}): { text: string; counts: NewsCounts } {
  const counts = newsCounts(p);
  const out: string[] = [];
  const want = (id: string) => !opts.ids?.length || opts.ids.includes(id);
  for (const s of p.reviews.summaries()) {
    if (!s.unread || !want(s.id)) continue;
    out.push(`## Review ${readFeedback(p.reviews, s.id, { filter: 'new', peek: opts.peek }).text}`, '');
  }
  for (const s of p.questions.summaries()) {
    if (!(s.unread + s.unreadMessages) || !want(s.id)) continue;
    out.push(`## Questions ${readAnswers(p.questions, s.id, { filter: 'new', peek: opts.peek }).text}`, '');
  }
  if (counts.notes && want('notes')) {
    const n = readNotes(p.notes, { filter: 'new', peek: opts.peek });
    if (n.count) out.push(`## Notes from the human (${n.count}; resolve each with a reply saying what you did)`, n.text, '');
  }
  if (!out.length) out.push('Nothing new from the human since you last read.');
  return { text: out.join('\n').trimEnd(), counts };
}

/** What's open, briefly: for `hitl status` and the MCP list tool. */
export function overviewText(p: ProjectView): string {
  const lines: string[] = [];
  const reviews = p.reviews.summaries();
  const sets = p.questions.summaries();
  const notes = p.notes.all();
  if (reviews.length) lines.push('Reviews:', ...reviews.map((s) => '- ' + reviewLine(s)));
  if (sets.length) lines.push('Question sets:', ...sets.map((s) => '- ' + questionsLine(s)));
  const open = notes.filter((c) => c.status === 'open').length;
  if (notes.length) lines.push(`Notes from the human: ${open} open of ${notes.length}${p.notes.unread() ? `, ${p.notes.unread()} new` : ''}`);
  if (!lines.length) lines.push(`Nothing in ${p.root} yet: no questions, reviews or notes.`);
  const c = newsCounts(p);
  if (c.total) lines.push('', `New since you last read: ${c.total} (npx hitloop news, or the news tool).`);
  return lines.join('\n');
}

// ── waiting ──

export const WAITS = ['any', 'done', 'all', 'blocking'] as const;
export type WaitFor = (typeof WAITS)[number];

export interface WaitOptions {
  /** any: anything new; done: the review's overall verdict (or approval) is given, or the question set is all answered;
   *  all: every item has a verdict / every question is answered; blocking: the blocking questions are answered */
  until?: WaitFor;
  /** request ids to watch (default: everything in the project) */
  ids?: string[];
  timeoutMs?: number;
  /** once it's true, wait until the human has paused this long */
  settleMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

function met(p: ProjectView, w: WaitOptions): { ok: boolean; stamp: string } {
  const until = w.until ?? 'any';
  const ids = w.ids?.length ? w.ids : undefined;
  const stamp: number[] = [];
  if (until === 'any') {
    let n = 0;
    for (const s of p.reviews.summaries()) if (!ids || ids.includes(s.id)) n += s.unread;
    for (const s of p.questions.summaries()) if (!ids || ids.includes(s.id)) n += s.unread + s.unreadMessages;
    if (!ids || ids.includes('notes')) n += p.notes.unread();
    return { ok: n > 0, stamp: String(n) + ':' + seqs(p, ids) };
  }
  const targets = ids ?? [...p.reviews.ids().filter((id) => p.reviews.summary(id)?.status === 'open'), ...p.questions.ids()];
  if (!targets.length) throw new StoreError('Nothing to wait for: name a review or question set');
  let ok = true;
  for (const id of targets) {
    if (p.reviews.has(id)) {
      const s = p.reviews.summary(id);
      if (!s) continue;
      stamp.push(p.reviews.feedback(id).seq);
      // dismissed by the human: nothing more to wait for, so a wait doesn't hang on it
      if (s.status === 'closed') continue;
      if (until === 'done' || until === 'blocking') ok &&= s.done;
      else ok &&= s.done || (s.mode !== 'approve' && s.reviewed >= s.items && s.items > 0);
    } else if (p.questions.has(id)) {
      const s = p.questions.summary(id);
      if (!s) continue;
      stamp.push(p.questions.answers(id).seq);
      if (s.status === 'closed') continue;
      if (until === 'blocking') ok &&= s.blocking === 0;
      else ok &&= s.toAnswer === 0;
    } else throw new StoreError(`No review or question set "${id}"`);
  }
  return { ok, stamp: stamp.join(',') };
}

function seqs(p: ProjectView, ids?: string[]): string {
  const out: number[] = [];
  for (const id of p.reviews.ids()) if (!ids || ids.includes(id)) out.push(p.reviews.feedback(id).seq);
  for (const id of p.questions.ids()) if (!ids || ids.includes(id)) out.push(p.questions.answers(id).seq);
  out.push(p.notes.marks().seq);
  return out.join(',');
}

/** Wait until the condition holds (and the human has paused). Resolves true, or false on timeout or abort. */
export async function waitFor(p: ProjectView, w: WaitOptions): Promise<boolean> {
  const started = Date.now();
  const poll = w.pollMs ?? 1000;
  let metAt = 0;
  let lastStamp = '';
  for (;;) {
    if (w.signal?.aborted) return false;
    const m = met(p, w);
    if (m.ok) {
      if (!w.settleMs) return true;
      if (m.stamp !== lastStamp) {
        lastStamp = m.stamp;
        metAt = Date.now();
      } else if (Date.now() - metAt >= w.settleMs) return true;
    } else lastStamp = '';
    if (w.timeoutMs && Date.now() - started >= w.timeoutMs) return false;
    await new Promise((r) => setTimeout(r, poll));
  }
}

// ── the decision log ──

export interface Decision {
  at: string;
  kind: 'answer' | 'verdict' | 'approval' | 'overall';
  /** the question set or review */
  request: string;
  requestTitle: string;
  /** the question or item */
  id: string;
  subject: string;
  decision: string;
  note?: string;
  from?: string;
}

/** What the human decided: every answer, verdict and approval, newest first. q narrows it (words, all must match). */
export function decisions(p: ProjectView, opts: { q?: string; limit?: number } = {}): { decisions: Decision[]; total: number } {
  const out: Decision[] = [];
  for (const id of p.questions.ids()) {
    const l = p.questions.load(id);
    if (!l) continue;
    const af = p.questions.answers(id);
    for (const q of allQuestions(l.set)) {
      const a: Answer | undefined = af.answers[q.id];
      if (!a || !isDone(a) || a.status === 'skipped') continue;
      out.push({ at: a.at, kind: 'answer', request: id, requestTitle: l.set.title, id: q.id, subject: q.question, decision: answerText(q, a), ...(a.note ? { note: a.note } : {}) });
    }
  }
  for (const id of p.reviews.ids()) {
    const l = p.reviews.load(id);
    if (!l) continue;
    const fb = p.reviews.feedback(id);
    const r = l.review;
    if (fb.overall)
      out.push({ at: fb.overall.at, kind: r.mode === 'approve' ? 'approval' : 'overall', request: id, requestTitle: r.title, id: '', subject: r.title, decision: verdictText(r, fb.overall.verdict), ...(fb.overall.note ? { note: fb.overall.note } : {}), ...(r.from ? { from: r.from } : {}) });
    for (const it of r.items) {
      const v = fb.items[it.id];
      if (v) out.push({ at: v.at, kind: 'verdict', request: id, requestTitle: r.title, id: it.id, subject: it.title, decision: VERDICT_TEXT[v.verdict], ...(v.note ? { note: v.note } : {}), ...(r.from ? { from: r.from } : {}) });
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  const words = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? out.filter((d) => words.every((w) => `${d.requestTitle} ${d.subject} ${d.decision} ${d.note ?? ''} ${d.request} ${d.id}`.toLowerCase().includes(w))) : out;
  return { decisions: hits.slice(0, Math.max(1, Math.min(2000, opts.limit ?? 200))), total: hits.length };
}

export function decisionsText(p: ProjectView, opts: { q?: string; limit?: number } = {}): string {
  const { decisions: list, total } = decisions(p, opts);
  if (!list.length) return opts.q ? `No decisions match "${opts.q}".` : 'No decisions yet.';
  const lines = [`${total} decision${total === 1 ? '' : 's'}${opts.q ? ` matching "${opts.q}"` : ''}${total > list.length ? ` (the newest ${list.length})` : ''}:`];
  for (const d of list) lines.push(`- ${d.at.slice(0, 10)} ${d.request}${d.id ? '/' + d.id : ''} — ${short(d.subject)}: ${d.decision}${d.note ? ` ("${d.note}")` : ''}`);
  return lines.join('\n');
}

const short = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '…' : t;
};

export function parseDuration(s: string | undefined, fallback: number): number {
  if (s === undefined || s === '') return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new StoreError(`Not a duration: "${s}" (like 90s, 10m, 2h)`);
  const n = Number(m[1]);
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'] ?? 1000));
}
