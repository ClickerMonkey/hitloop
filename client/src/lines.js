// A code view for reviews and questions: line numbers, a tap on a number picks a line (shift or a second tap picks a
// range), and threads can sit under any line. Lines are drawn in blocks the browser skips laying out until they come
// near the screen (content-visibility), and Shiki's colours are put in block by block when its grammar has loaded, so
// a long file opens at once.
import { esc, copy } from './util.js';
import { icon } from './icons.js';
import { highlightLines, prepare } from './shiki.js';
import { codeBar } from './code.js';
import { state } from './state.js';

const BLOCK = 250;

/**
 * Draw `text` into host. name: a file name (picks the language). first: the number of the first line.
 * onComment(a, b, quote): the human wants to comment on lines a–b. Returns { code, place(n, el), clearPlaced(), select(a, b) }.
 */
export function linesView(host, { text, name = '', first = 1, caption, onComment, readOnly = false, marks }) {
  const body = text.length > 8_000_000 ? text.slice(0, 8_000_000) : text;
  let html = highlightLines(body, name);
  if (html.length > 1 && html[html.length - 1] === '' && body.endsWith('\n')) html.pop();
  const n = html.length;
  const blocks = [];
  for (let b = 0; b < n; b += BLOCK) {
    const rows = [];
    for (let i = b; i < Math.min(n, b + BLOCK); i++) {
      const num = first + i;
      const mk = marks?.get(num);
      rows.push(`<div class="ln" data-n="${num}"><button class="gut" type="button" data-n="${num}" tabindex="-1">${num}</button>${marks ? `<span class="mk${mk ? ' ' + mk : ''}"></span>` : ''}<span class="src">${html[i] || ' '}</span></div>`);
    }
    blocks.push(`<div class="lblock" style="contain-intrinsic-size:auto ${Math.min(BLOCK, n - b) * 21}px">${rows.join('')}</div>`);
  }
  host.innerHTML = `<figure class="ui-code lines-view">${codeBar(caption ?? `${name || 'text'} · ${n.toLocaleString()} line${n === 1 ? '' : 's'}`)}<div class="code${state.settings.wrap ? ' wrap' : ''}" tabindex="0">${blocks.join('')}</div></figure>`;
  const code = host.querySelector('.code');
  code.text = text;
  code.lines = n;
  let sel = null;

  const row = (num) => code.querySelector(`.ln[data-n="${num}"]`);
  const after = (num) => {
    // under the line, and under any threads already there
    let at = row(num);
    while (at?.nextElementSibling && at.nextElementSibling.classList.contains('under')) at = at.nextElementSibling;
    return at;
  };
  const clear = () => {
    sel = null;
    code.querySelectorAll('.ln.sel').forEach((l) => l.classList.remove('sel'));
    code.querySelector('.selbar')?.remove();
  };
  const select = (a, b) => {
    clear();
    sel = [a, b];
    for (let i = a; i <= b; i++) row(i)?.classList.add('sel');
    const bar = document.createElement('div');
    bar.className = 'selbar under';
    const label = a === b ? `Line ${a}` : `Lines ${a}–${b}`;
    bar.innerHTML = `<span class="faint">${label}${a === b ? '<span class="hint"> · tap another line for a range</span>' : ''}</span>${readOnly || !onComment ? '' : `<button class="btn small primary" type="button" data-sb="comment">${icon('chat', 14)} Comment</button>`}<button class="btn small" type="button" data-sb="copy">${icon('copy', 14)} Copy</button><button class="mini" type="button" data-sb="clear" aria-label="Clear">${icon('x', 14)}</button>`;
    after(b)?.after(bar);
  };
  const quoteOf = (a, b) => {
    const t = [];
    for (let i = a; i <= Math.min(b, a + 11); i++) t.push(row(i)?.querySelector('.src')?.textContent ?? '');
    return t.join('\n') + (b > a + 11 ? '\n…' : '');
  };
  code.addEventListener('click', (e) => {
    const g = e.target.closest('.gut');
    const sb = e.target.closest('[data-sb]');
    if (g) {
      const num = Number(g.dataset.n);
      if (sel && (e.shiftKey || (sel[0] === sel[1] && sel[0] !== num && Math.abs(num - sel[0]) < 400 && e.detail === 1 && g.dataset.armed))) {
        select(Math.min(sel[0], num), Math.max(sel[1], num));
        return;
      }
      if (sel && sel[0] === num && sel[1] === num) return clear();
      select(num, num);
      // a second tap elsewhere (soon after) makes a range: easy on a phone, where there's no shift key
      code.querySelectorAll('.gut[data-armed]').forEach((x) => delete x.dataset.armed);
      code.querySelectorAll('.gut').forEach((x) => (x.dataset.armed = '1'));
      clearTimeout(code.disarm);
      code.disarm = setTimeout(() => code.querySelectorAll('.gut[data-armed]').forEach((x) => delete x.dataset.armed), 4000);
      return;
    }
    if (sb && sel) {
      const [a, b] = sel;
      if (sb.dataset.sb === 'comment') {
        clear();
        onComment?.(a, b, quoteOf(a, b));
      } else if (sb.dataset.sb === 'copy') copy(quoteOf(a, Math.min(b, a + 5000)).replace(/\n…$/, ''), 'Copied');
      else clear();
    }
  });

  // Shiki's colours once the grammar is in: block by block, in idle time, so a long file never freezes the page
  prepare(name).then((ok) => {
    if (!ok || !code.isConnected) return;
    const better = highlightLines(body, name);
    const srcs = code.querySelectorAll('.ln > .src');
    let i = 0;
    const step = (deadline) => {
      if (!code.isConnected) return;
      const until = i + 400;
      for (; i < srcs.length && i < until && (!deadline || deadline.timeRemaining() > 1 || i % 400 === 0); i++) if (better[i] !== undefined) srcs[i].innerHTML = better[i] || ' ';
      if (i < srcs.length) (window.requestIdleCallback || ((f) => setTimeout(f, 16)))(step);
    };
    step();
  });

  return {
    code,
    /** put an element under line num (after other things already there) */
    place(num, el) {
      el.classList.add('under');
      const at = after(Math.min(Math.max(num, first), first + n - 1));
      at?.after(el);
    },
    clearPlaced() {
      code.querySelectorAll('.under:not(.selbar)').forEach((x) => x.remove());
    },
    select,
    clear,
    row,
  };
}

/** the text of a code block (for copy) */
export const textOf = (code) => code.text ?? [...code.querySelectorAll('.src')].map((s) => s.textContent).join('\n');

void esc;
