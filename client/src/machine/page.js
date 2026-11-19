// The machine dashboard: this computer and its Claude Code sessions.
//   #/machine?r=1d                 everything, over a range (1h, 6h, 1d, 7d, 30d, 1y)
//   #/machine/s/<session>?r=…      one session: its agents and workflows, context per turn, tools
// Off until it's turned on; then live while the page is open (a sample a second), history from the hub's
// round-robin files.
import { $, api, esc, ago, toast, store } from '../util.js';
import { showChat } from './chat.js';
import { icon } from '../icons.js';
import { COLORS, fmt, points, timeChart, columns, barList, meter, heatmap, sparkline, hideTip } from './charts.js';

const RANGES = { '1h': 3600, '6h': 21600, '1d': 86400, '7d': 604800, '30d': 2592000, '1y': 31536000 };
const RANGE_NAMES = { '1h': 'hour', '6h': '6 hours', '1d': 'day', '7d': 'week', '30d': '30 days', '1y': 'year' };

const view = {
  el: null,
  range: '1d',
  session: '',
  status: null,
  now: null,
  series: {},
  claude: null,
  detail: null,
  /** chart renderers by element id, run again when the page resizes */
  renders: new Map(),
  timers: [],
  procSort: 'cpu',
  loadedAt: 0,
};

const rangeSec = () => RANGES[view.range] || 86400;
const hubApi = (u, o = {}) => api(u, { ...o, hub: true });

/** a conversation: the session's own, or one of its agents' */
export function chatHref(session, agent = '') {
  return `#/machine/s/${encodeURIComponent(session)}/${agent ? 'a/' + encodeURIComponent(agent) : 'c'}`;
}

export function machineHref(range = view.range, session = '') {
  return `#/machine${session ? '/s/' + encodeURIComponent(session) : ''}${range && range !== '1d' ? '?r=' + range : ''}`;
}

/** draw the page (or a session) at the address */
export async function showMachine(el, { range, session, chat, agent }) {
  const again = view.el === el && view.session === (session || '') && view.chat === (chat || '') && view.agent === (agent || '');
  view.el = el;
  view.range = RANGES[range] ? range : '1d';
  view.session = session || '';
  view.chat = chat || '';
  view.agent = agent || '';
  if (!again) {
    view.series = {};
    view.claude = null;
    view.detail = null;
  }
  document.title = `${chat ? 'Conversation' : session ? 'Session' : 'This computer'} · hitl`;
  startTimers();
  await load();
}

export function leaveMachine() {
  for (const t of view.timers) clearInterval(t);
  view.timers = [];
  view.renders.clear();
  view.el = null;
  hideTip();
}

/** a live event from the hub: a sample a second, or "something changed" */
export function machineEvent(d) {
  if (!view.el) return;
  if (d.kind === 'sample') return liveSample(d.sample);
  if (d.kind === 'state') return void load();
  if (d.kind === 'activity' || d.kind === 'live') soonClaude();
}

let claudeTimer = 0;
let lastClaude = 0;
function soonClaude() {
  clearTimeout(claudeTimer);
  const wait = Math.max(0, 4000 - (Date.now() - lastClaude));
  claudeTimer = setTimeout(() => void refreshClaude(), wait);
}

function startTimers() {
  for (const t of view.timers) clearInterval(t);
  const beat = () => document.visibilityState === 'visible' && view.status?.running && hubApi('api/machine/watch', { method: 'POST', json: {} }).catch(() => undefined);
  beat();
  view.timers = [
    setInterval(beat, 10_000),
    setInterval(() => document.visibilityState === 'visible' && view.status?.running && void refreshNow(), 3000),
    setInterval(() => document.visibilityState === 'visible' && view.status?.running && void refreshSeries(), view.range === '1h' ? 60_000 : 30_000),
  ];
}

