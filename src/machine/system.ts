// What this computer is doing, from what Node can reach without installing anything:
//   CPU per core and memory           os.cpus(), os.freemem()
//   free space per drive              fs.statfs
//   network and disk speed            Windows: typeperf (built in), one long-running process; Linux: /proc
//   GPU use, memory, heat, power      nvidia-smi, when it's installed
//   processes (CPU, memory)           Windows: one long-running PowerShell; Linux: /proc; macOS: ps
// Long-running helpers are started once and asked again and again, so a sample costs little.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile, type ChildProcess } from 'node:child_process';

export interface Proc {
  pid: number;
  name: string;
  /** % of one core */
  cpu: number;
  /** bytes */
  mem: number;
}

export interface Gpu {
  index: number;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  power: number;
}

export interface Drive {
  name: string;
  total: number;
  free: number;
}

export interface Snapshot {
  t: number;
  cpu: { total: number; cores: number[] };
  mem: { used: number; total: number };
  /** bytes per second, by adapter */
  net: Record<string, { rx: number; tx: number }>;
  disk: { read: number; write: number } | null;
  drives: Drive[];
  gpus: Gpu[];
  /** the busiest processes, and every process grouped by name for the ones we follow */
  procs: { top: Proc[]; topMem: Proc[]; count: number; groups: Record<string, { n: number; cpu: number; mem: number }>; t: number } | null;
}

/** process names whose totals get their own graphs */
export const GROUPS = ['claude', 'node'];

type Gauge = (name: string, t: number, v: number) => void;

export class SystemSampler {
  private prevCpu = os.cpus().map((c) => c.times);
  private timer: NodeJS.Timeout | undefined;
  private fast = false;
  private kids: ChildProcess[] = [];
  private net: Snapshot['net'] = {};
  private disk: Snapshot['disk'] = null;
  private drives: Drive[] = [];
  private gpus: Gpu[] = [];
  private procs: Snapshot['procs'] = null;
  private procTimes = new Map<number, number>();
  private procAt = 0;
  private procBusy = false;
  private ps: ChildProcess | undefined;
  private psOut: string[] = [];
  private psWait: ((lines: string[]) => void) | undefined;
  private lastDrives = 0;
  private lastProcs = 0;
  private linuxPrev: { t: number; net: Record<string, [number, number]>; disk: [number, number] } | undefined;
  private stopped = true;
  /** what this computer can tell us */
  readonly have = { net: false, disk: false, gpu: false, procs: true };

