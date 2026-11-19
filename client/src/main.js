// hitl's page: one shell (the bar, the sections, settings, live updates) around the views: the inbox, a project's
// files (folderview), its notes and decisions, a question set (questionme) and a review.
//   #/                          everything waiting on you, every project
//   #/p/<key>                   one project's inbox
//   #/p/<key>/files/<folder>?…  its files (open, search, changes, history: folderview's address)
//   #/p/<key>/notes             your notes for the agent
//   #/p/<key>/decisions         what you decided
//   #/p/<key>/q/<set>[/<id>]    a question set
//   #/p/<key>/r/<id>[/<item>]   a review, a showing or an approval
import { $, api, esc, emit, on, store, toast, debounce } from './util.js';
import { enterProject, loadComments, loadGit, projectOf, setSetting, state, where } from './state.js';
import { icon } from './icons.js';
import { filesChanged, filesHome, leaveFiles, notesChanged, paintBar, showFiles, wireFiles, busyTyping } from './files.js';
import { renderReviewPage } from './review.js';
import { renderInbox, renderDecisions } from './inbox.js';
import { showSet, leaveSet, setChanged } from './q/page.js';
import { showReview, leaveReview, reviewChanged } from './r/page.js';
import './grow.js';

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ── the address ──
function parse() {
  const h = location.hash.slice(1) || '/';
  const [p, qs = ''] = h.split('?');
  const parts = p.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
  if (parts[0] !== 'p' || !parts[1]) return { page: 'inbox', key: '' };
  const key = parts[1];
  const sec = parts[2] || '';
  const q = new URLSearchParams(qs);
  if (sec === 'files') return { page: where().m === 'changes' || where().m === 'history' ? 'changes' : 'files', key };
  if (sec === 'q' && parts[3]) return { page: 'questions', key, id: parts[3], focus: parts[4] || '' };
  if (sec === 'r' && parts[3]) return { page: 'review', key, id: parts[3], focus: parts[4] || '' };
  if (sec === 'notes') return { page: 'notes', key, filter: q.get('f') || '' };
  if (sec === 'decisions') return { page: 'decisions', key, q: q.get('q') || '' };
  return { page: 'project', key };
}

let current = { page: '' };

// one route at a time: a change of address while one is drawing waits, then the newest wins
let routing = null;
let again = false;
// a page that takes a moment (a project opening, a big folder): the bar at the top runs and the tapped link dims
let slow = 0;
function loading(on) {
  clearTimeout(slow);
  if (on) slow = setTimeout(() => document.body.classList.add('loading'), 120);
  else {
    document.body.classList.remove('loading');
    for (const a of document.querySelectorAll('a.pending')) a.classList.remove('pending');
  }
}
addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (a.getAttribute('href') !== location.hash) a.classList.add('pending');
});

async function route() {
  if (routing) {
    again = true;
    return routing;
  }
  loading(true);
  routing = (async () => {
    do {
      again = false;
      await draw();
    } while (again);
  })();
  try {
    await routing;
  } finally {
    routing = null;
    loading(false);
  }
}
// the open project's git status: the files views wait for it, everything else draws without it
let gitReady = Promise.resolve();

