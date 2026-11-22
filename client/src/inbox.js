// The inbox: everything waiting on you, across every project (or one project's), most urgent first. Approvals (an agent
// waiting at a gate), then blocking questions, then reviews and questions, then things just to look at; what's done
// folds away underneath. A project's home adds its files, changes, notes and decisions.
import { api, ago, esc } from './util.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { ring, hueOfText, setHref } from './q/page.js';
import { reviewHref } from './r/page.js';
import { closeButton } from './close.js';

const t = (s) => Date.parse(s || '') || 0;

/** a row, with Dismiss beside it while it waits on you, or Reopen once it's closed */
const withClose = (link, kind, key, s, waiting) => (waiting || s.status === 'closed' ? `<div class="set-line">${link}${closeButton(kind, key, s.id, s.status === 'closed')}</div>` : link);

/** every request as a row, with how urgent it is */
function rows(projects) {
  const out = [];
  for (const p of projects) {
    for (const s of p.reviews) {
      const waiting = s.status === 'open' && !s.done;
      const urgency = !waiting ? 0 : s.mode === 'approve' ? 100 : s.mode === 'review' ? 60 + (s.unread ? 0 : 0) : 30;
      out.push({ kind: 'review', p, s, waiting, urgency, at: t(s.updated || s.created) });
    }
    for (const s of p.questions) {
      const waiting = s.status === 'open' && s.toAnswer > 0;
      out.push({ kind: 'questions', p, s, waiting, urgency: !waiting ? 0 : s.blocking ? 90 : 50, at: t(s.updated) });
    }
  }
  return out.sort((a, b) => b.urgency - a.urgency || b.at - a.at);
}

function reviewRow(p, s, showProject) {
  const gate = s.mode === 'approve';
  const what = gate ? 'Approval' : s.mode === 'show' ? 'To look at' : 'Review';
  const ic = gate ? 'warning' : s.mode === 'show' ? 'eye' : 'diff';
  let status;
  if (gate) status = s.done ? `<span class="badge ${s.overall === 'ok' ? 'ok' : 'danger'}">${s.overall === 'ok' ? 'Approved' : s.overall === 'no' ? 'Refused' : 'Changes asked'}</span>` : '<span class="badge danger">Waiting for your OK</span>';
  else if (s.done) status = `<span class="badge ${s.overall === 'ok' ? 'ok' : 'warn'}">${icon('check', 12)}${s.mode === 'show' ? 'Seen' : s.overall === 'ok' ? 'Approved' : 'Changes asked'}</span>`;
  else if (s.mode === 'review') status = `<span class="badge accent">${s.items - s.reviewed} to review</span>`;
  else status = `<span class="badge accent">${s.items} to look at</span>`;
  const chips = [status, s.open ? `<span class="badge">${s.open} open comment${s.open === 1 ? '' : 's'}</span>` : '', s.stale ? `<span class="badge warn">${s.stale} updated since</span>` : '', s.errors ? `<span class="badge danger">${s.errors} errors</span>` : ''].join('');
  const sub = [showProject ? esc(p.name) : '', what, s.from ? `from ${esc(s.from)}` : '', s.updated ? esc(ago(t(s.updated))) : ''].filter(Boolean).join(' · ');
  const lead = gate ? `<span class="row-icon gate">${icon(ic, 22)}</span>` : s.mode === 'review' && s.items ? ring(s.reviewed, s.items, 48) : `<span class="row-icon">${icon(ic, 22)}</span>`;
  return `<a class="set-row${s.status === 'closed' ? ' closed' : ''}${gate && !s.done ? ' urgent' : ''}" href="${reviewHref(p.key, s.id)}">${lead}<div class="set-info"><b class="set-name">${esc(s.title)}</b><span class="set-sub">${sub}</span><span class="set-chips">${chips}</span></div><span class="set-go">${icon('chevron-right', 20)}</span></a>`;
}

