// A picture full screen: it opens fitted and centred; pinch, the wheel or + / − zoom (around the fingers or the
// pointer), dragging pans, a double tap or click switches between fitted and full size (around where you tapped).
// Esc, the close button or a tap on the dark edge closes it. Used for every picture that opens bigger.
import { esc } from './util.js';
import { icon } from './icons.js';

const MAX = 8;

/**
 * @param {string} src
 * @param {{ title?: string, download?: string, overlay?: Element | null }} [opts]
 *   overlay: drawn over the picture at its size (the marks of comments: an SVG with a 0–1 viewBox)
 */
export function openZoom(src, opts = {}) {
  const back = document.createElement('div');
  back.className = 'zoom-back';
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-label', opts.title || 'Picture');
  back.innerHTML = `<div class="zoom-bar"><span class="zoom-title">${esc(opts.title || '')}</span>
<button class="icon-btn" data-z="out" aria-label="Zoom out" title="Zoom out">${icon('minus', 18)}</button>
<button class="zoom-pct" data-z="fit" title="Fit (double tap switches to full size)">100%</button>
<button class="icon-btn" data-z="in" aria-label="Zoom in" title="Zoom in">${icon('plus', 18)}</button>
${opts.download ? `<a class="icon-btn" href="${esc(src)}" download="${esc(opts.download)}" aria-label="Download" title="Download">${icon('download', 18)}</a>` : ''}
<button class="icon-btn" data-z="close" aria-label="Close" title="Close (Esc)">${icon('x', 20)}</button></div>
<div class="zoom-view"><div class="zoom-pic"><img alt="${esc(opts.title || 'Picture')}" src="${esc(src)}" draggable="false"></div></div>`;
  const view = back.querySelector('.zoom-view');
  const pic = back.querySelector('.zoom-pic');
  const img = pic.querySelector('img');
  const pct = back.querySelector('.zoom-pct');
  if (opts.overlay) {
    const o = opts.overlay.cloneNode(true);
    o.classList.add('zoom-overlay');
    pic.append(o);
  }

  // the picture's natural size, the fitted scale, and where it is now (x, y: its top left in the view)
  let w = 1,
    h = 1,
    fit = 1,
    s = 1,
    x = 0,
    y = 0;
  const box = () => view.getBoundingClientRect();
  const clamp = () => {
    const b = box();
    const pw = w * s,
      ph = h * s;
    // smaller than the view: centred; bigger: no gap at an edge
    x = pw <= b.width ? (b.width - pw) / 2 : Math.min(0, Math.max(b.width - pw, x));
    y = ph <= b.height ? (b.height - ph) / 2 : Math.min(0, Math.max(b.height - ph, y));
  };
  const paint = (animate = false) => {
    clamp();
    pic.classList.toggle('animate', animate);
    pic.style.width = w + 'px';
    pic.style.height = h + 'px';
    pic.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    pct.textContent = Math.round(s * 100) + '%';
    view.classList.toggle('zoomed', s > fit + 1e-3);
  };
  /** zoom to scale n, keeping the point (px, py) of the view still */
  const zoomTo = (n, px, py, animate = false) => {
    const b = box();
    px ??= b.width / 2;
    py ??= b.height / 2;
    n = Math.min(Math.max(n, Math.min(fit, 1)), Math.max(MAX, fit));
    x = px - ((px - x) * n) / s;
    y = py - ((py - y) * n) / s;
    s = n;
    paint(animate);
  };
  const refit = (animate = false) => {
    const b = box();
    fit = Math.min(1, b.width / w, b.height / h);
    s = fit;
    paint(animate);
  };
  const ready = () => {
    w = img.naturalWidth || img.width || 1;
    h = img.naturalHeight || img.height || 1;
    refit();
  };
  if (img.complete && img.naturalWidth) ready();
  else img.onload = ready;

  // wheel: zoom around the pointer (a trackpad's pinch comes as a wheel with ctrl)
  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const b = box();
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      zoomTo(s * k, e.clientX - b.left, e.clientY - b.top);
    },
    { passive: false },
  );

  // pointers: one drags, two pinch; a quick second tap switches fitted / full size
  const pts = new Map();
  let pinch = null,
    moved = false,
    lastTap = 0,
    downAt = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    view.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      moved = false;
      downAt = { x: e.clientX, y: e.clientY };
    }
    if (pts.size === 2) {
      const [a, c] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - c.x, a.y - c.y) || 1, s };
    }
  });
  view.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const b = box();
    if (pts.size === 1) {
      const dx = e.clientX - p.x,
        dy = e.clientY - p.y;
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) moved = true;
      x += dx;
      y += dy;
      p.x = e.clientX;
      p.y = e.clientY;
      paint();
      return;
    }
    const [a0, c0] = [...pts.values()];
    const mid0 = { x: (a0.x + c0.x) / 2, y: (a0.y + c0.y) / 2 };
    p.x = e.clientX;
    p.y = e.clientY;
    const [a, c] = [...pts.values()];
    const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
    moved = true;
    // pan with the fingers' middle, zoom with their spread
    x += mid.x - mid0.x;
    y += mid.y - mid0.y;
    zoomTo((pinch.s * Math.hypot(a.x - c.x, a.y - c.y)) / pinch.d, mid.x - b.left, mid.y - b.top);
  });
  const up = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size < 2) pinch = null;
    if (pts.size) return;
    if (moved) return;
    // a tap on the dark around a fitted picture closes; a double tap zooms
    const now = Date.now();
    const b = box();
    if (now - lastTap < 320) {
      lastTap = 0;
      const full = s > fit + 1e-3 ? fit : Math.max(1, fit * 2.5);
      zoomTo(full, e.clientX - b.left, e.clientY - b.top, true);
    } else {
      lastTap = now;
      const r = pic.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (outside && e.pointerType !== 'mouse') setTimeout(() => lastTap === now && close(), 330);
      else if (outside) close();
    }
  };
  view.addEventListener('pointerup', up);
  view.addEventListener('pointercancel', (e) => {
    pts.delete(e.pointerId);
    pinch = null;
  });

  back.querySelector('.zoom-bar').onclick = (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    const z = b.dataset.z;
    if (z === 'close') close();
    else if (z === 'fit') (s > fit + 1e-3 ? refit(true) : zoomTo(1, undefined, undefined, true));
    else zoomTo(s * (z === 'in' ? 1.5 : 1 / 1.5), undefined, undefined, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') zoomTo(s * 1.5, undefined, undefined, true);
    else if (e.key === '-') zoomTo(s / 1.5, undefined, undefined, true);
    else if (e.key === '0') refit(true);
    else return;
    e.preventDefault();
  };
  const onResize = () => {
    const was = s <= fit + 1e-3;
    const b = box();
    fit = Math.min(1, b.width / w, b.height / h);
    if (was) s = fit;
    paint();
  };
  const close = () => {
    back.remove();
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
  };
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  document.body.append(back);
  if (img.complete && img.naturalWidth) ready();
  back.querySelector('[data-z="close"]').focus({ preventScroll: true });
  return close;
}

// photos on notes and comments open here instead of a new tab
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('.photos a');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  openZoom(a.getAttribute('href'), { title: 'Photo' });
});
