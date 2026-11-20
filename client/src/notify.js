// Notifications: this device (Web Push on or off, a test), setting up a phone (https with hitl's own certificate),
// which events notify, machine alerts, and where they go (devices, Slack, a webhook).
//   #/notify
import { api, esc, ago, toast } from './util.js';
import { icon } from './icons.js';

const hubApi = (u, o = {}) => api(u, { ...o, hub: true });
const view = { el: null, data: null, alerts: null, mine: '', busy: false };

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const ua = navigator.userAgent;
const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function idOf(endpoint) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/** this page's service worker (registered once; it only shows notifications) */
async function registration() {
  const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  return reg;
}

/** the subscription this device has now, if it's the hub's (an old key means sign up again) */
async function currentSubscription(vapidKey) {
  if (!supported() || !isSecureContext) return null;
  const reg = await navigator.serviceWorker.getRegistration('./');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const key = sub.options?.applicationServerKey;
  if (key && vapidKey) {
    const a = new Uint8Array(key);
    const b = keyBytes(vapidKey);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      await sub.unsubscribe();
      return null;
    }
  }
  return sub;
}

export async function showNotify(el) {
  view.el = el;
  document.title = 'Notifications · hitl';
  el.innerHTML = `<div class="page-wrap notif"><header class="page-hero"><div><span class="eyebrow">This hub</span><h1>Notifications</h1></div></header>
  <p class="lede">A notification when an agent asks you something, wants your OK, shows you something, or replies; when a Claude Code session finishes; and when this computer crosses a line you set.</p>
  <div id="nf-body"><div class="skeleton" style="height:180px"></div></div></div>`;
  await load();
}

export function leaveNotify() {
  view.el = null;
}

