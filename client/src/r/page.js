// A review: what an agent put in front of the human (files, code, text, diffs, pictures, diagrams, mockups, links),
// with a verdict on each item, comments on lines, on a selection or on a marked area of a picture (with photos), and
// a verdict on the whole. "show" reviews ask for no verdicts; "approve" ones ask one yes or no. As a list, or one item
// at a time to swipe through (right: looks good, left: needs changes). Live: the agent's replies and new items appear
// as they come, and so does what you do on another device.
import { api, esc, ago, debounce, toast, copy, extOf, rawUrl, purl, store } from '../util.js';
import { state, fileHref } from '../state.js';
import { icon } from '../icons.js';
import { markdownHtml, renderMarkdown } from '../markdown.js';
import { drawInto } from '../mermaid.js';
import { renderDiff } from '../code.js';
import { linesView } from '../lines.js';
import { jsonTree, table } from '../file.js';
import { startInk, marksSvg } from '../ink.js';
import { photoInputHtml, readPhotos, photosHtml } from '../photos.js';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']);
const VERDICT = {
  ok: { label: 'Looks good', short: 'Good', icon: 'check' },
  changes: { label: 'Needs changes', short: 'Changes', icon: 'edit' },
  no: { label: 'No', short: 'No', icon: 'x' },
};
const APPROVE = { ok: 'Approve', no: 'Refuse', changes: 'Not yet' };
const KIND_ICON = { file: 'file', code: 'code', text: 'file', md: 'file', json: 'code', diff: 'diff', image: 'image', mermaid: 'diff', html: 'monitor', link: 'external' };

let view = null;
let main = null;

export const reviewHref = (key, id, item) => `#/p/${encodeURIComponent(key)}/r/${encodeURIComponent(id)}${item ? `/${encodeURIComponent(item)}` : ''}`;

/** open a review in the container (the same review again just moves to the item) */
export async function showReview(container, key, id, focus) {
  if (view && view.key === key && view.id === id && main === container && container.querySelector('.rv-page')) {
    if (focus) focusItem(focus);
    return;
  }
  main = container;
  const data = await api(`api/r/${encodeURIComponent(id)}`);
  view = { key, id, data, shape: shapeOf(data), mode: store('rv-mode') === 'swipe' ? 'swipe' : 'list', filter: 'all', index: 0, inks: new Map() };
  if (data.review.mode !== 'review' || data.review.items.length < 2) view.mode = 'list';
  document.title = `${data.review.title} · hitl`;
  render();
  if (focus) focusItem(focus);
  else if (view.mode === 'swipe') showCard(firstTodo());
}

export function leaveReview() {
  view = null;
}

/** a change in a project's requests (from the shell's event stream) */
let reloading;
export function reviewChanged(d) {
  if (!view || d.project !== view.key || d.id !== view.id) return;
  clearTimeout(reloading);
  reloading = setTimeout(reload, 150);
}

const shapeOf = (d) => JSON.stringify([d.review.title, d.review.intro, d.review.mode, d.review.status, d.review.items.map((i) => [i.id, i.rev, i.title, i.note, i.ask]), d.files]);
const items = () => view.data.review.items;
const fb = () => view.data.feedback;
const ro = () => !!state.info.readOnly;
const isReview = () => view.data.review.mode === 'review';
const isGate = () => view.data.review.mode === 'approve';
const verdictOf = (iid) => fb().items[iid];
const commentsOf = (iid) => fb().comments.filter((c) => c.item === iid);
const firstTodo = () => Math.max(0, items().findIndex((i) => !verdictOf(i.id)));

async function reload() {
  if (!view || !main?.isConnected) return;
  let data;
  try {
    data = await api(`api/r/${encodeURIComponent(view.id)}`);
  } catch {
    return;
  }
  if (!view) return;
  const shape = shapeOf(data);
  const old = view.data;
  view.data = data;
  if (shape !== view.shape) {
    const added = data.review.items.length - old.review.items.length;
    view.shape = shape;
    const y = scrollY;
    render();
    scrollTo(0, y);
    if (added > 0) toast(`${added} new item${added === 1 ? '' : 's'} from the agent`);
    return;
  }
  // only feedback changed: redraw what changed, leaving alone anything being typed in
  for (const it of items()) {
    const card = main.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
    if (!card || card.contains(document.activeElement)) continue;
    const a = JSON.stringify([old.feedback.items[it.id], old.feedback.comments.filter((c) => c.item === it.id)]);
    const b = JSON.stringify([verdictOf(it.id), commentsOf(it.id)]);
    if (a !== b) paintFeedback(card, it);
  }
  const whole = main.querySelector('[data-item=""]');
  if (whole && !whole.contains(document.activeElement)) paintWholeComments(whole);
  paintProgress();
  paintFinish();
}

// ── the page ──

