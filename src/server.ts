// The HTTP server (the hub): the page, every project it serves (files, notes, questions, reviews, under p/<key>/),
// and live events when anything changes. One server for every project, so a phone needs one bookmark.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreError } from './hub/atomic.js';
import { Workspace, type ProjectSettings, type RequestChange } from './workspace.js';
import { bearer, body, cookie, json, same } from './http.js';
import { Machine, type MachineEvent } from './machine/index.js';
import { dualServer, caInfo, ensureTls, type TlsSource } from './hub/tls.js';
import { EVENTS, eventOn, isSlackWebhook, maskSlack, notifyConfig, send, testNotice, type NotifyEvent } from './hub/notify.js';
import { deviceName, pushAll, subscribe, subscriptions, unsubscribe, vapidPublicKey } from './hub/webpush.js';
import { lanAddresses, updateUserConfig } from './hub/registry.js';

export interface ServedProject {
  key: string;
  root: string;
}

export interface Options {
  /** the projects to serve; read again when `watchList` changes */
  projects: () => ServedProject[];
  /** a file whose changes mean the project list changed (the hub's projects.json) */
  watchList?: string;
  mode: 'hub' | 'solo';
  port: number;
  host: string;
  /** a URL path to serve under, as "/a/b/" (default "/") */
  base?: string;
  token?: string;
  allowHosts?: string[];
  /** settings for a project (its own .hitl/config.json over the user's) */
  settings: (root: string) => ProjectSettings;
  /** something changed in a project's requests: a question set, a review, the notes */
  onRequest?: (project: string, change: RequestChange) => void;
  /** a project joined after the start */
  onProject?: (project: string) => void;
  /** answer https on the same port too, when it says so */
  tls?: TlsSource;
  /** something on the machine dashboard worth a notification */
  onMachine?: (e: MachineEvent) => void;
}

export interface Running {
  server: net.Server;
  /** https is answered on the port too (now) */
  https: () => boolean;
  port: number;
  pool: Map<string, Workspace>;
  close: () => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, 'client');
export const version = readVersion();

const STATIC: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