async function draw() {
  const r = parse();
  try {
    if (r.key && !projectOf(r.key)) await loadHub();
    if (r.key && !projectOf(r.key)) throw new Error(`No project "${r.key}" here (it may have moved, or this hub doesn't serve it).`);
    if (r.key !== state.project) {
      enterProject(r.key);
      gitReady = Promise.resolve();
      if (r.key) {
        try {
          [state.info] = await Promise.all([api('api/info'), loadComments()]);
        } catch (e) {
          enterProject(''); // not half-open: the next tap tries again
          throw e;
        }
        gitReady = loadGit().then(() => r.key === state.project && paintBar());
      }
    }
    if (r.page === 'files' || r.page === 'changes') await gitReady;
    const main = $('main');
    if (r.page !== 'files' && r.page !== 'changes') leaveFiles();
    if (r.page !== 'questions') leaveSet();
    if (r.page !== 'review') leaveReview();
    current = r;
    document.body.dataset.view = r.page;
    paintChrome();
    // a phone: a new page starts at the top (the files view keeps its own scroll)
    const fresh = r.page !== 'files' && r.page !== 'changes';
    switch (r.page) {
      case 'inbox':
      case 'project':
        renderInbox(main, r.key);
        break;
      case 'files':
      case 'changes':
        await showFiles();
        break;
      case 'notes':
        renderReviewPage(main, r.filter, (f) => (location.hash = `#/p/${encodeURIComponent(r.key)}/notes${f ? '?f=' + f : ''}`));
        document.title = `Notes · ${state.info.name} · hitl`;
        break;
      case 'decisions':
        await renderDecisions(main, r.q);
        document.title = `Decisions · ${state.info.name} · hitl`;
        break;
      case 'questions':
        await showSet(main, r.key, r.id, r.focus);
        break;
      case 'review':
        await showReview(main, r.key, r.id, r.focus);
        break;
    }
    if (fresh && lastPage !== JSON.stringify([r.page, r.key, r.id])) scrollTo(0, 0);
    lastPage = JSON.stringify([r.page, r.key, r.id]);
  } catch (e) {
    leaveFiles();
    $('main').innerHTML = `<div class="page-wrap"><div class="empty"><h2>Couldn't open that</h2><p>${esc(e.message)}</p><p><a class="btn" href="#/">Back to the inbox</a></p></div></div>`;
  }
}
let lastPage = '';