function render() {
  const r = view.data.review;
  const project = state.hub.projects.find((p) => p.key === view.key);
  const page = document.createElement('div');
  page.className = `page-wrap rv-page mode-${r.mode}`;
  const modeLabel = isGate() ? 'Approval' : r.mode === 'show' ? 'To look at' : 'Review';
  page.innerHTML = `<header class="rv-hero${isGate() ? ' gate' : ''}">
    <span class="eyebrow">${esc(project?.name || view.key)} · ${modeLabel}${r.from ? ` · from ${esc(r.from)}` : ''}${r.updated ? ` · ${esc(ago(Date.parse(r.updated)))}` : ''}</span>
    <h1>${isGate() ? `${icon('warning', 22)} ` : ''}${esc(r.title)}</h1>
    <div class="rv-intro"></div>
    <div class="rv-progress" id="rv-progress"></div>
    ${view.data.errors.length ? `<details class="problems"><summary>${icon('warning', 16)} ${view.data.errors.length} problem${view.data.errors.length === 1 ? '' : 's'} in this review's file (the agent can fix them: <code>hitl validate ${esc(view.id)}</code>)</summary><ul>${view.data.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
    ${r.status === 'closed' ? `<p class="rv-closed">${icon('check', 14)} The agent closed this ${r.mode === 'approve' ? 'question' : 'review'}.</p>` : ''}
  </header>
  ${items().length && !isGate() ? `<div class="rv-tools" id="rv-tools"></div>` : ''}
  <div class="rv-items" id="rv-items"></div>
  <section class="rv-finish" id="rv-finish"></section>
  <section class="rv-whole" data-item=""></section>`;
  if (r.intro) renderMarkdown(page.querySelector('.rv-intro'), r.intro, '');
  main.replaceChildren(page);
  paintTools();
  paintItems();
  paintProgress();
  paintFinish();
  paintWholeComments(page.querySelector('.rv-whole'));
}

function paintTools() {
  const t = main.querySelector('#rv-tools');
  if (!t) return;
  const n = items().length;
  const todo = items().filter((i) => !verdictOf(i.id)).length;
  t.innerHTML = `${isReview() ? `<div class="seg" role="tablist">${[
    ['all', `All ${n}`],
    ['todo', `To review ${todo}`],
    ['changes', 'Needs changes'],
    ['comments', 'Comments'],
  ]
    .map(([k, l]) => `<button class="seg-btn${view.filter === k ? ' on' : ''}" data-filter="${k}">${l}</button>`)
    .join('')}</div>` : ''}<span class="grow"></span>${
    isReview() && n > 1 ? `<div class="seg"><button class="seg-btn${view.mode === 'list' ? ' on' : ''}" data-mode="list">${icon('menu', 15)} List</button><button class="seg-btn${view.mode === 'swipe' ? ' on' : ''}" data-mode="swipe">${icon('cards', 15)} One at a time</button></div>` : ''
  }`;
  t.onclick = (e) => {
    const f = e.target.closest('[data-filter]');
    const m = e.target.closest('[data-mode]');
    if (f) {
      view.filter = f.dataset.filter;
      paintTools();
      paintItems();
    } else if (m) {
      view.mode = m.dataset.mode;
      store('rv-mode', view.mode);
      paintTools();
      paintItems();
      if (view.mode === 'swipe') showCard(firstTodo());
    }
  };
}

function shownItems() {
  return items().filter((it) => {
    if (view.filter === 'todo') return !verdictOf(it.id);
    if (view.filter === 'changes') return verdictOf(it.id) && verdictOf(it.id).verdict !== 'ok';
    if (view.filter === 'comments') return commentsOf(it.id).length > 0;
    return true;
  });
}

function paintItems() {
  const host = main.querySelector('#rv-items');
  for (const ink of view.inks.values()) ink.stop();
  view.inks.clear();
  if (view.mode === 'swipe') {
    host.innerHTML = `<div class="rv-stage" id="rv-stage"></div><nav class="rv-swipebar" id="rv-swipebar"></nav>`;
    return;
  }
  host.replaceChildren();
  const list = shownItems();
  if (!list.length) {
    host.innerHTML = `<p class="empty">${view.filter === 'todo' ? `${icon('check', 18)} Everything has a verdict.` : 'Nothing here.'}</p>`;
    return;
  }
  for (const it of list) host.append(itemCard(it));
}

function itemCard(it) {
  const n = items().indexOf(it) + 1;
  const card = document.createElement('article');
  card.className = 'rv-item';
  card.dataset.item = it.id;
  card.id = 'item-' + it.id;
  const f = view.data.files?.[it.id];
  const openFile = it.kind === 'file' && it.file && f?.exists !== false ? `<a class="icon-btn" href="${fileHref(it.file, it.lines ? { line: it.lines } : {})}" title="Open in Files" aria-label="Open in Files">${icon('folder-open', 16)}</a>` : '';
  card.innerHTML = `<header class="rv-ihead"><span class="rv-n">${n}</span><span class="rv-kind">${icon(KIND_ICON[it.kind] || 'file', 16)}</span><h3 class="rv-title">${esc(it.title)}</h3><span class="rv-chip"></span>${openFile}<button class="icon-btn" data-act="fold" title="Fold" aria-label="Fold">${icon('chevron-down', 16)}</button></header>
  ${f && !f.exists ? `<p class="rv-banner warn">${icon('warning', 14)} This file isn't there any more.${it.snap ? ' Showing the copy kept when it was shown.' : ''}</p>` : ''}
  ${f?.changed ? `<p class="rv-banner">${icon('diff', 14)} Changed since it was shown. <button class="link-btn" data-act="since">See what changed</button></p><div class="rv-since" hidden></div>` : ''}
  ${it.note ? `<div class="rv-note md">${markdownHtml(it.note, '')}</div>` : ''}
  <div class="rv-body"></div>
  ${it.ask ? `<p class="rv-ask">${icon('chat', 15)} ${esc(it.ask)}</p>` : ''}
  <div class="rv-verdict"></div>
  <div class="rv-comments"></div>
  ${ro() ? '' : `<div class="rv-cbar"><button class="btn small" data-act="comment">${icon('chat', 14)} <span>Comment</span></button>${isPicture(it) ? `<button class="btn small" data-act="mark">${icon('pen', 14)} Mark an area</button>` : ''}</div>`}`;
  if (it.collapsed) card.classList.add('folded');
  const body = card.querySelector('.rv-body');
  drawBody(body, it, card);
  paintFeedback(card, it);
  wireCard(card, it);
  return card;
}

const isPicture = (it) => it.kind === 'image' || (it.kind === 'file' && IMAGE.has(extOf(it.file || '')) && !it.against);
const fileUrl = (it) => (view.data.files?.[it.id]?.exists === false && it.snap ? rawUrl(it.snap.path) : rawUrl(it.file));
const picUrl = (src) => (/^(https?:|data:image\/)/i.test(src) ? src : rawUrl(String(src).replace(/^\.?\//, '')));

// ── each kind's view ──

function drawBody(body, it, card) {
  const comment = (a, b, quote) => openComposer(card, it, { line: a, endLine: b, quote });
  const asCode = (text, name, first = 1, caption) => {
    const v = linesView(body, { text, name, first, caption, onComment: ro() ? null : comment, readOnly: ro() });
    card.lines = v;
    placeLineThreads(card, it);
  };
  switch (it.kind) {
    case 'file': {
      const ext = extOf(it.file);
      if (it.against) return void diffInto(body, it, card, `${it.file} · since ${it.against}`);
      if (IMAGE.has(ext)) return void pictureInto(body, it, card, fileUrl(it), '');
      if (VIDEO.has(ext)) return void (body.innerHTML = `<video controls preload="metadata" src="${esc(fileUrl(it))}"></video>`);
      if (AUDIO.has(ext)) return void (body.innerHTML = `<audio controls preload="metadata" src="${esc(fileUrl(it))}"></audio>`);
      if (ext === 'pdf') return void (body.innerHTML = `<a class="blk-link" href="${esc(fileUrl(it))}" target="_blank" rel="noopener">${icon('file', 16)}<span>Open the PDF</span></a>`);
      if ((ext === 'html' || ext === 'htm') && !it.lines) {
        body.innerHTML = `<div class="rv-tabs"><button class="seg-btn on" data-tab="page">Page</button><button class="seg-btn" data-tab="source">Source</button></div><div class="rv-tab"></div>`;
        const tab = body.querySelector('.rv-tab');
        const page = () => (tab.innerHTML = `<iframe class="blk-html" sandbox="" src="${esc(fileUrl(it))}?as=page" style="height:420px" title="${esc(it.file)}"></iframe>`);
        page();
        body.querySelector('.rv-tabs').onclick = async (e) => {
          const b = e.target.closest('[data-tab]');
          if (!b) return;
          body.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
          if (b.dataset.tab === 'page') return page();
          const r = await fetchText(it);
          if (r) linesInto(tab, r, it, card);
        };
        return;
      }
      body.innerHTML = '<div class="skeleton" style="height:96px"></div>';
      fetchText(it).then((r) => {
        if (!r) return void (body.innerHTML = `<p class="problem">${esc(it.file)}: can't be shown as text. <a href="${esc(fileUrl(it))}" download>Download it</a>.</p>`);
        if ((ext === 'md' || ext === 'markdown' || ext === 'mdx') && !it.lines) return renderedOrSource(body, it, card, r.text, (el) => renderMarkdown(el, r.text, it.file.includes('/') ? it.file.slice(0, it.file.lastIndexOf('/')) : ''));
        if ((ext === 'csv' || ext === 'tsv') && !it.lines) return renderedOrSource(body, it, card, r.text, (el) => table(el, r.text, ext === 'tsv' ? '\t' : ','));
        if ((ext === 'mmd' || ext === 'mermaid') && !it.lines) return renderedOrSource(body, it, card, r.text, (el) => drawInto(el, r.text));
        if ((ext === 'json' || ext === 'jsonc') && !it.lines && r.text.length < 2_000_000) {
          try {
            const v = JSON.parse(r.text);
            return renderedOrSource(body, it, card, r.text, (el) => (el.innerHTML = `<div class="jtree">${jsonTree(v, 0)}</div>`));
          } catch {
            // not JSON after all: as code
          }
        }
        linesInto(body, r, it, card);
        if (r.truncated) body.insertAdjacentHTML('beforeend', '<p class="muted small">Only the start of this file is shown (it is large).</p>');
      });
      return;
    }
    case 'code':
      if (it.before !== undefined) return void beforeAfterText(body, it, card, it.code, it.name || `x.${it.lang || 'txt'}`);
      return asCode(it.code, it.name || `x.${it.lang || 'txt'}`, 1, `${it.name || it.lang || 'code'} · ${it.code.split('\n').length} lines`);
    case 'text':
      if (it.before !== undefined) return void beforeAfterText(body, it, card, it.text, it.name || 'text.txt');
      return asCode(it.text, it.name || 'text.txt', 1, it.name || 'text');
    case 'md':
      return renderedOrSource(body, it, card, it.md, (el) => renderMarkdown(el, it.md, ''));
    case 'json':
      body.innerHTML = `<div class="jtree">${jsonTree(it.json, 0)}</div>`;
      return;
    case 'diff':
      return diffInto(body, it, card, it.title, it.diff);
    case 'image':
      if (it.before) return void compareInto(body, it, card);
      return pictureInto(body, it, card, picUrl(it.image), it.alt || '');
    case 'mermaid': {
      const d = document.createElement('div');
      d.className = 'md-diagram';
      body.append(d);
      drawInto(d, it.mermaid);
      return;
    }
    case 'html': {
      const f = document.createElement('iframe');
      f.className = 'blk-html';
      f.setAttribute('sandbox', '');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.style.height = (it.height || 360) + 'px';
      f.title = it.title;
      f.srcdoc = '<style>html,body{margin:0;min-height:100%}</style>' + it.html;
      body.append(f);
      return;
    }
    case 'link': {
      let host = '';
      try {
        host = new URL(it.link).host;
      } catch {
        host = '';
      }
      body.innerHTML = `<a class="blk-link" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${icon('external', 16)}<span>${esc(it.label || it.link)}</span><small>${esc(host)}</small></a>`;
      return;
    }
  }
}

