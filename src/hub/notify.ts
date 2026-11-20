// Notifications when an agent does something you'd want to know about: through Web Push (straight to this browser or
// your phone, once you turn it on in the page), a Slack channel (an incoming webhook), or any webhook (Pushover, Discord,
// Home Assistant, …). Changes are batched: an agent adding 50 questions over a minute makes one notification, sent once it has been quiet for a while. An approval is someone waiting at a gate, so
// it goes out within a couple of seconds. Each kind of event can be turned off (the page's Notifications, or
// `hitl notify events`). The machine dashboard adds its own: alerts, sessions that finished, workflows that finished.
import os from 'node:os';
import crypto from 'node:crypto';
import { userConfig, lanAddresses, type UserConfig } from './registry.js';
import { allQuestions, visibility, isDone } from '../q/model.js';
import type { ProjectView } from '../agent.js';
import { pushAll, subscriptions, type PushResult } from './webpush.js';

export interface NotifyConfig {
  /** POSTed JSON: the Notice below */
  webhook?: string;
  /** a Slack incoming webhook (https://hooks.slack.com/services/…): each notification posts to its channel */
  slack?: string;
  /** Web Push to the devices that turned it on (default true; false pauses every device) */
  push?: boolean;
  /** send once no more changes came for this long (default 20) */
  quietSeconds?: number;
  /** the start of links in notifications, e.g. http://100.100.4.74:4199 (default: Tailscale, else the LAN address) */
  link?: string;
  /** put the token in links (they pass through the push service; off by default) */
  includeToken?: boolean;
  /** also notify when the agent replies on a thread (default true); the same as events.replies */
  replies?: boolean;
  /** each kind of event, on or off (see EVENTS for the defaults) */
  events?: Partial<Record<NotifyEvent, boolean>>;
}

/** What can make a notification, what it's called, and whether it's on until you say otherwise. */
export const EVENTS = [
  { id: 'questions', label: 'New questions', detail: 'An agent asks you something.', on: true },
  { id: 'approve', label: 'Waiting for your OK', detail: 'An approval gate: the agent stops until you answer.', on: true },
  { id: 'review', label: 'Something to review', detail: 'An agent asks for your verdict on files, diffs, pictures, mockups.', on: true },
  { id: 'show', label: 'Something to look at', detail: 'An agent shows you something, no verdict needed.', on: true },
  { id: 'replies', label: 'Replies from the agent', detail: 'On your answers, comments and notes.', on: true },
  { id: 'acks', label: 'The agent acted on your answers', detail: 'It acknowledged answers or verdicts, saying what it did.', on: false },
  { id: 'resolved', label: 'The agent resolved your notes', detail: 'A note you wrote on a file was dealt with.', on: false },
  { id: 'updates', label: 'The agent changed what it asked', detail: 'Questions or review items you already had were edited.', on: false },
  { id: 'claudeIdle', label: 'A Claude Code session finished', detail: 'It worked for a while and now waits for you. Needs the machine dashboard on.', on: false },
  { id: 'workflowDone', label: 'A workflow finished', detail: 'Needs the machine dashboard on.', on: false },
  { id: 'alert', label: 'Machine alerts', detail: 'The rules you set below.', on: true },
] as const;

export type NotifyEvent = (typeof EVENTS)[number]['id'];

export function eventOn(cfg: NotifyConfig, e: NotifyEvent): boolean {
  const v = cfg.events?.[e];
  if (typeof v === 'boolean') return v;
  if (e === 'replies' && cfg.replies === false) return false;
  return EVENTS.find((x) => x.id === e)?.on ?? false;
}

export interface Notice {
  title: string;
  message: string;
  /** the whole link, for webhooks */
  url: string;
  /** the same place as a hash on the hub's page (#/p/…), for Web Push: each device opens it on its own address */
  hash: string;
  project: string;
  /** the question set or review */
  request: string;
  kind: 'questions' | 'review' | 'approve' | 'show' | 'notes' | 'machine' | 'test';
  /** what happened (the main one, when several did) */
  event: NotifyEvent | 'test';
  newQuestions: number;
  newItems: number;
  approval: boolean;
  blocking: number;
  replies: number;
  acks: number;
  resolved: number;
  updated: number;
  /** notifications with the same tag replace each other on a device */
  tag?: string;
}