// ── loading ──
async function load() {
  try {
    view.status = await hubApi('api/machine');
  } catch (e) {
    view.el.innerHTML = `<div class="page-wrap"><div class="empty"><h2>Can't reach the dashboard</h2><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  if (!view.status.on || !view.status.running) return paintOff();
  if (view.chat) {
    await Promise.all([refreshNow(false), loadDetail()]);
    const s = view.detail;
    const a = view.agent ? s?.agents?.[view.agent] : null;
    const title = view.agent ? a?.description || view.agent : 'Main conversation';
    const sub = `<a href="${machineHref(view.range, view.session)}">${esc(s?.title || view.session.slice(0, 8))}</a>${a ? ' · ' + esc(a.type) + (a.model ? ' · ' + esc(a.model.replace(/^claude-/, '')) : '') : ''}`;
    view.el.innerHTML = `<div class="page-wrap mach">${head(title, sub)}<div id="m-chat"></div></div>`;
    $('m-pause').addEventListener('click', (e) => pauseMenu(e.currentTarget));
    return showChat($('m-chat'), { session: view.session, agent: view.agent });
  }
  if (view.session) {
    await Promise.all([refreshNow(false), loadDetail()]);
    return paintSession();
  }
  await Promise.all([refreshNow(false), refreshSeries(false), refreshClaude(false)]);
  paint();
}

async function refreshNow(redraw = true) {
  try {
    view.now = await hubApi('api/machine/now');
    view.status = view.now.status;
  } catch {
    return;
  }
  if (redraw && view.el && !view.chat) {
    if (view.session) paintSessionLive();
    else paintNow();
  }
}

const SYSTEM_SERIES = ['sys.cpu', 'sys.mem', 'sys.cpu.*', 'sys.net.*', 'sys.disk.read', 'sys.disk.write', 'sys.gpu.*', 'sys.free.*', 'proc.claude.cpu', 'proc.claude.mem', 'proc.claude.n', 'proc.node.cpu', 'proc.node.mem', 'proc.node.n', 'proc.count'];
const CLAUDE_SERIES = ['cl.in', 'cl.out', 'cl.think', 'cl.cread', 'cl.cw5', 'cl.cw1h', 'cl.cost', 'cl.turns', 'cl.turns.agents', 'cl.tools', 'cl.toolerr', 'cl.ctx', 'cl.prompts', 'cl.t.*'];

async function refreshSeries(redraw = true) {
  if (view.session) return;
  try {
    const r = await hubApi(`api/machine/series?range=${rangeSec()}&n=${encodeURIComponent([...SYSTEM_SERIES, ...CLAUDE_SERIES].join(','))}`);
    view.series = r.series;
    view.loadedAt = r.now;
    // the busiest hours of the week always look at 30 days
    if (!view.heat || Date.now() - view.heat.at > 10 * 60_000) {
      const h = await hubApi(`api/machine/series?range=${RANGES['30d']}&n=cl.turns,cl.prompts`);
      view.heat = { at: Date.now(), turns: h.series['cl.turns'], prompts: h.series['cl.prompts'] };
    }
  } catch {
    return;
  }
  if (redraw && view.el && !view.session) paintCharts();
}

async function refreshClaude(redraw = true) {
  if (view.chat) return;
  if (view.session) return loadDetail().then(() => redraw && paintSession());
  lastClaude = Date.now();
  try {
    view.claude = await hubApi(`api/machine/claude?range=${rangeSec()}`);
  } catch {
    return;
  }
  if (redraw && view.el) paintClaude();
}

async function loadDetail() {
  try {
    view.detail = await hubApi(`api/machine/session/${encodeURIComponent(view.session)}`);
  } catch (e) {
    view.detail = { error: e.message };
  }
}

// ── live samples (one a second while the page is open) ──
function liveSample(s) {
  if (!view.now || view.chat) return;
  view.now.sample = s;
  if (view.session) return;
  paintNowTiles();
  if (view.range !== '1h') return;
  // the last hour: add the second's sample to the graphs as it arrives
  const add = (name, v) => {
    if (!Number.isFinite(v)) return;
    const r = (view.liveExtra ??= {})[name] ?? (view.liveExtra[name] = []);
    r.push([s.t, v]);
    const from = Date.now() - 3600_000;
    while (r.length && r[0][0] < from) r.shift();
  };
  add('sys.cpu', s.cpu.total);
  s.cpu.cores.forEach((c, i) => add(`sys.cpu.${i}`, c));
  add('sys.mem', s.mem.used);
  for (const [a, v] of Object.entries(s.net)) {
    add(`sys.net.${a}.rx`, v.rx);
    add(`sys.net.${a}.tx`, v.tx);
  }
  if (s.disk) {
    add('sys.disk.read', s.disk.read);
    add('sys.disk.write', s.disk.write);
  }
  for (const g of s.gpus) {
    add(`sys.gpu.${g.index}.util`, g.util);
    add(`sys.gpu.${g.index}.mem`, g.memUsed);
    add(`sys.gpu.${g.index}.temp`, g.temp);
    add(`sys.gpu.${g.index}.power`, g.power);
  }
  for (const id of ['c-cpu', 'c-mem', 'c-net', 'c-disk', 'c-gpu', 'c-gpu-heat']) view.renders.get(id)?.();
}

/** a series' points over the range, with the live seconds after the last stored point */
function pts(name, k = 'v') {
  const base = points(view.series[name], k);
  const extra = view.range === '1h' && k === 'v' ? (view.liveExtra?.[name] ?? []) : [];
  if (!extra.length) return base;
  const last = base.filter((p) => p[1] !== null).at(-1)?.[0] ?? 0;
  return [...base.filter((p) => p[0] <= last), ...extra.filter((p) => p[0] > last)];
}
const span = () => {
  const to = Date.now();
  return { from: to - rangeSec() * 1000, to };
};

// ── the page ──
function head(title, sub) {
  const st = view.status;
  const p = st.paused;
  const pill = !st.on ? '<span class="pill">Off</span>' : p ? `<span class="pill warn">${icon('clock', 14)}Paused${p.until ? ' until ' + new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : p.kind === 'restart' ? ' until the hub restarts' : ''}</span>` : '<span class="pill ok"><span class="live-dot"></span>Collecting</span>';
  const ranges = Object.keys(RANGES)
    .map((r) => `<a class="seg-btn${r === view.range ? ' on' : ''}" href="${machineHref(r, view.session)}" aria-current="${r === view.range}">${r}</a>`)
    .join('');
  return `<header class="mach-head">
    <div class="mach-title">${view.chat ? `<a class="link-btn" href="${machineHref(view.range, view.session)}">${icon('arrow-left', 16)}Session</a>` : view.session ? `<a class="link-btn" href="${machineHref(view.range)}">${icon('arrow-left', 16)}This computer</a>` : ''}<h1>${esc(title)}</h1><p class="faint">${sub}</p></div>
    <div class="mach-acts">${pill}<button class="btn small" id="m-pause" type="button">${icon(p ? 'refresh' : 'clock', 15)}${p ? 'Resume' : 'Pause'}</button><nav class="seg" aria-label="Time range">${ranges}</nav></div>
  </header>`;
}

function sysLine() {
  const st = view.status;
  const up = fmt.dur(st.uptime * 1000);
  return `${esc(st.hostname)} · ${esc(st.cpu.model)} · ${st.cpu.cores} threads · ${fmt.bytes(st.memTotal)} memory · up ${up}`;
}

function paintOff() {
  const st = view.status;
  const paused = st.on && st.paused;
  view.el.innerHTML = `<div class="page-wrap mach">
    ${paused ? head('This computer', sysLine()) : ''}
    <section class="card mach-off">
      <div class="mach-off-art">${icon('monitor', 40)}</div>
      <h2>${paused ? 'Paused' : 'A dashboard for this computer'}</h2>
      ${
        paused
          ? `<p>Nothing is being collected right now${st.paused.until ? `, until ${esc(new Date(st.paused.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : st.paused.kind === 'restart' ? ', until the hub restarts' : ', until you resume'}. The graphs show a gap for the paused time; Claude Code's transcripts are caught up when you resume.</p>
             <p><button class="btn primary big" id="m-resume" type="button">${icon('refresh', 18)}Resume now</button></p>`
          : `<p>CPU, memory, disks, network, the GPU and the busiest processes, plus every Claude Code session on this computer: the ones running now, tokens and estimated cost over time, every tool call and how long it took, and the subagents and workflows Claude Code doesn't show you.</p>
             <ul class="mach-off-list">
               <li>It reads <code>~/.claude</code> (transcripts, sessions, workflows) and asks Windows, Linux or macOS for its numbers. Nothing is installed in your projects and nothing leaves this computer.</li>
               <li>It keeps fixed-size round-robin files in <code>${esc(st.dir)}</code>: 5-second detail for an hour, minutes for 2 days, 10 minutes for a month, hours for 2 years. They never grow.</li>
               <li>The first time, it reads the last 30 days of transcripts (a minute or two). Pause it any time, or turn it off in Settings.</li>
             </ul>
             <p><button class="btn primary big" id="m-on" type="button">${icon('check', 18)}Turn it on</button></p>`
      }
    </section></div>`;
  $('m-on')?.addEventListener('click', () => setState({ on: true }));
  $('m-resume')?.addEventListener('click', () => setState({ pause: 'off' }));
  $('m-pause')?.addEventListener('click', (e) => pauseMenu(e.currentTarget));
}

async function setState(json) {
  try {
    view.status = await hubApi('api/machine', { method: 'POST', json });
    toast(json.on === true ? 'Collecting' : json.on === false ? 'Turned off' : json.pause === 'off' ? 'Collecting again' : 'Paused');
  } catch (e) {
    toast(e.message);
  }
  await load();
}

export function pauseMenu(anchor) {
  const old = $('m-pause-menu');
  if (old) return old.remove();
  const st = view.status || {};
  const pop = document.createElement('div');
  pop.id = 'm-pause-menu';
  pop.className = 'pop menu';
  const item = (act, ic, label, sub) => `<button class="menu-item" type="button" data-act="${act}"><span class="menu-ic">${icon(ic, 16)}</span><span class="grow">${label}${sub ? `<small class="faint">${sub}</small>` : ''}</span></button>`;
  pop.innerHTML = st.paused
    ? item('off', 'refresh', 'Resume now') + '<div class="menu-sep"></div>' + item('turn-off', 'x', 'Turn the dashboard off', 'Stops collecting; keeps what it has')
    : item('1h', 'clock', 'Pause for an hour') + item('restart', 'refresh', 'Pause until the hub restarts') + item('resume', 'clock', 'Pause until I resume') + '<div class="menu-sep"></div>' + item('turn-off', 'x', 'Turn the dashboard off', 'Stops collecting; keeps what it has');
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 290)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  document.body.append(pop);
  pop.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    pop.remove();
    void setState(b.dataset.act === 'turn-off' ? { on: false } : { pause: b.dataset.act });
  };
  setTimeout(() => {
    const away = (e) => {
      if (!pop.isConnected) return removeEventListener('pointerdown', away, true);
      if (pop.contains(e.target) || e.target === anchor) return;
      pop.remove();
      removeEventListener('pointerdown', away, true);
    };
    addEventListener('pointerdown', away, true);
  });
}

function paint() {
  const st = view.status;
  view.renders.clear();
  view.el.innerHTML = `<div class="page-wrap mach">
    ${head('This computer', sysLine())}
    ${progressNote()}
    <nav class="mach-nav" aria-label="Sections">${[
      ['m-sys', 'System'],
      ['m-procs', 'Processes'],
      ['m-claude', 'Claude Code'],
      ['m-tools', 'Tools'],
      ['m-sessions', 'Sessions'],
    ]
      .map(([id, l]) => `<button type="button" class="mach-nav-btn" data-go="${id}">${l}</button>`)
      .join('')}</nav>
    <section class="mach-tiles" id="m-now"></section>

    <h2 class="mach-h" id="m-sys">${icon('monitor', 18)}System <small class="faint">over the last ${RANGE_NAMES[view.range]}</small></h2>
    <div class="mach-grid">
      ${card('c-cpu', 'CPU', 'All cores, average and busiest moment')}
      ${card('c-cores', 'CPU per core', 'Each thread; the stronger the colour, the busier')}
      ${card('c-mem', 'Memory', `In use, of ${fmt.bytes(st.memTotal)}`)}
      ${st.have?.gpu ? card('c-gpu', 'GPU', 'Use and memory') : ''}
      ${st.have?.gpu ? card('c-gpu-heat', 'GPU heat and power', '') : ''}
      ${st.have?.net ? card('c-net', 'Network', 'Down and up, per adapter') : ''}
      ${st.have?.disk ? card('c-disk', 'Disk activity', 'Read and write, all disks') : ''}
      ${card('c-drives', 'Drives', 'Space used', 'html')}
    </div>

    <h2 class="mach-h" id="m-procs">${icon('cards', 18)}Processes</h2>
    <div class="mach-grid">
      ${card('c-pcpu', 'Claude and Node: CPU', '% of one core, every process with that name added up')}
      ${card('c-pmem', 'Claude and Node: memory', 'Every process with that name added up')}
      <section class="card mach-card wide"><div class="mach-card-head"><h3>Busiest now</h3><span class="seg"><button class="seg-btn${view.procSort === 'cpu' ? ' on' : ''}" data-sort="cpu" type="button">CPU</button><button class="seg-btn${view.procSort === 'mem' ? ' on' : ''}" data-sort="mem" type="button">Memory</button></span></div><div id="c-top"></div></section>
    </div>

    <h2 class="mach-h" id="m-claude">${icon('sparkles', 18)}Claude Code <small class="faint">over the last ${RANGE_NAMES[view.range]}</small></h2>
    <section class="mach-tiles" id="m-ctiles"></section>
    <div class="mach-grid">
      <section class="card mach-card wide"><div class="mach-card-head"><h3>Running now</h3><span class="faint small" id="m-live-n"></span></div><div id="c-live"></div></section>
      ${card('c-tok-in', 'Tokens read', 'What each reply was given: cache reads, cache writes, new input')}
      ${card('c-tok-out', 'Tokens written', 'Replies, and the thinking in them')}
      ${card('c-cost', 'Estimated cost', 'At API list prices: an estimate, not your bill')}
      ${card('c-cache', 'Cache hit rate', 'Share of input read from the cache')}
      ${card('c-ctx', 'Context per reply', 'Average size of what a reply was given')}
      ${card('c-turns', 'Replies', 'Main conversations and subagents')}
      <section class="card mach-card"><div class="mach-card-head"><h3>By model</h3><span class="faint small">tokens · est. cost</span></div><div id="c-models"></div></section>
      <section class="card mach-card"><div class="mach-card-head"><h3>By project</h3><span class="faint small">tokens · est. cost</span></div><div id="c-projects"></div></section>
      <section class="card mach-card wide"><div class="mach-card-head"><h3>When you work</h3><span class="faint small">replies per hour, the last 30 days</span></div><div id="c-heat"></div></section>
    </div>

    <h2 class="mach-h" id="m-tools">${icon('settings', 18)}Tools</h2>
    <div class="mach-grid">
      ${card('c-tcalls', 'Tool calls', 'The busiest tools')}
      <section class="card mach-card"><div class="mach-card-head"><h3>Running tool calls</h3></div><div id="c-running"></div></section>
      <section class="card mach-card wide"><div class="mach-card-head"><h3>Every tool</h3><span class="faint small">calls, failures, how long they took</span></div><div id="c-tools"></div></section>
      <section class="card mach-card wide"><div class="mach-card-head"><h3>Latest tool calls</h3></div><div id="c-recent"></div></section>
    </div>

    <h2 class="mach-h" id="m-sessions">${icon('chat', 18)}Sessions <small class="faint">active in the last ${RANGE_NAMES[view.range]}</small></h2>
    <section class="card" id="c-sessions"></section>
    <p class="faint small mach-foot">Collected since ${esc(new Date(st.since).toLocaleString())} · ${fmt.bytes(st.bytes)} in <code>${esc(st.dir)}</code> · cost is estimated from API list prices and the tokens in your transcripts.</p>
  </div>`;
  view.el.querySelector('.mach-nav').onclick = (e) => {
    const b = e.target.closest('[data-go]');
    if (b) $(b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  view.el.querySelector('[data-sort]')?.parentElement.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    view.procSort = b.dataset.sort;
    for (const x of b.parentElement.children) x.classList.toggle('on', x === b);
    paintTop();
  });
  $('m-pause').addEventListener('click', (e) => pauseMenu(e.currentTarget));
  paintNow();
  paintCharts();
  paintClaude();
}

function card(id, title, sub) {
  return `<section class="card mach-card"><div class="mach-card-head"><h3>${esc(title)}</h3>${sub ? `<span class="faint small">${esc(sub)}</span>` : ''}</div><div class="mach-chart" id="${id}"></div></section>`;
}

function progressNote() {
  const p = view.status.claude?.progress;
  if (!view.status.claude) return '';
  if (!view.status.claude.found) return `<p class="mach-note">${icon('warning', 16)}No Claude Code folder at <code>${esc(view.status.claude.home)}</code>: the Claude sections stay empty.</p>`;
  if (!p || p.finishedAt || !p.bytes) return '';
  const pct = Math.min(100, (p.read / p.bytes) * 100);
  return `<div class="mach-note" id="m-progress">${icon('clock', 16)}<span>Reading Claude Code's transcripts: ${fmt.bytes(p.read)} of ${fmt.bytes(p.bytes)} (${p.done} of ${p.files} files). The Claude graphs fill in as it goes.</span>${meter(pct, 100, 'Reading')}</div>`;
}

const tile = (label, value, sub = '', spark = '', title = '') => `<div class="mach-tile"${title ? ` title="${esc(title)}"` : ''}><span class="mach-tile-top"><span class="mach-tile-label">${esc(label)}</span>${spark}</span><b class="mach-tile-value">${value}</b>${sub ? `<span class="mach-tile-sub">${sub}</span>` : ''}</div>`;

function paintNow() {
  paintNowTiles();
  paintTop();
  paintLive();
  paintRunning();
  const pr = $('m-progress');
  if (pr) {
    const p = view.status.claude?.progress;
    if (p?.finishedAt) pr.remove();
    else pr.outerHTML = progressNote();
  }
}

function paintNowTiles() {
  const el = $('m-now');
  const s = view.now?.sample;
  if (!el || !s) return;
  const net = Object.values(s.net).reduce((a, v) => ({ rx: a.rx + v.rx, tx: a.tx + v.tx }), { rx: 0, tx: 0 });
  const g = s.gpus[0];
  const live = view.now.live || [];
  const busy = live.filter((l) => l.status === 'busy').length;
  const cpuSpark = sparkline(pts('sys.cpu').slice(-60).map((p) => p[1]), { max: 100, width: 72, height: 18 });
  const memSpark = sparkline(pts('sys.mem').slice(-60).map((p) => p[1]), { max: s.mem.total, color: 'var(--s3)', width: 72, height: 18 });
  el.innerHTML = [
    tile('CPU', fmt.pct(s.cpu.total), `${s.cpu.cores.filter((c) => c > 50).length} of ${s.cpu.cores.length} threads over half busy`, cpuSpark),
    tile('Memory', fmt.bytes(s.mem.used), `of ${fmt.bytes(s.mem.total)} · ${fmt.pct((s.mem.used / s.mem.total) * 100)}`, memSpark),
    g ? tile('GPU', fmt.pct(g.util), `${fmt.bytes(g.memUsed)} of ${fmt.bytes(g.memTotal)} · ${fmt.temp(g.temp)} · ${fmt.watts(g.power)}`, '', g.name) : '',
    view.status.have?.net ? tile('Network', `↓ ${fmt.rate(net.rx)}`, `↑ ${fmt.rate(net.tx)}`) : '',
    s.disk ? tile('Disk', `${fmt.rate(s.disk.read + s.disk.write)}`, `read ${fmt.rate(s.disk.read)} · write ${fmt.rate(s.disk.write)}`) : '',
    s.procs ? tile('Processes', fmt.num(s.procs.count), Object.entries(s.procs.groups).map(([k, v]) => `${v.n} ${k}`).join(' · ')) : '',
    tile('Claude sessions', String(live.length), live.length ? `${busy} working · ${live.length - busy} waiting` : 'none running'),
  ].join('');
}

function paintTop() {
  const el = $('c-top');
  const p = view.now?.sample?.procs;
  if (!el) return;
  if (!p) return void (el.innerHTML = '<p class="viz-none">Looking…</p>');
  const list = view.procSort === 'mem' ? p.topMem : p.top;
  el.innerHTML = `<div class="mach-table-wrap"><table class="mach-table"><thead><tr><th>Process</th><th class="n">PID</th><th class="n">CPU</th><th class="n">Memory</th></tr></thead><tbody>${list
    .slice(0, 12)
    .map((x) => `<tr><td>${esc(x.name)}</td><td class="n faint">${x.pid}</td><td class="n">${fmt.pct(x.cpu)}</td><td class="n">${fmt.bytes(x.mem)}</td></tr>`)
    .join('')}</tbody></table></div><p class="faint small">CPU is % of one core (a process can pass 100%). ${p.count} processes.</p>`;
}

function paintLive() {
  const el = $('c-live');
  if (!el) return;
  const live = view.now?.live || [];
  $('m-live-n').textContent = live.length ? `${live.length} session${live.length === 1 ? '' : 's'}` : '';
  if (!live.length) return void (el.innerHTML = '<p class="viz-none">No Claude Code sessions are running.</p>');
  el.innerHTML = `<div class="mach-table-wrap"><table class="mach-table mach-live"><thead><tr><th>Session</th><th>Status</th><th class="n">Running for</th><th class="n">Context</th><th class="n">Tokens</th><th class="n">Est. cost</th><th class="n">CPU · memory</th></tr></thead><tbody>${live
    .map((l) => {
      const tok = l.tok ? l.tok.in + l.tok.out + l.tok.cread + l.tok.cw5 + l.tok.cw1h : 0;
      const extra = [l.agentsRunning ? `${l.agentsRunning} agent${l.agentsRunning === 1 ? '' : 's'}` : '', l.workflowsRunning ? `${l.workflowsRunning} workflow${l.workflowsRunning === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      return `<tr><td><a href="${machineHref(view.range, l.sessionId)}"><b>${esc(l.title || l.name || l.sessionId.slice(0, 8))}</b></a><small class="faint">${esc(l.project)}${l.name && l.title ? ' · ' + esc(l.name) : ''}${l.model ? ' · ' + esc(l.model.replace(/^claude-/, '')) : ''}</small></td><td><span class="mach-status ${l.status === 'busy' ? 'busy' : ''}">${l.status === 'busy' ? 'Working' : l.status === 'idle' ? 'Waiting' : esc(l.status)}</span>${extra ? `<small class="faint">${esc(extra)}</small>` : ''}</td><td class="n">${fmt.dur(Date.now() - l.startedAt)}</td><td class="n">${l.ctx ? fmt.num(l.ctx) : '–'}</td><td class="n">${tok ? fmt.num(tok) : '–'}</td><td class="n">${l.cost ? fmt.usd(l.cost) : '–'}</td><td class="n">${l.proc ? `${fmt.pct(l.proc.cpu)} · ${fmt.bytes(l.proc.mem)}` : '–'}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

function paintRunning() {
  const el = $('c-running');
  if (!el) return;
  const run = view.now?.running || [];
  if (!run.length) return void (el.innerHTML = '<p class="viz-none">No tool call is waiting for its result.</p>');
  el.innerHTML = `<ul class="mach-calls">${run
    .slice(-12)
    .reverse()
    .map((c) => `<li><span class="mach-call-name">${esc(c.name)}</span><span class="mach-call-what" title="${esc(c.summary)}">${esc(c.summary)}</span><span class="mach-call-ms busy">${fmt.dur(Date.now() - c.t)}</span></li>`)
    .join('')}</ul>`;
}

function draw(id, fn) {
  const el = $(id);
  if (!el) return;
  const run = () => {
    const e = $(id);
    if (e) fn(e);
  };
  view.renders.set(id, run);
  run();
}

function paintCharts() {
  const { from, to } = span();
  const st = view.status;
  draw('c-cpu', (el) =>
    timeChart(
      el,
      [
        { name: 'Average', pts: pts('sys.cpu'), area: true },
        { name: 'Busiest moment', pts: pts('sys.cpu', 'max'), color: 'var(--s7)' },
      ].filter((s) => view.range !== '1h' || s.name === 'Average'),
      { from, to, y: fmt.pct, yMax: 100 },
    ),
  );
  draw('c-cores', (el) => {
    const n = st.cpu.cores;
    const per = [...Array(n).keys()].map((i) => pts(`sys.cpu.${i}`));
    const cols = Math.min(48, Math.max(12, Math.floor((el.clientWidth - 50) / 12)));
    const bucket = (rangeSec() * 1000) / cols;
    const rows = per.map((p, i) => ({
      label: `#${i}`,
      cells: [...Array(cols).keys()].map((k) => {
        const a = from + k * bucket;
        const vs = p.filter((q) => q[1] !== null && q[0] >= a && q[0] < a + bucket).map((q) => q[1]);
        const v = vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : 0;
        return { v, tip: vs.length ? `Thread ${i} · ${new Date(a).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}: ${fmt.pct(v)}` : '' };
      }),
    }));
    heatmap(el, rows, [...Array(cols).keys()].map(() => ''), { legend: ['idle', 'busy'] });
  });
  draw('c-mem', (el) => timeChart(el, [{ name: 'In use', pts: pts('sys.mem'), area: true, color: 'var(--s3)' }], { from, to, y: fmt.bytes, yMax: st.memTotal }));
  if (st.have?.gpu) {
    const gpus = Object.keys(view.series)
      .map((k) => /^sys\.gpu\.(\d+)\.util$/.exec(k)?.[1])
      .filter((x) => x !== undefined);
    draw('c-gpu', (el) =>
      timeChart(
        el,
        gpus.map((i, k) => ({ name: gpus.length > 1 ? `GPU ${i}` : 'Use', pts: pts(`sys.gpu.${i}.util`), area: true, color: COLORS[k] })),
        { from, to, y: fmt.pct, yMax: 100 },
      ),
    );
    draw('c-gpu-heat', (el) => timeChart(el, gpus.map((i, k) => ({ name: `Temperature${gpus.length > 1 ? ' ' + i : ''}`, pts: pts(`sys.gpu.${i}.temp`), color: COLORS[(k + 1) % 8] })), { from, to, y: fmt.temp }));
  }
  if (st.have?.net) {
    const adapters = [...new Set(Object.keys(view.series).map((k) => /^sys\.net\.(.+)\.(rx|tx)$/.exec(k)?.[1]).filter(Boolean))];
    // adapters that carried nothing in the range aren't drawn
    const used = adapters.filter((a) => pts(`sys.net.${a}.rx`).some((p) => p[1] > 0) || pts(`sys.net.${a}.tx`).some((p) => p[1] > 0));
    draw('c-net', (el) =>
      timeChart(
        el,
        used.flatMap((a) => [
          { name: `${short(a)} ↓`, pts: pts(`sys.net.${a}.rx`) },
          { name: `${short(a)} ↑`, pts: pts(`sys.net.${a}.tx`) },
        ]),
        { from, to, y: fmt.rate },
      ),
    );
  }
  if (st.have?.disk)
    draw('c-disk', (el) =>
      timeChart(
        el,
        [
          { name: 'Read', pts: pts('sys.disk.read') },
          { name: 'Write', pts: pts('sys.disk.write') },
        ],
        { from, to, y: fmt.rate },
      ),
    );
  draw('c-drives', (el) => {
    const drives = view.now?.sample?.drives || [];
    el.innerHTML = drives.length
      ? `<div class="mach-drives">${drives.map((d) => `<div class="mach-drive"><div class="mach-drive-top"><b>${esc(d.name)}</b><span class="faint">${fmt.bytes(d.total - d.free)} used of ${fmt.bytes(d.total)} · ${fmt.bytes(d.free)} free</span></div>${meter(d.total - d.free, d.total, d.name)}</div>`).join('')}</div>`
      : '<p class="viz-none">Looking…</p>';
  });
  draw('c-pcpu', (el) =>
    timeChart(
      el,
      [
        { name: 'claude', pts: pts('proc.claude.cpu') },
        { name: 'node', pts: pts('proc.node.cpu') },
      ],
      { from, to, y: fmt.pct },
    ),
  );
  draw('c-pmem', (el) =>
    timeChart(
      el,
      [
        { name: 'claude', pts: pts('proc.claude.mem') },
        { name: 'node', pts: pts('proc.node.mem') },
      ],
      { from, to, y: fmt.bytes },
    ),
  );
  // Claude, over time
  draw('c-tok-in', (el) =>
    timeChart(
      el,
      [
        { name: 'Cache reads', pts: pts('cl.cread') },
        { name: 'Cache writes', pts: sum(['cl.cw5', 'cl.cw1h']) },
        { name: 'New input', pts: pts('cl.in') },
      ],
      { from, to, stacked: true, y: fmt.num },
    ),
  );
  draw('c-tok-out', (el) =>
    timeChart(
      el,
      [
        { name: 'Written (all)', pts: pts('cl.out'), area: true },
        { name: 'Of which thinking', pts: pts('cl.think'), color: 'var(--s7)' },
      ],
      { from, to, y: fmt.num },
    ),
  );
  draw('c-cost', (el) => columns(el, [{ name: 'Est. cost', pts: pts('cl.cost') }], { from, to, step: view.series['cl.cost']?.step, y: fmt.usd }));
  draw('c-cache', (el) => {
    const r = pts('cl.cread');
    const all = sum(['cl.cread', 'cl.cw5', 'cl.cw1h', 'cl.in']);
    timeChart(el, [{ name: 'Hit rate', pts: r.map(([t, v], i) => [t, v === null || !all[i]?.[1] ? null : (v / all[i][1]) * 100]), area: true, color: 'var(--s3)' }], { from, to, y: fmt.pct, yMax: 100 });
  });
  draw('c-ctx', (el) => {
    const c = pts('cl.ctx');
    const n = pts('cl.turns');
    timeChart(el, [{ name: 'Average context', pts: c.map(([t, v], i) => [t, v === null || !n[i]?.[1] ? null : v / n[i][1]]), area: true, color: 'var(--s2)' }], { from, to, y: fmt.num });
  });
  draw('c-turns', (el) => {
    const all = pts('cl.turns');
    const ag = pts('cl.turns.agents');
    columns(
      el,
      [
        { name: 'Main conversations', pts: all.map(([t, v], i) => [t, v === null ? null : v - (ag[i]?.[1] ?? 0)]) },
        { name: 'Subagents', pts: ag },
      ],
      { from, to, step: view.series['cl.turns']?.step },
    );
  });
  draw('c-tcalls', (el) => {
    const tools = Object.keys(view.series)
      .filter((k) => k.startsWith('cl.t.'))
      .map((k) => ({ k, n: (view.series[k]?.v || []).reduce((a, b) => a + (b || 0), 0) }))
      .sort((a, b) => b.n - a.n);
    const top = tools.slice(0, 6);
    const rest = tools.slice(6);
    const series = top.map((t) => ({ name: t.k.slice(5), pts: pts(t.k) }));
    if (rest.length) series.push({ name: 'Other', pts: sum(rest.map((r) => r.k)), color: 'var(--text-faint)' });
    columns(el, series, { from, to, step: view.series['cl.tools']?.step });
  });
  draw('c-heat', (el) => {
    const h = view.heat?.turns;
    if (!h) return void (el.innerHTML = '<p class="viz-none">Nothing yet</p>');
    const grid = [...Array(7)].map(() => Array(24).fill(0));
    points(h).forEach(([t, v]) => {
      if (!v) return;
      const d = new Date(t);
      grid[(d.getDay() + 6) % 7][d.getHours()] += v;
    });
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    heatmap(
      el,
      grid.map((row, i) => ({ label: days[i], cells: row.map((v, hr) => ({ v, tip: `${days[i]} ${String(hr).padStart(2, '0')}:00–${String(hr + 1).padStart(2, '0')}:00 · ${fmt.num(v)} replies` })) })),
      [...Array(24).keys()].map((hr) => (hr % 3 ? '' : String(hr).padStart(2, '0'))),
      { legend: ['quiet', 'busy'] },
    );
  });
}

