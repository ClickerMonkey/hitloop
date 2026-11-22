// Dismiss a review, approval or question set: it stops waiting for you, and the agent sees it closed (a wait for it is
// over). Reopen brings it back. One delegated click handler, so the inbox and both request pages share it; the live
// update (the watcher's request event) redraws the page or the inbox after the change.
import { api, esc, toast } from './util.js';
import { icon } from './icons.js';

/** the button for a request: Dismiss, or Reopen when it's already closed */
export function closeButton(kind, key, id, closed) {
  return `<button class="btn small close-btn" type="button" data-close="${closed ? 'open' : 'closed'}" data-kind="${kind}" data-key="${esc(key)}" data-id="${esc(id)}">${icon(closed ? 'undo' : 'x', 14)} ${closed ? 'Reopen' : 'Dismiss'}</button>`;
}

/** close (closed = true) or reopen one request in a project */
export function setClosed(key, kind, id, closed) {
  const base = kind === 'review' ? 'r' : 'q';
  return api(`p/${encodeURIComponent(key)}/api/${base}/${encodeURIComponent(id)}/close`, { hub: true, method: 'POST', json: { closed } });
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-close]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const closed = b.dataset.close === 'closed';
  b.disabled = true;
  try {
    await setClosed(b.dataset.key, b.dataset.kind, b.dataset.id, closed);
    toast(closed ? 'Dismissed. The agent will see it closed.' : 'Reopened.');
  } catch (err) {
    b.disabled = false;
    toast(`Couldn't change that: ${err.message}`);
  }
});
