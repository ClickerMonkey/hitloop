// Small HTTP helpers shared by the hub and each project's routes.
import type http from 'node:http';
import crypto from 'node:crypto';
import { StoreError } from './hub/atomic.js';

export function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(data));
}

export function text(res: http.ServerResponse, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
}

export async function body(req: http.IncomingMessage, max = 1_000_000): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new StoreError('Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += b.length;
    if (size > max) throw new StoreError('Too large');
    chunks.push(b);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreError('Send a JSON object');
  return Object.fromEntries(Object.entries(data));
}

export const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export const bearer = (req: http.IncomingMessage) => /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];

export const cookie = (req: http.IncomingMessage, name: string) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};

export function same(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

export const str = (v: unknown) => (typeof v === 'string' ? v : '');
export const posInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
export const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

export interface Marks {
  area?: { x: number; y: number; w: number; h: number };
  strokes?: number[][];
  /** the marked-up picture: PNG bytes, and the same as a data URL */
  snapshot?: Buffer;
  snapshotUrl?: string;
}

/** a picture comment's marks from a request: the area, the strokes, and the marked-up picture (a PNG data URL) */
export function imageMarks(b: Record<string, unknown>): Marks {
  const out: Marks = {};
  const a = b['area'];
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const r: Record<string, unknown> = Object.fromEntries(Object.entries(a));
    const n = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && Number(r[k]) >= 0 ? Math.round(Number(r[k])) : undefined);
    const [x, y, w, h] = [n('x'), n('y'), n('w'), n('h')];
    if (x !== undefined && y !== undefined && w && h) out.area = { x, y, w, h };
  }
  const s = b['strokes'];
  if (Array.isArray(s)) {
    let budget = 20_000;
    const strokes = s
      .filter((st): st is unknown[] => Array.isArray(st))
      .map((st) => st.filter((v): v is number => typeof v === 'number' && v >= 0 && v <= 1).map((v) => Math.round(v * 10000) / 10000))
      .filter((st) => st.length >= 2 && st.length % 2 === 0 && (budget -= st.length) >= 0);
    if (strokes.length) out.strokes = strokes;
  }
  const snap = typeof b['snapshot'] === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(b['snapshot']) : null;
  if (snap && out.strokes) {
    const buf = Buffer.from(snap[1] ?? '', 'base64');
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      out.snapshot = buf;
      out.snapshotUrl = String(b['snapshot']);
    }
  }
  return out;
}

/** photos attached to a comment: image data URLs only */
export function photos(b: Record<string, unknown>): string[] {
  const p = b['photos'];
  if (!Array.isArray(p)) return [];
  return p.filter((x): x is string => typeof x === 'string' && /^data:image\/(png|jpeg|webp|gif|heic|avif);base64,[A-Za-z0-9+/=]+$/.test(x)).slice(0, 8);
}
