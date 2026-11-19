// Small SVG charts for the machine dashboard: lines and areas over time (one or stacked), columns over time, a heatmap,
// bar lists and meters. Thin marks, one y axis, recessive grid, a crosshair and tooltip on hover (or a tap on a
// phone), colours by series in a fixed order (the validated palette in machine.css: --s1 … --s8).
import { esc } from '../util.js';

export const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

// ── numbers ──
export const fmt = {
  num(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(0) + 'K';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return a >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString() : n.toFixed(1);
  },
  bytes(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return (i && Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  },
  rate: (n) => fmt.bytes(n) + '/s',
  pct: (n) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : (n < 10 && n > 0 ? n.toFixed(1) : Math.round(n)) + '%'),
  usd(n) {
    if (!Number.isFinite(n)) return '–';
    if (n >= 1000) return '$' + fmt.num(n);
    if (n >= 10) return '$' + n.toFixed(0);
    if (n >= 0.01 || n === 0) return '$' + n.toFixed(2);
    return '<$0.01';
  },
  ms(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    if (n < 1000) return Math.round(n) + ' ms';
    if (n < 60_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + ' s';
    if (n < 3600_000) return (n / 60_000).toFixed(n < 600_000 ? 1 : 0) + ' min';
    return (n / 3600_000).toFixed(1) + ' h';
  },
  dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  },
  temp: (n) => (Number.isFinite(n) ? Math.round(n) + ' °C' : '–'),
  watts: (n) => (Number.isFinite(n) ? n.toFixed(n < 10 ? 1 : 0) + ' W' : '–'),
};

/** the width inside an element's padding: what a graph can use */
function inner(el) {
  const cs = getComputedStyle(el);
  return Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
}

/** a time on an axis or in a tooltip: only as much as the range needs */
function timeLabel(t, span, full = false) {
  const d = new Date(t);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (span <= 2 * 86400_000) return full && span <= 3600_000 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : hm;
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (span <= 40 * 86400_000) return full ? `${day} ${hm}` : day;
  return d.toLocaleDateString([], full ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' });
}

/** clean ticks from 0 to at least max */
function ticks(max, n = 4) {
  if (!(max > 0)) return { top: 1, step: 0.25 };
  const raw = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: step * Math.ceil(max / step), step };
}

/** a read from the server ({step, start, v, max}) as [t, v] points */
export function points(read, key = 'v') {
  if (!read) return [];
  const out = [];
  const vs = read[key] || read.v;
  for (let i = 0; i < vs.length; i++) out.push([read.start + i * read.step * 1000, vs[i]]);
  return out;
}

// ── the hover layer, shared by every chart ──
let tip;
function showTip(html, x, y) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    document.body.append(tip);
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
export function hideTip() {
  if (tip) tip.hidden = true;
}
addEventListener('scroll', hideTip, { passive: true });

const key = (c) => `<span class="viz-key" style="background:${c}"></span>`;

/**
 * Lines (or areas) over time, sharing one y axis.
 *   series: [{ name, color?, pts: [[t, v|null]…], area? }]
 *   opts: { from, to, y: formatter, yMax, stacked, height, legend }
 */
