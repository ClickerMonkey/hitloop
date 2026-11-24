// A question set: every question as a list, or as cards (one per screen). Answers save as you go; when
// an agent adds questions or replies, or you answer on another device, it updates live. The shell mounts this view.
import { $, api, esc, store, toast, copy, debounce, ago } from '../util.js';
import { state, projectOf } from '../state.js';
import { icon } from '../icons.js';
import { md, renderBlocks, modal } from './blocks.js';
import { renderQuestion, draw, refreshTop, drawThread } from './question.js';
import { addSelectionTarget } from '../selcomment.js';
import { closeButton } from '../close.js';
import { visibility, summarise, allQuestions, isDone, isStale, recommendedAnswer, questionById } from '../../../src/q/model.ts';

let main = null;
let view = null; // the open set
const info = {
  get projects() {
    return state.hub.projects;
  },
  get readOnly() {
    return !!state.info.readOnly;
  },
};

export const setHref = (key, set, q) => `#/p/${encodeURIComponent(key)}/q/${encodeURIComponent(set)}${q ? `/${encodeURIComponent(q)}` : ''}`;

/** a progress ring: done of total */
export function ring(done, total, size = 52) {
  const pct = total ? done / total : 0;
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  return `<span class="ring${pct >= 1 ? ' full' : ''}" style="--size:${size}px" title="${done} of ${total}"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}"/><circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg><span class="ring-text">${pct >= 1 ? icon('check', Math.round(size / 3)) : Math.round(pct * 100) + '<small>%</small>'}</span></span>`;
}

