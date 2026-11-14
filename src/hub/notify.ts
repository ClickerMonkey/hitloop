// Push notifications to your phone when an agent asks for something: through ntfy (a push app for Android and iOS;
// the hub posts to your private topic) or any webhook (Pushover, Discord, Home Assistant, …). Changes are batched: an
// agent adding 50 questions over a minute makes one notification, sent once it has been quiet for a while. An approval
// is someone waiting at a gate, so it goes out within a couple of seconds.
//
// Web Push isn't used: a phone only allows it on HTTPS pages, and hitl is opened over plain http on the LAN.
import os from 'node:os';
import { userConfig, lanAddresses, type UserConfig } from './registry.js';
import { allQuestions, visibility, isDone } from '../q/model.js';
import type { ProjectView } from '../agent.js';

export interface NotifyConfig {
  /** an ntfy topic URL, e.g. https://ntfy.sh/hitl-k3j2h4 */
  ntfy?: string;
  /** an ntfy access token, for a protected topic or server */
  ntfyToken?: string;
  /** POSTed JSON: the Notice below */
  webhook?: string;
  /** send once no more changes came for this long (default 20) */
  quietSeconds?: number;
  /** the start of links in notifications, e.g. http://100.100.4.74:4199 (default: Tailscale, else the LAN address) */
  link?: string;
  /** put the token in links (they pass through the push service; off by default) */
  includeToken?: boolean;
  /** also notify when the agent replies on a thread (default true) */
  replies?: boolean;
}

export interface Notice {
  title: string;
  message: string;
  url: string;
  project: string;
  /** the question set or review */
  request: string;
  kind: 'questions' | 'review' | 'approve' | 'notes' | 'test';
  newQuestions: number;
  newItems: number;
  approval: boolean;
  blocking: number;
  replies: number;
}

interface Seen {
  things: Set<string>;
  agentMessages: number;
}

interface Pending {
  fresh: Set<string>;
  replies: number;
  first: number;
  timer?: NodeJS.Timeout;
}

export const notifyConfig = (cfg: UserConfig = userConfig()): NotifyConfig => (cfg.notify && typeof cfg.notify === 'object' ? cfg.notify : {});
export const notifyEnabled = (n: NotifyConfig) => !!(n.ntfy || n.webhook);

