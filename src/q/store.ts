// A project's question sets on disk:
//   <folder>/.hitl/questions/<set>.json   the questions (the agent writes these)
//   <folder>/.hitl/answers/<set>.json     the answers, replies and read marks (hitl writes these)
//   <folder>/.hitl/answers/<set>.md       the same answers, readable
// Every write is a locked read-modify-write with an atomic rename, so the page, the MCP server and the CLI can all
// write at once from different processes.
import fs from 'node:fs';
import path from 'node:path';
import { StoreError, ensureReadme, stripBom, withLock, writeAtomic } from '../hub/atomic.js';
export { StoreError };
import {
  SET_ID,
  answersMarkdown,
  checkAnswer,
  emptyAnswers,
  normalise,
  questionById,
  recommendedAnswer,
  summarise,
  type Answer,
  type AnswerFile,
  type AnswerInput,
  type Message,
  type Normalised,
  type QuestionInput,
  type SectionInput,
  type SetInput,
  type Summary,
} from './model.js';

export const DIR = '.hitl';
export const SCHEMA_URL = 'https://unpkg.com/hitloop/schema/questions.schema.json';


export interface LoadedSet extends Normalised {
  raw: SetInput;
  mtime: number;
}

export class Questions {
  readonly dir: string;
  readonly setsDir: string;
  readonly answersDir: string;
  private cache = new Map<string, { mtime: number; size: number; loaded: LoadedSet }>();

  constructor(
    readonly root: string,
    dirName = DIR,
  ) {
    this.root = path.resolve(root);
    this.dir = path.resolve(this.root, dirName);
    this.setsDir = path.join(this.dir, 'questions');
    this.answersDir = path.join(this.dir, 'answers');
  }

  get exists(): boolean {
    return fs.existsSync(this.setsDir);
  }

  ensure(): void {
    fs.mkdirSync(this.setsDir, { recursive: true });
    fs.mkdirSync(this.answersDir, { recursive: true });
    ensureReadme(this.dir);
  }

  setPath(id: string): string {
    checkId(id);
    return path.join(this.setsDir, id + '.json');
  }
  answersPath(id: string): string {
    checkId(id);
    return path.join(this.answersDir, id + '.json');
  }
  markdownPath(id: string): string {
    checkId(id);
    return path.join(this.answersDir, id + '.md');
  }

