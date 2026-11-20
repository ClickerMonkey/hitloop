// The machine dashboard: what this computer and its Claude Code sessions are doing, kept in round-robin files under
// ~/.config/hitl/machine/. Off until you turn it on (the page's Settings, or `hitl machine on`); pause it for an hour,
// until the hub restarts, or until you resume. Paused or off, nothing is sampled and no transcript is read.
//   GET  api/machine                 on, paused, what this computer has, how far reading has got
//   POST api/machine                 { on } or { pause: '1h' | 'restart' | 'resume' | 'off' }  ('off' ends a pause)
//   POST api/machine/watch           a page is open: sample every second for the next 15 s
//   GET  api/machine/now             the latest sample, the busiest processes, the live sessions
//   GET  api/machine/series?n=a,b&range=3600
//   GET  api/machine/claude?range=…  tokens, cost, models, projects, tools, sessions
//   GET  api/machine/session/<id>    one session: its agents, workflows and context per turn
//   GET  api/machine/workflow/<session>/<run>
//   GET  api/machine/alerts          the alert rules, and every metric a rule can watch
//   POST api/machine/alerts          { rules: [...] } replaces them
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { configDir, updateUserConfig, userConfig, userConfigPath, type MachineConfig } from '../hub/registry.js';
import { body, json } from '../http.js';
import { StoreError } from '../hub/atomic.js';
import { Rrd } from './rrd.js';
import { SystemSampler, type Snapshot } from './system.js';
import { ClaudeReader, folderName } from './claude.js';
import { Alerts, SessionWatch, METRICS, cleanRule, describe, type AlertRule } from './alerts.js';

/** something on this computer worth a notification */
export interface MachineEvent {
  event: 'alert' | 'claudeIdle' | 'workflowDone';
  title: string;
  message: string;
  /** where a tap goes on the hub's page */
  hash: string;
  /** notifications with the same tag replace each other */
  tag: string;
  urgent?: boolean;
}

export type PauseKind = '1h' | 'restart' | 'resume';

export function machineDir(): string {
  return path.join(configDir(), 'machine');
}

export class Machine {
  private rrd: Rrd | undefined;
  private sys: SystemSampler | undefined;
  private claude: ClaudeReader | undefined;
  private latest: Snapshot | undefined;
  private watchedUntil = 0;
  private pausedForRestart = false;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private cfgStamp = '';
  private since = 0;
  private alerts: Alerts | undefined;
  private sessions = new SessionWatch();
  private flows = new Map<string, string>();

  constructor(
    private broadcast: (type: string, data: unknown) => void,
    private notify: (e: MachineEvent) => void = () => undefined,
  ) {
    // the settings file can change under us (hitl machine on|off|pause): look now and then
    const t = setInterval(() => this.checkConfig(), 3000);
    t.unref();
    this.timers.push(t);
    this.checkConfig();
  }

  private config(): MachineConfig {
    const c = userConfig().machine;
    return c && typeof c === 'object' ? c : {};
  }

  /** paused now? and until when */
  pause(): { kind: PauseKind; until?: number } | null {
    if (this.pausedForRestart) return { kind: 'restart' };
    const p = this.config().paused;
    if (!p) return null;
    if (p === 'resume') return { kind: 'resume' };
    const until = Date.parse(p);
    return until > Date.now() ? { kind: '1h', until } : null;
  }

  private checkConfig(): void {
    let stamp = '';
    try {
      stamp = String(fs.statSync(userConfigPath()).mtimeMs);
    } catch {
      stamp = 'none';
    }
    const want = !!this.config().on && !this.pause();
    if (stamp === this.cfgStamp && want === this.running) return;
    this.cfgStamp = stamp;
    if (want && !this.running) this.start();
    else if (!want && this.running) this.stop();
  }

