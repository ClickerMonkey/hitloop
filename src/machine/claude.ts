// What Claude Code has been doing on this computer, read from its own files (nothing is installed in your projects):
//   ~/.claude/sessions/<pid>.json                           the sessions running now: name, folder, busy or idle
//   ~/.claude/projects/<folder>/<session>.jsonl             a session's transcript: every reply's model and tokens,
//                                                           every tool call (start and end times give durations)
//   …/<session>/subagents/agent-<id>.jsonl (+ .meta.json)   its subagents: type, description, model, depth
//   …/<session>/subagents/workflows/<run>/agent-<id>.jsonl  the agents of a workflow run
//   …/<session>/workflows/<run>.json                        a workflow run: phases, status, agents, tokens, script
// Transcripts are read once from the start (the last 30 days on the first run), then only what's added to them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../hub/atomic.js';
import type { Rrd } from './rrd.js';
import { costOf } from './prices.js';

export interface Tok {
  in: number;
  out: number;
  think: number;
  cread: number;
  cw5: number;
  cw1h: number;
}
const noTok = (): Tok => ({ in: 0, out: 0, think: 0, cread: 0, cw5: 0, cw1h: 0 });
const KEYS: (keyof Tok)[] = ['in', 'out', 'think', 'cread', 'cw5', 'cw1h'];

interface Work {
  first: number;
  last: number;
  tok: Tok;
  cost: number;
  turns: number;
  tools: number;
  toolErr: number;
  toolsBy: Record<string, number>;
  model: string;
}
const noWork = (): Work => ({ first: 0, last: 0, tok: noTok(), cost: 0, turns: 0, tools: 0, toolErr: 0, toolsBy: {}, model: '' });

export interface AgentInfo extends Work {
  id: string;
  type: string;
  description: string;
  depth: number;
  finished: boolean | null;
  workflow?: string;
  phase?: string;
  /** the tool call that started it, in the parent */
  toolUseId?: string;
}

export interface WorkflowInfo {
  runId: string;
  name: string;
  description: string;
  status: string;
  phases: { title: string; detail?: string }[];
  agentCount: number;
  durationMs: number;
  totalTokens: number;
  totalToolCalls: number;
  summary: string;
  startTime: number;
  file: string;
}

export interface SessionInfo extends Work {
  id: string;
  project: string;
  cwd: string;
  branch: string;
  version: string;
  title: string;
  titleRank: number;
  prompts: number;
  models: Record<string, { tok: number; cost: number }>;
  ctxMax: number;
  /** context size per turn of the main thread: [time, tokens] */
  ctx: [number, number][];
  agents: Record<string, AgentInfo>;
  workflows: Record<string, WorkflowInfo>;
}

interface FileState {
  size: number;
  off: number;
  mtime: number;
}

interface ToolStat {
  n: number;
  err: number;
  ms: number;
  max: number;
  /** where the slowest call was: session, agent, what it did */
  maxRef?: { session: string; agent?: string; summary: string; t: number };
  /** durations: bucket i holds calls up to 2^(i/2) ms */
  hist: number[];
}

export interface ToolCall {
  t: number;
  name: string;
  ms: number | null;
  err: boolean;
  session: string;
  agent?: string;
  summary: string;
}

export interface LiveSession {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  status: string;
  kind: string;
  entrypoint: string;
  version: string;
  startedAt: number;
  updatedAt: number;
}

const BUCKETS = 48;
const bucketOf = (ms: number) => Math.max(0, Math.min(BUCKETS - 1, Math.ceil(Math.log2(Math.max(1, ms)) * 2)));
const bucketMs = (i: number) => Math.pow(2, i / 2);
const DAY = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** line types we never need: requests the CLI logged, its bookkeeping */
const SKIP = /^\{"type":"(api-request|atis-latch|bridge-session|file-history|mode|permission-mode|session-owner|queue-operation|tools-used|cost-state|relocated|progress)/;

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] ? path.resolve(env['CLAUDE_CONFIG_DIR']) : path.join(os.homedir(), '.claude');
}