/** several series added together, point by point */
function sum(names) {
  const lists = names.map((n) => pts(n));
  const base = lists.find((l) => l.length) || [];
  return base.map(([t], i) => {
    let s = null;
    for (const l of lists) {
      const v = l[i]?.[1];
      if (v !== null && v !== undefined) s = (s ?? 0) + v;
    }
    return [t, s];
  });
}

const short = (a) => (a.length > 22 ? a.slice(0, 21) + '…' : a);
const tokAll = (t) => (t ? t.in + t.out + t.cread + t.cw5 + t.cw1h : 0);

function paintClaude() {
  const c = view.claude;
  if (!c || !$('m-ctiles')) return;
  const t = c.totals;
  const read = t.in + t.cread + t.cw5 + t.cw1h;
  const all = read + t.out;
  $('m-ctiles').innerHTML = [
    tile('Tokens', fmt.num(all), `${fmt.num(read)} read · ${fmt.num(t.out)} written`),
    tile('Est. cost', fmt.usd(t.cost), 'at API list prices', '', 'An estimate from the tokens in your transcripts and API list prices. A subscription is not billed this way.'),
    tile('Replies', fmt.num(t.turns), `${fmt.pct(t.turns ? (t.agentTurns / t.turns) * 100 : 0)} by subagents`),
    tile('Your prompts', fmt.num(t.prompts), t.prompts ? `${fmt.num(t.turns / t.prompts)} replies each` : ''),
    tile('Tool calls', fmt.num(t.tools), `${fmt.num(t.toolErr)} failed · ${fmt.pct(t.tools ? (t.toolErr / t.tools) * 100 : 0)}`),
    tile('Cache hit rate', fmt.pct(read ? (t.cread / read) * 100 : 0), `${fmt.num(t.cw5 + t.cw1h)} written to the cache`),
    tile('Context per reply', fmt.num(t.turns ? t.ctx / t.turns : 0), 'tokens, on average'),
    tile('Thinking', fmt.num(t.think), `${fmt.pct(t.out ? (t.think / t.out) * 100 : 0)} of what was written`),
  ].join('');
  $('c-models').innerHTML = barList(
    c.models.map((m) => ({ label: m.name.replace(/^claude-/, ''), value: m.tok, sub: fmt.usd(m.cost) })),
    { keys: true, empty: 'No replies in this range' },
  );
  $('c-projects').innerHTML = barList(
    c.projects.slice(0, 12).map((p) => ({ label: p.name, value: p.tok, sub: fmt.usd(p.cost) })),
    { empty: 'No replies in this range' },
  );
  paintTools();
  paintRecent();
  paintSessions();
}

