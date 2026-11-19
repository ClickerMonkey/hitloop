// Round-robin time series (like RRDtool): one fixed-size file per series that never grows. Each series keeps four
// rings of slots, finer to coarser:
//   5 s × 720     the last hour
//   1 min × 2880  the last 2 days
//   10 min × 4464 the last 31 days
//   1 h × 17520   the last 2 years
// A gauge (CPU %, memory) keeps each slot's average and maximum; a count (tokens, tool calls) keeps each slot's sum,
// and can be added to at a past time (reading transcripts after the fact lands in the right slots).
// A slot with nothing in it is NaN, so a pause shows as a gap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from '../hub/atomic.js';

export const TIERS = [
  { step: 5, n: 720 },
  { step: 60, n: 2880 },
  { step: 600, n: 4464 },
  { step: 3600, n: 17520 },
] as const;

export type Kind = 'gauge' | 'count';

const MAGIC = 'HRRD0001';
const HEADER = 64; // magic (8), kind (1), pad, lastSlot per tier as float64 at 16 + 8i
const SLOTS = TIERS.reduce((n, t) => n + t.n, 0);
const width = (k: Kind) => (k === 'gauge' ? 2 : 1);

/** where each tier starts in the float array, in slots */
const OFFSETS = TIERS.map((_, i) => TIERS.slice(0, i).reduce((n, t) => n + t.n, 0));

export interface Read {
  /** seconds between points */
  step: number;
  /** the first point's time (unix ms) */
  start: number;
  /** averages (gauges) or sums (counts); null where nothing was recorded */
  v: (number | null)[];
  /** gauges: each point's maximum */
  max?: (number | null)[];
}

class Series {
  readonly data: Float32Array;
  readonly last: number[];
  /** the slot being filled for each tier (gauges): its running sum, count and max */
  private open: { slot: number; sum: number; n: number; max: number }[];
  private dirty: Set<number>[] = TIERS.map(() => new Set());
  private headDirty = false;
  private fd: number | undefined;

  constructor(
    readonly name: string,
    readonly kind: Kind,
    readonly file: string,
  ) {
    const w = width(kind);
    this.data = new Float32Array(SLOTS * w).fill(NaN);
    this.last = TIERS.map(() => -1);
    this.open = TIERS.map(() => ({ slot: -1, sum: 0, n: 0, max: -Infinity }));
    this.load();
  }