export class ClaudeReader {
  readonly root = claudeHome();
  private files: Record<string, FileState> = {};
  private sessions = new Map<string, SessionInfo>();
  private dirtySessions = new Set<string>();
  private tools: Record<string, Record<string, ToolStat>> = {};
  private recent: ToolCall[] = [];
  private pending = new Map<string, { name: string; t: number; session: string; agent?: string; summary: string }>();
  /** per file: the reply being read (a reply is written as several lines with the same id) */
  private last = new Map<string, { id: string; tok: Tok; cost: number }>();
  /** the newest reply in each thread (a session, or one of its agents): a call older than that is not running */
  private threadLast = new Map<string, number>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private draining = false;
  private scanning = false;
  private stopped = true;
  private timers: NodeJS.Timeout[] = [];
  private watcher: fs.FSWatcher | undefined;
  private dirty = false;
  private cutoff: number;
  live: LiveSession[] = [];
  readonly progress = { files: 0, done: 0, bytes: 0, read: 0, startedAt: 0, finishedAt: 0 };

  constructor(
    private rrd: Rrd,
    private dir: string,
    /** something changed that a watching page would want: 'live' or 'activity' */
    private onChange: (what: string) => void,
    days = 30,
  ) {
    this.cutoff = Date.now() - days * DAY;
    this.load();
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.root, 'projects'));
  }

  // ── saved state ──
  private load(): void {
    const read = <T>(f: string, d: T): T => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as T;
      } catch {
        return d;
      }
    };
    const state = read<{ files?: Record<string, FileState>; cutoff?: number }>('files.json', {});
    this.files = state.files ?? {};
    if (state.cutoff) this.cutoff = state.cutoff;
    this.tools = read('tools.json', {});
    this.recent = read('recent.json', []);
    try {
      for (const f of fs.readdirSync(path.join(this.dir, 'sessions'))) {
        if (!f.endsWith('.json')) continue;
        const s = read<SessionInfo | undefined>(path.join('sessions', f), undefined);
        if (s?.id) this.sessions.set(s.id, s);
      }
    } catch {
      // first run
    }
  }

  save(): void {
    if (!this.dirty && !this.dirtySessions.size) return;
    fs.mkdirSync(path.join(this.dir, 'sessions'), { recursive: true });
    for (const id of this.dirtySessions) {
      const s = this.sessions.get(id);
      if (s) writeAtomic(path.join(this.dir, 'sessions', `${safe(id)}.json`), JSON.stringify(s));
    }
    this.dirtySessions.clear();
    if (this.dirty) {
      // old days of tool stats go
      const keep = dayOf(Date.now() - 400 * DAY);
      for (const d of Object.keys(this.tools)) if (d < keep) delete this.tools[d];
      writeAtomic(path.join(this.dir, 'files.json'), JSON.stringify({ cutoff: this.cutoff, files: this.files }));
      writeAtomic(path.join(this.dir, 'tools.json'), JSON.stringify(this.tools));
      writeAtomic(path.join(this.dir, 'recent.json'), JSON.stringify(this.recent));
      this.dirty = false;
    }
  }

  // ── running ──
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.progress.startedAt = Date.now();
    this.progress.finishedAt = 0;
    this.readLive();
    void this.scan();
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref();
      this.timers.push(t);
    };
    every(2000, () => this.readLive());
    every(5 * 60_000, () => void this.scan());
    every(15_000, () => this.save());
    try {
      // the whole tree, so a transcript that grows is read within a moment
      this.watcher = fs.watch(path.join(this.root, 'projects'), { recursive: true }, (_e, name) => {
        if (!name) return;
        const p = path.join(this.root, 'projects', String(name));
        if (/\.(jsonl|json)$/.test(p)) this.enqueue(p);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // no recursive watching here: poll the files we know are live instead
      every(5000, () => {
        for (const [f, st] of Object.entries(this.files)) if (Date.now() - st.mtime < 3600_000) this.enqueue(f);
      });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watcher?.close();
    this.watcher = undefined;
    this.save();
  }

  /** every transcript, meta and workflow file; the changed ones are queued */
  private async scan(): Promise<void> {
    const base = path.join(this.root, 'projects');
    const found: { p: string; mtime: number }[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      let list: fs.Dirent[];
      try {
        list = await fs.promises.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'memory' || e.name === 'tool-results' || depth > 5) continue;
          await walk(p, depth + 1);
        } else if (/\.jsonl$/.test(e.name) || /\.meta\.json$/.test(e.name) || (/^wf_.*\.json$/.test(e.name) && path.basename(d) === 'workflows')) {
          try {
            const st = await fs.promises.stat(p);
            found.push({ p, mtime: st.mtimeMs });
          } catch {
            // gone
          }
        }
      }
    };
    this.scanning = true;
    try {
      await walk(base, 0);
    } finally {
      this.scanning = false;
    }
    // newest first: what's happening now shows up before last month's backlog
    found.sort((a, b) => b.mtime - a.mtime);
    for (const f of found) this.enqueue(f.p);
    if (!this.queue.length && !this.draining && !this.progress.finishedAt) this.progress.finishedAt = Date.now();
  }

  private enqueue(p: string): void {
    if (this.stopped || this.queued.has(p)) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    const known = this.files[p];
    if (known && known.size === st.size && known.mtime === st.mtimeMs) return;
    if (!known && st.mtimeMs < this.cutoff) {
      // older than we read: start from its end, so only what's added later counts
      this.files[p] = { size: st.size, off: p.endsWith('.jsonl') ? st.size : 0, mtime: st.mtimeMs };
      if (!p.endsWith('.jsonl')) this.queue.push(p);
      else {
        this.dirty = true;
        return;
      }
    } else this.queue.push(p);
    this.queued.add(p);
    if (p.endsWith('.jsonl')) {
      this.progress.files++;
      this.progress.bytes += st.size - (known?.off ?? 0);
    }
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) {
        const p = this.queue.shift()!;
        this.queued.delete(p);
        try {
          if (p.endsWith('.jsonl')) await this.readTranscript(p);
          else if (p.endsWith('.meta.json')) this.readMeta(p);
          else this.readWorkflow(p);
        } catch {
          // a file being written, or not ours: next time
        }
      }
      if (!this.queue.length && !this.scanning && !this.progress.finishedAt) this.progress.finishedAt = Date.now();
    } finally {
      this.draining = false;
    }
  }

  // ── where a file belongs ──
  private whose(p: string): { session: string; agent?: string; workflow?: string } {
    const parts = p.split(path.sep);
    const name = parts[parts.length - 1] ?? '';
    const i = parts.lastIndexOf('subagents');
    if (i < 0) return { session: name.replace(/\.jsonl$/, '') };
    const session = parts[i - 1] ?? '';
    const agent = name.replace(/\.(jsonl|meta\.json)$/, '');
    const workflow = parts[i + 1] === 'workflows' ? parts[i + 2] : undefined;
    return workflow ? { session, agent, workflow } : { session, agent };
  }

  private session(id: string, project = ''): SessionInfo {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, project, cwd: '', branch: '', version: '', title: '', titleRank: 0, prompts: 0, models: {}, ctxMax: 0, ctx: [], agents: {}, workflows: {}, ...noWork() };
      this.sessions.set(id, s);
    }
    return s;
  }

  private agentOf(s: SessionInfo, id: string, workflow?: string, meta?: string): AgentInfo {
    let a = s.agents[id];
    if (!a) {
      a = { id, type: workflow ? 'workflow-subagent' : 'agent', description: '', depth: 1, finished: null, ...noWork() };
      if (workflow) a.workflow = workflow;
      s.agents[id] = a;
      // its meta file says what it is
      if (meta && fs.existsSync(meta)) this.readMeta(meta);
    }
    return a;
  }

  private readMeta(p: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const w = this.whose(p);
    if (!w.agent) return;
    const s = this.session(w.session);
    const a = s.agents[w.agent] ?? this.agentOf(s, w.agent, w.workflow);
    a.type = str(m['agentType']) || a.type;
    a.description = str(m['description']) || a.description;
    a.depth = num(m['spawnDepth']) || a.depth;
    if (typeof m['finished'] === 'boolean') a.finished = m['finished'];
    if (str(m['model'])) a.model = str(m['model']);
    if (str(m['workflowPhase'])) a.phase = str(m['workflowPhase']);
    if (str(m['toolUseId'])) a.toolUseId = str(m['toolUseId']);
    this.dirtySessions.add(s.id);
    try {
      this.files[p] = { size: fs.statSync(p).size, off: 0, mtime: fs.statSync(p).mtimeMs };
    } catch {
      // gone
    }
  }

  private readWorkflow(p: string): void {
    let w: Record<string, unknown>;
    try {
      w = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const parts = p.split(path.sep);
    const sessionId = parts[parts.length - 3] ?? '';
    const s = this.session(sessionId);
    const runId = str(w['runId']) || path.basename(p, '.json');
    const script = str(w['script']);
    const desc = /description:\s*['"`](.*?)['"`]\s*,?\s*$/m.exec(script)?.[1] ?? '';
    const phases = Array.isArray(w['phases']) ? (w['phases'] as unknown[]).map((x) => (x && typeof x === 'object' ? { title: str((x as Record<string, unknown>)['title']), detail: str((x as Record<string, unknown>)['detail']) || undefined } : { title: String(x) })) : [];
    s.workflows[runId] = {
      runId,
      name: str(w['workflowName']) || runId,
      description: desc,
      status: str(w['status']),
      phases: phases.map((x) => (x.detail ? { title: x.title, detail: x.detail } : { title: x.title })),
      agentCount: num(w['agentCount']),
      durationMs: num(w['durationMs']),
      totalTokens: num(w['totalTokens']),
      totalToolCalls: num(w['totalToolCalls']),
      summary: str(w['summary']),
      startTime: num(w['startTime']) || Date.parse(str(w['timestamp'])) || 0,
      file: p,
    };
    this.dirtySessions.add(s.id);
    try {
      const st = fs.statSync(p);
      this.files[p] = { size: st.size, off: 0, mtime: st.mtimeMs };
    } catch {
      // gone
    }
    this.onChange('activity');
  }

  // ── transcripts ──
  private async readTranscript(p: string): Promise<void> {
    const st = await fs.promises.stat(p);
    const state = this.files[p] ?? { size: 0, off: 0, mtime: 0 };
    if (st.size < state.off) state.off = 0; // rewritten
    const w = this.whose(p);
    let fd: fs.promises.FileHandle | undefined;
    try {
      fd = await fs.promises.open(p, 'r');
      const CHUNK = 4 << 20;
      let off = state.off;
      let rest = Buffer.alloc(0);
      while (off < st.size && !this.stopped) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - off));
        const { bytesRead } = await fd.read(buf, 0, buf.length, off);
        if (!bytesRead) break;
        off += bytesRead;
        this.progress.read += bytesRead;
        let data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (let nl = data.indexOf(10, start); nl >= 0; nl = data.indexOf(10, start)) {
          if (nl > start) this.line(p, w, data.toString('utf8', start, nl));
          start = nl + 1;
        }
        rest = Buffer.from(data.subarray(start));
        data = Buffer.alloc(0);
        // let the hub answer requests between chunks
        await new Promise((r) => setImmediate(r));
      }
      // a half-written last line waits for the rest
      state.off = off - rest.length;
      state.size = st.size;
      state.mtime = st.mtimeMs;
      this.files[p] = state;
      this.dirty = true;
      this.progress.done++;
      this.onChange('activity');
    } finally {
      await fd?.close();
    }
  }

  private line(file: string, w: { session: string; agent?: string; workflow?: string }, l: string): void {
    if (SKIP.test(l)) return;
    if (l.startsWith('{"type":')) {
      // titles
      if (l.length > 20000) return;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(l) as Record<string, unknown>;
      } catch {
        return;
      }
      const s = this.session(w.session);
      const set = (title: string, rank: number) => {
        if (!title || w.agent || rank < s.titleRank) return;
        s.title = title.slice(0, 200);
        s.titleRank = rank;
        this.dirtySessions.add(s.id);
      };
      if (o['type'] === 'custom-title') set(str(o['customTitle']), 3);
      else if (o['type'] === 'agent-name') set(str(o['agentName']), 3);
      else if (o['type'] === 'ai-title') set(str(o['aiTitle']) || str(o['title']), 2);
      else if (o['type'] === 'last-prompt' && s.titleRank <= 1) set(str(o['lastPrompt']), 1);
      return;
    }
    const isAssistant = l.includes('"type":"assistant"');
    if (isAssistant) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(l) as Record<string, unknown>;
      } catch {
        return;
      }
      this.assistant(file, w, o);
      return;
    }
    if (!l.includes('"type":"user"')) return;
    if (l.includes('"tool_use_id"')) {
      this.results(l);
      return;
    }
    // a prompt from the person (not a meta line or a command's output)
    if (w.agent || l.length > 100_000 || l.includes('"isMeta":true')) return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(l) as Record<string, unknown>;
    } catch {
      return;
    }
    const t = Date.parse(str(o['timestamp']));
    if (!t || t < this.cutoff) return;
    const s = this.session(w.session);
    this.place(s, o);
    s.prompts++;
    this.rrd.add('cl.prompts', t, 1);
    this.dirtySessions.add(s.id);
  }

  /** the session's folder, project name, branch and version, from its lines */
  private place(s: SessionInfo, o: Record<string, unknown>): void {
    if (!s.cwd && str(o['cwd'])) {
      s.cwd = str(o['cwd']);
      s.project = path.basename(s.cwd.replace(/[\\/]+$/, '')) || s.cwd;
    }
    if (str(o['gitBranch'])) s.branch = str(o['gitBranch']);
    if (str(o['version'])) s.version = str(o['version']);
  }

  private assistant(file: string, w: { session: string; agent?: string; workflow?: string }, o: Record<string, unknown>): void {
    const t = Date.parse(str(o['timestamp']));
    if (!t) return;
    const msg = (o['message'] ?? {}) as Record<string, unknown>;
    const model = str(msg['model']);
    const s = this.session(w.session);
    this.place(s, o);
    const a = w.agent ? this.agentOf(s, w.agent, w.workflow, file.replace(/\.jsonl$/, '.meta.json')) : undefined;
    const counts = t >= this.cutoff;
    const thread = s.id + '/' + (w.agent ?? '');
    this.threadLast.set(thread, Math.max(this.threadLast.get(thread) ?? 0, t));
    const works: Work[] = a ? [s, a] : [s];
    for (const x of works) {
      x.first = x.first ? Math.min(x.first, t) : t;
      x.last = Math.max(x.last, t);
    }

    // tokens: a reply is several lines with one id; count each id once, taking what each line adds
    const u = msg['usage'] as Record<string, unknown> | undefined;
    if (u && model && model !== '<synthetic>') {
      const cc = (u['cache_creation'] ?? {}) as Record<string, unknown>;
      const details = (u['output_tokens_details'] ?? {}) as Record<string, unknown>;
      const cw1h = num(cc['ephemeral_1h_input_tokens']);
      const cw5 = 'ephemeral_5m_input_tokens' in cc ? num(cc['ephemeral_5m_input_tokens']) : Math.max(0, num(u['cache_creation_input_tokens']) - cw1h);
      const tok: Tok = { in: num(u['input_tokens']), out: num(u['output_tokens']), think: num(details['thinking_tokens']), cread: num(u['cache_read_input_tokens']), cw5, cw1h };
      const fast = str(u['speed']) === 'fast';
      const cost = costOf(model, { input: tok.in, output: tok.out, cacheRead: tok.cread, cacheWrite5m: tok.cw5, cacheWrite1h: tok.cw1h }, fast);
      const id = str(msg['id']) || str(o['uuid']);
      const prev = this.last.get(file);
      const same = prev && prev.id === id;
      const add: Tok = noTok();
      for (const k of KEYS) add[k] = Math.max(0, tok[k] - (same ? prev.tok[k] : 0));
      const addCost = Math.max(0, cost - (same ? prev.cost : 0));
      this.last.set(file, { id, tok: same ? maxTok(prev.tok, tok) : tok, cost: same ? Math.max(prev.cost, cost) : cost });
      const all = add.in + add.out + add.cread + add.cw5 + add.cw1h;
      for (const x of works) {
        for (const k of KEYS) x.tok[k] += add[k];
        x.cost += addCost;
        if (!same) x.turns++;
        x.model = model;
      }
      const m = (s.models[model] ??= { tok: 0, cost: 0 });
      m.tok += all;
      m.cost += addCost;
      if (counts) {
        this.rrd.add('cl.in', t, add.in);
        this.rrd.add('cl.out', t, add.out);
        this.rrd.add('cl.think', t, add.think);
        this.rrd.add('cl.cread', t, add.cread);
        this.rrd.add('cl.cw5', t, add.cw5);
        this.rrd.add('cl.cw1h', t, add.cw1h);
        this.rrd.add('cl.cost', t, addCost);
        this.rrd.add(`cl.m.${model}.tok`, t, all);
        this.rrd.add(`cl.m.${model}.cost`, t, addCost);
        if (s.project) {
          this.rrd.add(`cl.p.${s.project}.tok`, t, all);
          this.rrd.add(`cl.p.${s.project}.cost`, t, addCost);
        }
        this.rrd.add('cl.web', t, Math.max(0, num((u['server_tool_use'] as Record<string, unknown> | undefined)?.['web_search_requests'])));
      }
      if (!same) {
        // how full the window was for this reply
        const ctx = tok.in + tok.cread + tok.cw5 + tok.cw1h;
        if (counts) {
          this.rrd.add('cl.turns', t, 1);
          this.rrd.add('cl.ctx', t, ctx);
          if (w.agent) this.rrd.add('cl.turns.agents', t, 1);
        }
        if (!w.agent) {
          s.ctxMax = Math.max(s.ctxMax, ctx);
          s.ctx.push([t, ctx]);
          if (s.ctx.length > 400) s.ctx.splice(0, s.ctx.length - 400);
        }
      }
    }

    // tool calls start here; their results come in a later line
    const content = Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : [];
    for (const c of content) {
      if (c?.['type'] !== 'tool_use') continue;
      const name = str(c['name']) || '?';
      const summary = summarise(name, c['input']);
      const entry: { name: string; t: number; session: string; agent?: string; summary: string } = { name, t, session: s.id, summary };
      if (w.agent) entry.agent = w.agent;
      this.pending.set(str(c['id']), entry);
      for (const x of works) {
        x.tools++;
        x.toolsBy[name] = (x.toolsBy[name] ?? 0) + 1;
      }
      if (counts) {
        this.rrd.add('cl.tools', t, 1);
        this.rrd.add(`cl.t.${name}`, t, 1);
      }
    }
    if (this.pending.size > 5000) {
      const old = Date.now() - 6 * 3600_000;
      for (const [k, v] of this.pending) if (v.t < old) this.pending.delete(k);
    }
    this.dirtySessions.add(s.id);
  }

  /** tool results: how long each call took, and whether it failed */
  private results(l: string): void {
    let t = 0;
    let list: { id: string; err: boolean }[] = [];
    if (l.length < 300_000) {
      try {
        const o = JSON.parse(l) as Record<string, unknown>;
        t = Date.parse(str(o['timestamp']));
        const content = ((o['message'] ?? {}) as Record<string, unknown>)['content'];
        if (Array.isArray(content))
          list = (content as Record<string, unknown>[]).filter((c) => c?.['type'] === 'tool_result').map((c) => ({ id: str(c['tool_use_id']), err: c['is_error'] === true }));
      } catch {
        return;
      }
    } else {
      // a huge result (a long file, a big command's output): pick out what we need without parsing it all
      const ids = [...l.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1] ?? '');
      const err = ids.length === 1 && /"is_error":true/.test(l);
      list = ids.map((id) => ({ id, err }));
      const ts = [...l.slice(-2000).matchAll(/"timestamp":"([^"]+)"/g)].pop()?.[1];
      t = Date.parse(ts ?? '');
    }
    if (!t) return;
    for (const r of list) {
      const p = this.pending.get(r.id);
      if (!p) continue;
      this.pending.delete(r.id);
      const ms = Math.max(0, t - p.t);
      const s = this.sessions.get(p.session);
      if (r.err && s) {
        s.toolErr++;
        const a = p.agent ? s.agents[p.agent] : undefined;
        if (a) a.toolErr++;
      }
      if (t < this.cutoff) continue;
      if (r.err) this.rrd.add('cl.toolerr', t, 1);
      const day = (this.tools[dayOf(p.t)] ??= {});
      const stat = (day[p.name] ??= { n: 0, err: 0, ms: 0, max: 0, hist: [] });
      stat.n++;
      if (r.err) stat.err++;
      stat.ms += ms;
      stat.hist[bucketOf(ms)] = (stat.hist[bucketOf(ms)] ?? 0) + 1;
      if (ms > stat.max) {
        stat.max = ms;
        stat.maxRef = { session: p.session, summary: p.summary, t: p.t, ...(p.agent ? { agent: p.agent } : {}) };
      }
      const call: ToolCall = { t: p.t, name: p.name, ms, err: r.err, session: p.session, summary: p.summary };
      if (p.agent) call.agent = p.agent;
      this.pushRecent(call);
      this.dirty = true;
    }
  }

  private pushRecent(c: ToolCall): void {
    // kept in time order; the backlog arrives newest file first, so most land near the end
    let i = this.recent.length;
    while (i > 0 && this.recent[i - 1]!.t > c.t) i--;
    if (i === 0 && this.recent.length >= 300) return;
    this.recent.splice(i, 0, c);
    if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
  }

  // ── the sessions running now ──
  private readLive(): void {
    const dir = path.join(this.root, 'sessions');
    const out: LiveSession[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      names = [];
    }
    for (const f of names) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
        const pid = num(o['pid']);
        if (!pid || !alive(pid)) continue;
        out.push({
          pid,
          sessionId: str(o['sessionId']),
          name: str(o['name']),
          cwd: str(o['cwd']),
          status: str(o['status']) || 'unknown',
          kind: str(o['kind']),
          entrypoint: str(o['entrypoint']),
          version: str(o['version']),
          startedAt: num(o['startedAt']),
          updatedAt: num(o['statusUpdatedAt']) || num(o['updatedAt']),
        });
      } catch {
        // being written
      }
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    const before = JSON.stringify(this.live.map((x) => [x.pid, x.status]));
    this.live = out;
    if (JSON.stringify(out.map((x) => [x.pid, x.status])) !== before) this.onChange('live');
  }

  // ── what the page asks for ──
  /** tool calls still waiting for their result (running now, if their session is live) */
  running(): ToolCall[] {
    const liveIds = new Set(this.live.map((l) => l.sessionId));
    const now = Date.now();
    return [...this.pending.values()]
      .filter((p) => liveIds.has(p.session) && now - p.t < 3 * 3600_000 && p.t >= (this.threadLast.get(p.session + '/' + (p.agent ?? '')) ?? 0))
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ t: p.t, name: p.name, ms: null, err: false, session: p.session, summary: p.summary, ...(p.agent ? { agent: p.agent } : {}) }));
  }

  recentCalls(n = 100): ToolCall[] {
    return this.recent.slice(-n).reverse();
  }

  /** each tool over the days in range: calls, errors, median, 95th percentile, slowest */
  toolStats(range: number): { name: string; n: number; err: number; avg: number; p50: number; p95: number; max: number; maxRef?: ToolStat['maxRef'] }[] {
    const from = dayOf(Date.now() - range * 1000);
    const merged: Record<string, ToolStat> = {};
    for (const [d, tools] of Object.entries(this.tools)) {
      if (d < from) continue;
      for (const [name, st] of Object.entries(tools)) {
        const m = (merged[name] ??= { n: 0, err: 0, ms: 0, max: 0, hist: [] });
        m.n += st.n;
        m.err += st.err;
        m.ms += st.ms;
        st.hist.forEach((v, i) => (m.hist[i] = (m.hist[i] ?? 0) + (v ?? 0)));
        if (st.max > m.max) {
          m.max = st.max;
          if (st.maxRef) m.maxRef = st.maxRef;
        }
      }
    }
    const pct = (h: number[], n: number, q: number) => {
      let c = 0;
      for (let i = 0; i < BUCKETS; i++) {
        c += h[i] ?? 0;
        if (c >= n * q) return Math.round(bucketMs(i));
      }
      return 0;
    };
    return Object.entries(merged)
      .map(([name, m]) => ({ name, n: m.n, err: m.err, avg: m.n ? Math.round(m.ms / m.n) : 0, p50: pct(m.hist, m.n, 0.5), p95: pct(m.hist, m.n, 0.95), max: m.max, ...(m.maxRef ? { maxRef: m.maxRef } : {}) }))
      .sort((a, b) => b.n - a.n);
  }

  /** sessions active in the range, newest first, without their per-turn detail */
  list(range: number, limit = 200): Omit<SessionInfo, 'ctx' | 'agents' | 'workflows'>[] {
    const from = Date.now() - range * 1000;
    return [...this.sessions.values()]
      .filter((s) => s.last >= from)
      .sort((a, b) => b.last - a.last)
      .slice(0, limit)
      .map((s) => {
        const { ctx: _c, agents, workflows, ...rest } = s;
        return { ...rest, agentCount: Object.keys(agents).length, workflowCount: Object.keys(workflows).length };
      });
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  /** a workflow run's script and result, read from its file when asked */
  workflow(session: string, runId: string): Record<string, unknown> | undefined {
    const w = this.sessions.get(session)?.workflows[runId];
    if (!w) return undefined;
    try {
      const o = JSON.parse(fs.readFileSync(w.file, 'utf8')) as Record<string, unknown>;
      return { ...w, script: str(o['script']), result: o['result'], logs: o['logs'], progress: o['workflowProgress'], defaultModel: str(o['defaultModel']) };
    } catch {
      return { ...w };
    }
  }

  counts(): { sessions: number; files: number } {
    return { sessions: this.sessions.size, files: Object.keys(this.files).length };
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
const maxTok = (a: Tok, b: Tok): Tok => ({ in: Math.max(a.in, b.in), out: Math.max(a.out, b.out), think: Math.max(a.think, b.think), cread: Math.max(a.cread, b.cread), cw5: Math.max(a.cw5, b.cw5), cw1h: Math.max(a.cw1h, b.cw1h) });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** a few words on what a tool call did: the command, the file, the pattern */
function summarise(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill', 'subject', 'title', 'set', 'message'];
  for (const k of pick) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) return clip(k === 'file_path' || k === 'path' ? v.replace(/^.*?([^\\/]+[\\/][^\\/]+)$/, '…/$1') : v);
  }
  const s = JSON.stringify(i);
  return s && s !== '{}' ? clip(s) : name;
}
const clip = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 140 ? one.slice(0, 139) + '…' : one;
};
