// Notifications: hitl's own certificates (https on the hub's port), Web Push's encryption and signature, which events
// notify (and the toggles), machine alerts and sessions that finished. Runs against dist/.
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-n-')));
process.env.HITL_HOME = path.join(tmp, 'home');
delete process.env.HITL_CONFIG;

const { ensureTls, caInfo, dualServer, resetTls } = await import('../dist/hub/tls.js');
const { encrypt, vapidHeader, subscribe, subscriptions, unsubscribe, vapidPublicKey, deviceName } = await import('../dist/hub/webpush.js');
const { Notifier, EVENTS, eventOn } = await import('../dist/hub/notify.js');
const { Alerts, SessionWatch, cleanRule, describe } = await import('../dist/machine/alerts.js');
const { updateUserConfig } = await import('../dist/hub/registry.js');
const { openProject } = await import('../dist/agent.js');
const { start } = await import('../dist/server.js');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const get = (mod, port, host, opts = {}) =>
  new Promise((resolve, reject) => {
    const r = mod.get({ host, port, path: '/', ...opts }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
    r.on('error', reject);
  });

test('the certificate authority is limited to local names, and the hub certificate covers this computer', () => {
  const t = ensureTls();
  const ca = new crypto.X509Certificate(t.ca);
  const leaf = new crypto.X509Certificate(t.cert);
  assert.ok(ca.ca, 'the authority is a CA');
  assert.ok(leaf.verify(ca.publicKey), 'the hub certificate is signed by it');
  assert.ok(leaf.checkIP('127.0.0.1') && leaf.checkHost('localhost'));
  for (const ip of t.ips) assert.ok(leaf.checkIP(ip), `covers ${ip}`);
  assert.ok(Date.parse(leaf.validTo) - Date.now() <= 398 * 86_400_000, 'no longer than a phone accepts');
  assert.equal(caInfo().fingerprint, t.fingerprint);
  // the same files the next time
  assert.equal(ensureTls().cert, t.cert);
});

test('one port answers http and https, and https follows the setting without a restart', async () => {
  let on = true;
  const d = dualServer((req, res) => res.end(req.socket.encrypted ? 'https' : 'http'), { enabled: () => on, get: ensureTls });
  await new Promise((r) => d.server.listen(0, '127.0.0.1', r));
  const port = d.server.address().port;
  const ca = caInfo().cert;
  assert.equal(await get(http, port, '127.0.0.1'), 'http');
  assert.equal(await get(https, port, '127.0.0.1', { ca }), 'https');
  assert.equal(await get(https, port, '127.0.0.1', { ca, servername: 'localhost', headers: { host: 'localhost' } }), 'https');
  await assert.rejects(get(https, port, '127.0.0.1'), /self.signed|unable to verify|UNABLE_TO_VERIFY/i, 'untrusted without the authority');
  on = false;
  await assert.rejects(get(https, port, '127.0.0.1', { ca, agent: false }), 'https is off: the TLS connection is dropped');
  assert.equal(await get(http, port, '127.0.0.1'), 'http');
  await new Promise((r) => {
    d.server.close(r);
    d.http.closeAllConnections();
    d.https()?.closeAllConnections();
  });
});

test('a new authority after a reset', () => {
  const before = caInfo().fingerprint;
  resetTls();
  assert.equal(caInfo(), undefined);
  assert.notEqual(ensureTls().fingerprint, before);
});

test('Web Push encryption matches RFC 8291 (appendix A)', () => {
  const as = crypto.createECDH('prime256v1');
  as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const out = encrypt(
    Buffer.from('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    as,
  );
  assert.equal(
    out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('the VAPID header is a JWT for the push service, signed with the hub key', () => {
  const k = crypto.createECDH('prime256v1');
  k.generateKeys();
  const keys = { publicKey: k.getPublicKey().toString('base64url'), privateKey: k.getPrivateKey().toString('base64url') };
  const h = vapidHeader('https://web.push.apple.com/abc', keys);
  const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(key, keys.publicKey);
  const [a, b, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
  const pub = k.getPublicKey();
  const verifyKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${a}.${b}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('devices sign up and leave; bad subscriptions are refused', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  assert.ok(vapidPublicKey().length > 80);
  subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/x1', keys }, 'Chrome on Android', 'https://192.168.1.5:4199');
  subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/x1', keys }, 'Chrome on Android', 'https://192.168.1.5:4199');
  assert.equal(subscriptions().length, 1, 'the same endpoint once');
  assert.throws(() => subscribe({ endpoint: 'http://evil/x', keys }, 'x', 'x'), /https/);
  assert.throws(() => subscribe({ endpoint: 'https://a/x', keys: { p256dh: 'short', auth: keys.auth } }, 'x', 'x'), /keys/);
  assert.ok(unsubscribe('https://fcm.googleapis.com/fcm/send/x1'));
  assert.equal(subscriptions().length, 0);
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
});

test('a level alert fires once it has held, then stays quiet; a total alert adds up its window', () => {
  const fired = [];
  let rules = [cleanRule({ metric: 'gpuTemp', op: '>', value: 85, minutes: 2 }, 'hot'), cleanRule({ metric: 'cost', op: '>', value: 20, minutes: 60 }, 'spend')];
  let spent = 5;
  const a = new Alerts(
    () => rules,
    (series, seconds) => (series === 'cl.cost' && seconds === 3600 ? spent : 0),
    (f) => fired.push(f),
  );
  const snap = (t, temp) => ({ t, cpu: { total: 10, cores: [] }, mem: { used: 1, total: 2 }, net: {}, disk: null, drives: [], gpus: [{ index: 0, name: 'g', util: 0, memUsed: 0, memTotal: 1, temp, power: 0 }], procs: null });
  const t0 = 1_000_000_000_000;
  a.sample(snap(t0, 90), []);
  a.sample(snap(t0 + 60_000, 90), []);
  assert.equal(fired.length, 0, 'not held long enough yet');
  a.sample(snap(t0 + 121_000, 91), []);
  assert.equal(fired.length, 1);
  assert.match(fired[0].title, /GPU temperature \(hottest\) above 85 °C for 2 minutes/);
  a.sample(snap(t0 + 200_000, 95), []);
  assert.equal(fired.length, 1, 'quiet for the cooldown');
  a.sample(snap(t0 + 210_000, 70), []);
  a.sample(snap(t0 + 40 * 60_000, 90), []);
  a.sample(snap(t0 + 43 * 60_000, 90), []);
  assert.equal(fired.length, 2, 'after the cooldown, held again: again');
  spent = 25;
  a.sample(snap(t0 + 44 * 60_000, 50), []);
  assert.equal(fired.length, 3);
  assert.equal(fired[2].rule.id, 'spend');
  assert.match(describe(fired[2].rule), /Token cost \(estimate\) above \$20 in 1 hour/);
  // off: never
  rules = rules.map((r) => ({ ...r, on: false }));
  a.sample(snap(t0 + 100 * 60_000, 99), []);
  assert.equal(fired.length, 3);
  assert.equal(typeof cleanRule({ metric: 'nope' }, 'x'), 'string');
  assert.equal(typeof cleanRule({ metric: 'cost', value: 1, minutes: 0 }, 'x'), 'string', 'a total needs a window');
});

test('a Claude Code session that worked a while and stopped counts as finished; a short one does not', () => {
  const w = new SessionWatch(20_000);
  const s = (status, sessionId = 'a') => ({ pid: 1, sessionId, name: 'n', cwd: '/x', status, kind: '', entrypoint: '', version: '', startedAt: 0, updatedAt: 0 });
  assert.deepEqual(w.update([s('busy')], 1000), []);
  const done = w.update([s('idle')], 40_000);
  assert.equal(done.length, 1);
  assert.equal(done[0].session.sessionId, 'a');
  w.update([s('busy', 'b')], 50_000);
  assert.deepEqual(w.update([s('idle', 'b')], 55_000), [], 'five seconds is not worth a notification');
});

test('events notify as configured: questions by default, acks only when turned on', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  updateUserConfig((c) => (c.notify = { webhook: `http://127.0.0.1:${hook.address().port}/`, quietSeconds: 1 }));
  assert.equal(eventOn({}, 'questions'), true);
  assert.equal(eventOn({}, 'acks'), false);
  assert.equal(eventOn({ replies: false }, 'replies'), false, 'the old replies setting still counts');
  assert.equal(EVENTS.length, 11);

  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const view = openProject(root);
  const n = new Notifier((k) => (k === 'proj' ? view : undefined), () => 4199, '', '/');
  n.baseline('proj');
  const until = async (count) => {
    for (let i = 0; i < 60 && received.length < count; i++) await new Promise((r) => setTimeout(r, 100));
  };
  view.questions.addQuestions('lunch', [{ id: 'food', question: 'Pizza or tacos?', type: 'single', options: [{ id: 'p', label: 'Pizza' }, { id: 't', label: 'Tacos' }], priority: 'blocking' }], undefined, { title: 'Lunch' });
  n.observe('proj', 'questions', 'lunch');
  await until(1);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'questions');
  assert.equal(received[0].blocking, 1);
  assert.equal(received[0].hash, '#/p/proj/q/lunch');
  assert.match(received[0].title, /Lunch: 1 new question/);

  // an ack: off by default
  view.questions.answer('lunch', 'food', { picked: ['t'] });
  view.questions.ack('lunch', ['food'], 'Ordered tacos');
  n.observe('proj', 'questions', 'lunch');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(received.length, 1, 'acks are off');

  updateUserConfig((c) => (c.notify.events = { acks: true }));
  view.questions.answer('lunch', 'food', { picked: ['p'] });
  view.questions.ack('lunch', ['food'], 'Ordered pizza instead');
  n.observe('proj', 'questions', 'lunch');
  await until(2);
  assert.equal(received[1].event, 'acks');
  assert.match(received[1].message, /Ordered pizza instead/);

  // questions turned off: a new one is quiet
  updateUserConfig((c) => (c.notify.events = { questions: false }));
  view.questions.addQuestions('lunch', [{ id: 'drink', question: 'Drink?', type: 'text' }]);
  n.observe('proj', 'questions', 'lunch');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(received.length, 2);

  // the machine's events go through the same toggles
  n.machine({ event: 'claudeIdle', title: 'x', message: 'y', hash: '#/machine', tag: 't' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 2, 'session finished is off by default');
  n.machine({ event: 'alert', title: '⚠ CPU', message: 'Now 99%.', hash: '#/machine', tag: 'alert-x', urgent: true });
  await until(3);
  assert.equal(received[2].kind, 'machine');
  assert.equal(received[2].event, 'alert');
  hook.close();
});

test('the hub serves the service worker and the authority without a token, and the settings with one', async () => {
  updateUserConfig((c) => {
    c.https = true;
    c.notify = {};
  });
  const run = await start({ mode: 'hub', projects: () => [], port: 0, host: '127.0.0.1', token: 'tok', settings: () => ({}), tls: { enabled: () => true, get: ensureTls } });
  try {
    const base = `http://127.0.0.1:${run.port}`;
    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(await sw.text(), /showNotification/);
    const ca = await fetch(`${base}/hitl-ca.crt`);
    assert.equal(ca.status, 200);
    assert.equal(new crypto.X509Certificate(Buffer.from(await ca.arrayBuffer())).fingerprint256, caInfo().fingerprint);
    assert.equal((await fetch(`${base}/api/notify`)).status, 401);
    const h = { authorization: 'Bearer tok', 'content-type': 'application/json' };
    const s = await (await fetch(`${base}/api/notify`, { headers: h })).json();
    assert.equal(s.https.on, true);
    assert.equal(s.https.secure, false);
    assert.equal(s.events.find((e) => e.id === 'questions').on, true);
    const s2 = await (await fetch(`${base}/api/notify`, { method: 'POST', headers: h, body: JSON.stringify({ events: { updates: true, bogus: true } }) })).json();
    assert.equal(s2.events.find((e) => e.id === 'updates').on, true);
    assert.equal(s2.channels.ntfy, undefined, 'ntfy is gone');
    // over https, on the same port
    const secure = await new Promise((resolve, reject) =>
      https
        .get({ host: '127.0.0.1', port: run.port, path: '/api/notify', ca: caInfo().cert, headers: { authorization: 'Bearer tok' } }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(JSON.parse(b)));
        })
        .on('error', reject),
    );
    assert.equal(secure.https.secure, true);
  } finally {
    await run.close();
  }
});

test('Slack: only incoming webhooks are accepted, the secret never shows, and messages are escaped with a button', async () => {
  const { isSlackWebhook, maskSlack, slackMessage, send } = await import('../dist/hub/notify.js');
  const hook = 'https://hooks.slack.com/services/T0ABCDEF/B0GHIJKL/abcdEFGHijklMNOPqrst1234';
  assert.ok(isSlackWebhook(hook));
  assert.ok(!isSlackWebhook('https://evil.example.com/services/x'));
  assert.ok(!isSlackWebhook('http://hooks.slack.com/services/x'));
  assert.ok(!isSlackWebhook('https://hooks.slack.com.evil.com/services/x'));
  const masked = maskSlack(hook);
  assert.ok(!masked.includes('abcdEFGHijklMNOPqrst'), masked);
  assert.match(masked, /^hooks\.slack\.com\/services\/.*1234$/);

  const n = { title: 'Ship <it> & go?', message: 'Approve or refuse: the agent is waiting.\nproj · deploy', url: 'http://192.168.1.5:4199/#/p/proj/r/deploy', hash: '#/p/proj/r/deploy', kind: 'approve', event: 'approve', approval: true, blocking: 1, project: 'proj', request: 'deploy', newQuestions: 0, newItems: 0, replies: 0, acks: 0, resolved: 0, updated: 0 };
  const m = slackMessage(n);
  assert.match(m.blocks[0].text.text, /\*Ship &lt;it&gt; &amp; go\?\*/);
  assert.equal(m.blocks[1].elements[0].url, n.url);
  assert.equal(m.blocks[1].elements[0].style, 'primary');
  assert.match(m.text, /^Ship <it> & go\?: Approve or refuse/);

  // it really posts (to a stand-in for Slack)
  const got = [];
  const fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  await send({ slack: `http://127.0.0.1:${fake.address().port}/services/x`, push: false }, n);
  assert.equal(got.length, 1);
  assert.ok(got[0].blocks);
  fake.close();
});

test('the hub refuses a Slack address that is not an incoming webhook, and shows the one it keeps masked', async () => {
  const run = await start({ mode: 'hub', projects: () => [], port: 0, host: '127.0.0.1', token: 'tok', settings: () => ({}) });
  try {
    const h = { authorization: 'Bearer tok', 'content-type': 'application/json' };
    const post = (json) => fetch(`http://127.0.0.1:${run.port}/api/notify`, { method: 'POST', headers: h, body: JSON.stringify(json) });
    const bad = await post({ slack: 'https://example.com/steal' });
    assert.equal(bad.status, 400);
    const ok = await (await post({ slack: 'https://hooks.slack.com/services/T1/B2/secretsecretsecret9876' })).json();
    assert.match(ok.channels.slack, /…9876$/);
    assert.ok(!ok.channels.slack.includes('secretsecret'));
    const off = await (await post({ slack: null })).json();
    assert.equal(off.channels.slack, '');
  } finally {
    await run.close();
  }
});