async function fetchText(it) {
  const p = view.data.files?.[it.id]?.exists === false && it.snap ? it.snap.path : it.file;
  try {
    return await api(`api/text?path=${encodeURIComponent(p)}${it.lines ? '&lines=' + encodeURIComponent(it.lines) : ''}`);
  } catch {
    return null;
  }
}

function linesInto(host, r, it, card) {
  const caption = it.lines ? `${it.file} · lines ${r.first}–${r.first + r.text.split('\n').length - 1} of ${r.total}` : `${it.file} · ${r.total.toLocaleString()} lines`;
  card.lines = linesView(host, { text: r.text, name: it.file, first: r.first, caption, onComment: ro() ? null : (a, b, quote) => openComposer(card, it, { line: a, endLine: b, quote }), readOnly: ro() });
  placeLineThreads(card, it);
}

/** markdown, a table, a diagram: drawn, with the source a tap away (where lines can be commented on) */
function renderedOrSource(body, it, card, text, drawn) {
  body.innerHTML = `<div class="rv-tabs"><button class="seg-btn on" data-tab="view">Rendered</button><button class="seg-btn" data-tab="source">Source</button></div><div class="rv-tab"></div>`;
  const tab = body.querySelector('.rv-tab');
  const showView = () => {
    tab.innerHTML = '<div class="md rv-rendered"></div>';
    drawn(tab.firstElementChild);
    card.lines = null;
  };
  showView();
  body.querySelector('.rv-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    body.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    if (b.dataset.tab === 'view') return showView();
    card.lines = linesView(tab, { text, name: it.file || it.name || 'notes.md', onComment: ro() ? null : (a, c, quote) => openComposer(card, it, { line: a, endLine: c, quote }), readOnly: ro() });
    placeLineThreads(card, it);
  };
  // a line comment can't be seen on the rendered view: say so
  if (commentsOf(it.id).some((c) => c.line)) body.querySelector('[data-tab="source"]').insertAdjacentHTML('beforeend', ` <span class="count">${commentsOf(it.id).filter((c) => c.line).length}</span>`);
}

/** code or text with an earlier version: after, before, or the changes */
function beforeAfterText(body, it, card, after, name) {
  body.innerHTML = `<div class="rv-tabs"><button class="seg-btn on" data-tab="after">After</button><button class="seg-btn" data-tab="before">Before</button><button class="seg-btn" data-tab="changes">${icon('diff', 14)} Changes</button></div><div class="rv-tab"></div>`;
  const tab = body.querySelector('.rv-tab');
  const show = async (which) => {
    body.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === which));
    card.lines = null;
    if (which === 'after') {
      card.lines = linesView(tab, { text: after, name, onComment: ro() ? null : (a, b, quote) => openComposer(card, it, { line: a, endLine: b, quote }), readOnly: ro() });
      placeLineThreads(card, it);
    } else if (which === 'before') {
      linesView(tab, { text: it.before, name, caption: 'Before', readOnly: true });
    } else {
      tab.innerHTML = '<div class="skeleton" style="height:96px"></div>';
      const d = await api(`api/r/${encodeURIComponent(view.id)}/diff?item=${encodeURIComponent(it.id)}`).catch((e) => `error: ${e.message}`);
      diffInto(tab, it, card, 'Before → after', d);
    }
  };
  body.querySelector('.rv-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  };
  show(store('rv-ba') === 'changes' ? 'changes' : 'after');
}