interface Seen {
  things: Set<string>;
  /** a fingerprint of each thing, to see edits */
  prints: Map<string, string>;
  agentMessages: number;
  /** each ack (what, when) and each resolved note, so a second ack after a changed answer counts too */
  acks: Set<string>;
  resolved: Set<string>;
}

interface Pending {
  fresh: Set<string>;
  updated: Set<string>;
  replies: number;
  acks: number;
  resolved: number;
  first: number;
  timer?: NodeJS.Timeout;
}

export const notifyConfig = (cfg: UserConfig = userConfig()): NotifyConfig => (cfg.notify && typeof cfg.notify === 'object' ? cfg.notify : {});
/** Any way to reach you: a device that turned on push, Slack, or a webhook. */
export const notifyEnabled = (n: NotifyConfig) => !!(n.webhook || n.slack || (n.push !== false && subscriptions().length));

/** A Slack incoming webhook's address (anything else is refused, so the hub never posts your notifications elsewhere). */
export const isSlackWebhook = (u: string) => /^https:\/\/hooks\.slack(-gov)?\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/.test(u);

/** The address, shortened so the secret part never shows: hooks.slack.com/services/T0…/B0…/…x9Zq */
export const maskSlack = (u: string) => {
  const m = /^https:\/\/([^/]+)\/(.*)$/.exec(u);
  if (!m) return '…';
  const parts = (m[2] ?? '').split('/');
  const last = parts.pop() ?? '';
  return [m[1], ...parts.map((p, i) => (i === 0 ? p : p.slice(0, 3) + '…')), '…' + last.slice(-4)].join('/');
};

