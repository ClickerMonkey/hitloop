// Machine alerts: a notification when something on the dashboard crosses a line you set, at once or held for a while
// ("GPU above 85 °C for 5 minutes"), or when a total over a window does ("more than $20 of tokens in an hour"). Also
// two Claude Code events: a session finished working (it's waiting for you), and a workflow finished.
// The rules live in ~/.config/hitl/config.json (machine.alerts); they need the dashboard on, since that's what samples.
import type { Snapshot } from './system.js';
import type { LiveSession } from './claude.js';

export interface AlertRule {
  id: string;
  on: boolean;
  metric: string;
  op: '>' | '<';
  value: number;
  /** a level: how long it has to stay past the line (0: at once). A total: the window it's added up over. */
  minutes: number;
  /** after it fires, stay quiet this long (default 30) */
  cooldown?: number;
}

export interface Metric {
  id: string;
  label: string;
  unit: string;
  /** a level read from each sample, or a total over a window */
  kind: 'level' | 'total';
  /** the usual direction and line, for a new rule */
  op: '>' | '<';
  value: number;
  minutes: number;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
const min = (a: number[]) => (a.length ? Math.min(...a) : NaN);

/** every metric a rule can watch: levels read from a sample, totals from the round-robin files */
export const METRICS: (Metric & { read?: (s: Snapshot, live: LiveSession[]) => number; series?: string[] })[] = [
  { id: 'cpu', label: 'CPU use', unit: '%', kind: 'level', op: '>', value: 90, minutes: 5, read: (s) => s.cpu.total },
  { id: 'mem', label: 'Memory used', unit: '%', kind: 'level', op: '>', value: 90, minutes: 2, read: (s) => (s.mem.used / s.mem.total) * 100 },
  { id: 'memFree', label: 'Memory free', unit: 'GB', kind: 'level', op: '<', value: 2, minutes: 1, read: (s) => (s.mem.total - s.mem.used) / GB },
  { id: 'gpu', label: 'GPU use (busiest GPU)', unit: '%', kind: 'level', op: '>', value: 95, minutes: 10, read: (s) => max(s.gpus.map((g) => g.util)) },
  { id: 'gpuTemp', label: 'GPU temperature (hottest)', unit: '°C', kind: 'level', op: '>', value: 85, minutes: 2, read: (s) => max(s.gpus.map((g) => g.temp)) },
  { id: 'vram', label: 'GPU memory used', unit: '%', kind: 'level', op: '>', value: 95, minutes: 2, read: (s) => max(s.gpus.map((g) => (g.memTotal ? (g.memUsed / g.memTotal) * 100 : NaN))) },
  { id: 'gpuPower', label: 'GPU power', unit: 'W', kind: 'level', op: '>', value: 300, minutes: 5, read: (s) => max(s.gpus.map((g) => g.power)) },
  { id: 'driveFree', label: 'Free space (fullest drive)', unit: 'GB', kind: 'level', op: '<', value: 20, minutes: 0, read: (s) => min(s.drives.filter((d) => d.total > 0).map((d) => d.free / GB)) },
  { id: 'driveFreePct', label: 'Free space % (fullest drive)', unit: '%', kind: 'level', op: '<', value: 5, minutes: 0, read: (s) => min(s.drives.filter((d) => d.total > 0).map((d) => (d.free / d.total) * 100)) },
  { id: 'diskRead', label: 'Disk reads', unit: 'MB/s', kind: 'level', op: '>', value: 500, minutes: 5, read: (s) => (s.disk ? s.disk.read / MB : NaN) },
  { id: 'diskWrite', label: 'Disk writes', unit: 'MB/s', kind: 'level', op: '>', value: 500, minutes: 5, read: (s) => (s.disk ? s.disk.write / MB : NaN) },
  { id: 'netDown', label: 'Network down (all adapters)', unit: 'MB/s', kind: 'level', op: '>', value: 50, minutes: 5, read: (s) => Object.values(s.net).reduce((a, n) => a + n.rx, 0) / MB },
  { id: 'netUp', label: 'Network up (all adapters)', unit: 'MB/s', kind: 'level', op: '>', value: 20, minutes: 5, read: (s) => Object.values(s.net).reduce((a, n) => a + n.tx, 0) / MB },
  { id: 'claudeCpu', label: 'CPU of all claude processes', unit: '% of a core', kind: 'level', op: '>', value: 200, minutes: 5, read: (s) => s.procs?.groups['claude']?.cpu ?? NaN },
  { id: 'claudeMem', label: 'Memory of all claude processes', unit: 'GB', kind: 'level', op: '>', value: 8, minutes: 2, read: (s) => (s.procs ? (s.procs.groups['claude']?.mem ?? 0) / GB : NaN) },
  { id: 'nodeCpu', label: 'CPU of all node processes', unit: '% of a core', kind: 'level', op: '>', value: 200, minutes: 5, read: (s) => s.procs?.groups['node']?.cpu ?? NaN },
  { id: 'nodeMem', label: 'Memory of all node processes', unit: 'GB', kind: 'level', op: '>', value: 8, minutes: 2, read: (s) => (s.procs ? (s.procs.groups['node']?.mem ?? 0) / GB : NaN) },
  { id: 'sessions', label: 'Claude Code sessions open', unit: '', kind: 'level', op: '>', value: 10, minutes: 0, read: (_s, live) => live.length },
  { id: 'busy', label: 'Claude Code sessions working', unit: '', kind: 'level', op: '>', value: 5, minutes: 0, read: (_s, live) => live.filter((l) => l.status === 'busy').length },
  { id: 'cost', label: 'Token cost (estimate)', unit: '$', kind: 'total', op: '>', value: 20, minutes: 60, series: ['cl.cost'] },
  { id: 'tokens', label: 'Tokens (all, with cache)', unit: 'M', kind: 'total', op: '>', value: 50, minutes: 60, series: ['cl.in', 'cl.out', 'cl.cread', 'cl.cw5', 'cl.cw1h'] },
  { id: 'tokensOut', label: 'Output tokens', unit: 'k', kind: 'total', op: '>', value: 500, minutes: 60, series: ['cl.out'] },
  { id: 'tools', label: 'Tool calls', unit: '', kind: 'total', op: '>', value: 1000, minutes: 60, series: ['cl.tools'] },
  { id: 'toolErrors', label: 'Tool errors', unit: '', kind: 'total', op: '>', value: 20, minutes: 10, series: ['cl.toolerr'] },
  { id: 'turns', label: 'Model turns', unit: '', kind: 'total', op: '>', value: 500, minutes: 60, series: ['cl.turns'] },
  { id: 'prompts', label: 'Prompts you sent', unit: '', kind: 'total', op: '>', value: 100, minutes: 60, series: ['cl.prompts'] },
];

/** totals are shown in a friendlier unit than they're kept in */
const SCALE: Record<string, number> = { M: 1e6, k: 1e3 };

export const metric = (id: string) => METRICS.find((m) => m.id === id);

/** a rule as written, cleaned (or a reason it can't be) */
export function cleanRule(r: Partial<AlertRule>, id: string): AlertRule | string {
  const m = metric(String(r.metric ?? ''));
  if (!m) return `no metric "${String(r.metric)}"`;
  const value = Number(r.value);
  if (!Number.isFinite(value)) return 'the value is a number';
  const minutes = Math.max(0, Math.min(43_200, Number(r.minutes ?? m.minutes) || 0));
  if (m.kind === 'total' && minutes < 1) return 'a total needs a window of at least a minute';
  return {
    id: String(r.id || id).slice(0, 40),
    on: r.on !== false,
    metric: m.id,
    op: r.op === '<' ? '<' : '>',
    value,
    minutes,
    cooldown: Math.max(1, Math.min(10_080, Number(r.cooldown ?? 30) || 30)),
  };
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');
const span = (min: number) => (min >= 1440 && min % 1440 === 0 ? `${min / 1440} day${min === 1440 ? '' : 's'}` : min >= 60 && min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minute${min === 1 ? '' : 's'}`);

/** "GPU temperature above 85 °C for 2 minutes" */
export function describe(r: AlertRule): string {
  const m = metric(r.metric);
  if (!m) return r.metric;
  const unit = m.unit ? (m.unit === '%' || m.unit === '$' ? m.unit : ` ${m.unit}`) : '';
  const v = m.unit === '$' ? `$${fmt(r.value)}` : `${fmt(r.value)}${unit}`;
  const dir = r.op === '>' ? 'above' : 'below';
  if (m.kind === 'total') return `${m.label} ${dir} ${v} in ${span(r.minutes)}`;
  return `${m.label} ${dir} ${v}${r.minutes ? ` for ${span(r.minutes)}` : ''}`;
}

export interface Fired {
  rule: AlertRule;
  /** the reading that crossed the line */
  value: number;
  title: string;
  message: string;
}

/** The rules' state between samples: since when each has been past its line, and when it last fired. */
export class Alerts {
  private past = new Map<string, number>();
  private fired = new Map<string, number>();
  private lastTotals = 0;

  constructor(
    private readonly rules: () => AlertRule[],
    private readonly total: (series: string, seconds: number) => number,
    private readonly fire: (f: Fired) => void,
  ) {}

  /** a fresh sample: check every level rule (and the totals, twice a minute) */
  sample(s: Snapshot, live: LiveSession[], now = s.t): void {
    const rules = this.rules().filter((r) => r.on);
    const ids = new Set(rules.map((r) => r.id));
    for (const k of this.past.keys()) if (!ids.has(k)) this.past.delete(k);
    for (const r of rules) {
      const m = metric(r.metric);
      if (!m || m.kind !== 'level' || !m.read) continue;
      const v = m.read(s, live);
      if (!Number.isFinite(v)) continue;
      this.check(r, v, now);
    }
    if (now - this.lastTotals >= 30_000) {
      this.lastTotals = now;
      for (const r of rules) {
        const m = metric(r.metric);
        if (!m || m.kind !== 'total' || !m.series) continue;
        const sum = m.series.reduce((a, n) => a + this.total(n, r.minutes * 60), 0) / (SCALE[m.unit] ?? 1);
        this.check(r, sum, now);
      }
    }
  }

  private check(r: AlertRule, v: number, now: number): void {
    const over = r.op === '>' ? v > r.value : v < r.value;
    if (!over) {
      this.past.delete(r.id);
      return;
    }
    const m = metric(r.metric);
    const since = this.past.get(r.id) ?? now;
    this.past.set(r.id, since);
    if (m?.kind === 'level' && now - since < r.minutes * 60_000) return;
    const last = this.fired.get(r.id) ?? 0;
    if (now - last < (r.cooldown ?? 30) * 60_000) return;
    this.fired.set(r.id, now);
    const unit = m?.unit === '$' ? '' : m?.unit ? (m.unit === '%' ? '%' : ` ${m.unit}`) : '';
    this.fire({ rule: r, value: v, title: `⚠ ${describe(r)}`, message: `Now ${m?.unit === '$' ? '$' : ''}${fmt(v)}${unit}.` });
  }
}

/** Claude Code sessions that stopped working (busy for a while, then not): they're waiting for you. */
export class SessionWatch {
  private busySince = new Map<string, number>();

  constructor(private readonly minBusyMs = 20_000) {}

  /** the sessions now; returns the ones that just finished a stretch of work */
  update(live: LiveSession[], now = Date.now()): { session: LiveSession; worked: number }[] {
    const done: { session: LiveSession; worked: number }[] = [];
    const seen = new Set<string>();
    for (const l of live) {
      const k = l.sessionId || String(l.pid);
      seen.add(k);
      const since = this.busySince.get(k);
      if (l.status === 'busy') {
        if (since === undefined) this.busySince.set(k, l.updatedAt || now);
      } else if (since !== undefined) {
        this.busySince.delete(k);
        if (now - since >= this.minBusyMs) done.push({ session: l, worked: now - since });
      }
    }
    for (const k of this.busySince.keys()) if (!seen.has(k)) this.busySince.delete(k);
    return done;
  }
}