export const hueOfText = (t) => {
  let h = 0;
  for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

export function setRow(key, s) {
  const chips = [
    s.toAnswer ? `<span class="badge accent">${s.toAnswer} to answer</span>` : `<span class="badge ok">${icon('check', 13)}All answered</span>`,
    s.blocking ? `<span class="badge danger">${icon('warning', 12)}${s.blocking} blocking</span>` : '',
    s.changed ? `<span class="badge warn">${s.changed} changed</span>` : '',
    s.later ? `<span class="badge">${s.later} later</span>` : '',
    s.errors ? `<span class="badge danger">${s.errors} errors in the file</span>` : '',
    s.status === 'closed' ? '<span class="badge">Closed</span>' : '',
  ].join('');
  return `<a class="set-row${s.status === 'closed' ? ' closed' : ''}${s.blocking ? ' urgent' : ''}" href="${setHref(key, s.id)}">${ring(s.done, s.visible)}<div class="set-info"><b class="set-name">${esc(s.title)}</b><span class="set-sub">${s.done} of ${s.visible} answered${s.updated ? ' · ' + esc(ago(Date.parse(s.updated))) : ''}</span><span class="set-chips">${chips}</span></div><span class="set-go">${icon('chevron-right', 20)}</span></a>`;
}

// ── one set ──
/** each section's colour (a hue), so you can tell where you are */
const HUES = [268, 205, 160, 30, 330, 85, 295, 185, 0, 125];
const hueOf = (sid) => HUES[Math.max(0, view.data.set.sections.findIndex((s) => s.id === sid)) % HUES.length];

const FILTERS = [
  ['todo', 'To answer'],
  ['blocking', 'Blocking'],
  ['changed', 'Changed'],
  ['later', 'Later'],
  ['done', 'Answered'],
  ['all', 'All'],
  ['hidden', 'Hidden'],
];

/** open a set in the container (the same set again just moves to the question) */
export async function showSet(container, key, setId, focusQ) {
  if (view && view.key === key && view.setId === setId && main === container && container.querySelector('.set-page')) {
    if (focusQ) focusQuestion(focusQ);
    return;
  }
  main = container;
  const data = await api(`api/q/${encodeURIComponent(setId)}`);
  view = {
    key,
    setId,
    data,
    shape: shapeOf(data.set),
    vis: visibility(data.set, data.answers.answers),
    filter: store(`filter:${key}/${setId}`) || 'todo',
    search: '',
    mode: store('mode') || 'list',
    shown: new Set(),
    cards: new Map(),
    index: 0,
    order: [],
  };
  document.title = `${data.set.title} · hitl`;
  renderSet();
  if (focusQ) focusQuestion(focusQ);
  else if (view.mode === 'cards') showCard(0);
}

const shapeOf = (set) => JSON.stringify(set.sections.map((s) => [s.id, s.title, s.intro, s.content, s.hidden, s.showIf, s.questions.map((q) => [q.id, q.rev, q.why, q.header, q.content, q.priority, q.hidden, q.showIf, q.options])]).concat([set.title, set.intro, set.content, set.status]));

function counts() {
  const set = view.data.set;
  const af = view.data.answers;
  const c = { todo: 0, blocking: 0, changed: 0, later: 0, done: 0, all: 0, hidden: 0 };
  for (const q of allQuestions(set)) for (const f of Object.keys(c)) if (matches(q, f)) c[f]++;
  return { c, summary: summarise(set, af) };
}

function matches(q, f) {
  const a = view.data.answers.answers[q.id];
  const visible = view.vis.question(q.id);
  if (f === 'hidden') return !visible;
  if (!visible) return false;
  switch (f) {
    case 'todo':
      return !isDone(a) || isStale(q, a);
    case 'blocking':
      return q.priority === 'blocking' && (!isDone(a) || isStale(q, a));
    case 'changed':
      return isStale(q, a);
    case 'later':
      return a?.status === 'later';
    case 'done':
      return isDone(a);
    default:
      return true;
  }
}

function searchHit(q, s) {
  if (!s) return true;
  const hay = [q.id, q.header, q.question, q.why, ...q.options.map((o) => o.label + ' ' + o.description)].join(' ').toLowerCase();
  return s
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

/** which questions the filter and search show (sticky: answering one doesn't hide it until the filter changes) */
function computeShown() {
  view.shown = new Set(allQuestions(view.data.set).filter((q) => matches(q, view.filter) && searchHit(q, view.search)).map((q) => q.id));
}

const ctx = {
  answer: (qid) => view?.data.answers.answers[qid],
  thread: (qid) => view?.data.answers.threads[qid] || [],
  get readOnly() {
    return !!info?.readOnly;
  },
  async save(qid, input, opts = {}) {
    const r = await api(`api/q/${encodeURIComponent(view.setId)}/answer`, { method: 'POST', json: { id: qid, ...input } });
    view.data.answers.answers[qid] = r.answer;
    view.data.answers.seq = Math.max(view.data.answers.seq, r.answer.seq);
    afterChange(qid, { redraw: !opts.quiet });
    return r.answer;
  },
  async clear(qid) {
    await api(`api/q/${encodeURIComponent(view.setId)}/answer`, { method: 'POST', json: { id: qid, clear: true } });
    delete view.data.answers.answers[qid];
    afterChange(qid, { redraw: true });
  },
  async message(qid, body, quote = '') {
    const r = await api(`api/q/${encodeURIComponent(view.setId)}/message`, { method: 'POST', json: { id: qid, body, ...(quote ? { quote } : {}) } });
    (view.data.answers.threads[qid] ??= []).push(r.message);
    if (qid === '') paintWhole(true);
    else redrawCard(qid, { threadOpen: true });
  },
  picked(qid) {
    if (view?.mode !== 'cards' || store('advance') === '0') return;
    const at = view.order.indexOf(qid);
    if (at !== view.index) return;
    setTimeout(() => {
      if (view?.order[view.index] === qid) nextCard(true);
    }, 380);
  },
  why: (qid) => whyHidden(qid),
  unseen(qid) {
    const seen = seenMap()[qid] || 0;
    return (view?.data.answers.threads[qid] || []).filter((m) => m.from === 'agent' && m.seq > seen).length;
  },
  seen(qid) {
    const m = seenMap();
    m[qid] = Math.max(0, ...(view.data.answers.threads[qid] || []).map((x) => x.seq));
    store(`seen:${view.key}/${view.setId}`, JSON.stringify(m));
  },
};

function seenMap() {
  try {
    return JSON.parse(store(`seen:${view.key}/${view.setId}`) || '{}');
  } catch {
    return {};
  }
}

/** why a hidden question is hidden: what would show it */
function whyHidden(qid) {
  const set = view.data.set;
  const q = questionById(set, qid);
  if (!q) return '';
  const label = (id) => {
    const x = questionById(set, id);
    return x ? `“${x.header || x.question.replace(/\s+/g, ' ').slice(0, 50)}”` : id;
  };
  const optLabel = (x, o) => `“${x.options.find((y) => y.id === o)?.label ?? o}”`;
  const reasons = [];
  const section = set.sections.find((s) => s.id === q.section);
  if (section && !view.vis.section(section.id)) reasons.push(`its section “${section.title || section.id}” is hidden`);
  for (const x of allQuestions(set))
    for (const o of x.options) {
      if (o.shows.includes(qid) || o.shows.includes(q.section)) reasons.push(`shown when you pick ${optLabel(x, o.id)} for ${label(x.id)}`);
      if (o.hides.includes(qid) || o.hides.includes(q.section)) reasons.push(`hidden while ${optLabel(x, o.id)} is picked for ${label(x.id)}`);
    }
  for (const c of q.showIf || []) {
    const x = questionById(set, c.question);
    const opts = (k) => (c[k] || []).map((o) => (x ? optLabel(x, o) : o)).join(' or ');
    if (c.any) reasons.push(`shown when ${label(c.question)} is ${opts('any')}`);
    else if (c.all) reasons.push(`shown when ${label(c.question)} includes ${(c.all || []).map((o) => (x ? optLabel(x, o) : o)).join(' and ')}`);
    else if (c.none) reasons.push(`shown when ${label(c.question)} isn't ${opts('none')}`);
    else if (c.answered !== undefined) reasons.push(`shown when ${label(c.question)} is ${c.answered ? '' : 'not '}answered`);
    if (c.gte !== undefined || c.lte !== undefined) reasons.push(`shown when ${label(c.question)} is ${c.gte !== undefined ? '≥ ' + c.gte : ''}${c.gte !== undefined && c.lte !== undefined ? ' and ' : ''}${c.lte !== undefined ? '≤ ' + c.lte : ''}`);
  }
  if (!reasons.length) return 'Hidden by default.';
  return reasons.join('; ').replace(/^./, (c) => c.toUpperCase()) + '.';
}

function renderSet() {
  const { data } = view;
  const set = data.set;
  computeShown();
  view.cards.clear();
  const page = document.createElement('div');
  page.className = 'set-page';
  const head = document.createElement('header');
  const project = info.projects.find((p) => p.key === view.key);
  head.className = 'set-hero';
  head.innerHTML = `<div class="hero-top"><div class="hero-text"><span class="eyebrow">${esc(project?.name || view.key)} · Questions${set.from ? ` · from ${esc(set.from)}` : ''}</span><h1>${esc(set.title)}</h1></div><div class="hero-ring" id="hero-ring"></div></div>`;
  if (set.intro) head.append(md(set.intro, '', 'set-intro'));
  head.insertAdjacentHTML('beforeend', '<div class="hero-stats" id="hero-stats"></div>');
  if (set.status === 'closed') head.insertAdjacentHTML('beforeend', `<p class="rv-closed">${icon('check', 14)} Closed: this set isn't waiting for you.</p>`);
  if (!info.readOnly) head.insertAdjacentHTML('beforeend', `<p class="close-row">${closeButton('questions', view.key, view.setId, set.status === 'closed')}</p>`);
  if (set.content.length) {
    const c = document.createElement('div');
    c.className = 'q-content';
    renderBlocks(c, set.content);
    head.append(c);
  }
  if (data.errors.length) {
    head.insertAdjacentHTML(
      'beforeend',
      `<details class="problems"><summary>${icon('warning', 16)} ${data.errors.length} problem${data.errors.length === 1 ? '' : 's'} in this set's file (the agent can fix them: <code>hitl validate ${esc(view.setId)}</code>)</summary><ul>${data.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>`,
    );
  }
  page.append(head);

  // the toolbar: progress, filters, search, list/cards
  const tools = document.createElement('div');
  tools.className = 'set-tools';
  tools.id = 'set-tools';
  page.append(tools);

  const body = document.createElement('div');
  body.id = 'set-body';
  page.append(body);
  // the thread on the whole set (what you select outside any question lands here too)
  const whole = document.createElement('section');
  whole.className = 'set-whole';
  whole.id = 'set-whole';
  page.append(whole);
  main.replaceChildren(page);
  paintTools();
  paintBody();
  paintWhole();
}

/** the thread on the whole set: its messages, or a button to start one */
function paintWhole(open = false) {
  const box = $('set-whole');
  if (!box || box.contains(document.activeElement)) return;
  const msgs = ctx.thread('');
  if (!msgs.length && !open) {
    box.innerHTML = info.readOnly ? '' : `<button class="link-btn" data-whole-open>${icon('chat', 14)} Write to the agent about the whole set</button>`;
    const b = box.querySelector('[data-whole-open]');
    if (b) b.onclick = () => (paintWhole(true), box.querySelector('textarea')?.focus());
    return;
  }
  box.innerHTML = `<h2 class="rv-h2">On the whole set</h2><div class="q-thread"></div>`;
  drawThread(box.querySelector('.q-thread'), { id: '' }, ctx);
}

function paintTools() {
  const tools = $('set-tools');
  if (!tools) return;
  const { c } = counts();
  const recs = acceptable(allQuestions(view.data.set)).length;
  const searching = view.searchOpen || !!view.search;
  tools.innerHTML = `
    <div class="tools-row">
      <div class="filters" role="tablist">${FILTERS.filter(([f]) => f === 'todo' || f === 'all' || c[f] || view.filter === f).map(([f, t]) => `<button class="chip${view.filter === f ? ' on' : ''}${f === 'blocking' ? ' danger' : ''}" data-filter="${f}" role="tab" aria-selected="${view.filter === f}">${t}<span class="n">${c[f]}</span></button>`).join('')}</div>
      <div class="tools-btns">
        <button class="icon-btn${searching ? ' on' : ''}" id="search-btn" title="Search" aria-label="Search">${icon('search', 18)}</button>
        ${view.mode === 'cards' ? `<button class="icon-btn" data-mode="list" title="Show every question" aria-label="Show every question">${icon('list', 18)}</button>` : `<button class="icon-btn" data-mode="cards" title="One question at a time" aria-label="One question at a time">${icon('cards', 18)}</button>`}
        <button class="icon-btn" id="set-menu" title="More" aria-label="More">${icon('more', 18)}</button>
      </div>
    </div>
    <div class="search-row" ${searching ? '' : 'hidden'}><label class="search-in">${icon('search', 16)}<input id="q-search" type="search" placeholder="Search questions and options" value="${esc(view.search)}" autocomplete="off" enterkeyhint="search" /></label></div>
    <div class="tools-progress" aria-hidden="true"><span></span></div>`;
  tools.querySelectorAll('[data-filter]').forEach(
    (b) =>
      (b.onclick = () => {
        view.filter = b.dataset.filter;
        store(`filter:${view.key}/${view.setId}`, view.filter);
        computeShown();
        paintTools();
        paintBody();
        const top = $('set-body').getBoundingClientRect().top + scrollY - tools.offsetHeight - 60;
        if (scrollY > top) scrollTo({ top, behavior: 'instant' });
      }),
  );
  tools.querySelector('.filters .on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  tools.querySelectorAll('[data-mode]').forEach(
    (b) =>
      (b.onclick = () => {
        if (view.mode === b.dataset.mode) return;
        const current = view.mode === 'cards' ? view.order[view.index] : firstOnScreen();
        view.mode = b.dataset.mode;
        store('mode', view.mode);
        paintTools();
        paintBody();
        if (current) focusQuestion(current);
      }),
  );
  const search = $('q-search');
  search.oninput = debounce(() => {
    view.search = search.value.trim();
    computeShown();
    paintBody();
    paintFilterCounts();
  }, 200);
  $('search-btn').onclick = () => {
    view.searchOpen = !searching;
    if (!view.searchOpen && view.search) {
      view.search = '';
      computeShown();
      paintBody();
    }
    paintTools();
    if (view.searchOpen) $('q-search').focus();
  };
  $('set-menu').onclick = (e) => menu(e.currentTarget, recs);
  paintProgress();
}

function paintFilterCounts() {
  const { c } = counts();
  for (const b of document.querySelectorAll('[data-filter]')) {
    const n = b.querySelector('.n');
    if (n) n.textContent = c[b.dataset.filter];
  }
}

function menu(anchor, recs) {
  document.querySelector('.pop.menu')?.remove();
  const pop = document.createElement('div');
  pop.className = 'pop menu';
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + scrollY + 6 + 'px';
  pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
  const prompt = `Read the new answers in the hitl question set "${view.setId}" (get_answers, filter "new"; or \`npx hitloop answers ${view.setId} --new\`), apply them, and ack each one with a short note.`;
  pop.innerHTML = `
    <button class="menu-item" data-m="accept" ${recs && !info.readOnly ? '' : 'disabled'}>${icon('sparkles', 16)}Take every recommendation${recs ? ` (${recs} unanswered)` : ''}</button>
    <button class="menu-item" data-m="prompt">${icon('copy', 16)}Copy a prompt for the agent</button>
    <button class="menu-item" data-m="link">${icon('link', 16)}Copy a link to this set</button>
    <label class="menu-item check"><input type="checkbox" data-m="advance" ${store('advance') === '0' ? '' : 'checked'} />Cards: move on after a pick</label>`;
  document.body.append(pop);
  const close = (e) => {
    if (e && pop.contains(e.target)) return;
    pop.remove();
    removeEventListener('pointerdown', close, true);
  };
  setTimeout(() => addEventListener('pointerdown', close, true));
  pop.onclick = async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    if (m === 'advance') return store('advance', e.target.checked ? null : '0');
    close();
    if (m === 'prompt') copy(prompt, 'Prompt copied');
    else if (m === 'link') copy(location.origin + location.pathname + setHref(view.key, view.setId), 'Link copied');
    else if (m === 'accept') acceptRecommended(allQuestions(view.data.set));
  };
}

/** unanswered visible questions that have a recommendation */
function acceptable(qs) {
  return qs.filter((q) => view.vis.question(q.id) && !isDone(view.data.answers.answers[q.id]) && recommendedAnswer(q));
}

async function acceptRecommended(qs) {
  const ids = acceptable(qs).map((q) => q.id);
  if (!ids.length) return toast('Nothing to take');
  if (!confirm(`Take the recommended answer for ${ids.length} question${ids.length === 1 ? '' : 's'}? You can change any of them after.`)) return;
  const r = await api(`api/q/${encodeURIComponent(view.setId)}/accept`, { method: 'POST', json: { ids } });
  view.data.answers = r.answers;
  for (const id of r.taken) afterChange(id, { redraw: true, quietVis: true });
  afterChange(null, {});
  toast(`Took ${r.taken.length} recommendation${r.taken.length === 1 ? '' : 's'}`);
}

// ── the list ──
function paintBody() {
  const body = $('set-body');
  if (!body) return;
  if (view.mode === 'cards') return paintCards();
  view.cards.clear();
  body.className = 'set-list';
  body.innerHTML = '';
  const set = view.data.set;
  let any = false;
  for (const s of set.sections) {
    const qs = s.questions.filter((q) => view.shown.has(q.id));
    if (!qs.length) continue;
    any = true;
    const sec = document.createElement('section');
    sec.className = 'sec';
    sec.dataset.s = s.id;
    sec.style.setProperty('--hue', hueOf(s.id));
    if (s.title || s.intro || s.content.length) {
      const h = document.createElement('header');
      h.className = 'sec-head';
      const n = set.sections.filter((x) => x.title).indexOf(s) + 1;
      h.innerHTML = s.title ? `<h2><span class="sec-num">${n}</span><span>${esc(s.title)}</span></h2>` : '';
      if (s.intro) h.append(md(s.intro, '', 'sec-intro'));
      if (s.content.length) {
        const c = document.createElement('div');
        c.className = 'q-content';
        renderBlocks(c, s.content);
        h.append(c);
      }
      sec.append(h);
    }
    const tools = document.createElement('div');
    tools.className = 'sec-tools';
    sec.append(tools);
    for (const q of qs) {
      const card = renderQuestion(q, ctx, { hidden: !view.vis.question(q.id) });
      card.__hidden = !view.vis.question(q.id);
      view.cards.set(q.id, card);
      sec.append(card);
    }
    body.append(sec);
    paintSectionTools(s.id);
  }
  if (!any) body.innerHTML = emptyText();
}

function paintSectionTools(sid) {
  const sec = document.querySelector(`.sec[data-s="${CSS.escape(sid)}"]`);
  const tools = sec?.querySelector('.sec-tools');
  if (!tools) return;
  const s = view.data.set.sections.find((x) => x.id === sid);
  const vis = s.questions.filter((q) => view.vis.question(q.id));
  const done = vis.filter((q) => isDone(view.data.answers.answers[q.id])).length;
  const recs = acceptable(s.questions).length;
  const pct = vis.length ? (done / vis.length) * 100 : 0;
  tools.innerHTML = `<span class="sec-count"><span class="mini-bar"><span style="width:${pct}%"></span></span>${done} of ${vis.length}</span>${recs && !info.readOnly ? `<button class="ghost-btn" data-accept>${icon('sparkles', 15)}Take ${recs === 1 ? 'the recommendation' : `all ${recs} recommendations`}</button>` : ''}`;
  const b = tools.querySelector('[data-accept]');
  if (b) b.onclick = () => acceptRecommended(s.questions);
}

function emptyText() {
  const { summary } = counts();
  if (view.search) return `<div class="empty"><p>No questions match “${esc(view.search)}”.</p></div>`;
  if (view.filter === 'todo') return `<div class="empty done-all"><div class="big-check">${icon('check', 44)}<i></i><i></i><i></i><i></i><i></i><i></i></div><h2>All answered</h2><p>${summary.done} of ${summary.visible} questions answered. The agent picks them up from here.</p></div>`;
  return `<div class="empty"><p>Nothing here.</p></div>`;
}

function redrawCard(qid, opts = {}) {
  const card = view?.cards.get(qid);
  const q = questionById(view.data.set, qid);
  if (!card || !q) return;
  const threadOpen = opts.threadOpen ?? !card.querySelector('.q-thread')?.hidden;
  draw(card, q, ctx, { hidden: !view.vis.question(qid), threadOpen });
  card.__hidden = !view.vis.question(qid);
}

/** after an answer changes: what shows, the counts, the card */
function afterChange(qid, { redraw = false, quietVis = false } = {}) {
  if (!view) return;
  const before = view.vis;
  view.vis = visibility(view.data.set, view.data.answers.answers);
  if (qid) {
    if (redraw) redrawCard(qid);
    else {
      const card = view.cards.get(qid);
      const q = questionById(view.data.set, qid);
      if (card && q) refreshTop(card, q, ctx, { hidden: !view.vis.question(qid) });
    }
  }
  if (quietVis) return;
  // questions whose visibility changed: shown ones join the list (if the filter wants them), hidden ones fold away
  const revealed = [];
  for (const q of allQuestions(view.data.set)) {
    const was = before.question(q.id);
    const now = view.vis.question(q.id);
    if (was === now) continue;
    if (now && matches(q, view.filter) && searchHit(q, view.search)) {
      view.shown.add(q.id);
      revealed.push(q.id);
    }
    if (!now && view.filter !== 'hidden') view.shown.delete(q.id);
    if (view.filter === 'hidden' && now) view.shown.delete(q.id);
  }
  const changedVis = allQuestions(view.data.set).some((q) => before.question(q.id) !== view.vis.question(q.id));
  if (changedVis) {
    if (view.mode === 'cards') {
      const cur = view.order[view.index];
      view.order = cardOrder();
      const at = view.order.indexOf(cur);
      view.index = at >= 0 ? at : Math.min(view.index, view.order.length - 1);
      paintCardNav();
    } else {
      const anchor = qid ? view.cards.get(qid) : null;
      const top = anchor?.getBoundingClientRect().top;
      const changed = allQuestions(view.data.set).filter((q) => before.question(q.id) !== view.vis.question(q.id)).map((q) => q.id);
      if (!patchList(changed)) {
        const y = scrollY;
        paintBody();
        scrollTo(0, y);
      }
      // keep the card you touched where it was on screen
      const again = qid ? view.cards.get(qid) : null;
      if (again && top !== undefined) scrollTo(0, scrollY + again.getBoundingClientRect().top - top);
      for (const id of revealed) view.cards.get(id)?.classList.add('revealed');
      for (const s of view.data.set.sections) paintSectionTools(s.id);
    }
    if (revealed.length) toast(`${revealed.length} follow-up question${revealed.length === 1 ? '' : 's'} opened`);
  } else if (view.mode === 'list') {
    const q = qid && questionById(view.data.set, qid);
    if (q) paintSectionTools(q.section);
  }
  paintProgress();
}

/** Add and take away just the cards whose visibility changed. False when a section has to appear (draw it all). */
function patchList(changed) {
  const set = view.data.set;
  for (const id of changed) {
    const q = questionById(set, id);
    if (!q) continue;
    const want = view.shown.has(id);
    const card = view.cards.get(id);
    if (!want) {
      card?.remove();
      view.cards.delete(id);
      continue;
    }
    if (card) {
      redrawCard(id);
      continue;
    }
    const sec = document.querySelector(`.sec[data-s="${CSS.escape(q.section)}"]`);
    if (!sec) return false;
    const fresh = renderQuestion(q, ctx, { hidden: !view.vis.question(id) });
    fresh.__hidden = !view.vis.question(id);
    const siblings = set.sections.find((s) => s.id === q.section)?.questions ?? [];
    let after = sec.querySelector('.sec-tools');
    for (const x of siblings) {
      if (x.id === id) break;
      const c = view.cards.get(x.id);
      if (c?.isConnected) after = c;
    }
    after.after(fresh);
    view.cards.set(id, fresh);
  }
  for (const sec of document.querySelectorAll('.sec')) if (!sec.querySelector('.q-card')) sec.remove();
  if (!document.querySelector('.sec')) $('set-body').innerHTML = emptyText();
  return true;
}

function paintProgress() {
  const { c, summary } = counts();
  const pct = summary.visible ? (summary.done / summary.visible) * 100 : 0;
  const bar = document.querySelector('.tools-progress span');
  if (bar) bar.style.width = pct + '%';
  const r = $('hero-ring');
  if (r) r.innerHTML = ring(summary.done, summary.visible, 64);
  const stats = $('hero-stats');
  if (stats)
    stats.innerHTML = [
      `<span class="stat"><b>${summary.done}</b> of ${summary.visible} answered</span>`,
      summary.blocking ? `<span class="badge danger">${icon('warning', 12)}${summary.blocking} blocking</span>` : '',
      summary.changed ? `<span class="badge warn">${summary.changed} changed</span>` : '',
      summary.later ? `<span class="badge">${summary.later} for later</span>` : '',
      !summary.toAnswer && summary.visible ? `<span class="badge ok">${icon('check', 12)}All answered</span>` : '',
    ].join('');
  document.title = `${summary.toAnswer ? `(${summary.toAnswer}) ` : ''}${view.data.set.title} · hitl`;
  for (const b of document.querySelectorAll('[data-filter]')) {
    const n = b.querySelector('.n');
    if (n) n.textContent = c[b.dataset.filter];
  }
}

function firstOnScreen() {
  for (const [id, card] of view.cards) if (card.getBoundingClientRect().bottom > 120) return id;
  return '';
}

function focusQuestion(qid) {
  if (!view) return;
  if (!view.shown.has(qid)) {
    // the filter hides it: show everything so it can be seen
    view.filter = view.vis.question(qid) ? 'all' : 'hidden';
    computeShown();
    paintTools();
    paintBody();
  }
  if (view.mode === 'cards') {
    const at = view.order.indexOf(qid);
    if (at >= 0) showCard(at);
    return;
  }
  const card = view.cards.get(qid);
  if (!card) return;
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

// ── cards: one question at a time ──
function cardOrder() {
  return allQuestions(view.data.set)
    .filter((q) => view.shown.has(q.id) && (view.vis.question(q.id) || view.filter === 'hidden'))
    .map((q) => q.id);
}

function paintCards() {
  const body = $('set-body');
  body.className = 'set-cards';
  view.order = cardOrder();
  view.index = Math.min(view.index, Math.max(0, view.order.length - 1));
  body.innerHTML = `<div class="card-stage" id="card-stage"></div><nav class="card-nav" id="card-nav"></nav>`;
  showCard(view.index);
  const stage = $('card-stage');
  let sx = 0,
    sy = 0,
    st = 0;
  stage.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      st = Date.now();
    },
    { passive: true },
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx,
        dy = t.clientY - sy;
      if (Date.now() - st < 600 && Math.abs(dx) > 70 && Math.abs(dy) < 50 && !e.target.closest('input,textarea,.ui-code,.md-table,iframe')) {
        if (dx < 0) nextCard();
        else prevCard();
      }
    },
    { passive: true },
  );
}

