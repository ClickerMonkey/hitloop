// Comment on what you selected. Select text anywhere a page can take a comment (a review's items, a question set, a
// file, a note's thread) and a Comment button appears by the selection. It opens a small composer that shows the
// selected text and where it is (the file and its lines, the item, the question, or the whole review or set), and the
// comment is saved on that thing: the agent reads it in news with the selection quoted.
//
// Pages register a resolver: (range, node) => null (not mine) or
//   { where: 'src/app.ts · lines 12–14', submit({ body, photos, quote }) => Promise }.
import { esc, toast } from './util.js';
import { icon } from './icons.js';
import { photoInputHtml, readPhotos } from './photos.js';

const resolvers = [];
export const addSelectionTarget = (fn) => resolvers.push(fn);

/** the element a node is in */
export const elOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement) || null;

/** the selected text, tidied: at most 4000 characters (the selection's text, which leaves out line numbers) */
export const quoteOf = (sel) =>
  String(sel)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, 4000);

/**
 * The lines a selection covers in a code view or a diff (rows with data-n, or a removed row's old number), inside
 * within. Returns { line, endLine, side? } or null when the selection isn't on numbered lines.
 */
export function lineSpan(range, within) {
  const rowOf = (n) => {
    const r = elOf(n)?.closest('.ln, .dl');
    return r && (!within || within.contains(r)) ? r : null;
  };
  const num = (r) => (r?.dataset.n ? { n: Number(r.dataset.n) } : r?.classList.contains('del') ? { n: Number(r.querySelector('.on')?.textContent || 0), old: true } : null);
  const a = rowOf(range.startContainer);
  const b = rowOf(range.endContainer);
  const x = num(a || b);
  const y = num(b || a);
  // a selection that runs to the very start of the next line (a triple click) ends on the line before
  if (a && b && a !== b && y && !y.old) {
    const tail = document.createRange();
    tail.setStart(b.querySelector('.src, .dsrc') || b, 0);
    tail.setEnd(range.endContainer, range.endOffset);
    if (!tail.toString().trim() && y.n > (x?.n || 0)) y.n--;
  }
  if (!x?.n) return null;
  if (x.old || y?.old) return x.old && y?.old ? { line: Math.min(x.n, y.n), endLine: Math.max(x.n, y.n), side: 'old' } : { line: x.old ? y?.n || x.n : x.n, ...(x.old && !y?.n ? { side: 'old' } : {}) };
  const lo = Math.min(x.n, y?.n || x.n);
  const hi = Math.max(x.n, y?.n || x.n);
  return { line: lo, ...(hi > lo ? { endLine: hi } : {}) };
}

export const linesLabel = (s) => (!s ? '' : `${s.side === 'old' ? 'removed ' : ''}${s.endLine && s.endLine !== s.line ? `lines ${s.line}–${s.endLine}` : `line ${s.line}`}`);

/** a quote as markdown (for replies, which keep the selection in their text) */
export const quoteMd = (q) => q.split('\n').map((l) => '> ' + l).join('\n');

// ── the button by the selection ──

let btn = null;
let found = null; // what the current selection would be a comment on
let pop = null;

function resolve() {
  const s = getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  const node = elOf(range.commonAncestorContainer);
  if (!node || node.closest('input, textarea, [contenteditable], .sel-pop, .sel-btn, form')) return null;
  const quote = quoteOf(s);
  if (!quote) return null;
  for (const fn of resolvers) {
    try {
      const t = fn(range, node);
      if (t) return { ...t, quote: t.quote ?? quote, range };
    } catch (err) {
      console.warn(err);
    }
  }
  return null;
}

function place(el, rect, below, gap = 10) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let x = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), vw - w - 8);
  let y = below ? rect.bottom + gap : rect.top - h - gap;
  if (y < 8) y = rect.bottom + gap;
  if (y + h > vh - 8) y = Math.max(8, rect.top - h - gap);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

const coarse = () => matchMedia('(pointer: coarse)').matches;