  constructor(
    private gauge: Gauge,
    private onSample: (s: Snapshot) => void,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.prevCpu = os.cpus().map((c) => c.times);
    if (process.platform === 'win32') this.startTypeperf();
    else if (process.platform === 'linux') {
      this.have.net = true;
      this.have.disk = true;
    } else if (process.platform === 'darwin') this.have.net = true;
    this.startNvidia();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const k of this.kids) k.kill();
    this.kids = [];
    this.ps?.kill();
    this.ps = undefined;
    this.psWait?.([]);
    this.psWait = undefined;
  }

  /** sample every second (someone is watching) or every five */
  setFast(on: boolean): void {
    if (on === this.fast) return;
    this.fast = on;
    if (!this.stopped) {
      clearTimeout(this.timer);
      this.schedule();
    }
  }

  private schedule(): void {
    const every = this.fast ? 1000 : 5000;
    // on the beat, so samples from each source line up
    this.timer = setTimeout(() => {
      void this.tick().finally(() => !this.stopped && this.schedule());
    }, every - (Date.now() % every));
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const t = Date.now();
    // CPU: the share of each core's time that wasn't idle since the last sample
    const now = os.cpus().map((c) => c.times);
    const cores = now.map((c, i) => {
      const p = this.prevCpu[i] ?? c;
      const busy = c.user - p.user + (c.nice - p.nice) + (c.sys - p.sys) + (c.irq - p.irq);
      const all = busy + (c.idle - p.idle);
      return all > 0 ? Math.max(0, Math.min(100, (busy / all) * 100)) : 0;
    });
    this.prevCpu = now;
    const total = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0;
    this.gauge('sys.cpu', t, total);
    cores.forEach((c, i) => this.gauge(`sys.cpu.${i}`, t, c));
    const memTotal = os.totalmem();
    const used = memTotal - os.freemem();
    this.gauge('sys.mem', t, used);

    if (process.platform === 'linux') this.linuxIo(t);
    else if (process.platform === 'darwin') await this.macNet(t);

    if (t - this.lastDrives > 60_000) {
      this.lastDrives = t;
      this.drives = await listDrives();
      for (const d of this.drives) this.gauge(`sys.free.${d.name}`, t, d.free);
    }
    if (t - this.lastProcs >= 4900 && !this.procBusy) {
      this.lastProcs = t;
      this.procBusy = true;
      void this.sampleProcs()
        .catch(() => undefined)
        .finally(() => (this.procBusy = false));
    }
    this.onSample({
      t,
      cpu: { total, cores },
      mem: { used, total: memTotal },
      net: this.net,
      disk: this.disk,
      drives: this.drives,
      gpus: this.gpus,
      procs: this.procs,
    });
  }

  // ── Windows: typeperf prints every counter once a second, as CSV ──
  private startTypeperf(): void {
    const counters = ['\\Network Interface(*)\\Bytes Received/sec', '\\Network Interface(*)\\Bytes Sent/sec', '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec', '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec'];
    let kid: ChildProcess;
    try {
      kid = spawn('typeperf', [...counters, '-si', '1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return;
    }
    kid.on('error', () => undefined);
    this.kids.push(kid);
    let cols: { kind: 'rx' | 'tx' | 'read' | 'write'; adapter?: string }[] | undefined;
    const rl = readline.createInterface({ input: kid.stdout! });
    rl.on('line', (line) => {
      const cells = parseCsv(line);
      if (cells.length < 2) return;
      if (!cols) {
        if (!/PDH-CSV/.test(cells[0] ?? '')) return;
        cols = cells.slice(1).map((c) => {
          const m = /\\Network Interface\((.*)\)\\Bytes (Received|Sent)/i.exec(c);
          if (m) return { kind: m[2]!.toLowerCase() === 'received' ? 'rx' : 'tx', adapter: niceAdapter(m[1]!) };
          return { kind: /Read/i.test(c) ? 'read' : 'write' };
        });
        this.have.net = cols.some((c) => c.adapter);
        this.have.disk = true;
        return;
      }
      const t = Date.now();
      const net: Snapshot['net'] = {};
      const disk = { read: 0, write: 0 };
      cells.slice(1).forEach((v, i) => {
        const c = cols?.[i];
        const x = Number(v);
        if (!c || !Number.isFinite(x)) return;
        if (c.adapter) (net[c.adapter] ??= { rx: 0, tx: 0 })[c.kind as 'rx' | 'tx'] += x;
        else disk[c.kind as 'read' | 'write'] += x;
      });
      this.record(t, net, disk);
    });
    // adapters come and go (a VPN, a phone tether): start again now and then to see new ones
    const again = setTimeout(() => {
      if (this.stopped) return;
      kid.kill();
      this.kids = this.kids.filter((k) => k !== kid);
      this.startTypeperf();
    }, 30 * 60_000);
    again.unref();
    kid.on('exit', () => clearTimeout(again));
  }

  private record(t: number, net: Snapshot['net'], disk: Snapshot['disk']): void {
    // adapters that never carry anything (virtual ones, a Wi-Fi card left off) aren't worth a graph
    for (const [a, v] of Object.entries(net)) {
      if (v.rx + v.tx === 0 && !this.net[a]) delete net[a];
    }
    this.net = net;
    this.disk = disk;
    for (const [a, v] of Object.entries(net)) {
      this.gauge(`sys.net.${a}.rx`, t, v.rx);
      this.gauge(`sys.net.${a}.tx`, t, v.tx);
    }
    if (disk) {
      this.gauge('sys.disk.read', t, disk.read);
      this.gauge('sys.disk.write', t, disk.write);
    }
  }

  // ── Linux: counters from /proc, as differences between samples ──
  private linuxIo(t: number): void {
    try {
      const net: Record<string, [number, number]> = {};
      for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
        const m = /^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/.exec(line);
        if (m && m[1] !== 'lo' && !/^(veth|docker|br-|virbr)/.test(m[1]!)) net[m[1]!] = [Number(m[2]), Number(m[3])];
      }
      let r = 0;
      let w = 0;
      for (const line of fs.readFileSync('/proc/diskstats', 'utf8').split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length > 10 && /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(f[2] ?? '')) {
          r += Number(f[5]) * 512;
          w += Number(f[9]) * 512;
        }
      }
      const prev = this.linuxPrev;
      this.linuxPrev = { t, net, disk: [r, w] };
      if (!prev) return;
      const dt = (t - prev.t) / 1000;
      const rates: Snapshot['net'] = {};
      for (const [a, [rx, tx]] of Object.entries(net)) {
        const p = prev.net[a];
        if (p) rates[a] = { rx: Math.max(0, (rx - p[0]) / dt), tx: Math.max(0, (tx - p[1]) / dt) };
      }
      this.record(t, rates, { read: Math.max(0, (r - prev.disk[0]) / dt), write: Math.max(0, (w - prev.disk[1]) / dt) });
    } catch {
      // not there in a container, say
    }
  }

  private macPrev: { t: number; net: Record<string, [number, number]> } | undefined;
  private async macNet(t: number): Promise<void> {
    const out = await run('netstat', ['-ibn']);
    if (!out) return;
    const net: Record<string, [number, number]> = {};
    for (const line of out.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 10 && f[2]?.startsWith('<Link') && !/^(lo|gif|stf|utun|awdl|llw|bridge|anpi|ap)\d*/.test(f[0] ?? '')) net[f[0]!] = [Number(f[6]), Number(f[9])];
    }
    const prev = this.macPrev;
    this.macPrev = { t, net };
    if (!prev) return;
    const dt = (t - prev.t) / 1000;
    const rates: Snapshot['net'] = {};
    for (const [a, [rx, tx]] of Object.entries(net)) {
      const p = prev.net[a];
      if (p) rates[a] = { rx: Math.max(0, (rx - p[0]) / dt), tx: Math.max(0, (tx - p[1]) / dt) };
    }
    this.record(t, rates, null);
  }

  // ── nvidia-smi, once a second ──
  private startNvidia(): void {
    let kid: ChildProcess;
    try {
      kid = spawn('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits', '-l', '1'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return;
    }
    kid.on('error', () => undefined);
    this.kids.push(kid);
    const seen = new Map<number, Gpu>();
    readline.createInterface({ input: kid.stdout! }).on('line', (line) => {
      const f = line.split(',').map((x) => x.trim());
      if (f.length < 7) return;
      const n = (s: string | undefined) => (Number.isFinite(Number(s)) ? Number(s) : 0);
      const g: Gpu = { index: n(f[0]), name: f[1] ?? 'GPU', util: n(f[2]), memUsed: n(f[3]) * 1048576, memTotal: n(f[4]) * 1048576, temp: n(f[5]), power: n(f[6]) };
      this.have.gpu = true;
      seen.set(g.index, g);
      this.gpus = [...seen.values()].sort((a, b) => a.index - b.index);
      const t = Date.now();
      this.gauge(`sys.gpu.${g.index}.util`, t, g.util);
      this.gauge(`sys.gpu.${g.index}.mem`, t, g.memUsed);
      this.gauge(`sys.gpu.${g.index}.temp`, t, g.temp);
      this.gauge(`sys.gpu.${g.index}.power`, t, g.power);
    });
  }

  // ── processes ──
  private async sampleProcs(): Promise<void> {
    const t = Date.now();
    let list: { pid: number; name: string; cpuMs: number; mem: number }[] = [];
    if (process.platform === 'win32') list = await this.winProcs();
    else if (process.platform === 'linux') list = linuxProcs();
    else list = await psProcs();
    if (!list.length) {
      this.have.procs = false;
      return;
    }
    this.have.procs = true;
    const dt = this.procAt ? t - this.procAt : 0;
    const procs: Proc[] = [];
    const next = new Map<number, number>();
    for (const p of list) {
      next.set(p.pid, p.cpuMs);
      const before = this.procTimes.get(p.pid);
      const cpu = dt > 0 && before !== undefined ? Math.max(0, ((p.cpuMs - before) / dt) * 100) : 0;
      procs.push({ pid: p.pid, name: p.name, cpu, mem: p.mem });
    }
    this.procTimes = next;
    this.all = new Map(procs.map((p) => [p.pid, p]));
    this.procAt = t;
    const groups: Record<string, { n: number; cpu: number; mem: number }> = {};
    for (const g of GROUPS) groups[g] = { n: 0, cpu: 0, mem: 0 };
    for (const p of procs) {
      const g = groups[p.name.toLowerCase().replace(/\.exe$/, '')];
      if (!g) continue;
      g.n++;
      g.cpu += p.cpu;
      g.mem += p.mem;
    }
    if (dt > 0) {
      for (const [k, g] of Object.entries(groups)) {
        this.gauge(`proc.${k}.cpu`, t, g.cpu);
        this.gauge(`proc.${k}.mem`, t, g.mem);
        this.gauge(`proc.${k}.n`, t, g.n);
      }
      this.gauge('proc.count', t, procs.length);
    }
    const top = [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, 15);
    const topMem = [...procs].sort((a, b) => b.mem - a.mem).slice(0, 15);
    this.procs = { top, topMem, count: procs.length, groups, t };
  }

  /** what a process is doing, by its id (for a Claude session's own process) */
  proc(pid: number): Proc | undefined {
    if (!this.procs) return undefined;
    return this.all.get(pid);
  }
  private all = new Map<number, Proc>();

  private winProcs(): Promise<{ pid: number; name: string; cpuMs: number; mem: number }[]> {
    if (!this.ps) {
      // one PowerShell, asked for a list each time it reads a line
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        'while ($true) {',
        '  $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }',
        '  $sb = New-Object System.Text.StringBuilder',
        '  foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {',
        '    $c = 0; try { $c = $p.TotalProcessorTime.TotalMilliseconds } catch {}',
        '    [void]$sb.Append($p.Id).Append("`t").Append($p.ProcessName).Append("`t").Append([int64]$c).Append("`t").Append($p.WorkingSet64).Append("`n")',
        '  }',
        '  [Console]::Out.Write($sb.ToString()); [Console]::Out.WriteLine("<<end>>"); [Console]::Out.Flush()',
        '}',
      ].join('\n');
      // the script goes in -EncodedCommand, so stdin is ours: each line we send asks for a list
      const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      ps.on('error', () => undefined);
      ps.on('exit', () => {
        if (this.ps === ps) this.ps = undefined;
        this.psWait?.([]);
      });
      this.ps = ps;
      readline.createInterface({ input: ps.stdout! }).on('line', (line) => {
        if (line === '<<end>>') {
          const out = this.psOut;
          this.psOut = [];
          const w = this.psWait;
          this.psWait = undefined;
          w?.(out);
        } else this.psOut.push(line);
      });
    }
    return new Promise((resolve) => {
      const done = setTimeout(() => {
        this.psWait = undefined;
        resolve([]);
      }, 8000);
      this.psWait = (lines) => {
        clearTimeout(done);
        const out = lines
          .map((l) => l.split('\t'))
          .filter((f) => f.length >= 4)
          .map((f) => ({ pid: Number(f[0]), name: f[1] ?? '?', cpuMs: Number(f[2]) || 0, mem: Number(f[3]) || 0 }))
          .filter((p) => p.pid > 0);
        resolve(out);
      };
      this.ps?.stdin?.write('go\r\n');
    });
  }
}