export async function start(opts: Options): Promise<Running> {
  const token = opts.token ?? '';
  const base = opts.base ?? '/';
  const pool = new Map<string, Workspace>();
  const clients = new Set<http.ServerResponse>();
  const broadcast = (type: string, data: unknown) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  let started = false;
  const refresh = () => {
    const list = opts.projects();
    const keys = new Set(list.map((p) => p.key));
    let changed = false;
    for (const [k, w] of pool)
      if (!keys.has(k) || path.resolve(list.find((p) => p.key === k)?.root ?? '') !== w.root) {
        w.close();
        pool.delete(k);
        changed = true;
      }
    for (const p of list) {
      if (pool.has(p.key)) continue;
      pool.set(p.key, new Workspace(p.key, p.root, opts.settings(p.root), broadcast, (c) => opts.onRequest?.(p.key, c)));
      if (started) opts.onProject?.(p.key);
      changed = true;
    }
    if (changed) broadcast('projects', {});
  };
  refresh();
  started = true;
  // the machine dashboard belongs to the hub (one per computer), not to a --solo server
  const machine = opts.mode === 'hub' ? new Machine(broadcast, opts.onMachine) : undefined;
  const tick = setInterval(refresh, 3000);
  tick.unref();
  let listWatch: fs.FSWatcher | undefined;
  if (opts.watchList) {
    try {
      listWatch = fs.watch(path.dirname(opts.watchList), (_e, name) => {
        if (String(name) === path.basename(opts.watchList ?? '')) refresh();
      });
      listWatch.on('error', () => undefined);
    } catch {
      // the tick covers it
    }
  }
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  ping.unref();

  const allowed = allowedHosts(opts.host, opts.allowHosts ?? []);

  const dual = dualServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const code = err instanceof StoreError ? 400 : 500;
      if (!res.headersSent) json(res, code, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  }, opts.tls);
  const server = dual.server;
  // a new Wi-Fi address needs a certificate that names it
  const certCheck = setInterval(() => dual.refresh(), 60_000);
  certCheck.unref();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding: a page on another site that resolves its name to this machine is refused
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!allowed(host)) return json(res, 403, { error: `Host "${host}" is not allowed. Start with --allow-host ${host} to allow it.` });
    const url = new URL(req.url ?? '/', 'http://x');
    if (base !== '/') {
      if (url.pathname === base.slice(0, -1)) return void res.writeHead(301, { location: base + url.search }).end();
      if (!url.pathname.startsWith(base)) return json(res, 404, { error: `not found (hitl is under ${base})` });
    }
    const p = '/' + url.pathname.slice(base.length);
    if (p === '/api/ping') return json(res, 200, { app: 'hitl', version, mode: opts.mode, base });
    if (p === '/manifest.webmanifest') return manifest(res, base);
    if (p === '/sw.js') return sendStatic(req, res, path.join(clientDir, 'sw.js'), false);
    // the certificate authority is public (it's what a phone installs to trust this hub)
    if (p === '/hitl-ca.crt' || p === '/hitl-ca.pem') {
      const ca = caInfo();
      if (!ca) return json(res, 404, { error: 'https is off: hitl https on' });
      const der = p.endsWith('.crt');
      const file = `hitl-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-ca.${der ? 'crt' : 'pem'}`;
      return void res
        .writeHead(200, { 'content-type': der ? 'application/x-x509-ca-cert' : 'application/x-pem-file', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' })
        .end(der ? ca.der : ca.cert);
    }
    if (token) {
      const given = url.searchParams.get('token') ?? bearer(req) ?? cookie(req, 'hitl_token') ?? '';
      if (!same(given, token)) {
        if (p === '/' || p === '/index.html') return void res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOCKED);
        return json(res, 401, { error: 'This hitl needs its token: open the link with ?token=… once.' });
      }
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        res.setHeader('set-cookie', `hitl_token=${encodeURIComponent(token)}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=31536000`);
        if (p === '/' || p === '/index.html') return void res.writeHead(302, { location: base + (url.search || '') }).end();
      }
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      // writes come only from this page: our own origin
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin write refused' });
    }

    if (p === '/' || p === '/index.html') return sendStatic(req, res, path.join(clientDir, 'index.html'), false);
    if (p.startsWith('/assets/')) {
      const abs = path.resolve(clientDir, '.' + p);
      if (!abs.startsWith(clientDir + path.sep)) return json(res, 404, { error: 'not found' });
      // chunks carry a hash in their name: keep them; the entry files are checked each time
      return sendStatic(req, res, abs, p.startsWith('/assets/chunks/'));
    }
    if (p === '/api/info') {
      return json(res, 200, {
        version,
        mode: opts.mode,
        hostname: os.hostname(),
        projects: [...pool.values()].map((w) => w.overview()),
      });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('event: hello\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/notify' || p.startsWith('/api/notify/')) return notifyApi(p.slice('/api/notify'.length), req, res);
    if (p === '/api/machine' || p.startsWith('/api/machine/')) {
      if (!machine) return json(res, 404, { error: 'The machine dashboard runs on the hub, not a --solo server' });
      return machine.handle(p.slice('/api/machine'.length), url, req, res);
    }
    const pm = /^\/p\/([^/]+)(\/.*)?$/.exec(p);
    if (pm) {
      const w = pool.get(decodeURIComponent(pm[1] ?? ''));
      if (!w) return json(res, 404, { error: 'No such project' });
      return w.handle(pm[2] ?? '/', url, req, res);
    }
    return json(res, 404, { error: 'not found' });
  }

  /** Notifications: what's on, the devices that get Web Push, https, and a test. */
  async function notifyApi(sub: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const secure = 'encrypted' in req.socket && !!req.socket.encrypted;
    const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    const origin = `${secure ? 'https' : 'http'}://${req.headers.host ?? ''}`;
    const idOf = (endpoint: string) => crypto.createHash('sha1').update(endpoint).digest('hex').slice(0, 12);
    if (sub === '/subscribe' && method === 'POST') {
      const b = await body(req);
      const s = b['subscription'] as { endpoint: string; keys: { p256dh: string; auth: string } } | undefined;
      if (!s || typeof s !== 'object') throw new StoreError('{ subscription }');
      try {
        const saved = subscribe(s, deviceName(String(req.headers['user-agent'] ?? '')), origin);
        return json(res, 200, { ok: true, id: idOf(saved.endpoint) });
      } catch (e) {
        throw new StoreError(e instanceof Error ? e.message : String(e));
      }
    }
    if (sub === '/unsubscribe' && method === 'POST') {
      const b = await body(req);
      const id = String(b['id'] ?? '');
      const endpoint = String(b['endpoint'] ?? '') || subscriptions().find((x) => idOf(x.endpoint) === id)?.endpoint || '';
      return json(res, 200, { ok: unsubscribe(endpoint) });
    }
    if (sub === '/test' && method === 'POST') {
      const b = await body(req);
      const cfg = notifyConfig();
      const n = testNotice(cfg, Number(req.socket.localPort) || opts.port, base);
      const id = typeof b['id'] === 'string' ? b['id'] : '';
      if (b['channel'] === 'slack') {
        if (!cfg.slack) return json(res, 200, { ok: false, error: 'Slack is off' });
        try {
          await send({ slack: cfg.slack, push: false }, { ...n, message: 'Slack gets them here. ' + n.message });
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (id) {
        const r = await pushAll({ title: n.title, body: 'This device gets them. ' + n.message, hash: n.hash, tag: 'test' }, (x) => idOf(x.endpoint) === id);
        return json(res, 200, { ok: r.sent > 0, ...r });
      }
      try {
        const r = await send(cfg, n);
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (sub === '' || sub === '/') {
      if (method === 'POST') {
        const b = await body(req);
        const slack = b['slack'];
        if (slack !== undefined && slack !== null && slack !== '' && (typeof slack !== 'string' || !isSlackWebhook(slack.trim())))
          throw new StoreError('That is not a Slack incoming webhook: it looks like https://hooks.slack.com/services/T…/B…/…');
        updateUserConfig((c) => {
          const n = (c.notify ??= {});
          if (slack === null || slack === '') delete n.slack;
          else if (typeof slack === 'string') n.slack = slack.trim();
          if (typeof b['push'] === 'boolean') n.push = b['push'];
          const ev = b['events'];
          if (ev && typeof ev === 'object')
            for (const [k, v] of Object.entries(ev as Record<string, unknown>)) if (EVENTS.some((e) => e.id === k) && typeof v === 'boolean') (n.events ??= {})[k as NotifyEvent] = v;
          if (typeof b['https'] === 'boolean') {
            if (b['https']) {
              ensureTls();
              c.https = true;
            }
            else delete c.https;
          }
          if (typeof b['quietSeconds'] === 'number') n.quietSeconds = Math.max(1, Math.min(600, b['quietSeconds']));
        });
      }
      const cfg = notifyConfig();
      const ca = caInfo();
      const url = (u: string) => {
        try {
          const x = new URL(u);
          return x.host + (x.pathname === '/' ? '' : x.pathname);
        } catch {
          return u;
        }
      };
      return json(res, 200, {
        events: EVENTS.map((e) => ({ ...e, on: eventOn(cfg, e.id) })),
        push: cfg.push !== false,
        quietSeconds: cfg.quietSeconds ?? 20,
        channels: { webhook: cfg.webhook ? url(cfg.webhook) : '', slack: cfg.slack ? maskSlack(cfg.slack) : '' },
        devices: subscriptions().map((s) => ({ id: idOf(s.endpoint), device: s.device, origin: s.origin, added: s.added, lastOk: s.lastOk ?? '', lastError: s.lastError ?? '', service: new URL(s.endpoint).host })),
        vapidKey: vapidPublicKey(),
        https: {
          on: !!opts.tls?.enabled(),
          port: Number(req.socket.localPort) || opts.port,
          fingerprint: ca?.fingerprint ?? '',
          secure,
          host: hostName,
          // the secure page on each address, with the token (a cookie from http may not carry over)
          links: opts.tls?.enabled() ? lanAddresses().map((ip) => `https://${ip}:${Number(req.socket.localPort) || opts.port}${base}${token ? `?token=${encodeURIComponent(token)}` : ''}#/notify`) : [],
        },
        machine: opts.mode === 'hub',
      });
    }
    return json(res, 404, { error: 'not found' });
  }

  const port = await listen(server, opts.port, opts.host);
  return {
    server,
    https: () => !!opts.tls?.enabled(),
    port,
    pool,
    close: async () => {
      clearInterval(tick);
      clearInterval(ping);
      clearInterval(certCheck);
      machine?.close();
      listWatch?.close();
      for (const w of pool.values()) w.close();
      for (const c of clients) c.end();
      const closed = new Promise<void>((r) => server.close(() => r()));
      dual.http.closeAllConnections();
      dual.https()?.closeAllConnections();
      await closed;
    },
  };
}

/** listen on the port, or the next free one */
function listen(server: net.Server, port: number, host: string, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && tries > 1 && port !== 0) resolve(listen(server, port + 1, host, tries - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const LOCKED =
  '<!doctype html><meta name="viewport" content="width=device-width"><title>hitl</title><body style="font:16px system-ui;padding:2em;max-width:36em;margin:auto"><h1>🔒 This hitl needs its token</h1><p>Open the link you were given (it ends in <code>?token=…</code>). It is kept as a cookie, so you only need it once on this device. <code>npx hitloop url</code> prints the links.</p>';

function allowedHosts(bind: string, extra: string[]): (host: string) => boolean {
  const names = new Set(['localhost', os.hostname().toLowerCase(), ...extra.map((h) => h.toLowerCase())]);
  if (bind !== '0.0.0.0' && bind !== '::') names.add(bind.toLowerCase());
  return (h) =>
    names.has(h) ||
    h.endsWith('.localhost') ||
    h.endsWith('.ts.net') || // a Tailscale name
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || // an IP address can't be rebound
    h.includes(':') ||
    extra.includes('*');
}

function sendStatic(req: http.IncomingMessage, res: http.ServerResponse, abs: string, immutable: boolean): void {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304, { etag, 'cache-control': cache }).end();
    fs.readFile(abs, (e2, buf) => {
      if (e2) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': STATIC[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': cache, etag }).end(buf);
    });
  });
}

/** so a phone can put hitl on its home screen, with its own icon */
function manifest(res: http.ServerResponse, base: string): void {
  const icon = `${base}assets/icon.svg`;
  json(res, 200, {
    name: 'hitl — Human In The Loop',
    short_name: 'hitl',
    start_url: base,
    scope: base,
    display: 'standalone',
    background_color: '#f8f8fb',
    theme_color: '#5b5fd6',
    icons: [
      { src: icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: `${base}assets/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${base}assets/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
}

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' && 'version' in pkg ? String(pkg.version) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