async function load() {
  try {
    view.data = await hubApi('api/notify');
    view.alerts = view.data.machine ? await hubApi('api/machine/alerts').catch(() => null) : null;
    const sub = await currentSubscription(view.data.vapidKey).catch(() => null);
    view.mine = sub ? await idOf(sub.endpoint) : '';
    // signed up here, but the hub forgot it (or another hub): tell this hub again
    if (sub && !view.data.devices.some((d) => d.id === view.mine)) {
      await hubApi('api/notify/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
      view.data = await hubApi('api/notify');
    }
  } catch (e) {
    if (view.el) view.el.querySelector('#nf-body').innerHTML = `<p class="problem">${esc(e.message)}</p>`;
    return;
  }
  paint();
}

function paint() {
  const body = view.el?.querySelector('#nf-body');
  if (!body) return;
  const d = view.data;
  body.innerHTML = `
  <section class="card nf-card" id="nf-device">${deviceCard()}</section>
  ${d.machine ? `<section class="card nf-card" id="nf-phone">${httpsCard()}</section>` : ''}
  <section class="card nf-card"><div class="card-head">${icon('check', 14)} What notifies</div>
    <div class="nf-events">${d.events
      .map(
        (e) => `<label class="nf-event"><input type="checkbox" data-ev="${esc(e.id)}" ${e.on ? 'checked' : ''}><span><b>${esc(e.label)}</b><span class="faint small">${esc(e.detail)}</span></span></label>`,
      )
      .join('')}</div>
    <p class="faint small nf-foot">Changes are gathered up: an agent asking 20 questions in a minute is one notification, sent once it has been quiet for ${d.quietSeconds} s. Approvals go at once.</p>
  </section>
  ${d.machine ? `<section class="card nf-card" id="nf-alerts">${alertsCard()}</section>` : ''}
  <section class="card nf-card"><div class="card-head">${icon('link', 14)} Where they go</div><div class="nf-pad">
    <p><b>Devices with push:</b> ${d.devices.length ? '' : 'none yet.'}</p>
    ${d.devices.length ? `<ul class="nf-devices">${d.devices.map(deviceRow).join('')}</ul>` : ''}
    ${d.push ? '' : '<p class="problem small">Push is paused for every device. <button class="link-btn" type="button" data-act="push-on">Resume it</button></p>'}
    <div class="nf-slack">
      <p><b>Slack:</b> ${d.channels.slack ? `<code>${esc(d.channels.slack)}</code> <button class="link-btn" type="button" data-act="slack-test">Test</button> <button class="link-btn danger" type="button" data-act="slack-off">Remove</button>` : '<span class="faint">off</span>'}</p>
      <form class="nf-new" id="nf-slack-form"><input id="nf-slack" type="url" placeholder="https://hooks.slack.com/services/…" autocomplete="off" spellcheck="false"><button class="btn${d.channels.slack ? '' : ' primary'}" type="submit">${d.channels.slack ? 'Replace' : 'Add Slack'}</button></form>
      <p class="faint small">Each notification posts to a Slack channel, with a button that opens hitl. In Slack: <b>Apps → Incoming Webhooks → Add to Slack</b>, pick the channel, and paste the webhook URL here. (The button opens this hub's address, so it works from devices that can reach it.)</p>
    </div>
    <p><b>Webhook:</b> ${d.channels.webhook ? esc(d.channels.webhook) : '<span class="faint">off</span>'}</p>
    <p class="faint small">Any webhook (Pushover, Discord, Home Assistant) gets each notification as JSON: <code>npx hitloop notify webhook &lt;url&gt;</code>. <button class="link-btn" type="button" data-act="test-all">Test every way</button></p>
  </div></section>`;
  wire(body);
}

function deviceRow(x) {
  const me = x.id === view.mine;
  const state = x.lastError ? `<span class="badge danger" title="${esc(x.lastError)}">failing</span>` : x.lastOk ? `<span class="faint">last sent ${esc(ago(Date.parse(x.lastOk)))}</span>` : '<span class="faint">nothing sent yet</span>';
  return `<li><span>${esc(x.device)}${me ? ' <span class="badge accent">this device</span>' : ''}<span class="faint small"> · ${esc(x.origin.replace(/^https?:\/\//, ''))} · ${state}</span></span><span class="nf-row-acts"><button class="link-btn" type="button" data-test="${esc(x.id)}">Test</button><button class="link-btn danger" type="button" data-forget="${esc(x.id)}">Remove</button></span></li>`;
}

function deviceCard() {
  const d = view.data;
  const head = `<div class="card-head">${icon('monitor', 14)} This device</div>`;
  const pad = (html) => `${head}<div class="nf-pad">${html}</div>`;
  if (!isSecureContext) {
    return pad(`<p class="nf-state off">${icon('warning', 16)} Notifications need a secure page, and this one is plain http.</p>
      ${d.https.on && d.https.links.length ? `<p>This hub answers https too. <a class="btn primary" id="nf-go-secure" href="${esc(secureLink())}">Open the secure page</a></p><p class="faint small" id="nf-probe">Checking whether this device trusts it…</p>` : `<p>${d.machine ? 'Turn on https below, then set up this device.' : 'On the computer: <code>npx hitloop https on</code>.'}</p>`}
      <p class="faint small">On the computer running hitl, <a href="http://localhost:${d.https.port}/#/notify">http://localhost:${d.https.port}</a> counts as secure: notifications work there with no setup.</p>`);
  }
  if (!supported()) {
    if (isIos && !standalone())
      return pad(`<p class="nf-state off">${icon('info', 16)} On an iPhone or iPad, notifications come to apps on the home screen.</p><ol class="nf-steps"><li>Tap <b>Share</b> (the square with the arrow), then <b>Add to Home Screen</b>.</li><li>Open hitl from the home screen.</li><li>Come back here (Settings → Notifications) and turn them on.</li></ol>`);
    return pad(`<p class="nf-state off">${icon('warning', 16)} This browser can't get push notifications.</p>`);
  }
  const perm = Notification.permission;
  if (perm === 'denied') return pad(`<p class="nf-state off">${icon('warning', 16)} Notifications are blocked for this page. Allow them in the browser's site settings (the icon left of the address), then reload.</p>`);
  if (view.mine)
    return pad(`<p class="nf-state on">${icon('check', 16)} On: this device gets notifications.</p><div class="nf-acts"><button class="btn" type="button" data-test="${esc(view.mine)}">Send a test</button><button class="btn" type="button" data-act="off">Turn off here</button></div>`);
  return pad(`<p class="nf-state">Off on this device.</p><div class="nf-acts"><button class="btn primary" type="button" data-act="on">${icon('check', 14)} Turn on notifications</button></div>${isIos ? '<p class="faint small">iPhone and iPad: needs iOS 16.4 or later.</p>' : ''}`);
}

function secureLink() {
  const links = view.data.https.links;
  return links.find((l) => new URL(l).hostname === location.hostname) || links[0] || '';
}

function httpsCard() {
  const d = view.data;
  const h = d.https;
  const head = `<div class="card-head">${icon('phone', 14)} Set up a phone (https)</div>`;
  const toggle = `<label class="check"><input type="checkbox" id="nf-https" ${h.on ? 'checked' : ''}> Answer https on this port too, with hitl's own certificate</label>`;
  if (!h.on) return `${head}<div class="nf-pad">${toggle}<p class="faint small">Phones only offer notifications on https pages. hitl makes its own certificate authority, kept on this computer; a phone installs it once and then trusts this hub. It can only vouch for local addresses (192.168.x.x, 10.x.x.x, localhost and this computer's name), never another website.</p></div>`;
  const ca = 'hitl-ca.crt';
  const android = `<li><a class="btn small" href="${ca}" download>${icon('download', 14)} Download the certificate</a></li><li>Open <b>Settings → Security &amp; privacy → More security settings → Encryption &amp; credentials → Install a certificate → CA certificate</b> (search Settings for “CA certificate”), tap <b>Install anyway</b>, and pick the file you downloaded.</li><li>Open the secure page and turn notifications on.</li>`;
  const ios = `<li><a class="btn small" href="${ca}">${icon('download', 14)} Download the certificate</a> in Safari, and tap <b>Allow</b>.</li><li>Open <b>Settings → General → VPN &amp; Device Management</b>, tap the hitl profile, <b>Install</b>.</li><li>Then <b>Settings → General → About → Certificate Trust Settings</b>: turn on full trust for the hitl certificate.</li><li>Open the secure page in Safari, <b>Share → Add to Home Screen</b>, open it from there and turn notifications on.</li>`;
  const computer = `<li><a class="btn small" href="${ca}" download>${icon('download', 14)} Download the certificate</a> and add it to the computer's trusted root authorities (Windows: open it, <b>Install Certificate → Current User → Trusted Root Certification Authorities</b>; Mac: Keychain Access, then set it to Always Trust), or run <code>npx hitloop https trust</code> on that computer.</li><li>Restart the browser, open the secure page and turn notifications on.</li>`;
  const mine = isIos ? 'ios' : isAndroid ? 'android' : 'computer';
  const block = (k, title, html) => `<details class="nf-how" ${k === mine ? 'open' : ''}><summary>${title}${k === mine ? ' <span class="badge accent">this device</span>' : ''}</summary><ol class="nf-steps">${html}</ol></details>`;
  return `${head}<div class="nf-pad">${toggle}
    <p>Secure addresses: ${h.links.map((l) => `<a href="${esc(l)}">${esc(new URL(l).host)}</a>`).join(' · ') || '<span class="faint">no network address</span>'}</p>
    ${block('android', 'Android', android)}${block('ios', 'iPhone and iPad', ios)}${block('computer', 'Another computer', computer)}
    <p class="faint small">The certificate's fingerprint (SHA-256), to compare if a phone shows it:<br><code class="nf-fp">${esc(h.fingerprint)}</code></p>
    <p class="faint small">On this computer you don't need it: <a href="http://localhost:${h.port}/#/notify">http://localhost:${h.port}</a> is already secure.</p></div>`;
}

const sortMetrics = (ms) => [...ms.filter((m) => m.kind === 'level'), ...ms.filter((m) => m.kind === 'total')];

function alertsCard() {
  const a = view.alerts;
  const head = `<div class="card-head">${icon('warning', 14)} Machine alerts</div>`;
  if (!a) return `${head}<div class="nf-pad"><p class="faint">Couldn't read the alert rules.</p></div>`;
  const rows = a.rules
    .map(
      (r, i) =>
        `<li><label class="check"><input type="checkbox" data-rule-on="${i}" ${r.on ? 'checked' : ''}> ${esc(r.text)}</label><span class="faint small">then quiet for ${r.cooldown} min</span><button class="link-btn danger" type="button" data-rule-del="${i}">Remove</button></li>`,
    )
    .join('');
  const opts = sortMetrics(a.metrics)
    .map((m, i, all) => `${i === 0 || all[i - 1].kind !== m.kind ? `<optgroup label="${m.kind === 'level' ? 'A level, read every few seconds' : 'A total over a window'}">` : ''}<option value="${esc(m.id)}">${esc(m.label)}${m.unit ? ` (${esc(m.unit)})` : ''}</option>${i === all.length - 1 || all[i + 1].kind !== m.kind ? '</optgroup>' : ''}`)
    .join('');
  const first = sortMetrics(a.metrics)[0];
  return `${head}<div class="nf-pad">
    ${a.on ? '' : '<p class="problem small">The machine dashboard is off, so nothing is measured: turn it on in Settings (This computer) for these to work.</p>'}
    ${rows ? `<ul class="nf-rules">${rows}</ul>` : '<p class="faint">No alerts yet. Add one: a level held for a while (“GPU above 85 °C for 2 minutes”), or a total over a window (“more than $20 of tokens in an hour”).</p>'}
    <form class="nf-new" id="nf-new">
      <select id="nf-metric">${opts}</select>
      <select id="nf-op"><option value=">">above</option><option value="<">below</option></select>
      <span class="nf-num"><input id="nf-value" type="number" step="any" required value="${first?.value ?? ''}"><span id="nf-unit" class="faint">${esc(first?.unit ?? '')}</span></span>
      <span class="nf-num"><span id="nf-span-label" class="faint">for</span><input id="nf-min" type="number" min="0" step="1" value="${first?.minutes ?? 0}"><span class="faint">min</span></span>
      <button class="btn primary" type="submit">${icon('plus', 14)} Add</button>
    </form>
    <p class="faint small" id="nf-hint"></p>
  </div>`;
}

function wire(body) {
  const d = view.data;
  body.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || view.busy) return;
    const act = b.dataset.act;
    try {
      view.busy = true;
      if (act === 'on') await turnOn();
      else if (act === 'off') await turnOff();
      else if (act === 'push-on') await hubApi('api/notify', { method: 'POST', json: { push: true } });
      else if (act === 'slack-off') {
        await hubApi('api/notify', { method: 'POST', json: { slack: null } });
        toast('Slack removed');
      } else if (act === 'slack-test') {
        const r = await hubApi('api/notify/test', { method: 'POST', json: { channel: 'slack' } });
        toast(r.ok ? 'Sent to Slack' : `Slack: ${r.error}`);
      }
      else if (act === 'test-all') {
        const r = await hubApi('api/notify/test', { method: 'POST', json: {} });
        toast(r.ok ? 'Sent a test every way that is on' : `Not everything worked: ${r.error}`);
      } else if (b.dataset.test) {
        const r = await hubApi('api/notify/test', { method: 'POST', json: { id: b.dataset.test } });
        toast(r.sent ? 'Sent: it should show in a moment' : `Didn't reach it: ${(r.errors || []).join('; ') || 'no such device'}`);
      } else if (b.dataset.forget) {
        if (b.dataset.forget === view.mine) await turnOff();
        else await hubApi('api/notify/unsubscribe', { method: 'POST', json: { id: b.dataset.forget } });
      } else if (b.dataset.ruleDel) {
        const rules = view.alerts.rules.filter((_r, i) => String(i) !== b.dataset.ruleDel);
        view.alerts = await hubApi('api/machine/alerts', { method: 'POST', json: { rules } });
      } else return;
      await load();
    } catch (err) {
      toast(err.message);
    } finally {
      view.busy = false;
    }
  };
  for (const c of body.querySelectorAll('[data-ev]'))
    c.onchange = async () => {
      try {
        view.data = await hubApi('api/notify', { method: 'POST', json: { events: { [c.dataset.ev]: c.checked } } });
      } catch (err) {
        toast(err.message);
        c.checked = !c.checked;
      }
    };
  for (const c of body.querySelectorAll('[data-rule-on]'))
    c.onchange = async () => {
      const rules = view.alerts.rules.map((r, i) => (String(i) === c.dataset.ruleOn ? { ...r, on: c.checked } : r));
      try {
        view.alerts = await hubApi('api/machine/alerts', { method: 'POST', json: { rules } });
      } catch (err) {
        toast(err.message);
      }
    };
  const hs = body.querySelector('#nf-https');
  if (hs)
    hs.onchange = async () => {
      try {
        await hubApi('api/notify', { method: 'POST', json: { https: hs.checked } });
        toast(hs.checked ? 'https on: set up a phone below' : 'https off');
        await load();
      } catch (err) {
        toast(err.message);
        hs.checked = !hs.checked;
      }
    };
  wireAlertForm(body);
  const sf = body.querySelector('#nf-slack-form');
  if (sf)
    sf.onsubmit = async (e) => {
      e.preventDefault();
      const url = sf.querySelector('#nf-slack').value.trim();
      if (!url) return;
      try {
        await hubApi('api/notify', { method: 'POST', json: { slack: url } });
        const r = await hubApi('api/notify/test', { method: 'POST', json: { channel: 'slack' } });
        toast(r.ok ? 'Slack added: a test is in the channel' : `Saved, but Slack said: ${r.error}`);
        await load();
      } catch (err) {
        toast(err.message);
      }
    };
  // from plain http: does this device already trust the hub's certificate?
  const probe = body.querySelector('#nf-probe');
  if (probe) {
    const link = secureLink();
    const u = new URL(link);
    fetch(`${u.origin}${u.pathname}api/ping`, { mode: 'no-cors', cache: 'no-store' })
      .then(() => (probe.innerHTML = `${icon('check', 14)} This device trusts it: open the secure page and turn notifications on there.`))
      .catch(() => (probe.innerHTML = `This device doesn't trust it yet: ${d.machine ? 'follow “Set up a phone” below first' : 'install hitl’s certificate first (on the computer: npx hitloop https)'}.`));
  }
}