export function timeChart(el, series, opts = {}) {
  const H = opts.height || 180;
  // a phone keeps a readable width and scrolls sideways
  const W = Math.max(innerWidth < 560 ? 520 : 280, inner(el) || 600);
  const pad = { l: 52, r: 12, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const from = opts.from;
  const to = opts.to;
  const span = to - from;
  const x = (t) => pad.l + ((t - from) / span) * iw;
  series = series.map((s, i) => ({ ...s, color: s.color || COLORS[i % COLORS.length] }));
  // stacked: each series sits on the ones before it, at the same times
  let tops = series.map((s) => s.pts);
  if (opts.stacked) {
    const acc = new Map();
    tops = series.map((s) =>
      s.pts.map(([t, v]) => {
        const base = acc.get(t) ?? 0;
        const top = v === null ? null : base + v;
        if (v !== null) acc.set(t, top);
        return [t, top, base];
      }),
    );
  }
  let max = opts.yMax ?? 0;
  if (opts.yMax === undefined) for (const s of tops) for (const p of s) if (p[1] !== null && p[1] > max) max = p[1];
  const { top, step } = ticks(max || 1);
  const yTop = opts.yMax ?? top;
  const y = (v) => pad.t + ih - (Math.min(v, yTop) / yTop) * ih;
  const yf = opts.y || fmt.num;

  let g = '';
  for (let v = 0; v <= yTop + 1e-9; v += opts.yMax ? yTop / 4 : step) {
    const yy = y(v).toFixed(1);
    g += `<line class="viz-grid${v === 0 ? ' base' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/><text class="viz-ax" x="${pad.l - 8}" y="${yy}" dy="0.32em" text-anchor="end">${esc(yf(v))}</text>`;
  }
  const nx = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  for (let i = 0; i <= nx; i++) {
    const t = from + (span * i) / nx;
    const anchor = i === 0 ? 'start' : i === nx ? 'end' : 'middle';
    g += `<text class="viz-ax" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(timeLabel(t, span))}</text>`;
  }
  // a run of points without gaps becomes one path
  const runs = (pts) => {
    const out = [];
    let cur = [];
    for (const p of pts) {
      if (p[1] === null || p[0] < from - 1 || p[0] > to + 1) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(p);
    }
    if (cur.length) out.push(cur);
    return out;
  };
  let marks = '';
  series.forEach((s, i) => {
    for (const r of runs(tops[i])) {
      const line = r.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      if (s.area || opts.stacked) {
        const base = opts.stacked
          ? r
              .slice()
              .reverse()
              .map((p) => `L${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`)
              .join('')
          : `L${x(r[r.length - 1][0]).toFixed(1)},${y(0)}L${x(r[0][0]).toFixed(1)},${y(0)}`;
        marks += `<path class="viz-area${opts.stacked ? ' solid' : ''}" style="fill:${s.color}" d="${line}${base}Z"/>`;
      }
      if (r.length === 1) marks += `<circle cx="${x(r[0][0]).toFixed(1)}" cy="${y(r[0][1]).toFixed(1)}" r="2.5" style="fill:${s.color}"/>`;
      // a stack is its fills: an outline on each would paint over the band below it
      else if (!opts.stacked) marks += `<path class="viz-line" style="stroke:${s.color}" d="${line}"/>`;
    }
  });
  const legend =
    series.length > 1 && opts.legend !== false
      ? `<div class="viz-legend">${series.map((s) => `<span>${key(s.color)}${esc(s.name)}</span>`).join('')}</div>`
      : '';
  el.innerHTML = `${legend}<div class="viz-scroll"><svg class="viz" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:${W}px" role="img" aria-label="${esc(opts.label || series.map((s) => s.name).join(', '))}">${g}<g>${marks}</g><line class="viz-cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" hidden/><g class="viz-dots"></g><rect class="viz-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/></svg></div>`;

  // hover: the nearest time, every series' value there
  const svg = el.querySelector('svg');
  // the newest is on the right: a graph wider than a phone starts there
  const sc = el.querySelector('.viz-scroll');
  if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;
  const cross = svg.querySelector('.viz-cross');
  const dots = svg.querySelector('.viz-dots');
  const times = [...new Set(series.flatMap((s) => s.pts.map((p) => p[0])))].sort((a, b) => a - b);
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = from + ((px - pad.l) / iw) * span;
    let best = times[0];
    for (const tt of times) if (Math.abs(tt - t) < Math.abs(best - t)) best = tt;
    if (best === undefined) return;
    cross.hidden = false;
    cross.setAttribute('x1', x(best));
    cross.setAttribute('x2', x(best));
    let rows = '';
    let d = '';
    series.forEach((s, i) => {
      const p = tops[i].find((q) => q[0] === best);
      const raw = s.pts.find((q) => q[0] === best);
      const v = raw ? raw[1] : null;
      rows += `<div class="viz-tip-row">${key(s.color)}<span>${esc(s.name)}</span><b>${v === null ? '–' : esc(yf(v))}</b></div>`;
      if (p && p[1] !== null) d += `<circle class="viz-dot" cx="${x(best)}" cy="${y(p[1])}" r="4" style="fill:${s.color}"/>`;
    });
    dots.innerHTML = d;
    const total = opts.stacked && series.length > 1 ? series.reduce((a, s) => a + (s.pts.find((q) => q[0] === best)?.[1] ?? 0), 0) : null;
    showTip(`<div class="viz-tip-h">${esc(timeLabel(best, span, true))}</div>${rows}${total !== null ? `<div class="viz-tip-row total"><span>Total</span><b>${esc(yf(total))}</b></div>` : ''}`, e.clientX, e.clientY);
  };
  const leave = () => {
    cross.hidden = true;
    dots.innerHTML = '';
    hideTip();
  };
  const hit = svg.querySelector('.viz-hit');
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

/** columns over time, stacked by series (tool calls by tool, cost per hour) */
export function columns(el, series, opts = {}) {
  const H = opts.height || 180;
  // a phone keeps a readable width and scrolls sideways
  const W = Math.max(innerWidth < 560 ? 520 : 280, inner(el) || 600);
  const pad = { l: 52, r: 12, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  series = series.map((s, i) => ({ ...s, color: s.color || COLORS[i % COLORS.length] }));
  const times = [...new Set(series.flatMap((s) => s.pts.map((p) => p[0])))].sort((a, b) => a - b);
  const from = opts.from ?? times[0];
  const to = opts.to ?? times[times.length - 1];
  const span = Math.max(1, to - from);
  const stepMs = opts.step ? opts.step * 1000 : times.length > 1 ? times[1] - times[0] : span;
  const slots = Math.max(1, Math.round(span / stepMs));
  const bw = Math.max(1, Math.min(24, iw / slots - 2));
  const x = (t) => pad.l + ((t - from) / span) * (iw - bw);
  const sums = new Map();
  for (const s of series) for (const [t, v] of s.pts) if (v) sums.set(t, (sums.get(t) ?? 0) + v);
  const { top, step } = ticks(Math.max(0, ...sums.values()) || 1);
  const y = (v) => pad.t + ih - (v / top) * ih;
  const yf = opts.y || fmt.num;
  let g = '';
  for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="viz-grid${v === 0 ? ' base' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="viz-ax" x="${pad.l - 8}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${esc(yf(v))}</text>`;
  const nx = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  for (let i = 0; i <= nx; i++) {
    const t = from + (span * i) / nx;
    g += `<text class="viz-ax" x="${(pad.l + (iw * i) / nx).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === nx ? 'end' : 'middle'}">${esc(timeLabel(t, span))}</text>`;
  }
  let marks = '';
  const gap = bw > 6 ? 2 : 0;
  for (const t of times) {
    let base = 0;
    const segs = [];
    series.forEach((s) => {
      const v = s.pts.find((p) => p[0] === t)?.[1];
      if (v) segs.push({ v, c: s.color });
    });
    segs.forEach((sg, k) => {
      const y0 = y(base);
      const y1 = y(base + sg.v);
      base += sg.v;
      const h = Math.max(1, y0 - y1 - (k ? gap : 0));
      const last = k === segs.length - 1;
      const r = last && bw >= 8 && h > 4 ? 3 : 0;
      marks += r
        ? `<path style="fill:${sg.c}" d="M${x(t).toFixed(1)},${(y0 - (k ? gap : 0)).toFixed(1)}v${(-h + r).toFixed(1)}q0,-${r} ${r},-${r}h${(bw - 2 * r).toFixed(1)}q${r},0 ${r},${r}v${(h - r).toFixed(1)}z"/>`
        : `<rect style="fill:${sg.c}" x="${x(t).toFixed(1)}" y="${(y0 - h - (k ? gap : 0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
    });
  }
  const legend = series.length > 1 ? `<div class="viz-legend">${series.map((s) => `<span>${key(s.color)}${esc(s.name)}</span>`).join('')}</div>` : '';
  el.innerHTML = `${legend}<div class="viz-scroll"><svg class="viz" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:${W}px" role="img" aria-label="${esc(opts.label || '')}">${g}${marks}<rect class="viz-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/></svg></div>`;
  const svg = el.querySelector('svg');
  // the newest is on the right: a graph wider than a phone starts there
  const sc = el.querySelector('.viz-scroll');
  if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;
  const hit = svg.querySelector('.viz-hit');
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = times[0];
    for (const t of times) if (Math.abs(x(t) + bw / 2 - px) < Math.abs(x(best) + bw / 2 - px)) best = t;
    if (best === undefined) return;
    const rows = series
      .map((s) => [s, s.pts.find((p) => p[0] === best)?.[1] ?? 0])
      .filter(([, v]) => v)
      .map(([s, v]) => `<div class="viz-tip-row">${key(s.color)}<span>${esc(s.name)}</span><b>${esc(yf(v))}</b></div>`)
      .join('');
    showTip(`<div class="viz-tip-h">${esc(timeLabel(best, span, true))}</div>${rows || '<div class="viz-tip-row"><span>Nothing</span></div>'}${series.length > 1 ? `<div class="viz-tip-row total"><span>Total</span><b>${esc(yf(sums.get(best) ?? 0))}</b></div>` : ''}`, e.clientX, e.clientY);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', hideTip);
}