  private start(): void {
    this.running = true;
    this.since = Date.now();
    const dir = machineDir();
    fs.mkdirSync(dir, { recursive: true });
    this.rrd ??= new Rrd(path.join(dir, 'series'));
    const rrd = this.rrd;
    this.sys = new SystemSampler(
      (n, t, v) => rrd.gauge(n, t, v),
      (s) => {
        this.latest = s;
        if (Date.now() < this.watchedUntil) this.broadcast('machine', { kind: 'sample', sample: s });
        this.watch(s);
      },
    );
    this.sys.start();
    this.alerts = new Alerts(
      () => this.rules(),
      (n, sec) => rrd.total(n, sec),
      (f) => this.notify({ event: 'alert', title: f.title, message: f.message, hash: '#/machine', tag: `alert-${f.rule.id}`, urgent: true }),
    );
    this.sessions = new SessionWatch();
    this.flows.clear();
    this.claude = new ClaudeReader(rrd, path.join(dir, 'claude'), (what) => {
      if (Date.now() < this.watchedUntil) this.broadcast('machine', { kind: what });
    });
    if (this.claude.exists()) this.claude.start();
    const flush = setInterval(() => {
      try {
        rrd.flush();
      } catch {
        // a full disk: try again later
      }
    }, 10_000);
    flush.unref();
    this.timers.push(flush);
    this.broadcast('machine', { kind: 'state' });
  }

  private stop(): void {
    this.running = false;
    this.sys?.stop();
    this.sys = undefined;
    this.claude?.stop();
    this.claude = undefined;
    // the flush timer is the last one pushed while running; the config check stays
    while (this.timers.length > 1) clearInterval(this.timers.pop());
    try {
      this.rrd?.close();
    } catch {
      // nothing to save
    }
    this.rrd = undefined;
    this.broadcast('machine', { kind: 'state' });
  }

  /** each sample: the alert rules, sessions that finished working, workflows that finished */
  private watch(s: Snapshot): void {
    try {
      const live = this.claude?.live ?? [];
      this.alerts?.sample(s, live);
      for (const { session, worked } of this.sessions.update(live, s.t)) {
        const info = this.claude?.get(session.sessionId);
        const name = session.name || info?.title || folderName(session.cwd);
        this.notify({
          event: 'claudeIdle',
          title: `${name}: done, waiting for you`,
          message: `Claude Code ${session.status === 'idle' ? 'finished' : `is now ${session.status}`} after ${Math.max(1, Math.round(worked / 60_000))} min of work.
${info?.project || folderName(session.cwd)}`,
          hash: `#/machine/s/${encodeURIComponent(session.sessionId)}/c`,
          tag: `idle-${session.sessionId}`,
        });
      }
      for (const l of live) {
        const info = l.sessionId ? this.claude?.get(l.sessionId) : undefined;
        for (const w of Object.values(info?.workflows ?? {})) {
          const k = `${l.sessionId}/${w.runId}`;
          const was = this.flows.get(k);
          this.flows.set(k, w.status);
          if (was === 'running' && w.status !== 'running')
            this.notify({
              event: 'workflowDone',
              title: `Workflow ${w.name || w.runId} ${w.status === 'completed' ? 'finished' : w.status}`,
              message: `${w.agentCount} agent${w.agentCount === 1 ? '' : 's'}, ${Math.max(1, Math.round(w.durationMs / 60_000))} min.
${info?.title || l.name || folderName(l.cwd)}`,
              hash: `#/machine/s/${encodeURIComponent(l.sessionId)}`,
              tag: `wf-${w.runId}`,
            });
        }
      }
    } catch {
      // a notification is never worth stopping the sampler for
    }
  }

  rules(): AlertRule[] {
    const r = this.config().alerts;
    return Array.isArray(r) ? r : [];
  }