function showCard(i) {
  if (!view || view.mode !== 'cards') return;
  const stage = $('card-stage');
  if (!stage) return;
  view.cards.clear();
  view.index = Math.max(0, Math.min(i, view.order.length - 1));
  const qid = view.order[view.index];
  if (!qid) {
    stage.innerHTML = emptyText();
    paintCardNav();
    return;
  }
  const q = questionById(view.data.set, qid);
  const s = view.data.set.sections.find((x) => x.id === q.section);
  const pos = s.questions.filter((x) => view.vis.question(x.id)).findIndex((x) => x.id === qid) + 1;
  const total = s.questions.filter((x) => view.vis.question(x.id)).length;
  stage.style.setProperty('--hue', hueOf(s.id));
  stage.innerHTML = s.title ? `<div class="card-section"><span class="sec-num">${set_n(s)}</span><b>${esc(s.title)}</b><span class="muted">${pos} of ${total}</span></div>` : '';
  if (s.intro && pos === 1) stage.append(md(s.intro, '', 'sec-intro'));
  const card = renderQuestion(q, ctx, { hidden: !view.vis.question(qid) });
  card.__hidden = !view.vis.question(qid);
  view.cards.set(qid, card);
  stage.append(card);
  paintCardNav();
  history.replaceState(null, '', setHref(view.key, view.setId, qid));
  scrollTo({ top: Math.max(0, stage.getBoundingClientRect().top + scrollY - 120), behavior: 'instant' });
}