  /** set ids, from the files in sets/ */
  ids(): string[] {
    try {
      return fs
        .readdirSync(this.setsDir)
        .filter((f) => f.endsWith('.json') && SET_ID.test(f.slice(0, -5)))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  has(id: string): boolean {
    return SET_ID.test(id) && fs.existsSync(this.setPath(id));
  }

  /** the set, normalised (cached until the file changes), or undefined when there's no such set */
  load(id: string): LoadedSet | undefined {
    if (!SET_ID.test(id)) return undefined;
    const file = this.setPath(id);
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
    const loaded: LoadedSet = { ...n, raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SetInput) : {}, mtime: st.mtimeMs };
    this.cache.set(id, { mtime: st.mtimeMs, size: st.size, loaded });
    return loaded;
  }

  answers(id: string): AnswerFile {
    try {
      const data: unknown = JSON.parse(stripBom(fs.readFileSync(this.answersPath(id), 'utf8')));
      if (!data || typeof data !== 'object') return emptyAnswers();
      const d = data as Partial<AnswerFile>;
      return {
        version: 1,
        seq: typeof d.seq === 'number' ? d.seq : 0,
        readSeq: typeof d.readSeq === 'number' ? d.readSeq : 0,
        answers: d.answers && typeof d.answers === 'object' ? d.answers : {},
        threads: d.threads && typeof d.threads === 'object' ? d.threads : {},
      };
    } catch {
      return emptyAnswers();
    }
  }

  summary(id: string): Summary | undefined {
    const l = this.load(id);
    if (!l) return undefined;
    return summarise(l.set, this.answers(id), l.errors.length);
  }

  summaries(): Summary[] {
    return this.ids()
      .map((id) => this.summary(id))
      .filter((s): s is Summary => !!s);
  }

  // ── writing answers ──

  /** Change the answers file under its lock; the markdown copy is rewritten too. */
  mutateAnswers<T>(id: string, fn: (af: AnswerFile) => T): T {
    if (!this.has(id)) throw new StoreError(`No set "${id}"`);
    fs.mkdirSync(this.answersDir, { recursive: true });
    return withLock(this.answersPath(id), () => {
      const af = this.answers(id);
      const result = fn(af);
      writeAtomic(this.answersPath(id), JSON.stringify(af, null, 2) + '\n');
      const l = this.load(id);
      if (l) writeAtomic(this.markdownPath(id), answersMarkdown(l.set, af));
      return result;
    });
  }

  /** Answer a question (from the page or the CLI). Returns the stored answer. */
  answer(id: string, qid: string, input: AnswerInput): Answer {
    const l = this.mustLoad(id);
    const q = questionById(l.set, qid);
    if (!q) throw new StoreError(`No question "${qid}" in "${id}"`);
    const checked = checkAnswer(q, input);
    if (!checked.ok) throw new StoreError(checked.error);
    return this.mutateAnswers(id, (af) => {
      const prev = af.answers[qid];
      const a: Answer = { ...checked.answer, rev: q.rev, at: new Date().toISOString(), seq: ++af.seq };
      // the agent's "applied" note stays only while the answer says the same thing
      if (prev?.ack && same(prev, a)) a.ack = prev.ack;
      af.answers[qid] = a;
      return a;
    });
  }

  clear(id: string, qid: string): void {
    this.mutateAnswers(id, (af) => {
      if (af.answers[qid]) {
        delete af.answers[qid];
        af.seq++;
      }
    });
  }

  /** Take the recommendation for each of these questions that has one and isn't answered. Returns the ids taken. */
  acceptRecommended(id: string, qids: string[]): string[] {
    const l = this.mustLoad(id);
    return this.mutateAnswers(id, (af) => {
      const taken: string[] = [];
      for (const qid of qids) {
        const q = questionById(l.set, qid);
        if (!q || (af.answers[qid] && af.answers[qid]?.status !== 'later')) continue;
        const rec = recommendedAnswer(q);
        if (!rec) continue;
        const checked = checkAnswer(q, rec);
        if (!checked.ok) continue;
        af.answers[qid] = { ...checked.answer, rev: q.rev, at: new Date().toISOString(), seq: ++af.seq };
        taken.push(qid);
      }
      return taken;
    });
  }

  /** A message on a question's thread, from the owner (the page) or the agent. */
  message(id: string, qid: string, from: Message['from'], body: string): Message {
    const l = this.mustLoad(id);
    if (!questionById(l.set, qid)) throw new StoreError(`No question "${qid}" in "${id}"`);
    if (!body.trim()) throw new StoreError('The message is empty');
    return this.mutateAnswers(id, (af) => {
      const m: Message = { from, body: body.slice(0, 20000), at: new Date().toISOString(), seq: ++af.seq };
      (af.threads[qid] ??= []).push(m);
      return m;
    });
  }

  /** The agent applied these answers: mark them, with a note the owner sees. Returns the ids marked. */
  ack(id: string, qids: string[], note: string): string[] {
    return this.mutateAnswers(id, (af) => {
      const done: string[] = [];
      for (const qid of qids) {
        const a = af.answers[qid];
        if (!a) continue;
        a.ack = { at: new Date().toISOString(), note: note.slice(0, 2000) };
        done.push(qid);
      }
      if (done.length) af.seq++;
      return done;
    });
  }

  /** The agent has read everything so far. */
  markRead(id: string, upTo?: number): void {
    this.mutateAnswers(id, (af) => {
      af.readSeq = Math.max(af.readSeq, Math.min(upTo ?? af.seq, af.seq));
    });
  }

  // ── writing sets ──

  /** Change the set file (as written, not normalised) under its lock. Rejects the change if it leaves errors. */
  mutateSet<T>(id: string, fn: (raw: SetInput) => T, opts: { create?: boolean; force?: boolean } = {}): { result: T; normalised: Normalised } {
    checkId(id);
    this.ensure();
    const file = this.setPath(id);
    return withLock(file, () => {
      let raw: SetInput;
      if (fs.existsSync(file)) {
        try {
          raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) as SetInput;
        } catch (e) {
          throw new StoreError(`${path.basename(file)} isn't valid JSON (${e instanceof Error ? e.message : String(e)}); fix it by hand first`);
        }
      } else if (opts.create) raw = { $schema: SCHEMA_URL, title: id, created: new Date().toISOString(), sections: [] };
      else throw new StoreError(`No set "${id}"`);
      const before = normalise(id, raw).errors.length;
      const result = fn(raw);
      raw.updated = new Date().toISOString();
      const n = normalise(id, raw);
      if (n.errors.length > before && !opts.force) throw new StoreError('That would make the set invalid:\n' + n.errors.map((e) => '  ' + e).join('\n'));
      writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
      this.cache.delete(id);
      return { result, normalised: n };
    });
  }