function questionsRow(p, s, showProject) {
  const chips = [
    s.toAnswer ? `<span class="badge accent">${s.toAnswer} to answer</span>` : `<span class="badge ok">${icon('check', 13)}All answered</span>`,
    s.blocking ? `<span class="badge danger">${icon('warning', 12)}${s.blocking} blocking</span>` : '',
    s.changed ? `<span class="badge warn">${s.changed} changed</span>` : '',
    s.later ? `<span class="badge">${s.later} later</span>` : '',
    s.errors ? `<span class="badge danger">${s.errors} errors in the file</span>` : '',
  ].join('');
  const sub = [showProject ? esc(p.name) : '', 'Questions', s.from ? `from ${esc(s.from)}` : '', `${s.done} of ${s.visible} answered`, s.updated ? esc(ago(t(s.updated))) : ''].filter(Boolean).join(' · ');
  return `<a class="set-row${s.status === 'closed' ? ' closed' : ''}${s.blocking ? ' urgent' : ''}" href="${setHref(p.key, s.id)}">${ring(s.done, s.visible, 48)}<div class="set-info"><b class="set-name">${esc(s.title)}</b><span class="set-sub">${sub}</span><span class="set-chips">${chips}</span></div><span class="set-go">${icon('chevron-right', 20)}</span></a>`;
}

const rowHtml = (r, showProject) => withClose(r.kind === 'review' ? reviewRow(r.p, r.s, showProject) : questionsRow(r.p, r.s, showProject), r.kind === 'review' ? 'review' : 'questions', r.p.key, r.s, r.waiting);