function wireAlertForm(body) {
  const form = body.querySelector('#nf-new');
  if (!form) return;
  const a = view.alerts;
  const m = () => a.metrics.find((x) => x.id === form.querySelector('#nf-metric').value);
  const hint = body.querySelector('#nf-hint');
  const sync = (reset) => {
    const x = m();
    if (!x) return;
    if (reset) {
      form.querySelector('#nf-op').value = x.op;
      form.querySelector('#nf-value').value = x.value;
      form.querySelector('#nf-min').value = x.minutes;
    }
    form.querySelector('#nf-unit').textContent = x.unit === '$' ? 'dollars' : x.unit === 'M' ? 'million tokens' : x.unit === 'k' ? 'thousand tokens' : x.unit;
    form.querySelector('#nf-span-label').textContent = x.kind === 'total' ? 'in the last' : 'for';
    form.querySelector('#nf-min').min = x.kind === 'total' ? 1 : 0;
    hint.textContent =
      x.kind === 'total'
        ? 'Added up over the window, checked twice a minute.'
        : `Read every few seconds; it fires once it has stayed past the line that long (0: at once).${a.have && x.id.startsWith('gpu') && !a.have.gpu ? ' No NVIDIA GPU was found on this computer.' : ''}`;
  };
  form.querySelector('#nf-metric').onchange = () => sync(true);
  sync(false);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const rule = { metric: form.querySelector('#nf-metric').value, op: form.querySelector('#nf-op').value, value: Number(form.querySelector('#nf-value').value), minutes: Number(form.querySelector('#nf-min').value), on: true };
    try {
      view.alerts = await hubApi('api/machine/alerts', { method: 'POST', json: { rules: [...a.rules, rule] } });
      toast('Alert added');
      paint();
    } catch (err) {
      toast(err.message);
    }
  };
}

