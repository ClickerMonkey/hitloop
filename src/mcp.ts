// `hitl mcp`: an MCP server on stdio (JSON-RPC, one message per line). Tools for an agent to ask the human questions,
// show things for review, ask for approval, and read what the human said, a little at a time. No SDK: the protocol
// needed here is small, and npx starts it quickly.
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { StoreError } from './hub/atomic.js';
import { describeSet, readAnswers, FILTERS, type Filter } from './q/agent.js';
import { decisionsText, news, openProject, overviewText, readFeedback, readNotes, waitFor, REVIEW_FILTERS, WAITS, type ProjectView, type ReviewFilter, type WaitFor } from './agent.js';
import { ensureHub, links, register, keyed, projects, runningHub } from './hub/registry.js';
import { questionSchema, sectionSchema, blockSchema, conditionSchema } from './q/schema.js';
import { itemSchema } from './r/schema.js';
import { version } from './server.js';
import type { QuestionInput, SectionInput, SetInput } from './q/model.js';
import type { ItemArg } from './r/store.js';
import type { Mode } from './r/model.js';

export const INSTRUCTIONS = `hitl (Human In The Loop) puts things in front of the user on their phone or computer, and saves what they say in the project (.hitl/). Use it instead of chat when:
- you have more than about 4 questions, or questions that need thought or pictures: add_questions (one set per topic), each with options, one recommended, and why it matters; mark the ones you can't go on without as blocking.
- you want the user to look at or review something: show (mode "review" asks a verdict per item; "show" is just to look). Items can be project files (whole, lines, or changes since a git revision), raw code/text/markdown/JSON, diffs, pictures (with a before for before/after), diagrams, HTML mockups, links. Each call makes its own review: it never replaces another's.
- you need a yes or no before doing something (a deploy, deleting data, spending money): approve. It waits, then tells you approved or refused.
Then give the user the link from the result (get_link gives it again). Keep working on what doesn't depend on the answer. To wait, prefer running \`npx hitloop wait --any\` (or \`--done <id>\`) in the background: it exits, and wakes you, when the user has said something. The wait tool blocks for at most a few minutes.
Read only what's new with news: answers, verdicts, comments on lines and marked picture areas, and notes the user wrote on files (or anywhere). Apply them, then ack (answers and verdicts) or resolve (comments and notes) with a short note the user sees. Put the user's words into docs word for word. decisions searches what they decided before: check it before asking again.
Say who's asking with "from" (your session's name or branch). The hitl CLI does all of this too, plus serving and setup: \`npx hitloop --help\` lists every command and option; check it instead of guessing.`;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json, signal: AbortSignal) => Promise<string>;
}

const folderProp = { folder: { type: 'string', description: 'The project folder (default: the folder the MCP server started in)' } };
const setProp = { set: { type: 'string', description: 'The question set id: letters, digits, . _ - (its file is .hitl/questions/<set>.json)' } };
const reviewProp = { review: { type: 'string', description: 'The review id (from show or approve)' } };
const fromProp = { from: { type: 'string', description: "Who's asking: your session's name, the branch, the tool (shown to the user)" } };
const idsProp = { ids: { type: 'array', items: { type: 'string' } } };

const projectOf = (args: Json): ProjectView => openProject(path.resolve(typeof args['folder'] === 'string' && args['folder'] ? args['folder'] : process.cwd()));
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const need = (v: unknown, what: string) => {
  const s = str(v);
  if (!s) throw new StoreError(`Which ${what}? Pass "${what}".`);
  return s;
};

let branchCache: Record<string, string> = {};
/** who's asking, when the agent doesn't say: HITL_FROM, else the git branch */
export function defaultFrom(root: string): string {
  if (process.env['HITL_FROM']) return process.env['HITL_FROM'];
  if (!(root in branchCache)) {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    branchCache = { ...branchCache, [root]: r.status === 0 && r.stdout.trim() && r.stdout.trim() !== 'HEAD' ? `branch ${r.stdout.trim()}` : '' };
  }
  return branchCache[root] ?? '';
}