/** a unified diff (given, or fetched for a file against a revision), with comments on its lines */
async function diffInto(host, it, card, caption, text) {
  if (text === undefined) {
    host.innerHTML = '<div class="skeleton" style="height:96px"></div>';
    text = await api(`api/r/${encodeURIComponent(view.id)}/diff?item=${encodeURIComponent(it.id)}`).catch((e) => `error: ${e.message}`);
  }
  if (typeof text !== 'string' || !text.trim()) return void (host.innerHTML = '<p class="note">No changes.</p>');
  renderDiff(host, text, it.file || guessName(text), { comments: false, caption });
  const diff = host.querySelector('.diff');
  if (!diff) return;
  card.diff = diff;
  placeDiffThreads(card, it);
  if (ro()) return;
  diff.addEventListener('click', (e) => {
    if (e.target.closest('.under, .rv-composer')) return;
    const row = e.target.closest('.dl');
    if (!row || String(getSelection()).trim()) return;
    const n = Number(row.dataset.n || 0);
    const old = Number(row.querySelector('.on')?.textContent || 0);
    if (!n && !old) return;
    openComposer(card, it, n ? { line: n, quote: row.querySelector('.dt')?.textContent || '' } : { line: old, side: 'old', quote: row.querySelector('.dt')?.textContent || '' }, row);
  });
}

const guessName = (diff) => /^\+\+\+ (?:b\/)?(.+)$/m.exec(diff)?.[1]?.trim() || 'changes.diff';

/** a picture, with earlier comments' marks over it and an area to mark */
function pictureInto(body, it, card, src, alt) {
  body.innerHTML = `<div class="rv-pic"><div class="picwrap"><img alt="${esc(alt)}" src="${esc(src)}" draggable="false"><svg class="marks" viewBox="0 0 1 1" preserveAspectRatio="none"></svg><div class="pins"></div></div></div>`;
  card.pic = body.querySelector('img');
  card.picwrap = body.querySelector('.picwrap');
  card.pic.onclick = () => {
    if (view.inks.has(it.id)) return;
    body.querySelector('.rv-pic').classList.toggle('actual');
  };
  paintPicMarks(card, it);
}

/** before and after: a slider over the two pictures, or side by side */
function compareInto(body, it, card) {
  const before = picUrl(it.before),
    after = picUrl(it.image);
  body.innerHTML = `<div class="rv-tabs"><button class="seg-btn on" data-tab="slide">Slide</button><button class="seg-btn" data-tab="side">Side by side</button><button class="seg-btn" data-tab="after">After</button><button class="seg-btn" data-tab="before">Before</button></div><div class="rv-tab"></div>`;
  const tab = body.querySelector('.rv-tab');
  const show = (which) => {
    body.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === which));
    card.pic = null;
    if (which === 'slide') {
      tab.innerHTML = `<div class="compare-slide" style="--at:50%"><img class="after" src="${esc(after)}" alt="After" draggable="false"><div class="before-clip"><img class="before" src="${esc(before)}" alt="Before" draggable="false"></div><div class="handle" role="slider" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" tabindex="0"><span>${icon('arrow-left', 14)}${icon('arrow-right', 14)}</span></div><span class="lbl l">Before</span><span class="lbl r">After</span></div>`;
      const box = tab.querySelector('.compare-slide');
      const handle = box.querySelector('.handle');
      const set = (x) => {
        const r = box.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100));
        box.style.setProperty('--at', pct + '%');
        handle.setAttribute('aria-valuenow', String(Math.round(pct)));
      };
      box.onpointerdown = (e) => {
        box.setPointerCapture(e.pointerId);
        set(e.clientX);
        box.onpointermove = (ev) => set(ev.clientX);
        box.onpointerup = () => (box.onpointermove = null);
      };
      handle.onkeydown = (e) => {
        const cur = parseFloat(box.style.getPropertyValue('--at')) || 50;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          box.style.setProperty('--at', Math.max(0, Math.min(100, cur + (e.key === 'ArrowLeft' ? -5 : 5))) + '%');
        }
      };
    } else if (which === 'side') {
      tab.innerHTML = `<div class="compare"><figure><figcaption>Before</figcaption><div class="stage"><img src="${esc(before)}" alt="Before"></div></figure><figure><figcaption>After</figcaption><div class="stage"><img src="${esc(after)}" alt="After"></div></figure></div>`;
    } else {
      pictureInto(tab, it, card, which === 'after' ? after : before, which === 'after' ? 'After' : 'Before');
      if (which === 'before') card.pic = null; // marks go on the after picture
    }
    const mark = card.querySelector('[data-act="mark"]');
    if (mark) mark.disabled = which !== 'after';
  };
  body.querySelector('.rv-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  };
  show('slide');
  const mark = card.querySelector('[data-act="mark"]');
  if (mark) mark.disabled = true;
}

// ── feedback on an item: its verdict and its comments ──

function paintFeedback(card, it) {
  const v = verdictOf(it.id);
  const chip = card.querySelector('.rv-chip');
  const stale = v && v.rev !== it.rev;
  chip.innerHTML = v ? `<span class="pill ${v.verdict === 'ok' ? 'ok' : v.verdict === 'no' ? 'danger' : 'warn'}">${icon(VERDICT[v.verdict].icon, 12)} ${VERDICT[v.verdict].short}</span>${stale ? '<span class="pill">updated since</span>' : ''}` : '';
  card.classList.toggle('done', !!v && !stale);
  const bar = card.querySelector('.rv-verdict');
  if (!isReview()) bar.innerHTML = '';
  else {
    bar.innerHTML = `<div class="verdicts${ro() ? ' ro' : ''}">${['ok', 'changes', 'no']
      .map((k) => `<button class="vbtn v-${k}${v?.verdict === k ? ' on' : ''}" data-verdict="${k}" ${ro() ? 'disabled' : ''}>${icon(VERDICT[k].icon, 16)}<span>${VERDICT[k].label}</span></button>`)
      .join('')}</div>${
      v && (v.verdict !== 'ok' || v.note)
        ? `<textarea class="vnote" rows="1" data-grow placeholder="${v.verdict === 'ok' ? 'Anything to add?' : 'What should change?'}" ${ro() ? 'disabled' : ''}>${esc(v.note || '')}</textarea>`
        : ''
    }${v?.ack ? `<p class="ack">${icon('sparkles', 14)} <b>Agent:</b> ${esc(v.ack.note || 'done')}</p>` : ''}${stale ? `<p class="faint small">You gave this verdict to an earlier version; the agent has changed it since.</p>` : ''}`;
    const ta = bar.querySelector('.vnote');
    if (ta) grow(ta);
  }
  const box = card.querySelector('.rv-comments');
  // comments on lines sit under their lines; marked areas and the rest are listed here
  const list = commentsOf(it.id).filter((c) => !c.line || (!card.lines && !card.diff));
  box.innerHTML = list.map((c) => threadHtml(c, it)).join('');
  if (card.lines) placeLineThreads(card, it);
  if (card.diff) placeDiffThreads(card, it);
  if (card.picwrap) paintPicMarks(card, it);
  const cbtn = card.querySelector('[data-act="comment"] span');
  if (cbtn) cbtn.textContent = commentsOf(it.id).length ? 'Comment' : 'Comment';
  if (view.mode === 'swipe') paintSwipeBar();
}