  /** Add questions to a section (made if needed). Questions without ids get one from their text. */
  addQuestions(id: string, questions: QuestionInput[], section?: SectionInput | string, opts: { title?: string; before?: string; from?: string } = {}): { ids: string[]; normalised: Normalised } {
    const { result, normalised } = this.mutateSet(
      id,
      (raw) => {
        if (opts.title && (!raw.title || raw.title === id)) raw.title = opts.title;
        if (opts.from && !raw.from) raw.from = opts.from;
        raw.sections ??= [];
        const sec = typeof section === 'string' ? { id: section } : section;
        let target: SectionInput | undefined;
        if (sec?.id || sec?.title) {
          const sid = sec.id ?? undefined;
          target = raw.sections.find((s) => (sid ? s.id === sid : s.title === sec.title));
          if (!target) {
            target = { ...sec, questions: [] };
            raw.sections.push(target);
          } else {
            for (const k of ['title', 'intro', 'content', 'hidden', 'showIf'] as const) if (sec[k] !== undefined && target[k] === undefined) Object.assign(target, { [k]: sec[k] });
          }
        } else if (raw.questions || !raw.sections.length) {
          raw.questions ??= [];
          target = { questions: raw.questions };
        } else {
          target = raw.sections[raw.sections.length - 1];
        }
        if (!target) throw new StoreError('No section to add to');
        target.questions ??= [];
        const taken = new Set(existingIds(raw));
        const ids: string[] = [];
        for (const q of questions) {
          const copy: QuestionInput = { ...q };
          if (!copy.id) {
            const base = slugOf(copy.question ?? copy.q ?? 'q');
            let qid = base,
              n = 2;
            while (taken.has(qid)) qid = `${base}-${n++}`;
            copy.id = qid;
          }
          if (taken.has(copy.id)) throw new StoreError(`The id "${copy.id}" is already in the set (use update_question to change it)`);
          taken.add(copy.id);
          ids.push(copy.id);
          const at = opts.before ? target.questions.findIndex((x) => x.id === opts.before) : -1;
          if (at >= 0) target.questions.splice(at, 0, copy);
          else target.questions.push(copy);
        }
        return ids;
      },
      { create: true },
    );
    return { ids: result, normalised };
  }

  /** Change one question: the patch's fields replace the question's (null removes one). */
  updateQuestion(id: string, qid: string, patch: Record<string, unknown>): Normalised {
    return this.mutateSet(id, (raw) => {
      const q = findRaw(raw, qid);
      if (!q) throw new StoreError(`No question "${qid}" in "${id}"`);
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id') continue;
        if (v === null) delete (q as Record<string, unknown>)[k];
        else (q as Record<string, unknown>)[k] = v;
      }
    }).normalised;
  }

  removeQuestions(id: string, qids: string[]): string[] {
    return this.mutateSet(id, (raw) => {
      const removed: string[] = [];
      const lists = [raw.questions ?? [], ...(raw.sections ?? []).map((s) => s.questions ?? [])];
      for (const list of lists)
        for (let i = list.length - 1; i >= 0; i--) {
          const q = list[i];
          if (q?.id && qids.includes(q.id)) {
            list.splice(i, 1);
            removed.push(q.id);
          }
        }
      return removed;
    }, { force: true }).result;
  }

  /** Set-level fields: title, intro, content, status. */
  updateSet(id: string, patch: Partial<Pick<SetInput, 'title' | 'intro' | 'content' | 'status'>>, create = false): Normalised {
    return this.mutateSet(
      id,
      (raw) => {
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) (raw as Record<string, unknown>)[k] = v;
      },
      { create },
    ).normalised;
  }

  /** Change or add a section's own fields (not its questions). */
  updateSection(id: string, sid: string, patch: Omit<SectionInput, 'questions' | 'id'>): Normalised {
    return this.mutateSet(id, (raw) => {
      raw.sections ??= [];
      let s = raw.sections.find((x) => x.id === sid);
      if (!s) {
        s = { id: sid, questions: [] };
        raw.sections.push(s);
      }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete (s as Record<string, unknown>)[k];
        else if (v !== undefined) (s as Record<string, unknown>)[k] = v;
      }
    }).normalised;
  }

  private mustLoad(id: string): LoadedSet {
    const l = this.load(id);
    if (!l) throw new StoreError(`No set "${id}"`);
    return l;
  }
}

function checkId(id: string): void {
  if (!SET_ID.test(id)) throw new StoreError(`Bad set id "${id}": letters, digits, . _ - (up to 80)`);
}

function existingIds(raw: SetInput): string[] {
  const out: string[] = [];
  for (const q of raw.questions ?? []) if (q.id) out.push(q.id);
  for (const s of raw.sections ?? []) {
    if (s.id) out.push(s.id);
    for (const q of s.questions ?? []) if (q.id) out.push(q.id);
  }
  return out;
}

function findRaw(raw: SetInput, qid: string): QuestionInput | undefined {
  for (const q of raw.questions ?? []) if (q.id === qid) return q;
  for (const s of raw.sections ?? []) for (const q of s.questions ?? []) if (q.id === qid) return q;
  return undefined;
}

function slugOf(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'q'
  );
}

function same(a: Answer, b: Answer): boolean {
  const pick = (x: Answer) => JSON.stringify([x.status, x.picked ?? [], x.other ?? '', x.text ?? '', x.number ?? null, x.order ?? [], x.note ?? '']);
  return pick(a) === pick(b);
}