  private load(): void {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.file);
    } catch {
      return;
    }
    const w = width(this.kind);
    if (buf.length !== HEADER + SLOTS * w * 4 || buf.toString('latin1', 0, 8) !== MAGIC || buf[8] !== (this.kind === 'gauge' ? 1 : 2)) return; // made by another version: start over
    for (let i = 0; i < TIERS.length; i++) this.last[i] = buf.readDoubleLE(16 + 8 * i);
    const floats = new Float32Array(buf.buffer, buf.byteOffset + HEADER, SLOTS * w);
    this.data.set(floats);
  }

  /** move a tier forward to `slot`, emptying the slots it skips over */
  private advance(i: number, slot: number): void {
    const t = TIERS[i]!;
    const last = this.last[i]!;
    if (slot <= last) return;
    const w = width(this.kind);
    const from = last < 0 || slot - last > t.n ? slot - t.n + 1 : last + 1;
    for (let s = from; s <= slot; s++) {
      const at = OFFSETS[i]! + (((s % t.n) + t.n) % t.n);
      for (let k = 0; k < w; k++) this.data[at * w + k] = NaN;
      this.dirty[i]!.add(at);
    }
    this.last[i] = slot;
    this.headDirty = true;
  }

  /** a gauge reading at time t (ms); readings only move forward */
  gauge(t: number, v: number): void {
    if (!Number.isFinite(v)) return;
    for (let i = 0; i < TIERS.length; i++) {
      const t0 = TIERS[i]!;
      const slot = Math.floor(t / 1000 / t0.step);
      if (slot < this.last[i]!) continue;
      this.advance(i, slot);
      const o = this.open[i]!;
      if (o.slot !== slot) {
        o.slot = slot;
        // a slot carried over from before a restart: keep what it had
        const at0 = OFFSETS[i]! + (slot % t0.n);
        const had = this.data[at0 * 2];
        o.sum = Number.isFinite(had) ? Number(had) : 0;
        o.n = Number.isFinite(had) ? 1 : 0;
        o.max = Number.isFinite(this.data[at0 * 2 + 1]) ? Number(this.data[at0 * 2 + 1]) : -Infinity;
      }
      o.sum += v;
      o.n++;
      o.max = Math.max(o.max, v);
      const at = OFFSETS[i]! + (slot % t0.n);
      this.data[at * 2] = o.sum / o.n;
      this.data[at * 2 + 1] = o.max;
      this.dirty[i]!.add(at);
    }
  }

  /** add to a count at time t (ms), now or in the past */
  add(t: number, v: number): void {
    if (!Number.isFinite(v) || v === 0) return;
    for (let i = 0; i < TIERS.length; i++) {
      const t0 = TIERS[i]!;
      const slot = Math.floor(t / 1000 / t0.step);
      if (slot > this.last[i]!) this.advance(i, slot);
      else if (slot <= this.last[i]! - t0.n) continue; // older than this ring holds
      const at = OFFSETS[i]! + (slot % t0.n);
      const had = this.data[at];
      this.data[at] = (Number.isFinite(had) ? Number(had) : 0) + v;
      this.dirty[i]!.add(at);
    }
  }

  /** points covering the last `range` seconds up to `now`, at most about `points` of them */
  read(range: number, now: number, points = 800): Read {
    // the finest tier that holds the whole range; then merge points so there aren't too many
    let i = TIERS.findIndex((t) => t.step * t.n >= range);
    if (i < 0) i = TIERS.length - 1;
    const t = TIERS[i]!;
    const w = width(this.kind);
    const end = Math.floor(now / 1000 / t.step);
    const count = Math.min(t.n, Math.ceil(range / t.step));
    const first = end - count + 1;
    const by = Math.max(1, Math.ceil(count / points));
    const start0 = first - (((first % by) + by) % by); // aligned, so points don't shift as time passes
    const v: (number | null)[] = [];
    const max: (number | null)[] = [];
    for (let s = start0; s <= end; s += by) {
      let sum = 0;
      let n = 0;
      let mx = -Infinity;
      for (let k = s; k < s + by && k <= end; k++) {
        if (k < first || k > this.last[i]! || k <= this.last[i]! - t.n) continue;
        const at = OFFSETS[i]! + (((k % t.n) + t.n) % t.n);
        const x = this.data[at * w];
        if (!Number.isFinite(x)) continue;
        sum += Number(x);
        n++;
        if (w === 2) mx = Math.max(mx, Number(this.data[at * w + 1]));
      }
      if (this.kind === 'gauge') {
        v.push(n ? sum / n : null);
        max.push(n ? mx : null);
      } else v.push(n ? sum : null);
    }
    const out: Read = { step: t.step * by, start: start0 * t.step * 1000, v };
    if (this.kind === 'gauge') out.max = max;
    return out;
  }

  /** the sum (counts) or average (gauges) over the last `range` seconds */
  total(range: number, now: number): number {
    const r = this.read(range, now, 100000);
    const xs = r.v.filter((x): x is number => x !== null);
    if (!xs.length) return 0;
    const s = xs.reduce((a, b) => a + b, 0);
    return this.kind === 'count' ? s : s / xs.length;
  }

  /** write what changed since the last flush */
  flush(): void {
    const w = width(this.kind);
    const any = this.headDirty || this.dirty.some((d) => d.size);
    if (!any) return;
    if (this.fd === undefined) {
      if (!fs.existsSync(this.file) || fs.statSync(this.file).size !== HEADER + SLOTS * w * 4) {
        const buf = Buffer.alloc(HEADER + SLOTS * w * 4);
        buf.write(MAGIC, 0, 'latin1');
        buf[8] = this.kind === 'gauge' ? 1 : 2;
        for (let i = 0; i < TIERS.length; i++) buf.writeDoubleLE(this.last[i]!, 16 + 8 * i);
        Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength).copy(buf, HEADER);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        writeAtomic(this.file, buf);
        for (const d of this.dirty) d.clear();
        this.headDirty = false;
        return;
      }
      this.fd = fs.openSync(this.file, 'r+');
    }
    const head = Buffer.alloc(8 * TIERS.length);
    for (let i = 0; i < TIERS.length; i++) head.writeDoubleLE(this.last[i]!, 8 * i);
    fs.writeSync(this.fd, head, 0, head.length, 16);
    const bytes = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    for (const d of this.dirty) {
      // runs of neighbouring slots, one write each
      const slots = [...d].sort((a, b) => a - b);
      for (let a = 0; a < slots.length; ) {
        let b = a;
        while (b + 1 < slots.length && slots[b + 1] === slots[b]! + 1) b++;
        const off = slots[a]! * w * 4;
        const len = (slots[b]! - slots[a]! + 1) * w * 4;
        fs.writeSync(this.fd, bytes, off, len, HEADER + off);
        a = b + 1;
      }
      d.clear();
    }
    this.headDirty = false;
  }

  close(): void {
    try {
      this.flush();
    } finally {
      if (this.fd !== undefined) fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

export interface SeriesInfo {
  name: string;
  kind: Kind;
  file: string;
}

/** every series in one folder, with an index of their names */
export class Rrd {
  private series = new Map<string, Series>();
  private index: Record<string, SeriesInfo> = {};
  private indexDirty = false;

  constructor(readonly dir: string) {
    try {
      this.index = JSON.parse(fs.readFileSync(path.join(dir, 'series.json'), 'utf8')) as Record<string, SeriesInfo>;
    } catch {
      this.index = {};
    }
  }

  private get(name: string, kind: Kind): Series {
    let s = this.series.get(name);
    if (s) return s;
    let info = this.index[name];
    if (!info || info.kind !== kind) {
      const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 60);
      const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 6);
      info = { name, kind, file: `${slug}-${hash}.rrd` };
      this.index[name] = info;
      this.indexDirty = true;
    }
    s = new Series(name, kind, path.join(this.dir, info.file));
    this.series.set(name, s);
    return s;
  }

  gauge(name: string, t: number, v: number): void {
    this.get(name, 'gauge').gauge(t, v);
  }

  add(name: string, t: number, v: number): void {
    this.get(name, 'count').add(t, v);
  }

  has(name: string): boolean {
    return name in this.index;
  }

  /** the names of every series, or those starting with a prefix */
  names(prefix = ''): string[] {
    return Object.keys(this.index).filter((n) => n.startsWith(prefix));
  }

  read(name: string, range: number, now = Date.now(), points?: number): Read | undefined {
    const info = this.index[name];
    if (!info) return undefined;
    return this.get(name, info.kind).read(range, now, points);
  }

  total(name: string, range: number, now = Date.now()): number {
    const info = this.index[name];
    return info ? this.get(name, info.kind).total(range, now) : 0;
  }

  flush(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const s of this.series.values()) s.flush();
    if (this.indexDirty) {
      writeAtomic(path.join(this.dir, 'series.json'), JSON.stringify(this.index, null, 1) + '\n');
      this.indexDirty = false;
    }
  }

  close(): void {
    this.flush();
    for (const s of this.series.values()) s.close();
    this.series.clear();
  }

  /** bytes on disk */
  size(): number {
    let n = 0;
    for (const i of Object.values(this.index)) {
      try {
        n += fs.statSync(path.join(this.dir, i.file)).size;
      } catch {
        // not written yet
      }
    }
    return n;
  }
}