/** a list of bars, biggest first: [{ label, value, sub?, href? }] */
export function barList(rows, opts = {}) {
  if (!rows.length) return `<p class="viz-none">${esc(opts.empty || 'Nothing yet')}</p>`;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const f = opts.fmt || fmt.num;
  return `<div class="viz-bars">${rows
    .map((r, i) => {
      const tag = r.href ? 'a' : 'div';
      return `<${tag} class="viz-bar-row"${r.href ? ` href="${esc(r.href)}"` : ''} title="${esc(r.label)}: ${esc(f(r.value))}${r.sub ? ' · ' + esc(r.sub) : ''}"><span class="viz-bar-label">${opts.keys ? key(COLORS[i % COLORS.length]) : ''}${esc(r.label)}</span><span class="viz-bar-track"><span class="viz-bar" style="width:${Math.max(0.5, (r.value / max) * 100).toFixed(1)}%${opts.keys ? `;background:${COLORS[i % COLORS.length]}` : ''}"></span></span><span class="viz-bar-val">${esc(f(r.value))}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></${tag}>`;
    })
    .join('')}</div>`;
}

/** how full something is: used of total, with a warning colour past 80% and danger past 92% */
export function meter(used, total, label) {
  const p = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const lvl = p > 92 ? 'danger' : p > 80 ? 'warn' : '';
  return `<div class="viz-meter ${lvl}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.toFixed(0)}" aria-label="${esc(label || '')}"><span style="width:${p.toFixed(1)}%"></span></div>`;
}

