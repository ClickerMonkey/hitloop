// Web Push straight from the hub, with nothing installed: the browser's push service (Google's for Chrome and Android,
// Apple's for Safari and iPhones, Mozilla's for Firefox) carries an encrypted message to each device that turned
// notifications on. Only that device can read it (RFC 8291); the hub proves who it is with its own key (VAPID, RFC 8292).
//   ~/.config/hitl/push.json    the hub's key pair and every device that signed up
// A browser only offers push on a secure page: http://localhost on this computer, or https (hitl https) elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from './registry.js';
import { writeAtomic, withLock } from './atomic.js';

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** a name for the device, from its browser ("Chrome on Android") */
  device: string;
  /** where it signed up (the page's address) */
  origin: string;
  added: string;
  /** the last time a message reached it, or failed */
  lastOk?: string;
  lastError?: string;
}

interface PushFile {
  /** base64url: the raw public key (65 bytes) and the private scalar */
  publicKey: string;
  privateKey: string;
  subscriptions: Subscription[];
}

const pushFile = () => path.join(configDir(), 'push.json');
const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

function read(): PushFile | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(pushFile(), 'utf8')) as Partial<PushFile>;
    if (typeof d.publicKey === 'string' && typeof d.privateKey === 'string') return { publicKey: d.publicKey, privateKey: d.privateKey, subscriptions: Array.isArray(d.subscriptions) ? d.subscriptions : [] };
  } catch {
    // none yet
  }
  return undefined;
}

function write(d: PushFile): void {
  fs.mkdirSync(configDir(), { recursive: true });
  writeAtomic(pushFile(), JSON.stringify(d, null, 2) + '\n');
  try {
    fs.chmodSync(pushFile(), 0o600);
  } catch {
    // Windows
  }
}

/** Change the push file under its lock (the key pair is made the first time). */
function mutate<T>(fn: (d: PushFile) => T): T {
  fs.mkdirSync(configDir(), { recursive: true });
  return withLock(pushFile(), () => {
    let d = read();
    if (!d) {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      d = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subscriptions: [] };
    }
    const out = fn(d);
    write(d);
    return out;
  });
}

/** The hub's public key, for the page's pushManager.subscribe (made the first time). */
export function vapidPublicKey(): string {
  return read()?.publicKey ?? mutate((d) => d.publicKey);
}

export function subscriptions(): Subscription[] {
  return read()?.subscriptions ?? [];
}

export function subscribe(s: { endpoint: string; keys: { p256dh: string; auth: string } }, device: string, origin: string): Subscription {
  if (!/^https:\/\//.test(s.endpoint ?? '')) throw new Error('a push endpoint is an https URL');
  if (fromB64u(s.keys?.p256dh ?? '').length !== 65 || fromB64u(s.keys?.auth ?? '').length < 16) throw new Error('the subscription keys look wrong');
  return mutate((d) => {
    const sub: Subscription = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: device.slice(0, 80), origin: origin.slice(0, 200), added: new Date().toISOString() };
    d.subscriptions = [...d.subscriptions.filter((x) => x.endpoint !== s.endpoint), sub];
    return sub;
  });
}

export function unsubscribe(endpoint: string): boolean {
  if (!read()) return false;
  return mutate((d) => {
    const n = d.subscriptions.length;
    d.subscriptions = d.subscriptions.filter((x) => x.endpoint !== endpoint);
    return d.subscriptions.length !== n;
  });
}

// ── RFC 8291: the message, encrypted for one device ──

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

/** aes128gcm content encoding, one record: salt(16) rs(4) idlen(1) keyid(65) ciphertext */
export function encrypt(payload: Buffer, p256dh: string, auth: string, salt = crypto.randomBytes(16), local?: crypto.ECDH): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const ecdh = local ?? crypto.createECDH('prime256v1');
  if (!local) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ── RFC 8292: who's sending ──

/** a JWT for the push service at this endpoint, signed with the hub's key */
export function vapidHeader(endpoint: string, keys: { publicKey: string; privateKey: string }, now = Date.now()): string {
  const pub = fromB64u(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://github.com/ClickerMonkey/hitloop' })));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export interface PushMessage {
  title: string;
  body: string;
  /** where a tap goes: a hash on the hub's page (#/p/…), opened on the device's own address */
  hash: string;
  /** notifications with the same tag replace each other */
  tag?: string;
  /** high for things someone is waiting on */
  urgent?: boolean;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
  errors: string[];
}

/** Send to every device (or the ones `only` picks). Devices the push service says are gone are forgotten. */
export async function pushAll(m: PushMessage, only?: (s: Subscription) => boolean): Promise<PushResult> {
  const d = read();
  const out: PushResult = { sent: 0, failed: 0, removed: 0, errors: [] };
  if (!d) return out;
  const subs = d.subscriptions.filter((s) => !only || only(s));
  const gone: string[] = [];
  const stamps = new Map<string, { ok?: string; err?: string }>();
  const payload = Buffer.from(JSON.stringify(m));
  await Promise.all(
    subs.map(async (s) => {
      try {
        const res = await fetch(s.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapidHeader(s.endpoint, d),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(m.urgent ? 6 * 3600 : 86400),
            urgency: m.urgent ? 'high' : 'normal',
            ...(m.tag ? { topic: m.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
          },
          body: new Uint8Array(encrypt(payload, s.keys.p256dh, s.keys.auth)),
          signal: AbortSignal.timeout(15_000),
        });
        // gone: forget it. A push service can say 404 for a moment right after a device signs up, so a new one is kept.
        if (res.status === 410 || (res.status === 404 && Date.now() - Date.parse(s.added) > 10 * 60_000)) {
          gone.push(s.endpoint);
          out.removed++;
          out.errors.push(`${s.device}: gone (${res.status} ${(await res.text().catch(() => '')).slice(0, 160)})`.trim());
          return;
        }
        if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
        out.sent++;
        stamps.set(s.endpoint, { ok: new Date().toISOString() });
      } catch (e) {
        out.failed++;
        const msg = `${s.device}: ${e instanceof Error ? e.message : String(e)}`;
        out.errors.push(msg);
        stamps.set(s.endpoint, { err: `${new Date().toISOString()} ${msg}` });
      }
    }),
  );
  if (gone.length || stamps.size)
    mutate((f) => {
      f.subscriptions = f.subscriptions.filter((s) => !gone.includes(s.endpoint));
      for (const s of f.subscriptions) {
        const st = stamps.get(s.endpoint);
        if (st?.ok) {
          s.lastOk = st.ok;
          delete s.lastError;
        } else if (st?.err) s.lastError = st.err;
      }
    });
  return out;
}

/** A short name for a device from its browser's user agent. */
export function deviceName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