async function turnOn() {
  const reg = await registration();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this page (the browser’s site settings can allow them)' : 'Notifications weren’t allowed');
  let sub = await currentSubscription(view.data.vapidKey);
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(view.data.vapidKey) });
  await hubApi('api/notify/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
  view.mine = await idOf(sub.endpoint);
  await hubApi('api/notify/test', { method: 'POST', json: { id: view.mine } }).catch(() => undefined);
  toast('Notifications on: a test is on its way');
}

async function turnOff() {
  const sub = await currentSubscription(view.data.vapidKey);
  if (sub) {
    await hubApi('api/notify/unsubscribe', { method: 'POST', json: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  }
  view.mine = '';
  toast('Notifications off on this device');
}

/** a tap on a notification while the page is open: go where it points */
export function listenForTaps() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.hitl === 'go' && typeof e.data.hash === 'string') location.hash = e.data.hash || '#/';
  });
}

/** a line for the Settings panel */
export async function notifySummary() {
  const d = await hubApi('api/notify');
  const sub = await currentSubscription(d.vapidKey).catch(() => null);
  const here = sub ? 'on for this device' : isSecureContext && supported() ? 'off for this device' : 'this page can’t get them (it needs https)';
  return `${d.devices.length} device${d.devices.length === 1 ? '' : 's'} with push, ${here}${d.channels.slack ? ', Slack' : ''}${d.channels.webhook ? ', a webhook' : ''}.`;
}

