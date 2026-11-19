// A conversation read from a Claude Code transcript: the main thread of a session or one of its agents.
// What was said, what it thought, each tool call (with its input, result and how long it took) and every
// picture it read. Pictures load as they scroll into view. Long ones load a page at a time.
import { api, esc, store } from '../util.js';
import { icon } from '../icons.js';
import { markdownHtml } from '../markdown.js';
import { fmt } from './charts.js';

const PAGE = 250;
const hubApi = (u) => api(u, { hub: true });
const FILTERS = [
  ['thinking', 'Thinking'],
  ['tools', 'Tool calls'],
  ['results', 'Tool results'],
  ['meta', 'System notes'],
];

const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const day = (t) => (t ? new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '');

function prefs() {
  try {
    return { thinking: true, tools: true, results: true, meta: false, ...JSON.parse(store('machine-chat-filters') || '{}') };
  } catch {
    return { thinking: true, tools: true, results: true, meta: false };
  }
}

/** a few words on what a call did, for its folded line */
function brief(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill', 'subject', 'title', 'message']) {
    if (typeof i[k] === 'string' && i[k].trim()) return i[k].replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  const s = JSON.stringify(i);
  return s && s !== '{}' ? s.slice(0, 160) : name;
}

const pre = (text, cap) => {
  const t = text || '';
  return `<pre class="mach-pre chat-pre">${esc(t)}</pre>${cap ? `<p class="faint small">…${fmt.num(cap)} more characters not shown</p>` : ''}`;
};