function placeLineThreads(card, it) {
  const v = card.lines;
  if (!v) return;
  v.clearPlaced();
  for (const c of commentsOf(it.id).filter((x) => x.line && x.side !== 'old')) {
    const el = document.createElement('div');
    el.className = 'threads';
    el.innerHTML = threadHtml(c, it);
    v.place(c.endLine || c.line, el);
  }
}

function placeDiffThreads(card, it) {
  const diff = card.diff;
  if (!diff) return;
  diff.querySelectorAll('.under').forEach((x) => x.remove());
  for (const c of commentsOf(it.id).filter((x) => x.line)) {
    const rows = [...diff.querySelectorAll('.dl')];
    const row = c.side === 'old' ? rows.find((r) => r.classList.contains('del') && Number(r.querySelector('.on')?.textContent) === c.line) : rows.find((r) => Number(r.dataset.n) === (c.endLine || c.line));
    if (!row) continue;
    const el = document.createElement('div');
    el.className = 'threads under';
    el.innerHTML = threadHtml(c, it);
    let at = row;
    while (at.nextElementSibling?.classList.contains('under')) at = at.nextElementSibling;
    at.after(el);
  }
}

function areaNo(it, c) {
  return commentsOf(it.id).filter((x) => x.strokes?.length).indexOf(c) + 1;
}

function paintPicMarks(card, it) {
  const wrap = card.picwrap;
  if (!wrap?.isConnected) return;
  const list = commentsOf(it.id).filter((c) => c.strokes?.length);
  wrap.querySelector('.marks').innerHTML = list.map((c) => marksSvg(c.strokes, c.status)).join('');
  wrap.querySelector('.pins').innerHTML = list.map((c) => `<button class="pin ${c.status}" data-pin="${esc(c.id)}" style="left:${c.strokes[0][0] * 100}%;top:${c.strokes[0][1] * 100}%" title="Marked area ${areaNo(it, c)}">${areaNo(it, c)}</button>`).join('');
  wrap.querySelector('.pins').onclick = (e) => {
    const b = e.target.closest('[data-pin]');
    const t = b && card.querySelector(`[data-cid="${CSS.escape(b.dataset.pin)}"]`);
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
  };
}

function whereLabel(c, it) {
  if (c.strokes?.length) return `<span class="pin static ${c.status}">${areaNo(it, c)}</span> Marked area`;
  if (c.line) return `${c.side === 'old' ? 'Removed ' : ''}${c.endLine && c.endLine !== c.line ? `lines ${c.line}–${c.endLine}` : `line ${c.line}`}`;
  if (c.quote) return 'On the selection';
  return '';
}

function threadHtml(c, it) {
  const agent = c.from === 'agent';
  const done = c.status === 'resolved';
  const w = it ? whereLabel(c, it) : '';
  const replies = c.replies
    .map((r) => `<div class="reply${r.from === 'agent' ? ' agent' : ''}"><div class="cmt-head"><b>${r.from === 'agent' ? `${icon('sparkles', 13)} agent` : 'You'}</b><span class="faint">${ago(Date.parse(r.at))}</span></div><div class="cmt-body md">${markdownHtml(r.body, '')}</div></div>`)
    .join('');
  const stale = it && c.rev && c.rev !== it.rev && !done;
  return `<div class="cmt rv-cmt${done ? ' resolved' : ''}${agent ? ' agent' : ''}" data-cid="${esc(c.id)}">
  <div class="cmt-head"><b>${agent ? `${icon('sparkles', 13)} agent` : 'You'}</b>${w ? `<span class="where">${w}</span>` : ''}<span class="faint">${ago(Date.parse(c.at))}</span>${done ? '<span class="pill ok">Resolved</span>' : ''}${stale ? '<span class="pill">item changed since</span>' : ''}
  ${ro() ? '' : `<span class="cmt-acts"><button class="mini" data-cact="${done ? 'reopen' : 'resolve'}">${done ? icon('undo', 14) + ' Reopen' : icon('check', 14) + ' Resolve'}</button>${agent ? '' : `<button class="mini" data-cact="edit" aria-label="Edit">${icon('edit', 14)}</button><button class="mini" data-cact="delete" aria-label="Delete">${icon('trash', 14)}</button>`}</span>`}</div>
  ${c.quote && !c.line ? `<blockquote class="quote-sel">${esc(c.quote)}</blockquote>` : ''}
  ${c.body ? `<div class="cmt-body md">${markdownHtml(c.body, '')}</div>` : ''}
  ${c.marked ? `<a href="${esc(rawUrl(c.marked))}" target="_blank" rel="noopener"><img class="rimg" src="${esc(rawUrl(c.marked))}" alt="The marked area" loading="lazy"></a>` : ''}
  ${photosHtml((c.photos || []).map((p) => rawUrl(p)))}
  ${replies}
  ${ro() ? '' : `<form class="rv-reply" data-cid="${esc(c.id)}"><textarea rows="1" data-grow placeholder="Reply…"></textarea><button class="btn small" type="submit">Reply</button></form>`}
</div>`;
}

function paintWholeComments(box) {
  if (!box) return;
  const list = commentsOf('');
  box.innerHTML = `${list.length ? `<h2 class="rv-h2">On the whole ${isGate() ? 'question' : 'review'}</h2>${list.map((c) => threadHtml(c, null)).join('')}` : ''}${ro() ? '' : `<button class="link-btn rv-whole-btn" data-comment-whole>${icon('chat', 14)} Comment on the whole ${isGate() ? 'question' : 'review'}</button>`}`;
}

// ── progress and the finish ──