function selRect(range) {
  const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
  if (!rects.length) return range.getBoundingClientRect();
  // the end of the selection: where the hand (or the mouse) is
  return rects[rects.length - 1];
}

function showButton() {
  if (pop) return;
  found = resolve();
  if (!found) return hideButton();
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sel-btn';
    // act the moment it's pressed: on a phone the tap itself clears the selection (and hides the button) before any
    // click arrives, so waiting for the click does nothing. What it's a comment on was worked out when it showed.
    const press = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (found && !pop) openPopover(found);
    };
    btn.addEventListener('pointerdown', press);
    // no mouse events or click after the touch (they'd land on whatever is under the button once it's gone)
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => e.preventDefault());
    document.body.append(btn);
  }
  btn.innerHTML = `${icon('chat', 15)}<span>Comment</span>`;
  btn.title = `Comment on the selection (${found.where})`;
  btn.hidden = false;
  // on a phone the system's copy menu sits above the selection and its handles hang below it: go below the handles
  place(btn, selRect(found.range), coarse(), coarse() ? 36 : 10);
}

function hideButton() {
  found = null;
  if (btn) btn.hidden = true;
}

let timer = 0;
const later = () => {
  clearTimeout(timer);
  // while a mouse is still dragging, wait for it to let go
  timer = setTimeout(() => (dragging ? null : showButton()), coarse() ? 350 : 120);
};
let dragging = false;
document.addEventListener('selectionchange', () => {
  if (getSelection()?.isCollapsed) return hideButton();
  later();
});
document.addEventListener('mousedown', (e) => {
  if (e.button === 0 && !e.target.closest?.('.sel-btn, .sel-pop')) dragging = true;
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  later();
});
addEventListener(
  'scroll',
  () => {
    if (btn && !btn.hidden && found?.range) place(btn, selRect(found.range), coarse(), coarse() ? 36 : 10);
  },
  { passive: true, capture: true },
);
addEventListener('hashchange', () => {
  hideButton();
  closePopover();
});

// ── the composer ──

function openPopover(t) {
  closePopover();
  hideButton();
  const rect = selRect(t.range);
  getSelection()?.removeAllRanges();
  pop = document.createElement('form');
  pop.className = 'sel-pop';
  const shown = t.quote.length > 600 ? t.quote.slice(0, 600) + '…' : t.quote;
  pop.innerHTML = `<div class="sel-pop-head">${icon('chat', 15)}<span>Comment on <b>${esc(t.where)}</b></span><button class="mini" type="button" data-sel-close aria-label="Cancel">${icon('x', 14)}</button></div>
  <blockquote class="quote-sel sel-quote">${esc(shown)}</blockquote>
  <textarea rows="2" data-grow placeholder="What about it? Markdown works. Ctrl+Enter to send."></textarea>
  <div class="photo-list"></div>
  <div class="composer-acts"><button class="btn primary" type="submit">Comment</button>${photoInputHtml()}<button class="btn" type="button" data-sel-close>Cancel</button></div>`;
  document.body.append(pop);
  const ta = pop.querySelector('textarea');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 280) + 'px';
  });
  if (!coarse()) place(pop, rect, true);
  else pop.classList.add('sheet');
  ta.focus({ preventScroll: true });
  pop.addEventListener('click', (e) => {
    if (e.target.closest('[data-sel-close]')) closePopover();
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  });
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    const photos = readPhotos(pop);
    if (!body && !photos.length) return toast('Say what you mean first');
    const b = pop.querySelector('[type=submit]');
    b.disabled = true;
    try {
      await t.submit({ body, photos, quote: t.quote });
      closePopover();
      toast('Comment saved');
    } catch (err) {
      b.disabled = false;
      toast(err.message);
    }
  });
}

function closePopover() {
  pop?.remove();
  pop = null;
}

document.addEventListener('pointerdown', (e) => {
  // a tap outside an empty composer closes it; one with words in it stays until you cancel
  if (pop && !pop.contains(e.target) && !e.target.closest?.('.sel-btn') && !pop.querySelector('textarea').value.trim() && !readPhotos(pop).length) closePopover();
});