const set_n = (s) => view.data.set.sections.filter((x) => x.title).indexOf(s) + 1;

function paintCardNav() {
  const nav = $('card-nav');
  if (!nav) return;
  const n = view.order.length;
  const todo = view.order.filter((id) => !isDone(view.data.answers.answers[id])).length;
  const pct = n ? ((view.index + 1) / n) * 100 : 0;
  nav.innerHTML = `<button class="nav-btn" data-nav="-1" aria-label="Back" ${view.index <= 0 ? 'disabled' : ''}>${icon('chevron-left', 22)}</button><span class="card-pos"><span><b>${n ? view.index + 1 : 0}</b> / ${n}</span><span class="mini-bar"><span style="width:${pct}%"></span></span><small>${todo} to answer</small></span><button class="nav-btn primary" data-nav="1" ${view.index >= n - 1 ? 'disabled' : ''}><span>Next</span>${icon('chevron-right', 20)}</button>`;
  nav.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => (b.dataset.nav === '1' ? nextCard() : prevCard())));
}

/** the next card; after a pick, the next one still to answer */
function nextCard(unanswered = false) {
  let i = view.index + 1;
  if (unanswered) while (i < view.order.length && isDone(view.data.answers.answers[view.order[i]])) i++;
  if (i >= view.order.length) i = view.index + 1;
  if (i < view.order.length) showCard(i);
  else toast('That was the last one');
}
const prevCard = () => view.index > 0 && showCard(view.index - 1);