function paintTools() {
  const el = $('c-tools');
  const tools = view.claude?.tools || [];
  if (!el) return;
  if (!tools.length) return void (el.innerHTML = '<p class="viz-none">No tool calls in this range</p>');
  const max = Math.max(...tools.map((t) => t.n));
  el.innerHTML = `<div class="mach-table-wrap"><table class="mach-table"><thead><tr><th>Tool</th><th class="calls">Calls</th><th class="n">Failed</th><th class="n">Median</th><th class="n">95% under</th><th class="n">Slowest</th></tr></thead><tbody>${tools
    .slice(0, 40)
    .map(
      (x) =>
        `<tr><td><b>${esc(x.name)}</b></td><td class="calls"><div class="mach-cell-bar"><span class="viz-bar-track"><span class="viz-bar" style="width:${((x.n / max) * 100).toFixed(1)}%"></span></span><span class="n">${fmt.num(x.n)}</span></div></td><td class="n${x.err ? ' bad' : ' faint'}">${x.err ? `${fmt.num(x.err)} <small>(${fmt.pct((x.err / x.n) * 100)})</small>` : '0'}</td><td class="n">${fmt.ms(x.p50)}</td><td class="n">${fmt.ms(x.p95)}</td><td class="n">${x.maxRef ? `<a href="${machineHref(view.range, x.maxRef.session)}" title="${esc(x.maxRef.summary)}">${fmt.ms(x.max)}</a>` : fmt.ms(x.max)}</td></tr>`,
    )
    .join('')}</tbody></table></div><p class="faint small">Times run from the call to its result, so a call that waited for your permission counts that wait too. Median and 95% are close estimates.</p>`;
}

