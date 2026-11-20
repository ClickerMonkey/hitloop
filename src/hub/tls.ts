// HTTPS for the hub without installing anything: hitl makes its own certificate authority (once) and, from it, a
// certificate for this computer's addresses (localhost, its name, every LAN IP), made again when an address changes or
// it nears its end. A phone that installs the authority trusts the hub, so the page is a secure context: push
// notifications work there.
//   ~/.config/hitl/tls/ca.key, ca.crt       the authority (ten years; the key never leaves this computer)
//   ~/.config/hitl/tls/hub.key, hub.crt     the hub's certificate (397 days, the most a phone accepts)
// The authority is limited by name constraints to private addresses, localhost and this computer's name: even with its
// key, nobody could use it to pass as another website.
// The hub answers http and https on the same port: the first byte of a connection says which (a TLS hello is 0x16).
// https follows the setting (hitl https on|off, or the page) without a restart.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { configDir, lanAddresses } from './registry.js';
import { writeAtomic, withLock } from './atomic.js';

// ── DER, just what certificates need ──

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const ctx = (n: number, ...p: Buffer[]) => tlv(0xa0 | n, ...p);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
function int(v: number | Buffer): Buffer {
  let b = typeof v === 'number' ? Buffer.from([v]) : v;
  while (b.length > 1 && b[0] === 0 && !((b[1] ?? 0) & 0x80)) b = b.subarray(1);
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(s: string): Buffer {
  const n = s.split('.').map(Number);
  const out = [40 * (n[0] ?? 0) + (n[1] ?? 0)];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}
const name = (cn: string) => seq(set(seq(oid('2.5.4.10'), utf8('hitl (Human In The Loop)'))), set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function ipBytes(ip: string): Buffer | undefined {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return undefined;
  const [head = '', tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return Buffer.from(groups.flatMap((g) => [(parseInt(g, 16) >> 8) & 0xff, parseInt(g, 16) & 0xff]));
}

const keyId = (pub: crypto.KeyObject) => crypto.createHash('sha1').update(pub.export({ type: 'spki', format: 'der' }).subarray(-65)).digest();

interface CertSpec {
  subject: string;
  issuer: string;
  pub: crypto.KeyObject;
  signer: crypto.KeyObject;
  issuerKeyId: Buffer;
  days: number;
  extensions: Buffer[];
}

function certificate(s: CertSpec): string {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const from = new Date(Date.now() - 3600_000);
  const tbs = seq(
    ctx(0, int(2)),
    int(serial),
    ECDSA_SHA256,
    name(s.issuer),
    seq(time(from), time(new Date(from.getTime() + s.days * 86_400_000))),
    name(s.subject),
    s.pub.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(...s.extensions, ext('2.5.29.14', false, octets(keyId(s.pub))), ext('2.5.29.35', false, seq(tlv(0x80, s.issuerKeyId))))),
  );
  const sig = crypto.sign('sha256', tbs, s.signer);
  const der = seq(tbs, ECDSA_SHA256, bits(sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`;
}

/** the private ranges the authority may vouch for */
const PERMITTED_IPS: [string, string][] = [
  ['127.0.0.0', '255.0.0.0'],
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['169.254.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'], // carrier-grade NAT, as Tailscale and some VPNs use
];
const PERMITTED_IP6: [string, string][] = [
  ['::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fc00::', 'fe00::'],
  ['fe80::', 'ffc0::'],
];

/** a host name the certificates may carry: "bagend" and "bagend.local" */
export const hostName = () =>
  os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'hitl';

function makeCa(): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const host = hostName();
  const subtree = (b: Buffer) => seq(b);
  const constraints = seq(
    ctx(
      0,
      subtree(tlv(0x82, Buffer.from('localhost'))),
      subtree(tlv(0x82, Buffer.from('local'))),
      subtree(tlv(0x82, Buffer.from(host))),
      ...[...PERMITTED_IPS, ...PERMITTED_IP6].map(([a, m]) => subtree(tlv(0x87, Buffer.concat([ipBytes(a)!, ipBytes(m)!])))),
    ),
  );
  const cert = certificate({
    subject: `hitl on ${os.hostname()}`,
    issuer: `hitl on ${os.hostname()}`,
    pub: publicKey,
    signer: privateKey,
    issuerKeyId: keyId(publicKey),
    days: 3650,
    extensions: [
      ext('2.5.29.19', true, seq(bool(true), int(0))),
      ext('2.5.29.15', true, bits(Buffer.from([0x86]), 1)), // digitalSignature, keyCertSign, cRLSign
      ext('2.5.29.30', true, constraints),
    ],
  });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

function makeLeaf(ca: { key: string; cert: string }, ips: string[], names: string[]): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caKey = crypto.createPrivateKey(ca.key);
  const caCert = new crypto.X509Certificate(ca.cert);
  const san = seq(...names.map((n) => tlv(0x82, Buffer.from(n))), ...ips.map((ip) => ipBytes(ip)).filter((b): b is Buffer => !!b).map((b) => tlv(0x87, b)));
  const cert = certificate({
    subject: names[0] ?? 'localhost',
    issuer: caCert.subject.split('\n').find((l) => l.startsWith('CN='))?.slice(3) ?? `hitl on ${os.hostname()}`,
    pub: publicKey,
    signer: caKey,
    issuerKeyId: keyId(caCert.publicKey),
    days: 397,
    extensions: [
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bits(Buffer.from([0x80]), 7)), // digitalSignature
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // serverAuth
      ext('2.5.29.17', false, san),
    ],
  });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

// ── on disk ──

function writeKey(f: string, pem: string): void {
  writeAtomic(f, pem);
  try {
    fs.chmodSync(f, 0o600);
  } catch {
    // Windows: the folder's own permissions
  }
}

export const tlsDir = () => path.join(configDir(), 'tls');
const file = (n: string) => path.join(tlsDir(), n);

/** the addresses the hub's certificate covers now */
export function wantedNames(): { ips: string[]; names: string[] } {
  const host = hostName();
  const ips = ['127.0.0.1', '::1', ...lanAddresses().filter((ip) => PERMITTED_IPS.some(([a, m]) => inRange(ip, a, m)))];
  return { ips: [...new Set(ips)], names: ['localhost', host, `${host}.local`] };
}

function inRange(ip: string, a: string, m: string): boolean {
  const x = ipBytes(ip);
  const b = ipBytes(a);
  const k = ipBytes(m);
  if (!x || !b || !k || x.length !== b.length) return false;
  return x.every((v, i) => (v & (k[i] ?? 0)) === ((b[i] ?? 0) & (k[i] ?? 0)));
}

export interface Tls {
  key: string;
  cert: string;
  ca: string;
  /** the addresses it covers */
  ips: string[];
  names: string[];
  expires: number;
  /** the authority's SHA-256 fingerprint, to compare on the phone */
  fingerprint: string;
}

/** The authority and the hub's certificate: made when missing, made again when an address changed or it nears its end. */
export function ensureTls(): Tls {
  fs.mkdirSync(tlsDir(), { recursive: true });
  return withLock(file('ca.crt'), () => {
    let ca: { key: string; cert: string } | undefined;
    try {
      ca = { key: fs.readFileSync(file('ca.key'), 'utf8'), cert: fs.readFileSync(file('ca.crt'), 'utf8') };
      if (Date.parse(new crypto.X509Certificate(ca.cert).validTo) < Date.now() + 30 * 86_400_000) ca = undefined;
    } catch {
      ca = undefined;
    }
    let fresh = false;
    if (!ca) {
      ca = makeCa();
      writeKey(file('ca.key'), ca.key);
      writeAtomic(file('ca.crt'), ca.cert);
      fresh = true;
    }
    const want = wantedNames();
    let leaf: { key: string; cert: string } | undefined;
    if (!fresh) {
      try {
        leaf = { key: fs.readFileSync(file('hub.key'), 'utf8'), cert: fs.readFileSync(file('hub.crt'), 'utf8') };
        const x = new crypto.X509Certificate(leaf.cert);
        const ok =
          Date.parse(x.validTo) > Date.now() + 30 * 86_400_000 &&
          x.verify(new crypto.X509Certificate(ca.cert).publicKey) &&
          want.ips.every((ip) => x.checkIP(ip)) &&
          want.names.every((n) => x.checkHost(n, { wildcards: false }));
        if (!ok) leaf = undefined;
      } catch {
        leaf = undefined;
      }
    }
    if (!leaf) {
      leaf = makeLeaf(ca, want.ips, want.names);
      writeKey(file('hub.key'), leaf.key);
      writeAtomic(file('hub.crt'), leaf.cert);
    }
    const caX = new crypto.X509Certificate(ca.cert);
    return { ...leaf, ca: ca.cert, ...want, expires: Date.parse(new crypto.X509Certificate(leaf.cert).validTo), fingerprint: caX.fingerprint256 };
  });
}

/** The authority, if made, without making anything. */
export function caInfo(): { cert: string; fingerprint: string; der: Buffer } | undefined {
  try {
    const cert = fs.readFileSync(file('ca.crt'), 'utf8');
    const x = new crypto.X509Certificate(cert);
    return { cert, fingerprint: x.fingerprint256, der: x.raw };
  } catch {
    return undefined;
  }
}

/** Start again: a new authority (every device has to install the new one). */
export function resetTls(): void {
  for (const n of ['ca.key', 'ca.crt', 'hub.key', 'hub.crt']) fs.rmSync(file(n), { force: true });
}

// ── one port, both protocols ──

export interface DualServer {
  /** listen here */
  server: net.Server;
  /** handles plain http */
  http: http.Server;
  /** the TLS side, once a TLS connection came while https is on */
  https(): https.Server | undefined;
  /** look again at the certificate (an address changed) */
  refresh(): void;
}

export interface TlsSource {
  /** answer https now? (read on each new connection, so turning it on or off needs no restart) */
  enabled: () => boolean;
  /** the certificate (made, or made again, as needed) */
  get: () => Tls;
}

/**
 * A server that answers plain http and https on one port: a small TCP server peeks at the first byte of each
 * connection (a TLS hello starts 0x16) and hands it to the right side. TLS connections are dropped while https is off.
 */
export function dualServer(handler: http.RequestListener, tls: TlsSource | undefined): DualServer {
  const plain = http.createServer(handler);
  let secure: https.Server | undefined;
  let cert = '';
  let checked = 0;
  const secureSide = (): https.Server | undefined => {
    if (!tls?.enabled()) return undefined;
    if (secure && Date.now() - checked < 60_000) return secure;
    try {
      const t = tls.get();
      checked = Date.now();
      if (!secure) secure = https.createServer({ key: t.key, cert: t.cert }, handler);
      else if (t.cert !== cert) secure.setSecureContext({ key: t.key, cert: t.cert });
      cert = t.cert;
    } catch {
      // keep the old certificate, if there is one
    }
    return secure;
  };
  const front = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.once('data', (first: Buffer) => {
      socket.pause();
      socket.unshift(first);
      const side = first[0] === 0x16 ? secureSide() : plain;
      if (!side) return void socket.destroy();
      side.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  front.on('close', () => {
    plain.close();
    secure?.close();
  });
  return {
    server: front,
    http: plain,
    https: () => secure,
    refresh: () => {
      checked = 0;
      if (secure) secureSide();
    },
  };
}