export type NotifyKind = 'questions' | 'review' | 'notes';

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
      return { things: new Set(allQuestions(l.set).map((q) => q.id)), agentMessages };
    }
    if (kind === 'review') {
      const l = p.reviews.load(id);
      if (!l) return undefined;
      const fb = p.reviews.feedback(id);
      let agentMessages = 0;
      for (const c of fb.comments) agentMessages += (c.from === 'agent' ? 1 : 0) + c.replies.filter((r) => r.from === 'agent').length;
      // "@open": the review is (again) open, so an approval asked again counts as new
      return { things: new Set([...l.review.items.map((i) => i.id), `@${l.review.status}`]), agentMessages };
    }
    let agentMessages = 0;
    for (const c of p.notes.all()) agentMessages += (c.replies ?? []).filter((r) => r.from === 'agent' || r.author === 'agent').length;
    return { things: new Set(), agentMessages };
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
    if (!was) was = this.created(p, kind, id) >= this.started - 5000 ? { things: new Set(), agentMessages: 0 } : now;
    const fresh = [...now.things].filter((t) => !was.things.has(t) && t !== '@closed');
    const replies = Math.max(0, now.agentMessages - was.agentMessages);
    this.seen.set(k, now);
    if (!fresh.length && !replies) return;
    const cfg = notifyConfig();
    if (!notifyEnabled(cfg)) return;
    const pend = this.pending.get(k) ?? { fresh: new Set<string>(), replies: 0, first: Date.now() };
    for (const t of fresh) pend.fresh.add(t);
    pend.replies += cfg.replies === false ? 0 : replies;
    if (!pend.fresh.size && !pend.replies) return;
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
    try {
      await send(notifyConfig(), notice);
      this.log(`notified: ${notice.title}`);
    } catch (e) {
      this.log(`couldn't notify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private compose(p: ProjectView, key: string, kind: NotifyKind, id: string, pend: Pending): Notice | undefined {
    const base = { url: this.link(key, kind, id), project: key, request: id, newQuestions: 0, newItems: 0, approval: false, blocking: 0, replies: pend.replies };
    const replyText = pend.replies ? `${pend.replies} repl${pend.replies === 1 ? 'y' : 'ies'} from the agent` : '';
    if (kind === 'questions') {
      const l = p.questions.load(id);
      if (!l) return undefined;
      const af = p.questions.answers(id);
      const vis = visibility(l.set, af.answers);
      const fresh = allQuestions(l.set).filter((q) => pend.fresh.has(q.id) && vis.question(q.id));
      const blocking = fresh.filter((q) => q.priority === 'blocking' && !isDone(af.answers[q.id])).length;
      if (!fresh.length && !pend.replies) return undefined;
      const first = fresh[0];
      return {
        ...base,
        kind: 'questions',
        title: `${l.set.title}: ${[fresh.length ? `${fresh.length} new question${fresh.length === 1 ? '' : 's'}` : '', replyText].filter(Boolean).join(', ')}`,
        message: [
          blocking ? `${blocking} blocking: the agent is waiting on ${blocking === 1 ? 'it' : 'them'}.` : '',
          first ? `“${first.question.replace(/\s+/g, ' ').slice(0, 120)}”${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ''}` : 'Tap to read.',
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
      const items = r.items.filter((i) => pend.fresh.has(i.id));
      const gate = r.mode === 'approve';
      const asked = gate && pend.fresh.has('@open');
      if (!items.length && !pend.replies && !asked) return undefined;
      const what = gate ? 'asks for your OK' : `${items.length} thing${items.length === 1 ? '' : 's'} to ${r.mode === 'show' ? 'look at' : 'review'}`;
      return {
        ...base,
        kind: gate ? 'approve' : 'review',
        title: `${r.title}: ${[items.length || asked ? what : '', replyText].filter(Boolean).join(', ')}`,
        message: [
          r.from ? `From ${r.from}.` : '',
          gate ? 'Approve or refuse: the agent is waiting.' : items[0] ? `“${items[0].title.slice(0, 120)}”${items.length > 1 ? ` and ${items.length - 1} more` : ''}` : 'Tap to read.',
          `${key} · ${id}`,
        ]
          .filter(Boolean)
          .join('\n'),
        newItems: items.length,
        approval: gate,
        blocking: gate ? 1 : 0,
      };
    }
    if (!pend.replies) return undefined;
    return { ...base, kind: 'notes', title: `${key}: ${replyText} on your notes`, message: 'Tap to read.' };
  }

  link(key: string, kind: NotifyKind, id: string): string {
    const hash = kind === 'notes' ? `#/p/${encodeURIComponent(key)}/notes` : `#/p/${encodeURIComponent(key)}/${kind === 'review' ? 'r' : 'q'}/${encodeURIComponent(id)}`;
    return linkBase(notifyConfig(), this.port(), this.token, this.base) + hash;
  }
}

/** Where links in notifications point: the configured base, else Tailscale (works anywhere), else the LAN. */
export function linkBase(cfg: NotifyConfig, port: number, token: string, hubBase = '/'): string {
  let base = cfg.link?.replace(/\/+$/, '');
  if (!base) {
    const ips = lanAddresses();
    const ts = ips.find((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip));
    base = `http://${ts ?? ips[0] ?? os.hostname()}:${port}${hubBase.replace(/\/$/, '')}`;
  }
  return `${base}/${cfg.includeToken && token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Send one notice to every configured channel. */
export async function send(cfg: NotifyConfig, n: Notice): Promise<void> {
  const errors: string[] = [];
  if (cfg.ntfy) {
    try {
      const u = new URL(cfg.ntfy);
      const topic = u.pathname.replace(/^\/+|\/+$/g, '');
      if (!topic) throw new Error(`no topic in ${cfg.ntfy}`);
      const tags = [n.approval ? 'raising_hand' : n.blocking ? 'warning' : n.kind === 'review' ? 'eyes' : n.kind === 'notes' ? 'speech_balloon' : 'question'];
      const res = await fetch(u.origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.ntfyToken ? { authorization: `Bearer ${cfg.ntfyToken}` } : {}) },
        body: JSON.stringify({ topic, title: n.title, message: n.message, click: n.url, tags, priority: n.approval ? 5 : n.blocking ? 4 : 3 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`ntfy: ${res.status} ${await res.text().catch(() => '')}`.trim());
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
}