/** The hub's links to a place in the project (the hub is started if needed, and knows the project). */
export async function linkFor(root: string, where = '', start = true): Promise<string> {
  register(root);
  const hub = start ? await ensureHub() : await runningHub();
  if (!hub) return 'The hitl server is not running (get_link starts it).';
  const key = keyed(projects()).find((p) => path.resolve(p.root).toLowerCase() === path.resolve(root).toLowerCase())?.key ?? '';
  const hash = key ? `#/p/${encodeURIComponent(key)}${where}` : '';
  const all = links(hub.port, hub.host, hub.token, hash, hub.base);
  return ['Links for the user (the first is this computer; the others work from a phone on the same network or Tailscale):', ...all.map((l) => '  ' + l)].join('\n');
}

function problems(n: { errors: string[]; warnings: string[] }): string {
  const out: string[] = [];
  if (n.errors.length) out.push('Errors:', ...n.errors.map((e) => '  ' + e));
  if (n.warnings.length) out.push('Warnings:', ...n.warnings.slice(0, 20).map((e) => '  ' + e));
  return out.join('\n');
}

const clampTimeout = (v: unknown, dflt: number) => Math.min(900, Math.max(1, typeof v === 'number' ? v : dflt)) * 1000;

const tools: Tool[] = [
  // ── everything ──
  {
    name: 'news',
    description:
      "Everything the user said since you last read, across every question set, review and note: answers, verdicts, comments (on lines, on marked areas of pictures, with photos), and notes they wrote on files. Compact, one line each. Reading marks it read unless peek. Start here.",
    inputSchema: { type: 'object', properties: { peek: { type: 'boolean', description: "Don't mark it read" }, ...idsProp, ...folderProp } },
    run: async (a) => news(projectOf(a), { peek: a['peek'] === true, ids: strList(a['ids']) }).text,
  },
  {
    name: 'status',
    description: "What's in this project: every review and question set with its counts, and the notes. Cheap: nothing is marked read.",
    inputSchema: { type: 'object', properties: { ...folderProp } },
    run: async (a) => {
      const p = projectOf(a);
      const hub = await runningHub();
      return [overviewText(p), hub ? '\n' + (await linkFor(p.root, '', false)).split('\n').slice(0, 3).join('\n') : ''].join('');
    },
  },
  {
    name: 'wait',
    description:
      'Block until the user has said something: until "any" (anything new; the default), "done" (these reviews have an overall verdict or approval / these question sets are all answered), "all" (every item has a verdict / every question answered), or "blocking" (the blocking questions are answered). ids narrows it to some reviews or question sets ("notes" for notes). Waits at most timeout_seconds (default 240, max 900); settle_seconds waits for a pause. For longer waits run `npx hitloop wait --any` in the background instead. Returns the news when it ends.',
    inputSchema: { type: 'object', properties: { until: { enum: [...WAITS] }, ...idsProp, timeout_seconds: { type: 'number' }, settle_seconds: { type: 'number' }, ...folderProp } },
    run: async (a, signal) => {
      const p = projectOf(a);
      const until = (WAITS as readonly string[]).includes(str(a['until'])) ? (str(a['until']) as WaitFor) : 'any';
      const timeout = clampTimeout(a['timeout_seconds'], 240);
      const settle = Math.max(0, typeof a['settle_seconds'] === 'number' ? a['settle_seconds'] : until === 'any' ? 20 : 0) * 1000;
      const ok = await waitFor(p, { until, ids: strList(a['ids']), timeoutMs: timeout, settleMs: settle, signal });
      return (ok ? 'Done waiting.\n' : `Still waiting after ${Math.round(timeout / 1000)} s.\n`) + news(p, { ids: strList(a['ids']) }).text;
    },
  },
  {
    name: 'get_link',
    description: 'Links to the project (or one review or question set) on the shared hitl server, which this starts if needed. Give these to the user.',
    inputSchema: { type: 'object', properties: { review: { type: 'string' }, set: { type: 'string' }, ...folderProp } },
    run: async (a) => linkFor(projectOf(a).root, str(a['review']) ? `/r/${encodeURIComponent(str(a['review']))}` : str(a['set']) ? `/q/${encodeURIComponent(str(a['set']))}` : ''),
  },
  {
    name: 'decisions',
    description: 'What the user decided before: every answer, verdict and approval, newest first. q narrows it by words (all must match). Check this before asking something again.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' }, ...folderProp } },
    run: async (a) => decisionsText(projectOf(a), { q: str(a['q']), limit: typeof a['limit'] === 'number' ? a['limit'] : 60 }),
  },

  // ── reviews ──
  {
    name: 'show',
    description:
      'Put things in front of the user: files, code, text, diffs, pictures, diagrams, mockups, links. mode "review" (the default) asks for a verdict on each item (looks good / needs changes / no) and lets them comment on lines and mark areas of pictures; mode "show" is just to look. Each call makes a new review (its own file: it never replaces another) unless "to" names one to add to. Returns its id and the link to send.',
    inputSchema: {
      type: 'object',
      required: ['items'],
      properties: {
        title: { type: 'string', description: 'What this is, short ("Login screen, round 2")' },
        intro: { type: 'string', description: 'Markdown at the top: what you did and what you want from them' },
        mode: { enum: ['review', 'show'] },
        items: { type: 'array', items: itemSchema, minItems: 1 },
        to: { type: 'string', description: 'Add these items to this review instead of making a new one' },
        ...fromProp,
        ...folderProp,
      },
    },
    run: async (a) => {
      const p = projectOf(a);
      const items = Array.isArray(a['items']) ? (a['items'] as ItemArg[]) : [];
      if (!items.length) throw new StoreError('Nothing to show: pass items');
      const from = str(a['from']) || defaultFrom(p.root);
      const to = str(a['to']);
      if (to) {
        const r = p.reviews.addItems(to, items, { ...(str(a['title']) ? { title: str(a['title']) } : {}), ...(str(a['intro']) ? { intro: str(a['intro']) } : {}) });
        return [`Added ${r.ids.length} item${r.ids.length === 1 ? '' : 's'} to "${to}": ${r.ids.join(', ')}`, problems(r.normalised), await linkFor(p.root, `/r/${encodeURIComponent(to)}`)].filter(Boolean).join('\n');
      }
      const mode: Mode = a['mode'] === 'show' ? 'show' : 'review';
      const r = p.reviews.create({ title: str(a['title']) || 'Review', ...(str(a['intro']) ? { intro: str(a['intro']) } : {}), mode, ...(from ? { from } : {}) }, items);
      return [
        `Made ${mode === 'show' ? 'a showing' : 'a review'} "${r.id}" with ${r.ids.length} item${r.ids.length === 1 ? '' : 's'}: ${r.ids.join(', ')}`,
        problems(r.normalised),
        await linkFor(p.root, `/r/${encodeURIComponent(r.id)}`),
        `Read what they say with news (or get_feedback review "${r.id}"); wait with \`npx hitloop wait --done ${r.id}\` in the background.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'approve',
    description:
      'Ask the user for a yes or no before you do something (deploy, delete, spend, send). Shows the question, your details and any items, notifies their phone, and waits up to timeout_seconds (default 120, max 900) for the answer. Returns APPROVED, REFUSED or "changes asked for" with their note; if they haven\'t answered yet, says so: then wait with `npx hitloop wait --done <id>` in the background, or check with get_feedback.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'What you want to do, as a yes/no question ("Deploy 2.4.0 to production?")' },
        details: { type: 'string', description: 'Markdown: what will happen, what could go wrong, how to undo it' },
        items: { type: 'array', items: itemSchema, description: 'Things to look at first (a diff, a plan, a screenshot)' },
        timeout_seconds: { type: 'number' },
        ...fromProp,
        ...folderProp,
      },
    },
    run: async (a, signal) => {
      const p = projectOf(a);
      const from = str(a['from']) || defaultFrom(p.root);
      const items = Array.isArray(a['items']) ? (a['items'] as ItemArg[]) : [];
      const r = p.reviews.create({ title: need(a['question'], 'question'), ...(str(a['details']) ? { intro: str(a['details']) } : {}), mode: 'approve', ...(from ? { from } : {}) }, items);
      const link = await linkFor(p.root, `/r/${encodeURIComponent(r.id)}`);
      const ok = await waitFor(p, { until: 'done', ids: [r.id], timeoutMs: clampTimeout(a['timeout_seconds'], 120), signal });
      const fb = p.reviews.feedback(r.id);
      if (!ok || !fb.overall) return [`Asked "${r.id}"; no answer yet.`, link, `Wait for it: \`npx hitloop wait --done ${r.id}\` (in the background), then get_feedback review "${r.id}".`].join('\n');
      const v = fb.overall.verdict;
      p.reviews.markRead(r.id);
      return `${v === 'ok' ? 'APPROVED' : v === 'no' ? 'REFUSED' : 'NOT YET: changes asked for'}${fb.overall.note ? ` — "${fb.overall.note}"` : ''} (${r.id})`;
    },
  },
  {
    name: 'get_feedback',
    description: 'The user\'s feedback on one review: verdicts, comments (with lines, marked areas, photos) and replies. filter: new (the default; marks it read unless peek), all, open (comments still open).',
    inputSchema: { type: 'object', required: ['review'], properties: { ...reviewProp, filter: { enum: [...REVIEW_FILTERS] }, peek: { type: 'boolean' }, format: { enum: ['text', 'json'] }, ...folderProp } },
    run: async (a) => {
      const r = readFeedback(projectOf(a).reviews, need(a['review'], 'review'), { filter: (REVIEW_FILTERS as readonly string[]).includes(str(a['filter'])) ? (str(a['filter']) as ReviewFilter) : 'new', peek: a['peek'] === true });
      return a['format'] === 'json' ? JSON.stringify(r.data, null, 1) : r.text;
    },
  },
  {
    name: 'update_item',
    description: 'Change an item in a review: the fields in "changes" replace the item\'s own (null removes one). A changed item\'s earlier verdict is flagged as given to an earlier version. A file item is snapshotted again.',
    inputSchema: { type: 'object', required: ['review', 'id', 'changes'], properties: { ...reviewProp, id: { type: 'string' }, changes: { type: 'object' }, ...folderProp } },
    run: async (a) => {
      const n = projectOf(a).reviews.updateItem(need(a['review'], 'review'), need(a['id'], 'id'), (a['changes'] as Json) ?? {});
      return [`Updated ${str(a['id'])}.`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'remove_items',
    description: 'Remove items from a review (their feedback stays in the answers file).',
    inputSchema: { type: 'object', required: ['review', 'ids'], properties: { ...reviewProp, ...idsProp, ...folderProp } },
    run: async (a) => {
      const removed = projectOf(a).reviews.removeItems(need(a['review'], 'review'), strList(a['ids']));
      return removed.length ? `Removed ${removed.join(', ')}.` : 'None of those ids are in the review.';
    },
  },
  {
    name: 'update_review',
    description: "Change a review's title, intro or mode, or close it (closed ones drop to the bottom of the user's list) and reopen it.",
    inputSchema: { type: 'object', required: ['review'], properties: { ...reviewProp, title: { type: 'string' }, intro: { type: 'string' }, mode: { enum: ['review', 'show', 'approve'] }, status: { enum: ['open', 'closed'] }, ...folderProp } },
    run: async (a) => {
      const patch: Json = {};
      for (const k of ['title', 'intro', 'mode', 'status']) if (typeof a[k] === 'string') patch[k] = a[k];
      const n = projectOf(a).reviews.update(need(a['review'], 'review'), patch);
      return [`Saved review "${str(a['review'])}".`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'ack',
    description: 'Mark answers (set + ids: question ids) or review verdicts (review + ids: item ids) as dealt with, with a short note the user sees under each (e.g. "fixed in src/x.ts").',
    inputSchema: { type: 'object', required: ['ids', 'note'], properties: { ...setProp, ...reviewProp, ...idsProp, note: { type: 'string' }, ...folderProp } },
    run: async (a) => {
      const p = projectOf(a);
      const ids = strList(a['ids']);
      const note = str(a['note']);
      if (str(a['review'])) {
        const done = p.reviews.ack(str(a['review']), ids, note);
        return done.length ? `Marked ${done.length} done: ${done.join(', ')}` : 'None of those items have verdicts.';
      }
      const done = p.questions.ack(need(a['set'], 'set'), ids, note);
      return done.length ? `Marked ${done.length} applied: ${done.join(', ')}` : 'None of those questions have answers.';
    },
  },
  {
    name: 'resolve',
    description: 'Resolve the user\'s comments (review + ids: comment ids like c12) or notes (no review; ids: note ids from news), with a note saying what you did; the user sees it. reopen: true opens them again.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ...reviewProp, ...idsProp, note: { type: 'string' }, reopen: { type: 'boolean' }, ...folderProp } },
    run: async (a) => {
      const p = projectOf(a);
      const ids = strList(a['ids']);
      const status = a['reopen'] === true ? 'open' : 'resolved';
      const done = str(a['review']) ? p.reviews.setStatus(str(a['review']), ids, status, 'agent', str(a['note'])) : p.notes.resolve(ids, str(a['note']), status);
      return done.length ? `${status === 'open' ? 'Reopened' : 'Resolved'} ${done.join(', ')}.` : 'None of those ids were found.';
    },
  },
  {
    name: 'reply',
    description: "Write to the user: on a question's thread (set + id), on a review comment (review + comment), on a review as a whole or one item (review + item; a new comment from you), or on a note (note). They see it there.",
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: { ...setProp, id: { type: 'string', description: 'The question id' }, ...reviewProp, comment: { type: 'string' }, item: { type: 'string' }, note: { type: 'string', description: 'A note id' }, message: { type: 'string', description: 'Markdown' }, ...folderProp },
    },
    run: async (a) => {
      const p = projectOf(a);
      const msg = need(a['message'], 'message');
      if (str(a['note'])) {
        const c = p.notes.reply(str(a['note']), 'agent', msg, 'agent');
        if (!c) throw new StoreError(`No note "${str(a['note'])}"`);
        return `Replied on note ${str(a['note'])}.`;
      }
      if (str(a['review'])) {
        if (str(a['comment'])) {
          p.reviews.reply(str(a['review']), str(a['comment']), 'agent', msg);
          return `Replied on ${str(a['comment'])}.`;
        }
        const c = p.reviews.comment(str(a['review']), { item: str(a['item']), body: msg }, 'agent');
        return `Wrote ${c.id} on ${str(a['item']) || 'the review'}.`;
      }
      p.questions.message(need(a['set'], 'set'), need(a['id'], 'id'), 'agent', msg);
      return `Replied on ${str(a['id'])}.`;
    },
  },
  {
    name: 'notes',
    description: 'Notes the user wrote on files, lines, picture areas or nothing in particular. filter: new (the default; marks them read), open, all. (news includes new ones too.)',
    inputSchema: { type: 'object', properties: { filter: { enum: ['new', 'open', 'all'] }, peek: { type: 'boolean' }, ...folderProp } },
    run: async (a) => {
      const f = ['new', 'open', 'all'].includes(str(a['filter'])) ? (str(a['filter']) as 'new') : 'new';
      const r = readNotes(projectOf(a).notes, { filter: f, peek: a['peek'] === true });
      return r.count ? `${r.count} note${r.count === 1 ? '' : 's'} (${f}):\n${r.text}` : f === 'new' ? 'No new notes.' : `No ${f} notes.`;
    },
  },

  // ── questions (questionme) ──
  {
    name: 'add_questions',
    description:
      'Add questions to a set (the set and section are made if needed). Returns the ids, any problems, and the link to send the user. Questions are validated: a bad one is rejected with the reason.',
    inputSchema: {
      type: 'object',
      required: ['set', 'questions'],
      properties: {
        ...setProp,
        title: { type: 'string', description: "The set's title, when it's new" },
        section: { oneOf: [{ type: 'string', description: 'An existing section id' }, { ...sectionSchema, description: 'A section (made if new): id, title, intro, content, hidden, showIf' }] },
        before: { type: 'string', description: 'Insert before this question id (default: at the end of the section)' },
        questions: { type: 'array', items: questionSchema, minItems: 1 },
        ...fromProp,
        ...folderProp,
      },
    },
    run: async (a) => {
      const p = projectOf(a);
      const set = need(a['set'], 'set');
      if (p.reviews.has(set)) throw new StoreError(`"${set}" is a review's id; pick another set id`);
      const qs = Array.isArray(a['questions']) ? (a['questions'] as QuestionInput[]) : [];
      if (!qs.length) throw new StoreError('No questions given');
      const section = a['section'] && typeof a['section'] === 'object' ? (a['section'] as SectionInput) : str(a['section']) || undefined;
      const from = str(a['from']) || defaultFrom(p.root);
      const { ids, normalised } = p.questions.addQuestions(set, qs, section, { title: str(a['title']) || undefined, before: str(a['before']) || undefined, from });
      return [`Added ${ids.length} question${ids.length === 1 ? '' : 's'} to "${set}": ${ids.join(', ')}`, problems(normalised), await linkFor(p.root, `/q/${encodeURIComponent(set)}`)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'update_question',
    description:
      'Change a question: the fields in "changes" replace the question\'s own (null removes a field; options are replaced whole). If the question text, type or options change, an earlier answer is flagged "changed" for the user to look at again.',
    inputSchema: { type: 'object', required: ['set', 'id', 'changes'], properties: { ...setProp, id: { type: 'string' }, changes: { type: 'object', description: 'Question fields (see add_questions)' }, ...folderProp } },
    run: async (a) => {
      const n = projectOf(a).questions.updateQuestion(need(a['set'], 'set'), str(a['id']), (a['changes'] as Json) ?? {});
      return [`Updated ${str(a['id'])}.`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'remove_questions',
    description: 'Remove questions from a set. Their answers stay in the answers file, listed as answers to removed questions.',
    inputSchema: { type: 'object', required: ['set', 'ids'], properties: { ...setProp, ...idsProp, ...folderProp } },
    run: async (a) => {
      const removed = projectOf(a).questions.removeQuestions(need(a['set'], 'set'), strList(a['ids']));
      return removed.length ? `Removed ${removed.join(', ')}.` : 'None of those ids are in the set.';
    },
  },
  {
    name: 'update_set',
    description: "Make a question set, or change its title, intro, content or status (closed sets drop to the bottom of the user's list).",
    inputSchema: {
      type: 'object',
      required: ['set'],
      properties: { ...setProp, title: { type: 'string' }, intro: { type: 'string', description: 'Markdown at the top of the set' }, content: { oneOf: [blockSchema, { type: 'array', items: blockSchema }] }, status: { enum: ['open', 'closed'] }, ...folderProp },
    },
    run: async (a) => {
      const p = projectOf(a);
      const set = need(a['set'], 'set');
      const patch: Partial<SetInput> = {};
      if (typeof a['title'] === 'string') patch.title = a['title'];
      if (typeof a['intro'] === 'string') patch.intro = a['intro'];
      if (a['content'] !== undefined) patch.content = a['content'] as SetInput['content'];
      if (a['status'] === 'open' || a['status'] === 'closed') patch.status = a['status'];
      const n = p.questions.updateSet(set, patch, true);
      return [`Saved set "${set}".`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'update_section',
    description: "Make a section, or change its title, intro, content, hidden or showIf (null removes a field). Its questions aren't touched.",
    inputSchema: {
      type: 'object',
      required: ['set', 'id'],
      properties: { ...setProp, id: { type: 'string' }, title: { type: 'string' }, intro: { type: 'string' }, content: { oneOf: [blockSchema, { type: 'array', items: blockSchema }] }, hidden: { type: 'boolean' }, showIf: conditionSchema, ...folderProp },
    },
    run: async (a) => {
      const patch: Json = {};
      for (const k of ['title', 'intro', 'content', 'hidden', 'showIf']) if (k in a) patch[k] = a[k];
      const n = projectOf(a).questions.updateSection(need(a['set'], 'set'), str(a['id']), patch);
      return [`Saved section "${str(a['id'])}".`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'show_set',
    description: "A set's questions, one line each with their state (open, answered, later, hidden, changed). full: true adds options. Page with limit/offset.",
    inputSchema: { type: 'object', required: ['set'], properties: { ...setProp, section: { type: 'string' }, ...idsProp, full: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' }, ...folderProp } },
    run: async (a) =>
      describeSet(projectOf(a).questions, need(a['set'], 'set'), {
        section: str(a['section']) || undefined,
        ids: strList(a['ids']),
        full: a['full'] === true,
        limit: typeof a['limit'] === 'number' ? a['limit'] : undefined,
        offset: typeof a['offset'] === 'number' ? a['offset'] : undefined,
      }),
  },
  {
    name: 'get_answers',
    description:
      'Read one set\'s answers, compactly: "id (question): answer — note" per line. filter: new (the default: answers and messages since you last read; marks them read unless peek), all, unacked, changed (answered before the question changed), blocking, open (still to answer, with recommendations). Page with limit/offset. format: "json" for full records. (news covers every set at once.)',
    inputSchema: {
      type: 'object',
      required: ['set'],
      properties: {
        ...setProp,
        filter: { enum: [...FILTERS] },
        ...idsProp,
        section: { type: 'string' },
        limit: { type: 'integer', description: 'Default 100' },
        offset: { type: 'integer' },
        peek: { type: 'boolean', description: "Don't mark new answers read" },
        questions: { enum: ['none', 'short', 'full'], description: 'How much of each question to repeat (default short)' },
        format: { enum: ['text', 'json'] },
        ...folderProp,
      },
    },
    run: async (a) => {
      const r = readAnswers(projectOf(a).questions, need(a['set'], 'set'), {
        filter: (FILTERS as readonly string[]).includes(str(a['filter'])) ? (str(a['filter']) as Filter) : 'new',
        ids: strList(a['ids']),
        section: str(a['section']) || undefined,
        limit: typeof a['limit'] === 'number' ? a['limit'] : undefined,
        offset: typeof a['offset'] === 'number' ? a['offset'] : undefined,
        peek: a['peek'] === true,
        questions: ['none', 'short', 'full'].includes(str(a['questions'])) ? (str(a['questions']) as 'none') : undefined,
      });
      return a['format'] === 'json' ? JSON.stringify(r.data, null, 1) : r.text;
    },
  },
];

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function serveMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const send = (msg: Json) => output.write(JSON.stringify(msg) + '\n');
  const running = new Map<string | number, AbortController>();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const handle = async (msg: Json) => {
    const id = msg['id'] as string | number | undefined;
    const method = str(msg['method']);
    const params = (msg['params'] as Json) ?? {};
    const reply = (result: Json) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = str(params['protocolVersion']);
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hitl', title: 'hitl — Human In The Loop', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params['name']);
        if (!tool) return fail(-32602, `Unknown tool ${str(params['name'])}`);
        const ctl = new AbortController();
        if (id !== undefined) running.set(id, ctl);
        try {
          const text = await tool.run((params['arguments'] as Json) ?? {}, ctl.signal);
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
        } finally {
          if (id !== undefined) running.delete(id);
        }
      }
      case 'notifications/cancelled': {
        const rid = params['requestId'] as string | number | undefined;
        if (rid !== undefined) running.get(rid)?.abort();
        return;
      }
      default:
        if (method.startsWith('notifications/')) return;
        return fail(-32601, `Method not found: ${method}`);
    }
  };

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) if (m && typeof m === 'object') void handle(m as Json);
    });
    rl.on('close', () => {
      for (const c of running.values()) c.abort();
      resolve();
    });
  });
}