function paintProgress() {
  const p = main.querySelector('#rv-progress');
  if (!p) return;
  const n = items().length;
  const s = view.data.summary;
  if (isGate()) return void (p.innerHTML = '');
  if (!isReview()) return void (p.innerHTML = n ? `<span class="faint">${n} thing${n === 1 ? '' : 's'} to look at${s.comments ? ` · ${s.comments} comment${s.comments === 1 ? '' : 's'}` : ''}</span>` : '');
  const pct = n ? Math.round((s.reviewed / n) * 100) : 0;
  p.innerHTML = `<div class="mini-bar big"><span style="width:${pct}%"></span></div><div class="rv-stats"><b>${s.reviewed} of ${n}</b> reviewed${s.ok ? ` · <span class="ok-t">${s.ok} good</span>` : ''}${s.changes ? ` · <span class="warn-t">${s.changes} need changes</span>` : ''}${s.no ? ` · <span class="danger-t">${s.no} no</span>` : ''}${s.open ? ` · ${s.open} open comment${s.open === 1 ? '' : 's'}` : ''}</div>`;
  const tools = main.querySelector('#rv-tools');
  if (tools && !tools.contains(document.activeElement)) paintTools();
}

function paintFinish() {
  const box = main.querySelector('#rv-finish');
  if (!box || box.contains(document.activeElement)) return;
  const o = fb().overall;
  const s = view.data.summary;
  if (isGate()) {
    box.className = 'rv-finish gate' + (o ? ' answered v-' + o.verdict : '');
    box.innerHTML = o
      ? `<div class="gate-answer"><span class="gate-mark">${icon(o.verdict === 'ok' ? 'check' : o.verdict === 'no' ? 'x' : 'edit', 22)}</span><div><b>${o.verdict === 'ok' ? 'You approved this' : o.verdict === 'no' ? 'You refused this' : 'You asked for changes first'}</b>${o.note ? `<p>${esc(o.note)}</p>` : ''}<span class="faint">${ago(Date.parse(o.at))}</span></div>${ro() ? '' : '<button class="btn small" data-overall="">Change my answer</button>'}</div>`
      : ro()
        ? '<p class="faint">Waiting for an answer.</p>'
        : `<textarea class="onote" rows="1" data-grow placeholder="A note for the agent (optional)"></textarea><div class="gate-btns"><button class="btn big v-no" data-overall="no">${icon('x', 18)} ${APPROVE.no}</button><button class="btn big v-changes" data-overall="changes">${icon('edit', 18)} ${APPROVE.changes}</button><button class="btn big primary v-ok" data-overall="ok">${icon('check', 18)} ${APPROVE.ok}</button></div>`;
    return;
  }
  if (!items().length) return void (box.innerHTML = '');
  if (!isReview()) {
    box.className = 'rv-finish';
    box.innerHTML = o
      ? `<p class="done-note">${icon('check', 16)} You've looked at this${o.note ? `: “${esc(o.note)}”` : ''}. <button class="link-btn" data-overall="">Undo</button></p>`
      : ro()
        ? ''
        : `<textarea class="onote" rows="1" data-grow placeholder="Anything to tell the agent? (optional)"></textarea><div class="finish-btns"><button class="btn primary" data-overall="ok">${icon('check', 16)} Seen it</button></div>`;
    return;
  }
  const todo = items().filter((i) => !verdictOf(i.id)).length;
  box.className = 'rv-finish' + (o ? ' answered v-' + o.verdict : '');
  box.innerHTML = o
    ? `<div class="gate-answer"><span class="gate-mark">${icon(o.verdict === 'ok' ? 'check' : o.verdict === 'no' ? 'x' : 'edit', 20)}</span><div><b>${o.verdict === 'ok' ? 'You approved the review' : o.verdict === 'no' ? 'You rejected it' : 'You asked for changes'}</b>${o.note ? `<p>${esc(o.note)}</p>` : ''}<span class="faint">The agent sees this in <code>hitl news</code>.</span></div>${ro() ? '' : '<button class="btn small" data-overall="">Reopen</button>'}</div>`
    : ro()
      ? ''
      : `<h2 class="rv-h2">Finish the review</h2><p class="faint">${todo ? `${todo} item${todo === 1 ? '' : 's'} without a verdict${todo && s.reviewed === 0 ? '' : ''}.` : 'Every item has a verdict.'} The agent is told when you finish.</p>
      <textarea class="onote" rows="1" data-grow placeholder="A note on the whole thing (optional)"></textarea>
      <div class="finish-btns">${todo ? `<button class="btn" data-accept-rest>${icon('check', 16)} The other ${todo} look good</button>` : ''}<button class="btn v-changes" data-overall="changes">${icon('edit', 16)} Request changes</button><button class="btn primary v-ok" data-overall="ok">${icon('check', 16)} Approve</button></div>`;
  box.querySelectorAll('textarea').forEach(grow);
}

// ── actions ──

async function post(action, json) {
  const r = await api(`api/r/${encodeURIComponent(view.id)}/${action}`, { method: 'POST', json });
  return r;
}

async function refresh() {
  view.data = await api(`api/r/${encodeURIComponent(view.id)}`);
  view.shape = shapeOf(view.data);
}

async function setVerdict(it, verdict, note) {
  const cur = verdictOf(it.id);
  const next = cur?.verdict === verdict && note === undefined ? null : verdict;
  const r = await post('verdict', { item: it.id, verdict: next, note: note ?? (next ? cur?.note || '' : '') });
  if (r.verdict) fb().items[it.id] = r.verdict;
  else delete fb().items[it.id];
  view.data.summary = r.summary;
  const card = main.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
  if (card) paintFeedback(card, it);
  paintProgress();
  paintFinish();
  return next;
}

function wireCard(card, it) {
  card.addEventListener('click', async (e) => {
    const vb = e.target.closest('[data-verdict]');
    const act = e.target.closest('[data-act]');
    try {
      if (vb) {
        const next = await setVerdict(it, vb.dataset.verdict);
        if (next && next !== 'ok') requestAnimationFrame(() => card.querySelector('.vnote')?.focus());
        if (next && view.mode === 'swipe') setTimeout(() => next === 'ok' && nextCard(), 260);
      } else if (act?.dataset.act === 'comment') {
        const quote = selectionIn(card);
        openComposer(card, it, quote ? { quote } : {});
      } else if (act?.dataset.act === 'mark') startMarking(card, it);
      else if (act?.dataset.act === 'fold') card.classList.toggle('folded');
      else if (act?.dataset.act === 'since') {
        const box = card.querySelector('.rv-since');
        box.hidden = !box.hidden;
        if (!box.hidden && !box.childElementCount) {
          const d = await api(`api/r/${encodeURIComponent(view.id)}/diff?item=${encodeURIComponent(it.id)}`).catch((err) => `error: ${err.message}`);
          if (d.trim()) renderDiff(box, d, it.file, { comments: false, caption: 'As shown → now' });
          else box.innerHTML = '<p class="note">No changes in the text.</p>';
        }
      }
    } catch (err) {
      toast(err.message);
    }
  });
  const saveNote = debounce(async (ta) => {
    const v = verdictOf(it.id);
    if (!v) return;
    try {
      const r = await post('verdict', { item: it.id, verdict: v.verdict, note: ta.value });
      fb().items[it.id] = r.verdict;
      view.data.summary = r.summary;
      flash(ta, 'Saved');
    } catch (err) {
      toast(err.message);
    }
  }, 700);
  card.addEventListener('input', (e) => {
    if (e.target.matches('.vnote')) saveNote(e.target);
  });
}