// ── the bar and the sections ──
function paintChrome() {
  const key = state.project;
  const p = projectOf(key);
  const k = encodeURIComponent(key);
  $('proj').hidden = !p;
  if (p) {
    $('proj-name').textContent = p.name;
    $('proj-mark').textContent = p.name.slice(0, 1).toUpperCase();
    $('proj-mark').style.setProperty('--hue', hueOf(p.name));
  }
  $('tabs').hidden = !p;
  const tabFor = { inbox: 'inbox', project: 'inbox', files: 'files', changes: 'changes', notes: 'notes', decisions: 'decisions', questions: 'inbox', review: 'inbox' };
  const on = tabFor[current.page] || '';
  const hrefs = { inbox: `#/p/${k}`, files: `#/p/${k}/files/`, changes: `#/p/${k}/files/?m=changes`, notes: `#/p/${k}/notes`, decisions: `#/p/${k}/decisions` };
  for (const a of $('tabs').querySelectorAll('[data-tab]')) {
    a.href = hrefs[a.dataset.tab];
    a.classList.toggle('on', a.dataset.tab === on);
    if (a.dataset.tab === on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const filesView = current.page === 'files' || current.page === 'changes';
  $('search-form').hidden = !filesView;
  $('qo-btn').hidden = !filesView;
  paintCounts();
  if (p) paintBar();
}

const hueOf = (t) => {
  let h = 0;
  for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

function waitingIn(p) {
  let n = 0;
  for (const s of p.reviews) if (s.status === 'open' && !s.done) n++;
  for (const s of p.questions) if (s.status === 'open' && s.toAnswer > 0) n++;
  return n;
}

function paintCounts() {
  const all = state.hub.projects.reduce((n, p) => n + waitingIn(p), 0);
  $('inbox-count').textContent = String(all);
  $('inbox-count').hidden = !all;
  const p = projectOf();
  const n = p ? waitingIn(p) : 0;
  $('proj-count').textContent = String(n);
  $('proj-count').hidden = !n;
  const gates = state.hub.projects.some((x) => x.reviews.some((s) => s.mode === 'approve' && s.status === 'open' && !s.done));
  $('inbox-count').classList.toggle('danger', gates);
}

// the project picker: every project, with what's waiting
function projectMenu() {
  const old = $('proj-menu');
  if (old) {
    $('proj').setAttribute('aria-expanded', 'false');
    return old.remove();
  }
  const pop = document.createElement('div');
  pop.id = 'proj-menu';
  pop.className = 'pop menu';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = state.hub.projects
    .map((p) => {
      const n = waitingIn(p);
      return `<a class="menu-item${p.key === state.project ? ' on' : ''}" href="#/p/${encodeURIComponent(p.key)}"><span class="proj-mark" style="--hue:${hueOf(p.name)}">${esc(p.name.slice(0, 1).toUpperCase())}</span><span class="grow">${esc(p.name)}</span>${n ? `<span class="count">${n}</span>` : ''}</a>`;
    })
    .join('') + `<div class="menu-sep" role="separator"></div><a class="menu-item" href="#/"><span class="menu-ic">${icon('home', 16)}</span><span class="grow">Every project</span></a>`;
  const r = $('proj').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 300)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  document.body.append(pop);
  $('proj').setAttribute('aria-expanded', 'true');
  // pointerdown outside closes it; a tap on one of its links closes it in onclick, after the link has done its work
  // (removing it on pointerdown ate the click, so picking a project did nothing)
  const away = (e) => {
    if (!pop.isConnected) return removeEventListener('pointerdown', away, true);
    if (pop.contains(e.target) || e.target.closest?.('#proj')) return;
    $('proj').setAttribute('aria-expanded', 'false');
    pop.remove();
    removeEventListener('pointerdown', away, true);
  };
  setTimeout(() => addEventListener('pointerdown', away, true));
  pop.onclick = (e) => {
    if (!e.target.closest('a')) return;
    $('proj').setAttribute('aria-expanded', 'false');
    pop.remove();
  };
}

// ── settings ──
async function settingsPanel() {
  const old = $('settings-pop');
  if (old) return old.remove();
  const s = state.settings;
  const pop = document.createElement('div');
  pop.id = 'settings-pop';
  pop.className = 'pop';
  const p = projectOf();
  pop.innerHTML = `<h3>Settings</h3>
  <label>Theme <select data-s="theme"><option value="auto">Match the system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
  <label>Ignored files <select data-s="ignored"><option value="dim">Show dimmed</option><option value="hide">Hide</option></select></label>
  <label class="check"><input type="checkbox" data-s="wrap"> Wrap long lines</label>
  <label class="check"><input type="checkbox" data-s="review"> Tap a line to write a note on it</label>
  <label class="check"><input type="checkbox" data-s="resolved"> Show resolved notes in files</label>
  <label>Your name on notes <input data-s="author" placeholder="${esc(state.info.author || '')}" value="${esc(s.author)}"></label>
  ${p ? `<h3>Claude Code in ${esc(p.name)}</h3><div id="hooks-box" class="faint small">…</div>` : ''}
  <h3>On your phone</h3>
  <p class="faint small">Open this page on your phone (the same Wi-Fi or Tailscale) and add it to your home screen. For notifications when an agent asks something: <code>npx hitloop notify ntfy</code>.</p>
  <h3>Shortcuts</h3>
  <dl class="keys"><dt><kbd>Ctrl</kbd> <kbd>P</kbd></dt><dd>Go to a file</dd><dt><kbd>/</kbd></dt><dd>Search in files</dd><dt><kbd>Esc</kbd></dt><dd>Close the file</dd><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next file</dd><dt><kbd>Shift</kbd>-click</dt><dd>A range of lines</dd><dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Send a note or comment</dd><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>One at a time: previous / next</dd></dl>
  <p class="faint">hitl ${esc(state.hub.version || '')} — Human In The Loop${state.info.root ? ' · ' + esc(state.info.root) : ''}</p>`;
  document.body.append(pop);
  for (const el of pop.querySelectorAll('[data-s]')) {
    const k = el.dataset.s;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
    el.onchange = () => {
      setSetting(k, el.type === 'checkbox' ? el.checked : el.value.trim());
      if (k === 'theme') applyTheme();
      emit('settings');
    };
  }
  if (p) paintHooks(pop.querySelector('#hooks-box'));
  setTimeout(() => {
    const away = (e) => {
      if (!pop.contains(e.target) && !e.target.closest('#settings-btn')) {
        pop.remove();
        removeEventListener('pointerdown', away);
      }
    };
    addEventListener('pointerdown', away);
  });
}

/** the optional Claude Code hooks for this project (they live in its .claude/settings.json) */
async function paintHooks(box) {
  if (!box) return;
  let h;
  try {
    h = await api('api/hooks');
  } catch (e) {
    box.textContent = e.message;
    return;
  }
  box.classList.remove('faint', 'small');
  box.innerHTML = `<label class="check"><input type="checkbox" data-hook="prompt" ${h.prompt ? 'checked' : ''} ${state.info.readOnly ? 'disabled' : ''}> Tell Claude what you said, each time you send it a message</label>
  <label class="check"><input type="checkbox" data-hook="stop" ${h.stop ? 'checked' : ''} ${state.info.readOnly ? 'disabled' : ''}> Don't let Claude finish while an approval or a blocking question is waiting</label>
  <p class="faint small">Saved in <code>.claude/settings.json</code>; Claude Code picks them up in its next session. (<code>hitl hooks</code> does the same.)</p>`;
  box.onchange = async (e) => {
    const c = e.target.closest('[data-hook]');
    if (!c) return;
    try {
      await api('api/hooks', { method: 'POST', json: { [c.dataset.hook]: c.checked } });
      toast(c.checked ? 'Hook on' : 'Hook off');
    } catch (err) {
      c.checked = !c.checked;
      toast(err.message);
    }
  };
}

// notes changed here (written, resolved, deleted): the Notes page shows it at once
on('comments', () => {
  if (current.page === 'notes' && !busyTyping($('main'))) renderReviewPage($('main'), current.filter, (f) => (location.hash = `#/p/${encodeURIComponent(current.key)}/notes${f ? '?f=' + f : ''}`));
});

// ── live ──
const loadHub = async () => {
  state.hub = await api('api/info', { hub: true });
};
const refreshHub = debounce(async () => {
  try {
    await loadHub();
  } catch {
    return;
  }
  paintCounts();
  if ((current.page === 'inbox' || current.page === 'project') && !busyTyping($('main'))) renderInbox($('main'), current.key);
}, 250);

function connect() {
  const es = new EventSource('api/events');
  es.addEventListener('hello', () => $('live').classList.add('on'));
  es.onerror = () => $('live').classList.remove('on');
  es.addEventListener('change', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.project === state.project) filesChanged(d);
  });
  es.addEventListener('notes', async (ev) => {
    const d = JSON.parse(ev.data);
    if (d.project !== state.project) return refreshHub();
    await notesChanged();
    if (current.page === 'notes' && !busyTyping($('main'))) renderReviewPage($('main'), current.filter, (f) => (location.hash = `#/p/${encodeURIComponent(current.key)}/notes${f ? '?f=' + f : ''}`));
    refreshHub();
  });
  es.addEventListener('request', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.kind === 'review') reviewChanged(d);
    else setChanged(d);
    refreshHub();
  });
  es.addEventListener('projects', refreshHub);
  // back from sleep (a phone in a pocket): catch up
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshHub());
}