addEventListener('keydown', (e) => {
  if (!view || !main?.isConnected || view.mode !== 'cards' || e.target.closest?.('input,textarea,select') || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowRight' || e.key === 'j') nextCard();
  else if (e.key === 'ArrowLeft' || e.key === 'k') prevCard();
});

// links to a question (its id in the corner)
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-link]');
  if (!a || !view) return;
  e.preventDefault();
  const url = location.origin + location.pathname + setHref(view.key, view.setId, a.dataset.link);
  copy(url, 'Link to the question copied');
});

// ── live: when the files change (an agent adds questions or replies, another device answers) ──
let reloading = null;
async function reloadSet() {
  if (!main?.isConnected || !main.querySelector('.set-page')) view = null;
  if (!view) return;
  const key = view.key,
    setId = view.setId;
  let data;
  try {
    data = await api(`api/q/${encodeURIComponent(setId)}`);
  } catch {
    return;
  }
  if (!view || view.key !== key || view.setId !== setId) return;
  const old = view.data;
  const shape = shapeOf(data.set);
  view.data = data;
  if (old.set.status !== data.set.status) {
    // dismissed or brought back: draw the top again (its button and the closed note)
    view.shape = shape;
    view.vis = visibility(data.set, data.answers.answers);
    renderSet();
    return;
  }
  if (shape !== view.shape) {
    // the questions changed: draw again, keeping the place
    view.shape = shape;
    view.vis = visibility(data.set, data.answers.answers);
    const keep = view.mode === 'cards' ? view.order[view.index] : firstOnScreen();
    const oldIds = new Set(allQuestions(old.set).map((q) => q.id));
    const added = allQuestions(data.set).filter((q) => !oldIds.has(q.id)).length;
    const shown = view.shown;
    computeShown();
    for (const id of shown) if (questionById(data.set, id)) view.shown.add(id);
    const y = scrollY;
    paintTools();
    paintBody();
    if (view.mode === 'cards' && keep) {
      const at = view.order.indexOf(keep);
      if (at >= 0) showCard(at);
    } else scrollTo(0, y);
    if (added) toast(`${added} new question${added === 1 ? '' : 's'}`);
    return;
  }
  // only answers or threads changed: redraw the cards that changed (not one you're typing in)
  const before = view.vis;
  view.vis = visibility(data.set, data.answers.answers);
  for (const q of allQuestions(data.set)) {
    const a = old.answers.answers[q.id],
      b = data.answers.answers[q.id];
    const ta = old.answers.threads[q.id]?.length || 0,
      tb = data.answers.threads[q.id]?.length || 0;
    const differs = (a?.seq ?? -1) !== (b?.seq ?? -1) || JSON.stringify(a?.ack) !== JSON.stringify(b?.ack) || ta !== tb;
    if (!differs) continue;
    const card = view.cards.get(q.id);
    if (card && !card.contains(document.activeElement)) redrawCard(q.id);
  }
  view.vis = before;
  if ((old.answers.threads['']?.length || 0) !== (data.answers.threads['']?.length || 0)) paintWhole();
  afterChange(null, {});
}

// ── comment on a selection: on the question it's in (its thread), or on the whole set ──
addSelectionTarget((range, node) => {
  if (!view || !main?.isConnected || info.readOnly || !main.contains(node) || !node.closest('.set-page')) return null;
  const card = node.closest('.q-card[data-q]');
  const q = card ? questionById(view.data.set, card.dataset.q) : null;
  const text = q ? q.question.replace(/\s+/g, ' ') : '';
  return {
    where: q ? `question ${q.id}: “${text.length > 60 ? text.slice(0, 57) + '…' : text}”` : 'the whole set',
    submit: ({ body, quote }) => ctx.message(q ? q.id : '', body, quote),
  };
});

/** the shell left this view */
export function leaveSet() {
  view = null;
}

/** a change in a project's requests (from the shell's event stream) */
export function setChanged(d) {
  if (view && d.project === view.key && d.id === view.setId) {
    clearTimeout(reloading);
    reloading = setTimeout(reloadSet, 150);
  }
}