function paintRecent() {
  const el = $('c-recent');
  const list = view.claude?.recent || [];
  if (!el) return;
  if (!list.length) return void (el.innerHTML = '<p class="viz-none">Nothing yet</p>');
  el.innerHTML = `<ul class="mach-calls">${list
    .slice(0, 30)
    .map(
      (c) =>
        `<li><span class="mach-call-name">${esc(c.name)}</span><a class="mach-call-what" href="${machineHref(view.range, c.session)}" title="${esc(c.summary)}">${esc(c.summary)}</a>${c.agent ? '<span class="badge">agent</span>' : ''}<span class="mach-call-ms${c.err ? ' bad' : ''}">${c.err ? icon('x', 12) : ''}${fmt.ms(c.ms)}</span><span class="faint small mach-call-ago">${esc(ago(c.t))}</span></li>`,
    )
    .join('')}</ul>`;
}

function paintSessions() {
  const el = $('c-sessions');
  const list = view.claude?.sessions || [];
  if (!el) return;
  if (!list.length) return void (el.innerHTML = '<p class="viz-none">No sessions in this range</p>');
  const liveIds = new Set((view.now?.live || []).map((l) => l.sessionId));
  el.innerHTML = `<div class="mach-table-wrap"><table class="mach-table"><thead><tr><th>Session</th><th class="n">Last active</th><th class="n">Replies</th><th class="n">Agents</th><th class="n">Tools</th><th class="n">Tokens</th><th class="n">Est. cost</th></tr></thead><tbody>${list
    .slice(0, 80)
    .map(
      (s) =>
        `<tr><td><a href="${machineHref(view.range, s.id)}"><b>${liveIds.has(s.id) ? '<span class="live-dot"></span>' : ''}${esc(s.title || s.id.slice(0, 8))}</b></a><small class="faint">${esc(s.project || '?')}${s.branch ? ' · ' + esc(s.branch) : ''}${s.model ? ' · ' + esc(s.model.replace(/^claude-/, '')) : ''}</small></td><td class="n">${esc(ago(s.last))}</td><td class="n">${fmt.num(s.turns)}</td><td class="n">${s.agentCount ? fmt.num(s.agentCount) : '–'}${s.workflowCount ? ` <small class="faint">${s.workflowCount} wf</small>` : ''}</td><td class="n">${fmt.num(s.tools)}${s.toolErr ? ` <small class="bad">${s.toolErr}✕</small>` : ''}</td><td class="n">${fmt.num(tokAll(s.tok))}</td><td class="n">${fmt.usd(s.cost)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

// ── one session ──
function paintSession() {
  const s = view.detail;
  view.renders.clear();
  if (!s || s.error) {
    view.el.innerHTML = `<div class="page-wrap mach">${head('Session', '')}<div class="empty"><p>${esc(s?.error || 'Not found')}</p></div></div>`;
    return;
  }
  const agents = Object.values(s.agents || {});
  const wfs = Object.values(s.workflows || {}).sort((a, b) => a.startTime - b.startTime);
  const sub = [esc(s.project), s.cwd ? `<code>${esc(s.cwd)}</code>` : '', s.branch ? esc(s.branch) : '', s.version ? 'Claude Code ' + esc(s.version) : ''].filter(Boolean).join(' · ');
  const agentTok = agents.reduce((a, x) => a + tokAll(x.tok), 0);
  view.el.innerHTML = `<div class="page-wrap mach">
    ${head(s.title || s.id, sub)}
    <section class="mach-tiles" id="m-stiles"></section>
    <div class="mach-grid">
      ${card('c-sctx', 'Context per reply', `The main conversation · largest ${fmt.num(s.ctxMax)} tokens`)}
      <section class="card mach-card"><div class="mach-card-head"><h3>Tools used</h3><span class="faint small">by the session and its agents</span></div>${barList(
        Object.entries(s.toolsBy || {})
          .map(([k, v]) => ({ label: k, value: v }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 14),
      )}</section>
      <section class="card mach-card wide"><div class="mach-card-head"><h3>Running now</h3></div><div id="c-srun"></div></section>
    </div>
    <h2 class="mach-h">${icon('cards', 18)}Agents and workflows <small class="faint">${agents.length} agent${agents.length === 1 ? '' : 's'}, ${wfs.length} workflow run${wfs.length === 1 ? '' : 's'} · ${fmt.num(agentTok)} tokens in agents</small><span class="mach-fold-all"><button class="link-btn" type="button" data-fold-all="close">Collapse all</button> · <button class="link-btn" type="button" data-fold-all="open">Expand all</button></span></h2>
    <section class="card mach-tree">${tree(s, agents, wfs)}</section>
  </div>`;
  $('m-pause').addEventListener('click', (e) => pauseMenu(e.currentTarget));
  view.el.querySelector('.mach-tree').addEventListener('click', onTreeClick);
  view.el.querySelector('.mach-fold-all').addEventListener('click', onTreeClick);
  paintSessionLive();
  const ctx = s.ctx || [];
  if (ctx.length) draw('c-sctx', (el) => timeChart(el, [{ name: 'Context', pts: ctx, area: true, color: 'var(--s2)' }], { from: ctx[0][0], to: Math.max(ctx.at(-1)[0], ctx[0][0] + 60_000), y: fmt.num }));
  else $('c-sctx').innerHTML = '<p class="viz-none">No replies read yet</p>';
}

function paintSessionLive() {
  const s = view.detail;
  if (!s || s.error || !$('m-stiles')) return;
  const live = (view.now?.live || []).find((l) => l.sessionId === s.id);
  const run = (view.now?.running || []).filter((r) => r.session === s.id);
  const read = s.tok.in + s.tok.cread + s.tok.cw5 + s.tok.cw1h;
  $('m-stiles').innerHTML = [
    tile('Status', live ? (live.status === 'busy' ? '<span class="mach-status busy">Working</span>' : '<span class="mach-status">Waiting</span>') : 'Ended', live ? `running for ${fmt.dur(Date.now() - live.startedAt)}${live.proc ? ` · ${fmt.pct(live.proc.cpu)} CPU · ${fmt.bytes(live.proc.mem)}` : ''}` : `last active ${esc(ago(s.last))}`),
    tile('Tokens', fmt.num(tokAll(s.tok)), `${fmt.num(read)} read · ${fmt.num(s.tok.out)} written`),
    tile('Est. cost', fmt.usd(s.cost), 'at API list prices'),
    tile('Replies', fmt.num(s.turns), `${fmt.num(s.prompts)} prompts from you`),
    tile('Tool calls', fmt.num(s.tools), `${fmt.num(s.toolErr)} failed`),
    tile('Cache hit rate', fmt.pct(read ? (s.tok.cread / read) * 100 : 0), ''),
    tile('Time', fmt.dur(s.last - s.first), `${esc(new Date(s.first).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} to ${esc(new Date(s.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}`),
    tile('Models', Object.keys(s.models).length ? esc(Object.keys(s.models).map((m) => m.replace(/^claude-/, '')).join(', ')) : '–', ''),
  ].join('');
  const el = $('c-srun');
  if (el)
    el.innerHTML = run.length
      ? `<ul class="mach-calls">${run.map((c) => `<li><span class="mach-call-name">${esc(c.name)}</span><span class="mach-call-what" title="${esc(c.summary)}">${esc(c.summary)}</span>${c.agent ? `<span class="badge">${esc(s.agents[c.agent]?.description || 'agent')}</span>` : ''}<span class="mach-call-ms busy">${fmt.dur(Date.now() - c.t)}</span></li>`).join('')}</ul>`
      : `<p class="viz-none">${live ? 'No tool call is waiting for its result.' : 'This session isn’t running.'}</p>`;
}

/** the session, its workflows (with their agents by phase) and its other agents */
function tree(s, agents, wfs) {
  const row = (a, depth = 0) => {
    const running = a.finished === false || (a.finished === null && Date.now() - a.last < 120_000);
    return `<div class="mach-agent" style="--d:${depth}"><span class="mach-status ${running ? 'busy' : 'done'}" title="${running ? 'Running' : 'Finished'}"></span><div class="mach-agent-main"><a class="mach-agent-link" href="${chatHref(s.id, a.id)}" title="Read this agent's conversation"><b>${esc(a.description || a.id)}</b></a><small class="faint">${esc(a.type)}${a.phase ? ' · ' + esc(a.phase) : ''}${a.model ? ' · ' + esc(a.model.replace(/^claude-/, '')) : ''}${a.depth > 1 ? ` · depth ${a.depth}` : ''}</small></div><span class="mach-agent-stat">${fmt.num(tokAll(a.tok))}<small>tokens</small></span><span class="mach-agent-stat">${fmt.num(a.tools)}<small>tools${a.toolErr ? `, <span class="bad">${a.toolErr} failed</span>` : ''}</small></span><span class="mach-agent-stat">${a.first ? fmt.dur(a.last - a.first) : '–'}</span><span class="mach-agent-stat">${fmt.usd(a.cost)}</span></div>`;
  };
  // the main conversation: the session less its agents, in the same columns
  const less = (f) => f(s) - agents.reduce((n, a) => n + f(a), 0);
  const main = { tok: less((x) => tokAll(x.tok)), tools: less((x) => x.tools), err: less((x) => x.toolErr), cost: less((x) => x.cost), turns: less((x) => x.turns) };
  let html = `<div class="mach-agent is-main"><span class="mach-status ${(view.now?.live || []).some((l) => l.sessionId === s.id) ? 'busy' : 'done'}"></span><div class="mach-agent-main"><a class="mach-agent-link" href="${chatHref(s.id)}" title="Read the main conversation"><b>Main conversation</b></a><small class="faint">${esc(s.model ? s.model.replace(/^claude-/, '') : '')} · ${fmt.num(main.turns)} replies</small></div><span class="mach-agent-stat">${fmt.num(main.tok)}<small>tokens</small></span><span class="mach-agent-stat">${fmt.num(main.tools)}<small>tools${main.err > 0 ? `, <span class="bad">${main.err} failed</span>` : ''}</small></span><span class="mach-agent-stat">${fmt.dur(s.last - s.first)}</span><span class="mach-agent-stat">${fmt.usd(main.cost)}</span></div>`;
  // workflows (and the subagents outside any), most recently active first; each one folds, and stays folded
  const folded = foldedMap();
  const last = (list, ...more) => Math.max(0, ...list.map((a) => a.last || 0), ...more);
  const blocks = [];
  const fold = (key, label, inner, dflt = false) => {
    const shut = key in folded ? folded[key] : dflt;
    return `<div class="mach-wf${shut ? ' is-folded' : ''}" data-wf="${esc(key)}">
      <div class="mach-wf-head"><button class="mach-fold" type="button" data-fold="${esc(key)}" aria-expanded="${!shut}" title="${shut ? 'Expand' : 'Collapse'}">${icon('chevron-down', 16)}</button>${label}</div>
      <div class="mach-wf-inner"${shut ? ' hidden' : ''}>${inner}</div>
    </div>`;
  };
  for (const w of wfs) {
    const mine = agents.filter((a) => a.workflow === w.runId);
    const phases = [...new Set([...w.phases.map((p) => p.title), ...mine.map((a) => a.phase || '')])];
    const at = last(mine, w.startTime + (w.durationMs || 0));
    const label = `<span class="badge ${w.status === 'completed' ? 'ok' : w.status === 'running' ? 'accent' : w.status ? 'danger' : ''}">${esc(w.status || '?')}</span><b>${esc(w.name)}</b><span class="faint small">${w.agentCount} agents · ${fmt.dur(w.durationMs)} · ${fmt.num(mine.reduce((n, x) => n + tokAll(x.tok), 0))} tokens with cache reads <span title="The workflow record's own total, which leaves out tokens read from the cache">(${fmt.num(w.totalTokens)} by Claude Code's count)</span> · ${fmt.num(w.totalToolCalls)} tool calls · ${fmt.usd(mine.reduce((n, x) => n + x.cost, 0))}</span><span class="faint small mach-wf-when">${esc(ago(at))}</span><button class="btn small" type="button" data-open="${esc(w.runId)}">${icon('chevron-down', 14)}Script and result</button>`;
    const inner = `${w.description ? `<p class="mach-wf-desc">${esc(w.description)}</p>` : ''}
      ${w.summary && w.summary !== w.description ? `<p class="mach-wf-desc faint">${esc(w.summary)}</p>` : ''}
      <div class="mach-wf-body" hidden></div>
      ${phases
        .map((ph) => {
          const list = mine.filter((a) => (a.phase || '') === ph);
          if (!list.length && !ph) return '';
          return `<div class="mach-phase"><span class="mach-phase-name">${esc(ph || 'Other')}</span>${list.length ? list.sort((a, b) => a.first - b.first).map((a) => row(a, 1)).join('') : '<p class="faint small">No agents read for this phase</p>'}</div>`;
        })
        .join('')}`;
    blocks.push({ at, html: fold(w.runId, label, inner, w.status === 'completed') });
  }
  // agents of a workflow run whose record is gone (or not written yet)
  const runs = new Set(wfs.map((w) => w.runId));
  const orphans = [...new Set(agents.filter((a) => a.workflow && !runs.has(a.workflow)).map((a) => a.workflow))];
  for (const id of orphans) {
    const mine = agents.filter((x) => x.workflow === id);
    const at = last(mine);
    const label = `${mine.some((x) => x.finished === false || Date.now() - x.last < 120_000) ? '<span class="badge accent">running</span>' : '<span class="badge">no record</span>'}<b>Workflow ${esc(id)}</b><span class="faint small">Claude Code writes a run's record when it ends</span><span class="faint small mach-wf-when">${esc(ago(at))}</span>`;
    blocks.push({ at, html: fold(id, label, mine.sort((a, b) => a.first - b.first).map((a) => row(a, 1)).join('')) });
  }
  const loose = agents.filter((a) => !a.workflow).sort((a, b) => a.first - b.first);
  if (loose.length) {
    const at = last(loose);
    blocks.push({ at, html: fold('subagents:' + s.id, `<b>Subagents</b><span class="faint small">${loose.length} outside any workflow</span><span class="faint small mach-wf-when">${esc(ago(at))}</span>`, loose.map((a) => row(a, Math.max(1, a.depth))).join('')) });
  }
  blocks.sort((x, y) => y.at - x.at);
  html += blocks.map((x) => x.html).join('');
  if (!agents.length && !wfs.length) html += '<p class="viz-none">This session ran no subagents or workflows.</p>';
  return html;
}

/** which workflows the person folded (true) or opened (false); the rest follow the default: finished ones fold */
function foldedMap() {
  try {
    const o = JSON.parse(store('machine-fold') || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
function setFolded(key, shut) {
  const o = foldedMap();
  delete o[key];
  o[key] = shut;
  store('machine-fold', JSON.stringify(Object.fromEntries(Object.entries(o).slice(-1000))));
}
function applyFold(wf, shut) {
  wf.classList.toggle('is-folded', shut);
  wf.querySelector(':scope > .mach-wf-inner').hidden = shut;
  const b = wf.querySelector(':scope > .mach-wf-head > .mach-fold');
  b.setAttribute('aria-expanded', String(!shut));
  b.title = shut ? 'Expand' : 'Collapse';
}

async function onTreeClick(e) {
  const f = e.target.closest('[data-fold]');
  if (f) {
    const wf = f.closest('.mach-wf');
    const shut = !wf.classList.contains('is-folded');
    applyFold(wf, shut);
    return setFolded(f.dataset.fold, shut);
  }
  const all = e.target.closest('[data-fold-all]');
  if (all) {
    const shut = all.dataset.foldAll === 'close';
    for (const wf of view.el.querySelectorAll('.mach-tree .mach-wf')) {
      applyFold(wf, shut);
      setFolded(wf.dataset.wf, shut);
    }
    return;
  }
  const head = e.target.closest('.mach-wf-head');
  if (head && !e.target.closest('a, button, summary')) return void head.querySelector('.mach-fold')?.click();
  const b = e.target.closest('[data-open]');
  if (!b) return;
  const box = b.closest('.mach-wf').querySelector('.mach-wf-body');
  if (!box.hidden) return void (box.hidden = true);
  box.hidden = false;
  box.innerHTML = '<p class="faint small">Loading…</p>';
  try {
    const w = await hubApi(`api/machine/workflow/${encodeURIComponent(view.session)}/${encodeURIComponent(b.dataset.open)}`);
    const result = w.result === undefined ? '' : JSON.stringify(w.result, null, 2);
    box.innerHTML = `${w.script ? `<details open><summary>Script</summary><pre class="mach-pre">${esc(w.script)}</pre></details>` : ''}${result ? `<details><summary>Result</summary><pre class="mach-pre">${esc(result.length > 60000 ? result.slice(0, 60000) + '\n…' : result)}</pre></details>` : ''}`;
  } catch (err) {
    box.innerHTML = `<p class="bad">${esc(err.message)}</p>`;
  }
}

// charts follow the page's width
let resizeT = 0;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    for (const fn of view.renders.values()) fn();
  }, 150);
});