/** the inbox: every project (key ''), or one */
export function renderInbox(el, key = '') {
  const projects = state.hub.projects.filter((p) => !key || p.key === key);
  const all = rows(projects);
  const waiting = all.filter((r) => r.waiting);
  const done = all.filter((r) => !r.waiting);
  const gates = waiting.filter((r) => r.kind === 'review' && r.s.mode === 'approve').length;
  const many = !key && projects.length > 1;
  const p = key ? projects[0] : null;
  document.title = `${waiting.length ? `(${waiting.length}) ` : ''}${p ? p.name + ' · ' : ''}hitl`;
  let html = `<div class="page-wrap inbox">`;
  html += `<header class="page-hero"><div>${p ? `<span class="eyebrow">${esc(p.name)}</span>` : '<span class="eyebrow">Human In The Loop</span>'}<h1>${waiting.length ? `${waiting.length} waiting on you` : 'All caught up'}</h1>${
    gates ? `<p><span class="badge danger">${icon('warning', 13)} ${gates} approval${gates === 1 ? '' : 's'}: an agent is waiting</span></p>` : ''
  }</div></header>`;
  if (p) html += projectLinks(p);
  if (!all.length) {
    html += `<div class="empty"><div class="empty-art">${icon('chat', 34)}</div><h2>Nothing from an agent yet</h2><p>When an agent asks you something, shows you something or waits for your OK, it shows up here (and as a notification on your phone or computer: <a href="#/notify">Notifications</a>). In a project folder, run <code>npx hitloop init</code> once to set it up for Claude Code.</p>${p ? `<p><a class="btn" href="#/p/${encodeURIComponent(p.key)}/files/">${icon('folder', 16)} Browse the files</a></p>` : ''}</div>`;
  } else {
    if (waiting.length) html += `<section class="inbox-sec"><div class="sets">${waiting.map((r) => rowHtml(r, many)).join('')}</div></section>`;
    if (done.length) html += `<details class="inbox-done"${waiting.length ? '' : ' open'}><summary>${icon('check', 15)} Done (${done.length})</summary><div class="sets">${done.slice(0, 60).map((r) => rowHtml(r, many)).join('')}</div></details>`;
  }
  if (!key && projects.length) {
    html += `<section class="inbox-sec"><h2 class="sec-h">Projects</h2><div class="proj-grid">${projects
      .map((pr) => {
        const w = rows([pr]).filter((r) => r.waiting).length;
        return `<a class="proj-card" href="#/p/${encodeURIComponent(pr.key)}"><span class="proj-mark" style="--hue:${hueOfText(pr.name)}">${esc(pr.name.slice(0, 1).toUpperCase())}</span><span class="proj-text"><b>${esc(pr.name)}</b><span class="faint">${esc(pr.root)}</span></span>${w ? `<span class="count">${w}</span>` : ''}${pr.notes.open ? `<span class="pill">${pr.notes.open} note${pr.notes.open === 1 ? '' : 's'}</span>` : ''}</a>`;
      })
      .join('')}</div></section>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

function projectLinks(p) {
  const k = encodeURIComponent(p.key);
  return `<nav class="proj-links"><a class="tile" href="#/p/${k}/files/">${icon('folder', 20)}<b>Files</b><span class="faint">Browse &amp; search</span></a><a class="tile" href="#/p/${k}/files/?m=changes">${icon('diff', 20)}<b>Changes</b><span class="faint">Since last commit</span></a><a class="tile" href="#/p/${k}/notes">${icon('chat', 20)}<b>Notes</b><span class="faint">${p.notes.open ? `${p.notes.open} open` : 'You &amp; the agent'}</span></a><a class="tile" href="#/p/${k}/decisions">${icon('check', 20)}<b>Decisions</b><span class="faint">What you decided</span></a></nav>`;
}

// ── the decision log ──

export async function renderDecisions(el, q = '') {
  el.innerHTML = `<div class="page-wrap decisions"><header class="page-hero"><div><span class="eyebrow">${esc(state.info.name)}</span><h1>Decisions</h1></div></header>
  <p class="lede">Everything you answered, approved or gave a verdict on, newest first. Agents check this (<code>hitl decisions</code>) before asking again.</p>
  <form class="search wide" id="dec-form" role="search">${icon('search', 16)}<input id="dec-q" type="search" placeholder="Find a decision" value="${esc(q)}" autocomplete="off" enterkeyhint="search"></form>
  <div id="dec-list"><div class="skeleton" style="height:120px"></div></div></div>`;
  const list = el.querySelector('#dec-list');
  const draw = async () => {
    const want = el.querySelector('#dec-q').value.trim();
    const r = await api(`api/decisions?q=${encodeURIComponent(want)}&limit=300`).catch((e) => ({ error: e.message }));
    if (r.error) return void (list.innerHTML = `<p class="problem">${esc(r.error)}</p>`);
    if (!r.decisions.length) return void (list.innerHTML = `<p class="empty">${want ? `Nothing matches “${esc(want)}”.` : 'No decisions yet.'}</p>`);
    let day = '';
    list.innerHTML = r.decisions
      .map((d) => {
        const dd = new Date(d.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const head = dd !== day ? `<h3 class="dec-day">${esc((day = dd))}</h3>` : '';
        const href = d.kind === 'answer' ? setHref(state.project, d.request, d.id) : reviewHref(state.project, d.request, d.id || '');
        const cls = /good|approved/.test(d.decision) ? 'ok' : /no|refused|reject/.test(d.decision) ? 'danger' : /changes|not yet/.test(d.decision) ? 'warn' : 'accent';
        return `${head}<a class="dec-row" href="${href}"><span class="dec-kind">${icon(d.kind === 'answer' ? 'chat' : d.kind === 'approval' ? 'warning' : 'check', 16)}</span><span class="dec-text"><span class="dec-subject">${esc(d.subject)}</span><span class="dec-decision"><span class="badge ${cls}">${esc(d.decision)}</span>${d.note ? ` <span class="dec-note">“${esc(d.note)}”</span>` : ''}</span><span class="faint small">${esc(d.requestTitle)}${d.from ? ` · from ${esc(d.from)}` : ''} · ${new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></span></a>`;
      })
      .join('');
  };
  let timer;
  el.querySelector('#dec-q').oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 200);
  };
  el.querySelector('#dec-form').onsubmit = (e) => {
    e.preventDefault();
    draw();
  };
  await draw();
}