function linuxProcs(): { pid: number; name: string; cpuMs: number; mem: number }[] {
  const out: { pid: number; name: string; cpuMs: number; mem: number }[] = [];
  let ids: string[] = [];
  try {
    ids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const id of ids) {
    try {
      const stat = fs.readFileSync(`/proc/${id}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]);
      const rss = Number(f[21]) * 4096;
      out.push({ pid: Number(id), name, cpuMs: ticks * 10, mem: rss });
    } catch {
      // it ended
    }
  }
  return out;
}

async function psProcs(): Promise<{ pid: number; name: string; cpuMs: number; mem: number }[]> {
  const out = await run('ps', ['-axo', 'pid=,time=,rss=,comm=']);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      // [[dd-]hh:]mm:ss[.cc]
      let s = 0;
      const t = m[2] ?? '';
      const [whole = '0', frac = '0'] = t.split('.');
      const segs = whole.split(/[-:]/).map(Number);
      const mult = [1, 60, 3600, 86400];
      segs.reverse().forEach((v, i) => (s += v * (mult[i] ?? 0)));
      return { pid: Number(m[1]), name: path.basename(m[4] ?? '?'), cpuMs: s * 1000 + Number('0.' + frac) * 1000, mem: Number(m[3]) * 1024 };
    });
}

async function listDrives(): Promise<Drive[]> {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) roots.push(String.fromCharCode(c) + ':\\');
  } else if (process.platform === 'linux') {
    roots.push('/');
    try {
      for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
        const [, mnt, type] = line.split(' ');
        if (mnt && mnt !== '/' && /^(ext[234]|xfs|btrfs|zfs|ntfs3?|vfat|exfat|fuseblk|f2fs)$/.test(type ?? '') && /^\/(home|mnt|media|data|srv)/.test(mnt)) roots.push(mnt.replace(/\\040/g, ' '));
      }
    } catch {
      // just /
    }
  } else {
    roots.push('/');
    try {
      for (const v of fs.readdirSync('/Volumes')) roots.push('/Volumes/' + v);
    } catch {
      // just /
    }
  }
  const out: Drive[] = [];
  for (const r of roots) {
    try {
      const s = await fs.promises.statfs(r);
      const total = s.blocks * s.bsize;
      if (total < 1e9) continue; // a card reader, a tiny boot partition
      out.push({ name: process.platform === 'win32' ? r.slice(0, 2) : r, total, free: s.bavail * s.bsize });
    } catch {
      // no such drive
    }
  }
  // the same disk mounted twice (macOS's data volume): once is enough
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = `${d.total}:${Math.round(d.free / 1e8)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

/** one CSV line, with quotes */
function parseCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** "Killer E2500 Gigabit Ethernet Controller" → as is; typeperf writes ( ) as [ ] */
const niceAdapter = (s: string) => s.replace(/\[/g, '(').replace(/\]/g, ')').replace(/_/g, ' ').trim();