function flash(el, text) {
  let t = el.parentElement.querySelector('.saved');
  if (!t) {
    t = document.createElement('span');
    t.className = 'saved faint small';
    el.after(t);
  }
  t.textContent = text;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.remove(), 1400);
}

/** text selected inside an item (to quote in a comment) */
function selectionIn(card) {
  const s = getSelection();
  if (!s || s.isCollapsed) return '';
  const node = s.anchorNode?.nodeType === 1 ? s.anchorNode : s.anchorNode?.parentElement;
  if (!node || !card.querySelector('.rv-body')?.contains(node)) return '';
  return String(s).trim().slice(0, 2000);
}

function composerHtml(where) {
  return `<form class="rv-composer">
  <div class="composer-head">${esc(where)}</div>
  <textarea rows="2" data-grow placeholder="What should change? Markdown works. Ctrl+Enter to send."></textarea>
  <div class="photo-list"></div>
  <div class="composer-acts"><button class="btn primary" type="submit">Comment</button>${photoInputHtml()}<button class="btn" type="button" data-cancel>Cancel</button></div>
</form>`;
}

function openComposer(card, it, at = {}, anchorRow) {
  main.querySelectorAll('.rv-composer').forEach((f) => (f.querySelector('textarea').value.trim() ? null : f.remove()));
  const where = at.line ? `Comment on ${at.side === 'old' ? 'removed ' : ''}${at.endLine && at.endLine !== at.line ? `lines ${at.line}–${at.endLine}` : `line ${at.line}`}` : at.quote ? 'Comment on the selection' : at.strokes ? 'Comment on the marked area' : `Comment on ${it ? `“${it.title}”` : 'the whole review'}`;
  const holder = document.createElement('div');
  holder.innerHTML = composerHtml(where);
  const form = holder.firstElementChild;
  form.at = at;
  form.it = it;
  if (at.quote && !at.line) form.querySelector('.composer-head').insertAdjacentHTML('afterend', `<blockquote class="quote-sel">${esc(at.quote.slice(0, 400))}</blockquote>`);
  if (at.line && card.lines && !anchorRow) {
    form.classList.add('under');
    card.lines.place(at.endLine || at.line, form);
  } else if (anchorRow) {
    form.classList.add('under');
    let a = anchorRow;
    while (a.nextElementSibling?.classList.contains('under')) a = a.nextElementSibling;
    a.after(form);
  } else (it ? card.querySelector('.rv-cbar') : card).before(form);
  const ta = form.querySelector('textarea');
  ta.focus({ preventScroll: true });
  form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return form;
}

/** draw on the picture, then say what you mean */
function startMarking(card, it) {
  if (view.inks.has(it.id) || !card.picwrap || !card.pic) return;
  card.querySelector('.rv-pic')?.classList.remove('actual');
  const ink = startInk(card.picwrap, card.pic);
  view.inks.set(it.id, ink);
  const bar = document.createElement('div');
  bar.className = 'ink-tools';
  bar.innerHTML = `<span class="ink-hint">${icon('pen', 14)} Draw around what you mean, then say what should change.</span><span class="grow"></span><button class="btn small" type="button" data-ink="undo">${icon('undo', 14)} Undo</button><button class="btn small" type="button" data-ink="clear">Clear</button>`;
  card.picwrap.parentElement.after(bar);
  const form = openComposer(card, it, { strokes: true });
  form.ink = ink;
  form.inkBar = bar;
  bar.onclick = (e) => {
    const b = e.target.closest('[data-ink]');
    if (b?.dataset.ink === 'undo') ink.undo();
    else if (b?.dataset.ink === 'clear') ink.clear();
  };
}

function stopMarking(form) {
  if (!form.ink) return;
  form.ink.stop();
  form.inkBar?.remove();
  for (const [k, v] of view.inks) if (v === form.ink) view.inks.delete(k);
}

// delegated: composers, replies, thread actions, the finish (anywhere in the review page)
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!view || !main?.contains(f) || !f.matches('.rv-composer, .rv-reply, .rv-edit')) return;
  e.preventDefault();
  const text = f.querySelector('textarea').value.trim();
  const btn = f.querySelector('[type=submit]');
  try {
    if (f.matches('.rv-composer')) {
      const photos = readPhotos(f);
      const json = { item: f.it?.id || '', body: text, photos };
      const at = f.at || {};
      if (at.line) Object.assign(json, { line: at.line, ...(at.endLine ? { endLine: at.endLine } : {}), ...(at.side ? { side: at.side } : {}), ...(at.quote ? { quote: at.quote } : {}) });
      else if (at.quote) json.quote = at.quote;
      if (f.ink) {
        if (!f.ink.count()) return toast('Draw on the picture first');
        Object.assign(json, await f.ink.marks());
      }
      if (!text && !photos.length) return toast('Say what you mean first');
      btn.disabled = true;
      await post('comment', json);
      stopMarking(f);
      f.remove();
    } else if (f.matches('.rv-reply')) {
      if (!text) return;
      btn.disabled = true;
      await post('reply', { cid: f.dataset.cid, body: text });
    } else {
      btn.disabled = true;
      await post('edit', { cid: f.dataset.cid, body: text });
    }
    await refresh();
    repaintAll();
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
});

function repaintAll() {
  for (const it of items()) {
    const card = main.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
    if (card) paintFeedback(card, it);
  }
  paintWholeComments(main.querySelector('.rv-whole'));
  paintProgress();
  paintFinish();
}