async function boot() {
  applyTheme();
  try {
    await loadHub();
  } catch (err) {
    $('main').innerHTML = `<div class="page-wrap"><p class="empty">Can't reach the hitl server: ${esc(err.message)}</p></div>`;
    return;
  }
  // one project only (hitl --solo): its inbox is home
  if (state.hub.mode === 'solo' && state.hub.projects[0] && (!location.hash || location.hash === '#/')) history.replaceState(null, '', `#/p/${encodeURIComponent(state.hub.projects[0].key)}`);
  $('settings-btn').innerHTML = icon('settings');
  $('proj-caret').innerHTML = icon('chevron-down', 14);
  const tabIcons = { inbox: 'home', files: 'folder', changes: 'diff', notes: 'chat', decisions: 'check' };
  for (const a of $('tabs').querySelectorAll('[data-tab]')) a.querySelector('.tab-ic').innerHTML = icon(tabIcons[a.dataset.tab], 18);
  $('settings-btn').onclick = settingsPanel;
  $('proj').onclick = projectMenu;
  // the Files tab again: back to the top folder
  $('tab-files').addEventListener('click', (e) => {
    if (current.page === 'files' && where().folder === '' && !where().open) return;
    if (current.page === 'files') {
      e.preventDefault();
      filesHome();
    }
  });
  // the bar's height, for what sticks under it on a phone
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px')).observe($('bar'));
  wireFiles();
  addEventListener('hashchange', route);
  await route();
  connect();
  void store;
}
boot();