  close(): void {
    if (this.running) this.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  setOn(on: boolean): void {
    updateUserConfig((c) => {
      const m = (c.machine ??= {});
      m.on = on;
      delete m.paused;
    });
    this.pausedForRestart = false;
    this.checkConfig();
  }

  setPause(kind: PauseKind | 'off'): void {
    this.pausedForRestart = kind === 'restart';
    updateUserConfig((c) => {
      const m = (c.machine ??= {});
      if (kind === '1h') m.paused = new Date(Date.now() + 3600_000).toISOString();
      else if (kind === 'resume') m.paused = 'resume';
      else delete m.paused;
    });
    this.checkConfig();
  }

  status(): Record<string, unknown> {
    const c = this.config();
    const cpus = os.cpus();
    return {
      on: !!c.on,
      running: this.running,
      paused: this.pause(),
      since: this.since,
      platform: process.platform,
      hostname: os.hostname(),
      cpu: { model: cpus[0]?.model.trim() ?? '', cores: cpus.length },
      memTotal: os.totalmem(),
      uptime: os.uptime(),
      have: this.sys?.have ?? null,
      claude: this.claude ? { home: this.claude.root, found: this.claude.exists(), progress: this.claude.progress, ...this.claude.counts() } : null,
      dir: machineDir(),
      bytes: this.rrd?.size() ?? 0,
      now: Date.now(),
    };
  }

  async handle(sub: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (sub === '' || sub === '/') {
      if (method === 'POST') {
        const b = await body(req);
        if (typeof b['on'] === 'boolean') this.setOn(b['on']);
        const p = b['pause'];
        if (p !== undefined) {
          if (p !== '1h' && p !== 'restart' && p !== 'resume' && p !== 'off') throw new StoreError('pause is 1h, restart, resume or off');
          this.setPause(p);
        }
      }
      return json(res, 200, this.status());
    }
    if (sub === '/watch' && method === 'POST') {
      this.watchedUntil = Date.now() + 15_000;
      this.sys?.setFast(true);
      const t = setTimeout(() => Date.now() >= this.watchedUntil && this.sys?.setFast(false), 15_500);
      t.unref();
      return json(res, 200, { ok: true });
    }
    if (sub === '/now') {
      const live = (this.claude?.live ?? []).map((l) => {
        const s = this.claude?.get(l.sessionId);
        const p = this.sys?.proc(l.pid);
        return {
          ...l,
          proc: p ? { cpu: p.cpu, mem: p.mem } : null,
          title: s?.title ?? '',
          project: s?.project || folderName(l.cwd),
          model: s?.model ?? '',
          tok: s?.tok ?? null,
          cost: s?.cost ?? 0,
          turns: s?.turns ?? 0,
          tools: s?.tools ?? 0,
          ctx: s?.ctx.at(-1)?.[1] ?? 0,
          last: s?.last ?? 0,
          agentsRunning: s ? Object.values(s.agents).filter((a) => a.finished === false || (a.finished === null && Date.now() - a.last < 120_000)).length : 0,
          workflowsRunning: s ? Object.values(s.workflows).filter((w) => w.status === 'running').length : 0,
        };
      });
      return json(res, 200, { status: this.status(), sample: this.latest ?? null, live, running: this.claude?.running() ?? [] });
    }
    if (sub === '/alerts') {
      if (method === 'POST') {
        const b = await body(req);
        if (!Array.isArray(b['rules'])) throw new StoreError('{ rules: [...] }');
        const rules: AlertRule[] = [];
        (b['rules'] as Partial<AlertRule>[]).slice(0, 100).forEach((r, i) => {
          const c = cleanRule(r, `r${Date.now().toString(36)}${i}`);
          if (typeof c === 'string') throw new StoreError(`rule ${i + 1}: ${c}`);
          rules.push(c);
        });
        updateUserConfig((c) => ((c.machine ??= {}).alerts = rules));
      }
      return json(res, 200, {
        rules: this.rules().map((r) => ({ ...r, text: describe(r) })),
        metrics: METRICS.map(({ read: _r, series: _s, ...m }) => m),
        have: this.sys?.have ?? null,
        on: !!this.config().on,
      });
    }
    const rng = Math.max(60, Math.min(2 * 365 * 86400, Number(url.searchParams.get('range')) || 3600));
    if (sub === '/series') {
      const rrd = this.rrd;
      const out: Record<string, unknown> = {};
      const names = (url.searchParams.get('n') ?? '').split(',').filter(Boolean);
      // a name ending in * means every series under it (sys.cpu.* : each core)
      const all = names.flatMap((n) => (n.endsWith('*') ? (rrd?.names(n.slice(0, -1)) ?? []) : [n]));
      for (const n of all.slice(0, 200)) out[n] = rrd?.read(n, rng) ?? null;
      return json(res, 200, { range: rng, now: Date.now(), series: out });
    }
    if (sub === '/claude') {
      const rrd = this.rrd;
      const c = this.claude;
      const tot = (n: string) => rrd?.total(n, rng) ?? 0;
      const group = (prefix: string, suffix: string) =>
        (rrd?.names(prefix) ?? [])
          .filter((n) => n.endsWith(suffix))
          .map((n) => {
            const name = n.slice(prefix.length, -suffix.length);
            return { name, tok: tot(prefix + name + '.tok'), cost: tot(prefix + name + '.cost') };
          })
          .filter((x) => x.tok > 0)
          .sort((a, b) => b.tok - a.tok);
      return json(res, 200, {
        range: rng,
        now: Date.now(),
        totals: {
          in: tot('cl.in'),
          out: tot('cl.out'),
          think: tot('cl.think'),
          cread: tot('cl.cread'),
          cw5: tot('cl.cw5'),
          cw1h: tot('cl.cw1h'),
          cost: tot('cl.cost'),
          turns: tot('cl.turns'),
          agentTurns: tot('cl.turns.agents'),
          tools: tot('cl.tools'),
          toolErr: tot('cl.toolerr'),
          prompts: tot('cl.prompts'),
          ctx: tot('cl.ctx'),
          web: tot('cl.web'),
        },
        models: group('cl.m.', '.tok'),
        projects: group('cl.p.', '.tok'),
        tools: c?.toolStats(rng) ?? [],
        recent: c?.recentCalls(60) ?? [],
        running: c?.running() ?? [],
        sessions: c?.list(rng) ?? [],
        progress: c?.progress ?? null,
      });
    }
    const sm = /^\/session\/([^/]+)$/.exec(sub);
    if (sm) {
      const s = this.claude?.get(decodeURIComponent(sm[1] ?? ''));
      if (!s) return json(res, 404, { error: 'No such session (or it is older than what was read)' });
      const live = this.claude?.live.find((l) => l.sessionId === s.id);
      return json(res, 200, { ...s, live: live ? { ...live, proc: this.sys?.proc(live.pid) ?? null } : null, running: (this.claude?.running() ?? []).filter((r) => r.session === s.id) });
    }
    if (sub === '/transcript' || sub === '/transcript-image') {
      const q = url.searchParams;
      const session = q.get('session') ?? '';
      const agent = q.get('agent') || undefined;
      if (sub === '/transcript') {
        const t = this.claude?.transcript(session, agent, Math.max(0, Number(q.get('offset')) || 0), Math.min(500, Math.max(1, Number(q.get('limit')) || 200)));
        if (!t) return json(res, 404, { error: 'No transcript for that' });
        return json(res, 200, t);
      }
      const im = this.claude?.transcriptImage(session, agent, Number(q.get('line')) || 0, Number(q.get('n')) || 0);
      if (!im) return json(res, 404, { error: 'No such picture' });
      return json(res, 200, im);
    }
    const wm = /^\/workflow\/([^/]+)\/([^/]+)$/.exec(sub);
    if (wm) {
      const w = this.claude?.workflow(decodeURIComponent(wm[1] ?? ''), decodeURIComponent(wm[2] ?? ''));
      if (!w) return json(res, 404, { error: 'No such workflow run' });
      return json(res, 200, w);
    }
    return json(res, 404, { error: 'not found' });
  }
}