document.addEventListener('click', async (e) => {
  if (!view || !main?.contains(e.target)) return;
  const cancel = e.target.closest('.rv-composer [data-cancel]');
  if (cancel) {
    const f = cancel.closest('.rv-composer');
    stopMarking(f);
    f.remove();
    return;
  }
  const ca = e.target.closest('.rv-cmt [data-cact]');
  if (ca) {
    const cid = ca.closest('[data-cid]').dataset.cid;
    try {
      if (ca.dataset.cact === 'resolve' || ca.dataset.cact === 'reopen') await post('status', { cid: [cid], status: ca.dataset.cact === 'resolve' ? 'resolved' : 'open' });
      else if (ca.dataset.cact === 'delete') {
        if (!confirm('Delete this comment?')) return;
        await post('delete', { cid });
      } else if (ca.dataset.cact === 'edit') {
        const c = fb().comments.find((x) => x.id === cid);
        const body = ca.closest('.rv-cmt').querySelector(':scope > .cmt-body');
        const form = document.createElement('form');
        form.className = 'rv-edit';
        form.dataset.cid = cid;
        form.innerHTML = `<textarea rows="2" data-grow>${esc(c?.body || '')}</textarea><div class="composer-acts"><button class="btn primary small" type="submit">Save</button><button class="btn small" type="button" data-cancel-edit>Cancel</button></div>`;
        (body || ca.closest('.rv-cmt').querySelector('.cmt-head')).after(form);
        body?.remove();
        grow(form.querySelector('textarea'));
        form.querySelector('textarea').focus();
        return;
      }
      await refresh();
      repaintAll();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (e.target.closest('[data-cancel-edit]')) return repaintAll();
  const ov = e.target.closest('[data-overall]');
  const rest = e.target.closest('[data-accept-rest]');
  if (ov || rest) {
    const box = main.querySelector('#rv-finish');
    const note = box?.querySelector('.onote')?.value || '';
    try {
      if (rest) {
        for (const it of items()) if (!verdictOf(it.id)) await post('verdict', { item: it.id, verdict: 'ok', note: '' });
        await refresh();
        repaintAll();
        return;
      }
      const v = ov.dataset.overall;
      if (v === 'changes' && isReview() && !note.trim() && !fb().comments.length && !Object.values(fb().items).some((x) => x.verdict !== 'ok')) {
        box.querySelector('.onote')?.focus();
        return toast('Say what should change (in the note, or on the items)');
      }
      await post('overall', { verdict: v || null, note });
      await refresh();
      paintFinish();
      paintProgress();
      if (v) toast(isGate() ? (v === 'ok' ? 'Approved: the agent is told' : 'Sent: the agent is told') : 'Sent to the agent');
    } catch (err) {
      toast(err.message);
    }
  }
  const wholeBtn = e.target.closest('[data-comment-whole]');
  if (wholeBtn) openComposer(main.querySelector('.rv-whole'), null, {});
});

document.addEventListener('keydown', (e) => {
  if (!view || !main?.isConnected) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('.rv-composer textarea, .rv-reply textarea, .rv-edit textarea')) {
    e.preventDefault();
    e.target.form.requestSubmit();
    return;
  }
  if (view.mode !== 'swipe' || e.target.closest?.('input,textarea,select') || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowRight') nextCard();
  else if (e.key === 'ArrowLeft') prevCard();
});

// ── one at a time: swipe right for "looks good", left for "needs changes" ──

function showCard(i) {
  const stage = main.querySelector('#rv-stage');
  if (!stage) return;
  const list = items();
  view.index = Math.max(0, Math.min(list.length - 1, i));
  const it = list[view.index];
  if (!it) return;
  for (const ink of view.inks.values()) ink.stop();
  view.inks.clear();
  const card = itemCard(it);
  card.classList.add('swipe-card');
  stage.replaceChildren(card);
  wireSwipe(stage, card, it);
  paintSwipeBar();
  history.replaceState(null, '', reviewHref(view.key, view.id, it.id));
}

function paintSwipeBar() {
  const bar = main?.querySelector('#rv-swipebar');
  if (!bar) return;
  const list = items();
  bar.innerHTML = `<button class="icon-btn" data-sw="prev" aria-label="Previous" ${view.index === 0 ? 'disabled' : ''}>${icon('arrow-left')}</button><span class="dots">${list
    .map((it, i) => {
      const v = verdictOf(it.id);
      return `<button class="dot${i === view.index ? ' cur' : ''}${v ? ' v-' + v.verdict : ''}" data-sw="${i}" aria-label="Item ${i + 1}"></button>`;
    })
    .join('')}</span><span class="faint">${view.index + 1} / ${list.length}</span><button class="icon-btn" data-sw="next" aria-label="Next" ${view.index >= list.length - 1 ? 'disabled' : ''}>${icon('arrow-right')}</button>`;
  bar.onclick = (e) => {
    const b = e.target.closest('[data-sw]');
    if (!b) return;
    if (b.dataset.sw === 'prev') prevCard();
    else if (b.dataset.sw === 'next') nextCard();
    else showCard(Number(b.dataset.sw));
  };
}

function nextCard() {
  const list = items();
  // the next one without a verdict, else simply the next
  const after = list.findIndex((it, i) => i > view.index && !verdictOf(it.id));
  if (after >= 0) return showCard(after);
  if (view.index < list.length - 1) return showCard(view.index + 1);
  main.querySelector('#rv-finish')?.scrollIntoView({ behavior: 'smooth' });
}
const prevCard = () => view.index > 0 && showCard(view.index - 1);

function wireSwipe(stage, card, it) {
  let start = null;
  const head = card.querySelector('.rv-ihead');
  // swipe on the card's head (the body may need its own gestures: drawing, scrolling code sideways)
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,a')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    head.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  head.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    card.dataset.lean = dx > 40 ? 'ok' : dx < -40 ? 'changes' : '';
  });
  const end = async (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    start = null;
    card.style.transition = '';
    card.style.transform = '';
    card.dataset.lean = '';
    if (ro() || Math.abs(dx) < 90) return;
    try {
      if (dx > 0) {
        await setVerdict(it, 'ok', verdictOf(it.id)?.note || '');
        setTimeout(nextCard, 180);
      } else {
        await setVerdict(it, 'changes', verdictOf(it.id)?.note || '');
        requestAnimationFrame(() => stage.querySelector('.vnote')?.focus());
      }
    } catch (err) {
      toast(err.message);
    }
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  void stage;
}

function focusItem(iid) {
  if (view.mode === 'swipe') {
    const i = items().findIndex((x) => x.id === iid);
    if (i >= 0) showCard(i);
    return;
  }
  const el = main.querySelector(`[data-item="${CSS.escape(iid)}"]`);
  if (!el) return;
  el.classList.remove('folded');
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/** a textarea that grows with what's typed */
export function grow(ta) {
  const fit = () => {
    if (!ta.isConnected) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, Math.max(160, innerHeight * 0.5)) + 'px';
  };
  requestAnimationFrame(fit);
}

void copy;
void purl;