const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One notification as a Slack message: the title in bold, the details, and a button that opens hitl there. */
export function slackMessage(n: Notice): Record<string, unknown> {
  const mark = n.approval ? ':raising_hand:' : n.event === 'alert' ? ':rotating_light:' : n.blocking ? ':warning:' : n.kind === 'machine' ? ':robot_face:' : n.kind === 'test' ? ':bell:' : n.kind === 'questions' ? ':question:' : n.kind === 'notes' ? ':speech_balloon:' : ':eyes:';
  const text = `${mark} *${slackEscape(n.title)}*${n.message ? '\n' + slackEscape(n.message) : ''}`;
  const button = /^https?:\/\//.test(n.url) && n.url.length < 3000;
  return {
    text: `${n.title}${n.message ? ': ' + n.message.split('\n')[0] : ''}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
      ...(button ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: n.approval ? 'Approve or refuse' : 'Open in hitl' }, url: n.url, ...(n.approval || n.blocking ? { style: 'primary' } : {}) }] }] : []),
    ],
    unfurl_links: false,
  };
}

export type NotifyKind = 'questions' | 'review' | 'notes';

const print = (v: unknown) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('base64').slice(0, 12);

export class Notifier {
  private seen = new Map<string, Seen>();
  private pending = new Map<string, Pending>();
  private readonly started = Date.now();

  constructor(
    private readonly project: (key: string) => ProjectView | undefined,
    private readonly port: () => number,
    private readonly token: string,
    private readonly base: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  private state(p: ProjectView, kind: NotifyKind, id: string): Seen | undefined {
    if (kind === 'questions') {
      const l = p.questions.load(id);
      if (!l) return undefined;
      const af = p.questions.answers(id);
      let agentMessages = 0;
      for (const list of Object.values(af.threads)) for (const m of list) if (m.from === 'agent') agentMessages++;
      const qs = allQuestions(l.set);
      return {
        things: new Set(qs.map((q) => q.id)),
        prints: new Map(qs.map((q) => [q.id, print(q)])),
        agentMessages,
        acks: new Set(Object.entries(af.answers).flatMap(([q, a]) => (a?.ack ? [`${q}@${a.ack.at}`] : []))),
        resolved: new Set(),
      };
    }
    if (kind === 'review') {
      const l = p.reviews.load(id);
      if (!l) return undefined;
      const fb = p.reviews.feedback(id);
      let agentMessages = 0;
      for (const c of fb.comments) agentMessages += (c.from === 'agent' ? 1 : 0) + c.replies.filter((r) => r.from === 'agent').length;
      // "@open": the review is (again) open, so an approval asked again counts as new
      return {
        things: new Set([...l.review.items.map((i) => i.id), `@${l.review.status}`]),
        prints: new Map(l.review.items.map((i) => [i.id, i.rev || print(i)])),
        agentMessages,
        acks: new Set(Object.entries(fb.items).flatMap(([i, v]) => (v?.ack ? [`${i}@${v.ack.at}`] : []))),
        resolved: new Set(),
      };
    }
    let agentMessages = 0;
    const resolved = new Set<string>();
    for (const c of p.notes.all()) {
      agentMessages += (c.replies ?? []).filter((r) => r.from === 'agent' || r.author === 'agent').length;
      if (c.status === 'resolved') resolved.add(c.id);
    }
    return { things: new Set(), prints: new Map(), agentMessages, acks: new Set(), resolved };
  }

  private created(p: ProjectView, kind: NotifyKind, id: string): number {
    const c = kind === 'questions' ? p.questions.load(id)?.set.created : kind === 'review' ? p.reviews.load(id)?.review.created : '';
    return Date.parse(c ?? '') || 0;
  }

  /** What's there now counts as seen (on start). */
  baseline(key: string): void {
    const p = this.project(key);
    if (!p) return;
    for (const id of p.questions.ids()) this.keep(key, p, 'questions', id);
    for (const id of p.reviews.ids()) this.keep(key, p, 'review', id);
    this.keep(key, p, 'notes', 'notes');
  }

  private keep(key: string, p: ProjectView, kind: NotifyKind, id: string): void {
    const s = this.state(p, kind, id);
    if (s) this.seen.set(`${key}/${kind}/${id}`, s);
  }

  /** Something changed in a request: queue what's new. */
  observe(key: string, kind: NotifyKind, id: string): void {
    const k = `${key}/${kind}/${id}`;
    const p = this.project(key);
    if (!p) return;
    const now = this.state(p, kind, id);
    if (!now) return;
    let was = this.seen.get(k);
    if (!was) was = this.created(p, kind, id) >= this.started - 5000 ? { things: new Set(), prints: new Map(), agentMessages: 0, acks: new Set(), resolved: new Set() } : now;
    const fresh = [...now.things].filter((t) => !was.things.has(t) && t !== '@closed');
    const updated = [...now.prints].filter(([t, f]) => was.prints.has(t) && was.prints.get(t) !== f).map(([t]) => t);
    const replies = Math.max(0, now.agentMessages - was.agentMessages);
    const acks = [...now.acks].filter((a) => !was.acks.has(a)).length;
    const resolved = [...now.resolved].filter((r) => !was.resolved.has(r)).length;
    this.seen.set(k, now);
    if (!fresh.length && !updated.length && !replies && !acks && !resolved) return;
    const cfg = notifyConfig();
    if (!notifyEnabled(cfg)) return;
    const pend = this.pending.get(k) ?? { fresh: new Set<string>(), updated: new Set<string>(), replies: 0, acks: 0, resolved: 0, first: Date.now() };
    for (const t of fresh) pend.fresh.add(t);
    if (eventOn(cfg, 'updates')) for (const t of updated) if (!pend.fresh.has(t)) pend.updated.add(t);
    pend.replies += eventOn(cfg, 'replies') ? replies : 0;
    pend.acks += eventOn(cfg, 'acks') ? acks : 0;
    pend.resolved += eventOn(cfg, 'resolved') ? resolved : 0;
    if (!pend.fresh.size && !pend.updated.size && !pend.replies && !pend.acks && !pend.resolved) return;
    this.pending.set(k, pend);
    clearTimeout(pend.timer);
    const quiet = Math.max(1, cfg.quietSeconds ?? 20) * 1000;
    const isGate = kind === 'review' && p.reviews.load(id)?.review.mode === 'approve';
    const wait = isGate ? 1500 : Math.min(quiet, Math.max(0, pend.first + 120_000 - Date.now()));
    pend.timer = setTimeout(() => void this.flush(key, kind, id), wait);
    pend.timer.unref?.();
  }

  private async flush(key: string, kind: NotifyKind, id: string): Promise<void> {
    const k = `${key}/${kind}/${id}`;
    const pend = this.pending.get(k);
    this.pending.delete(k);
    const p = this.project(key);
    if (!pend || !p) return;
    const notice = this.compose(p, key, kind, id, pend);
    if (!notice) return;
    await this.deliver(notice);
  }

  /** Something from the machine dashboard (an alert, a session or workflow that finished). */
  machine(e: { event: 'alert' | 'claudeIdle' | 'workflowDone'; title: string; message: string; hash: string; tag: string; urgent?: boolean }): void {
    const cfg = notifyConfig();
    if (!eventOn(cfg, e.event) || !notifyEnabled(cfg)) return;
    const n: Notice = {
      ...blank(),
      kind: 'machine',
      event: e.event,
      title: e.title,
      message: e.message,
      hash: e.hash,
      url: linkBase(cfg, this.port(), this.token, this.base) + e.hash,
      tag: e.tag,
      approval: false,
      blocking: e.urgent ? 1 : 0,
    };
    void this.deliver(n);
  }

  private async deliver(notice: Notice): Promise<void> {
    try {
      const r = await send(notifyConfig(), notice);
      this.log(`notified: ${notice.title}${r.push ? ` (${r.push.sent} device${r.push.sent === 1 ? '' : 's'}${r.push.removed ? `, ${r.push.removed} gone` : ''})` : ''}`);
    } catch (e) {
      this.log(`couldn't notify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private compose(p: ProjectView, key: string, kind: NotifyKind, id: string, pend: Pending): Notice | undefined {
    const cfg = notifyConfig();
    const hash = hashFor(key, kind, id);
    const base = {
      ...blank(),
      url: linkBase(cfg, this.port(), this.token, this.base) + hash,
      hash,
      project: key,
      request: id,
      replies: pend.replies,
      acks: pend.acks,
      resolved: pend.resolved,
      updated: pend.updated.size,
      tag: `${key}/${kind}/${id}`,
    };
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const extras = [
      pend.updated.size ? `${plural(pend.updated.size, kind === 'questions' ? 'question' : 'item', kind === 'questions' ? 'questions' : 'items')} changed` : '',
      pend.replies ? `${plural(pend.replies, 'reply', 'replies')} from the agent` : '',
      pend.acks ? `${plural(pend.acks, 'answer', 'answers')} acted on` : '',
    ].filter(Boolean);
    const extraEvent = (): NotifyEvent => (pend.replies ? 'replies' : pend.acks ? 'acks' : 'updates');
    if (kind === 'questions') {
      const l = p.questions.load(id);
      if (!l) return undefined;
      const af = p.questions.answers(id);
      const vis = visibility(l.set, af.answers);
      const fresh = eventOn(cfg, 'questions') ? allQuestions(l.set).filter((q) => pend.fresh.has(q.id) && vis.question(q.id)) : [];
      const blocking = fresh.filter((q) => q.priority === 'blocking' && !isDone(af.answers[q.id])).length;
      if (!fresh.length && !extras.length) return undefined;
      const first = fresh[0];
      return {
        ...base,
        kind: 'questions',
        event: fresh.length ? 'questions' : extraEvent(),
        title: `${l.set.title}: ${[fresh.length ? plural(fresh.length, 'new question', 'new questions') : '', ...extras].filter(Boolean).join(', ')}`,
        message: [
          blocking ? `${blocking} blocking: the agent is waiting on ${blocking === 1 ? 'it' : 'them'}.` : '',
          first ? `“${first.question.replace(/\s+/g, ' ').slice(0, 120)}”${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ''}` : ackNote(af.answers) || 'Tap to read.',
          `${key} · ${id}`,
        ]
          .filter(Boolean)
          .join('\n'),
        newQuestions: fresh.length,
        blocking,
      };
    }
    if (kind === 'review') {
      const l = p.reviews.load(id);
      if (!l) return undefined;
      const r = l.review;
      const gate = r.mode === 'approve';
      const ev: NotifyEvent = gate ? 'approve' : r.mode === 'show' ? 'show' : 'review';
      const on = eventOn(cfg, ev);
      const items = on ? r.items.filter((i) => pend.fresh.has(i.id)) : [];
      const asked = on && gate && pend.fresh.has('@open');
      if (!items.length && !extras.length && !asked) return undefined;
      const what = gate ? 'asks for your OK' : `${plural(items.length, 'thing', 'things')} to ${r.mode === 'show' ? 'look at' : 'review'}`;
      const main = items.length || asked;
      return {
        ...base,
        kind: gate ? 'approve' : r.mode === 'show' ? 'show' : 'review',
        event: main ? ev : extraEvent(),
        title: `${r.title}: ${[main ? what : '', ...extras].filter(Boolean).join(', ')}`,
        message: [
          r.from ? `From ${r.from}.` : '',
          gate && main ? 'Approve or refuse: the agent is waiting.' : items[0] ? `“${items[0].title.slice(0, 120)}”${items.length > 1 ? ` and ${items.length - 1} more` : ''}` : 'Tap to read.',
          `${key} · ${id}`,
        ]
          .filter(Boolean)
          .join('\n'),
        newItems: items.length,
        approval: gate && !!main,
        blocking: gate && main ? 1 : 0,
      };
    }
    const notes = [pend.resolved ? `${plural(pend.resolved, 'note', 'notes')} resolved` : '', pend.replies ? `${plural(pend.replies, 'reply', 'replies')} from the agent` : ''].filter(Boolean);
    if (!notes.length) return undefined;
    return { ...base, kind: 'notes', event: pend.resolved ? 'resolved' : 'replies', title: `${key}: ${notes.join(', ')} on your notes`, message: 'Tap to read.' };
  }

  link(key: string, kind: NotifyKind, id: string): string {
    return linkBase(notifyConfig(), this.port(), this.token, this.base) + hashFor(key, kind, id);
  }
}

