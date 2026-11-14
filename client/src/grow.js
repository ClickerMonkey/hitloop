// Every text box grows with what's typed and wraps long lines, instead of scrolling one long line sideways. Boxes
// marked data-grow start at their content's height too.
const MAX = () => Math.max(160, innerHeight * 0.55);

function fit(ta) {
  if (!ta.isConnected || ta.closest('[data-nogrow]')) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, MAX()) + 'px';
}

document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLTextAreaElement) fit(e.target);
});

// new boxes with something already in them (an answer, a note being edited)
new MutationObserver((list) => {
  for (const m of list)
    for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      const boxes = n.matches('textarea[data-grow]') ? [n] : n.querySelectorAll?.('textarea[data-grow]') || [];
      for (const ta of boxes) if (ta.value) requestAnimationFrame(() => fit(ta));
    }
}).observe(document.documentElement, { childList: true, subtree: true });
