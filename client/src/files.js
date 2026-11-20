// A project's files: the folder tree, the folder or search or changes in the middle, the open file beside
// it on a wide screen (over it on a phone), and the shortcuts. The shell (main.js) mounts this for #/p/<key>/files/….
import { $, esc, on, emit, store } from './util.js';
import { loadComments, loadGit, nav, go, state, where } from './state.js';
import { renderTree, wireTree } from './tree.js';
import { renderFolder, wireFolder, clearFilter } from './folder.js';
import { closeFile, refreshFileThreads, renderFile, step } from './file.js';
import { focusSearch, forgetFiles, quickOpen, renderSearch, wireSearchBar } from './search.js';
import { branchHtml, refreshChangesThreads, renderChanges, renderHistory } from './changes.js';
import { renderReviewPage, updateReviewBadge } from './review.js';
import { icon } from './icons.js';

const phone = matchMedia('(max-width: 759px)');
/** what scrolls: the page on a phone, the pane on a wide screen */
const scroller = (el) => (phone.matches ? document.scrollingElement : el);
/** where a folder was scrolled to, so coming back from a file on a phone lands in the same place */
const folderScroll = new Map();
let lastOpen = '';
let active = false;

const wide = matchMedia('(min-width: 1000px)');
const roomy = matchMedia('(min-width: 1280px)');

export const isActive = () => active;

function layout() {
  const { open } = where();
  const app = $('app');
  app.classList.remove('page');
  app.classList.toggle('rail', wide.matches);
  app.classList.toggle('split', !!open && roomy.matches);
  $('main').hidden = !!open && !roomy.matches;
  $('file').hidden = !open;
}

let mainKey = '';
async function renderMain(force = false) {
  const w = where();
  const key = JSON.stringify([state.project, w.folder, w.m, w.q, w.show, w.scope, w.opts, w.inc, w.view, w.open]);
  if (!force && key === mainKey) return;
  const scrolled = key === mainKey ? scroller($('main')).scrollTop : 0;
  mainKey = key;
  const m = $('main');
  if (busyTyping(m)) return; // don't wipe a note being written; the next change redraws it
  if (w.m === 'search' && w.q) await renderSearch(m);
  else if (w.m === 'changes') await renderChanges(m);
  else if (w.m === 'history') await renderHistory(m);
  else if (w.m === 'review') renderReviewPage(m, w.q, (f) => nav({ q: f }));
  else await renderFolder(m);
  if (!(phone.matches && w.open)) scroller(m).scrollTop = scrolled;
}

export const busyTyping = (el) => {
  const a = document.activeElement;
  return a && a.tagName === 'TEXTAREA' && el.contains(a) && a.value.trim();
};

/** the bar's file things: the branch, the change count, the notes count */
export function paintBar() {
  $('branch').innerHTML = active ? branchHtml() : '';
  const n = state.git ? state.git.changes.length : 0;
  $('changes-count').textContent = String(n);
  $('changes-count').hidden = !n;
  $('changes-btn').hidden = !state.info.git;
  updateReviewBadge();
}

/** open the files view (the shell calls this on every route change inside it) */
export async function showFiles() {
  const first = !active;
  active = true;
  document.body.dataset.view = 'files';
  if (first) mainKey = '';
  const w = where();
  // a phone: remember the folder's scroll when a file opens over it, and go back to it when the file closes
  if (phone.matches && w.open && !lastOpen) folderScroll.set(w.folder, document.scrollingElement.scrollTop);
  const closing = phone.matches && !w.open && lastOpen;
  lastOpen = w.open;
  layout();
  await renderMain(closing || first);
  if (w.open) renderFile($('file'));
  else closeFile();
  if (closing) document.scrollingElement.scrollTop = folderScroll.get(w.folder) || 0;
  if (wide.matches) renderTree(first);
  paintBar();
  document.title = `${w.open || (w.m === 'search' ? '“' + w.q + '”' : w.folder.split('/').pop() || state.info.name)} — hitl`;
}

/** leave the files view: the shell draws something else in #main */
export function leaveFiles() {
  if (!active) return;
  active = false;
  lastOpen = '';
  mainKey = '';
  closeFile();
  $('file').hidden = true;
  $('main').hidden = false;
  $('branch').innerHTML = '';
  const app = $('app');
  app.classList.remove('rail', 'split');
  app.classList.add('page');
}

/** a project was opened (or changed): what the files view needs before it draws */
/** live changes for the open project, from the shell's event stream */
export async function filesChanged(b) {
  for (const f of b.folders) state.cache.delete(f);
  if (b.files.length) forgetFiles();
  if (b.git) await loadGit();
  paintBar();
  if (!active) return;
  const w = where();
  const openPath = w.open ? (w.folder ? w.folder + '/' : '') + w.open : '';
  if (w.m === 'changes' || w.m === 'history' ? b.git : !w.m && (b.folders.includes(w.folder) || b.git)) await renderMain(true);
  if (openPath && b.files.includes(openPath)) renderFile($('file'), true);
  if (wide.matches) renderTree();
}

export async function notesChanged() {
  await loadComments();
  emit('comments');
}

on('comments', () => {
  updateReviewBadge();
  if (!active) return;
  refreshFileThreads($('file'));
  const w = where();
  if (w.m === 'review' || !w.m) renderMain(true);
  else if (w.m === 'changes') refreshChangesThreads($('main'));
  if (wide.matches) renderTree();
});
on('settings', () => {
  if (!active) return;
  renderMain(true);
  if (where().open) renderFile($('file'), true);
  if (wide.matches) renderTree();
});

// ── shortcuts (only while the files are open) ──
addEventListener('keydown', (e) => {
  if (!active) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'k')) {
    e.preventDefault();
    quickOpen();
  } else if (e.key === '/' && !typing) {
    e.preventDefault();
    focusSearch();
  } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && where().open && (e.key === '[' || e.key === ']' || ($('picwrap') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')))) {
    e.preventDefault();
    step(e.key === '[' || e.key === 'ArrowLeft' ? -1 : 1);
  } else if (e.key === 'Escape' && !typing && !$('qo') && where().open) {
    nav({ open: '', tab: '', line: '' });
  } else if (e.key === 'Escape' && document.activeElement === $('q')) $('q').blur();
});

// ── the splitter ──
function wireSplitter() {
  const tw = Number(store('tree')) || 280;
  $('app').style.setProperty('--tree', tw + 'px');
  $('splitter').onpointerdown = (e) => {
    e.preventDefault();
    const mv = (ev) => {
      const w = Math.min(560, Math.max(180, ev.clientX));
      $('app').style.setProperty('--tree', w + 'px');
      store('tree', String(w));
    };
    const up = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
}

/** once, at boot */
export function wireFiles() {
  $('search-icon').innerHTML = icon('search', 16);
  $('qo-btn').insertAdjacentHTML('afterbegin', icon('file'));
  $('qo-btn').onclick = () => quickOpen();
  phone.addEventListener('change', () => active && showFiles());
  wide.addEventListener('change', () => active && showFiles());
  roomy.addEventListener('change', () => active && showFiles());
  wireTree();
  wireFolder($('main'));
  wireSearchBar();
  wireSplitter();
}

export const filesHome = () => {
  clearFilter();
  go({ folder: '' });
};

void esc;