const blank = (): Omit<Notice, 'title' | 'message' | 'url' | 'hash' | 'kind' | 'event'> => ({
  project: '',
  request: '',
  newQuestions: 0,
  newItems: 0,
  approval: false,
  blocking: 0,
  replies: 0,
  acks: 0,
  resolved: 0,
  updated: 0,
});

function ackNote(answers: Record<string, { ack?: { at: string; note: string } } | undefined>): string {
  let best: { at: string; note: string } | undefined;
  for (const a of Object.values(answers)) if (a?.ack && (!best || a.ack.at > best.at)) best = a.ack;
  return best?.note ? `“${best.note.replace(/\s+/g, ' ').slice(0, 140)}”` : '';
}

const hashFor = (key: string, kind: NotifyKind, id: string) =>
  kind === 'notes' ? `#/p/${encodeURIComponent(key)}/notes` : `#/p/${encodeURIComponent(key)}/${kind === 'review' ? 'r' : 'q'}/${encodeURIComponent(id)}`;

/** Where links in notifications point: the configured base, else Tailscale (works anywhere), else the LAN. */
export function linkBase(cfg: NotifyConfig, port: number, token: string, hubBase = '/'): string {
  let base = cfg.link?.replace(/\/+$/, '');
  if (!base) {
    const ips = lanAddresses();
    const ts = ips.find((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip));
    base = `${userConfig().https ? 'https' : 'http'}://${ts ?? ips[0] ?? os.hostname()}:${port}${hubBase.replace(/\/$/, '')}`;
  }
  return `${base}/${cfg.includeToken && token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Send one notice to every configured channel. */
export async function send(cfg: NotifyConfig, n: Notice): Promise<{ push?: PushResult }> {
  const errors: string[] = [];
  const out: { push?: PushResult } = {};
  const urgent = n.approval || n.blocking > 0;
  if (cfg.push !== false && subscriptions().length) {
    try {
      out.push = await pushAll({ title: n.title, body: n.message, hash: n.hash, ...(n.tag ? { tag: n.tag } : {}), urgent });
      if (out.push.failed) errors.push(...out.push.errors);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (cfg.slack) {
    try {
      const res = await fetch(cfg.slack, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slackMessage(n)), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`slack: ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`.trim());
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (cfg.webhook) {
    try {
      const res = await fetch(cfg.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`webhook: ${res.status}`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return out;
}

/** A test notice to every channel. */
export function testNotice(cfg: NotifyConfig, port: number, hubBase?: string): Notice {
  return {
    ...blank(),
    title: 'hitl: notifications work',
    message: "You'll get one when an agent asks you something, shows you something, or waits for your OK.",
    url: linkBase(cfg, port, '', hubBase),
    hash: '#/notify',
    kind: 'test',
    event: 'test',
    tag: 'test',
  };
}
