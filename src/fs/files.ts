// Paths inside the served folder, what is hidden, folder listings and raw file serving (with ranges).
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export interface Entry {
  name: string;
  type: 'folder' | 'file';
  size: number;
  mtime: number;
  link?: boolean;
}

export interface Scope {
  root: string;
  /** names never listed, served or searched, wherever they are */
  hidden: Set<string>;
  /** also hide the secret-looking files (.env, *.key, *.pem, id_rsa…) */
  hideSecrets: boolean;
  /** excluded by pattern (--exclude, .folderviewignore, config): never listed, served, searched or zipped */
  excluded: (rel: string, isDir?: boolean) => boolean;
}

/** Folders a search or a file list skips when git can't say what is ignored. */
export const NOISE = new Set(['node_modules', '.git', '.hg', '.svn', '.next', '.cache', '.turbo', '__pycache__', '.venv']);

export function isSecret(name: string): boolean {
  if (name.startsWith('.env') && name !== '.env.example' && name !== '.env.sample') return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name)) return true;
  return /\.(key|pem|p12|pfx|keystore)$/i.test(name);
}

export function isHidden(scope: Scope, name: string): boolean {
  return scope.hidden.has(name) || (scope.hideSecrets && isSecret(name));
}

/** A root-relative path with forward slashes, no leading slash. */
export function toRel(scope: Scope, abs: string): string {
  return path.relative(scope.root, abs).split(path.sep).join('/');
}

/** The absolute path for a root-relative one, or undefined when it leaves the root or touches something hidden. */
export function inside(scope: Scope, rel: string): string | undefined {
  const clean = rel.replace(/\\/g, '/');
  const abs = path.resolve(scope.root, '.' + path.sep + clean);
  if (abs !== scope.root && !abs.startsWith(scope.root + path.sep)) return undefined;
  const parts = path.relative(scope.root, abs).split(path.sep).filter(Boolean);
  if (parts.some((p) => isHidden(scope, p))) return undefined;
  if (parts.length && scope.excluded(parts.join('/'))) return undefined;
  // a link may point outside the root: follow it and check again
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(scope.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined;
  } catch {
    // missing files are fine here (a deleted file's diff); the caller checks existence
  }
  return abs;
}

export function list(scope: Scope, rel: string): Entry[] | undefined {
  const abs = inside(scope, rel);
  if (abs === undefined) return undefined;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return undefined;
  }
  return dirents
    .filter((e) => {
      if (isHidden(scope, e.name)) return false;
      const dir = toRel(scope, abs);
      return !scope.excluded(dir ? dir + '/' + e.name : e.name, e.isDirectory());
    })
    .flatMap((e): Entry[] => {
      try {
        const st = fs.statSync(path.join(abs, e.name));
        const entry: Entry = { name: e.name, type: st.isDirectory() ? 'folder' : 'file', size: st.size, mtime: st.mtimeMs };
        if (e.isSymbolicLink()) entry.link = true;
        return [entry];
      } catch {
        return []; // a broken link, or removed while listing
      }
    });
}

export const RAW_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
};

/** Any file the page shows: never run as a page on this origin (except a sandboxed HTML preview). */
const RAW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; font-src 'self'";
/** An HTML preview: sandboxed (no scripts, its own origin), may load its own images and styles. */
const PREVIEW_CSP = "sandbox; default-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'";

export function serveRaw(scope: Scope, rel: string, req: http.IncomingMessage, res: http.ServerResponse, asPage: boolean): void {
  const abs = inside(scope, rel);
  let st: fs.Stats | undefined;
  try {
    st = abs === undefined ? undefined : fs.statSync(abs);
  } catch {
    st = undefined;
  }
  if (abs === undefined || st === undefined || !st.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const type = asPage && /^html?$/.test(ext) ? 'text/html; charset=utf-8' : (RAW_TYPES[ext] ?? 'text/plain; charset=utf-8');
  // the browser keeps a copy and asks again cheaply: unchanged files answer 304 with no body
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' }).end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-cache',
    etag,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': asPage ? PREVIEW_CSP : RAW_CSP,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
      return;
    }
    start = Math.max(0, start);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1) });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': String(st.size) });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(abs).pipe(res);
}

/** Every file under the root (root-relative), skipping hidden names and the usual noise folders. */
export function walk(scope: Scope, limit = 200_000): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop() ?? '';
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(scope.root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (isHidden(scope, d.name) || NOISE.has(d.name)) continue;
      const p = rel ? rel + '/' + d.name : d.name;
      if (scope.excluded(p, d.isDirectory())) continue;
      if (d.isDirectory()) stack.push(p);
      else if (d.isFile()) out.push(p);
    }
  }
  return out.sort();
}

/** A text file's contents (for a review item or a question's file block), cut to a line range if asked. */
export function readText(scope: Scope, rel: string, lines: string, maxBytes: number): { text: string; size: number; first: number; total: number; truncated: boolean; mtime: number } | { error: string; status: number } {
  const abs = inside(scope, rel);
  if (!abs) return { error: 'Not available', status: 404 };
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `No file ${rel}`, status: 404 };
  }
  if (!st.isFile()) return { error: `${rel} isn't a file`, status: 400 };
  const buf = readHead(abs, lines ? Math.max(maxBytes, 50 * 1048576) : maxBytes);
  if (buf.subarray(0, 8000).includes(0)) return { error: `${rel} is a binary file`, status: 415 };
  let text = buf.toString('utf8');
  const all = text.split(/\r?\n/);
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
  let first = 1;
  if (m) {
    first = Math.max(1, Number(m[1]));
    const last = Math.min(all.length, m[2] ? Number(m[2]) : first);
    text = all.slice(first - 1, last).join('\n');
  }
  const truncated = !m && st.size > maxBytes;
  return { text, size: st.size, first, total: all.length, truncated, mtime: st.mtimeMs };
}

/** the first `max` bytes of a file, without reading the rest */
export function readHead(abs: string, max: number): Buffer {
  const fd = fs.openSync(abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (!n) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}