export async function showChat(el, { session, agent }) {
  const q = `session=${encodeURIComponent(session)}${agent ? '&agent=' + encodeURIComponent(agent) : ''}`;
  const f = prefs();
  el.innerHTML = `<div class="chat">
    <div class="chat-bar">${FILTERS.map(([k, label]) => `<label class="check"><input type="checkbox" data-f="${k}" ${f[k] ? 'checked' : ''}> ${label}</label>`).join('')}<span class="faint small chat-count"></span></div>
    <div class="chat-list${f.thinking ? '' : ' hide-thinking'}${f.tools ? '' : ' hide-tools'}${f.results ? '' : ' hide-results'}${f.meta ? '' : ' hide-meta'}"></div>
    <div class="chat-more"></div>
  </div>`;
  const list = el.querySelector('.chat-list');
  const more = el.querySelector('.chat-more');
  const count = el.querySelector('.chat-count');
  el.querySelector('.chat-bar').addEventListener('change', (e) => {
    const k = e.target.dataset.f;
    if (!k) return;
    f[k] = e.target.checked;
    list.classList.toggle('hide-' + k, !e.target.checked);
    store('machine-chat-filters', JSON.stringify(f));
  });

  // pictures load when they come near the screen
  const seen = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        seen.unobserve(en.target);
        void loadImage(en.target);
      }
    },
    { rootMargin: '600px' },
  );
  async function loadImage(box) {
    try {
      const im = await hubApi(`api/machine/transcript-image?${q}&line=${box.dataset.line}&n=${box.dataset.n}`);
      box.innerHTML = `<a href="#" class="chat-img-link" title="Open full size"><img src="data:${esc(im.mediaType)};base64,${im.data}" alt="A picture in the conversation"></a>`;
      box.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault();
        const w = window.open('', '_blank');
        if (w) w.document.write(`<title>Picture</title><body style="margin:0;background:#111"><img src="data:${im.mediaType};base64,${im.data}" style="max-width:100%;display:block;margin:auto">`);
      });
    } catch (err) {
      box.innerHTML = `<span class="bad small">${esc(err.message)}</span>`;
    }
  }
  const imageBox = (it) => {
    const d = document.createElement('div');
    d.className = 'chat-img';
    d.dataset.line = it.line;
    d.dataset.n = it.n;
    d.innerHTML = `<span class="faint small">${icon('image', 14)} ${esc(it.mediaType)} · ${fmt.bytes(it.bytes)}</span>`;
    seen.observe(d);
    return d;
  };

  let offset = 0;
  let total = 0;
  let lastDay = '';
  const calls = new Map(); // tool_use id -> { card, t }

  function paint(items) {
    for (const it of items) {
      const dd = day(it.t);
      if (dd && dd !== lastDay) {
        lastDay = dd;
        const sep = document.createElement('div');
        sep.className = 'chat-day';
        sep.textContent = dd;
        list.append(sep);
      }
      if (it.kind === 'tool_use') {
        const wrap = document.createElement('div');
        wrap.className = 'chat-item chat-toolwrap k-tools';
        const card = document.createElement('details');
        card.className = 'chat-tool';
        card.innerHTML = `<summary><span class="chat-tool-name">${esc(it.name)}</span><span class="chat-tool-what">${esc(brief(it.name, it.input))}</span><span class="chat-tool-dur faint small"></span><span class="faint small">${clock(it.t)}</span></summary>
          <div class="chat-tool-body"><h5>Input</h5>${pre(typeof it.input === 'string' ? it.input : JSON.stringify(it.input, null, 2))}<div class="chat-result"></div></div>`;
        wrap.append(card);
        wrap.insertAdjacentHTML('beforeend', '<div class="chat-tool-imgs"></div>');
        list.append(wrap);
        calls.set(it.id, { card, t: it.t });
      } else if (it.kind === 'tool_result') {
        const c = calls.get(it.id);
        if (c) {
          c.card.querySelector('.chat-result').innerHTML = `<h5 class="${it.error ? 'bad' : ''}">${it.error ? 'Failed' : 'Result'}</h5>${pre(it.text || '(nothing returned)', it.truncated)}`;
          if (it.error) c.card.classList.add('is-error');
          if (it.t && c.t) c.card.querySelector('.chat-tool-dur').textContent = fmt.ms(it.t - c.t);
          c.card.dataset.has = '1';
        } else {
          const d = document.createElement('details');
          d.className = 'chat-item chat-tool k-results';
          d.innerHTML = `<summary><span class="chat-tool-name">Result</span><span class="chat-tool-what">${esc((it.text || '').replace(/\s+/g, ' ').slice(0, 160))}</span><span class="faint small">${clock(it.t)}</span></summary><div class="chat-tool-body">${pre(it.text, it.truncated)}</div>`;
          list.append(d);
        }
      } else if (it.kind === 'image') {
        // pictures a tool returned sit under its call; the rest stand on their own
        const last = list.lastElementChild;
        const host = last?.classList.contains('chat-toolwrap') ? last.querySelector('.chat-tool-imgs') : null;
        if (host) host.append(imageBox(it));
        else {
          const d = document.createElement('div');
          d.className = `chat-item chat-msg ${it.role}`;
          d.append(imageBox(it));
          list.append(d);
        }
      } else if (it.kind === 'thinking') {
        const d = document.createElement('details');
        d.className = 'chat-item chat-think k-thinking';
        d.innerHTML = `<summary>${icon('sparkles', 14)}<span>Thinking</span><span class="faint small">${fmt.num((it.text || '').length + (it.truncated || 0))} characters</span></summary><div class="chat-think-body">${pre(it.text, it.truncated)}</div>`;
        list.append(d);
      } else {
        const d = document.createElement('article');
        d.className = `chat-item chat-msg ${it.role}${it.meta ? ' k-meta' : ''}`;
        const who = it.role === 'user' ? (agent ? 'Task' : 'You') : esc((it.model || 'Claude').replace(/^claude-/, ''));
        d.innerHTML = `<header><b>${it.meta ? 'System note' : who}</b><span class="faint small">${clock(it.t)}</span></header><div class="chat-md md">${it.meta ? pre(it.text, it.truncated) : markdownHtml(it.text || '', '')}</div>${it.truncated ? `<p class="faint small">…${fmt.num(it.truncated)} more characters not shown</p>` : ''}`;
        list.append(d);
      }
    }
  }

  async function next(all = false) {
    more.innerHTML = '<p class="faint small">Loading…</p>';
    try {
      do {
        const r = await hubApi(`api/machine/transcript?${q}&offset=${offset}&limit=${PAGE}`);
        total = r.total;
        paint(r.items);
        offset += r.items.length;
        if (!r.items.length) break;
      } while (all && offset < total);
    } catch (err) {
      more.innerHTML = `<p class="bad">${esc(err.message)}</p>`;
      return;
    }
    count.textContent = `${fmt.num(offset)} of ${fmt.num(total)} entries`;
    more.innerHTML =
      offset < total
        ? `<button class="btn" type="button" data-next>Load ${fmt.num(Math.min(PAGE, total - offset))} more</button> <button class="btn" type="button" data-all>Load everything</button>`
        : total
          ? '<button class="link-btn" type="button" data-refresh>Check for new entries</button>'
          : '<p class="viz-none">Nothing in this conversation yet.</p>';
  }
  more.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) void next();
    else if (e.target.closest('[data-all]')) void next(true);
    else if (e.target.closest('[data-refresh]')) void next();
  });
  await next();
}