/**
 * A heatmap: rows × columns of values, one hue from faint to strong.
 *   rows: [{ label, cells: [{ v, tip }] }], cols: column labels (some may be '')
 */
export function heatmap(el, rows, cols, opts = {}) {
  let max = 0;
  for (const r of rows) for (const c of r.cells) if (c.v > max) max = c.v;
  const step = (v) => (v <= 0 || !max ? 0 : Math.max(1, Math.ceil((v / max) * 6)));
  el.innerHTML = `<div class="viz-scroll"><div class="viz-heat" style="--cols:${cols.length}">${rows
    .map(
      (r) =>
        `<span class="viz-heat-label">${esc(r.label)}</span>${r.cells.map((c) => `<span class="viz-cell h${step(c.v)}" data-tip="${esc(c.tip || '')}"></span>`).join('')}`,
    )
    .join('')}<span></span>${cols.map((c) => `<span class="viz-heat-col">${esc(c)}</span>`).join('')}</div></div>${opts.legend ? `<div class="viz-heat-legend"><span>${esc(opts.legend[0])}</span>${[1, 2, 3, 4, 5, 6].map((i) => `<span class="viz-cell h${i}"></span>`).join('')}<span>${esc(opts.legend[1])}</span></div>` : ''}`;
  const grid = el.querySelector('.viz-heat');
  const move = (e) => {
    const c = e.target.closest('.viz-cell');
    if (!c || !c.dataset.tip) return hideTip();
    showTip(c.dataset.tip, e.clientX, e.clientY);
  };
  grid.addEventListener('pointermove', move);
  grid.addEventListener('pointerdown', move);
  grid.addEventListener('pointerleave', hideTip);
}

/** a tiny line with no axes, for tiles */
export function sparkline(vals, opts = {}) {
  const W = opts.width || 120;
  const H = opts.height || 28;
  const xs = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null && Number.isFinite(v));
  if (xs.length < 2) return '';
  const max = opts.max ?? Math.max(...xs.map(([, v]) => v), 1e-9);
  const n = vals.length - 1 || 1;
  const d = xs.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * (W - 2) + 1).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join('');
  return `<svg class="viz-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><path d="${d}" style="stroke:${opts.color || 'var(--s1)'}"/></svg>`;
}
