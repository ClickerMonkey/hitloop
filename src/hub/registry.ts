// The shared server ("the hub"): one hitl for every project, so a phone needs one bookmark.
//   ~/.config/hitl/projects.json  the folders it serves (added by `hitl`, `init` and the MCP server)
//   ~/.config/hitl/hub.json       where the running hub listens (written while it runs)
//   ~/.config/hitl/token          the hub's access token (made once)
//   ~/.config/hitl/config.json    your settings (port, host, token, …)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeAtomic, withLock } from './atomic.js';
import type { NotifyConfig } from './notify.js';
import type { AlertRule } from '../machine/alerts.js';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['HITL_HOME']) return path.resolve(env['HITL_HOME']);
  return path.join(env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'hitl');
}

export interface ProjectEntry {
  root: string;
  added: string;
}

export interface Keyed extends ProjectEntry {
  /** the project's name in links: its folder name, made unique */
  key: string;
}

const projectsFile = () => path.join(configDir(), 'projects.json');

export function projects(): ProjectEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile(), 'utf8')) as { projects?: ProjectEntry[] };
    return Array.isArray(data.projects) ? data.projects.filter((p) => p && typeof p.root === 'string') : [];
  } catch {
    return [];
  }
}

/** Projects with their keys: the folder's name, with -2, -3 … when two share a name (oldest keeps the plain one). */
export function keyed(list: ProjectEntry[] = projects()): Keyed[] {
  const used = new Map<string, number>();
  return list.map((p) => {
    const base =
      path
        .basename(p.root)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { ...p, key: n === 1 ? base : `${base}-${n}` };
  });
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/** Add a folder to the hub's list (no-op if it's there). Returns true when added. */
export function register(root: string): boolean {
  fs.mkdirSync(configDir(), { recursive: true });
  return withLock(projectsFile(), () => {
    const list = projects();
    if (list.some((p) => norm(p.root) === norm(root))) return false;
    list.push({ root: path.resolve(root), added: new Date().toISOString() });
    writeAtomic(projectsFile(), JSON.stringify({ projects: list }, null, 2) + '\n');
    return true;
  });
}

export function forget(root: string): boolean {
  if (!fs.existsSync(projectsFile())) return false;
  return withLock(projectsFile(), () => {
    const list = projects();
    const kept = list.filter((p) => norm(p.root) !== norm(root));
    if (kept.length === list.length) return false;
    writeAtomic(projectsFile(), JSON.stringify({ projects: kept }, null, 2) + '\n');
    return true;
  });
}

export function projectsPath(): string {
  return projectsFile();
}

// ── user settings ──

export interface UserConfig {
  port?: number;
  host?: string;
  /** a fixed token, or false for none (default: one made once and kept in ~/.config/hitl/token) */
  token?: string | false;
  allowHosts?: string[];
  /** a URL path to serve under, e.g. "team/questions" */
  base?: string;
  /** the name shown on answers and replies from the page */
  author?: string;
  /** push notifications (hitl notify) */
  notify?: NotifyConfig;
  /** file browsing, for every project (a project's .hitl/config.json can say otherwise) */
  exclude?: string[];
  hide?: string[];
  showSecrets?: boolean;
  maxFileMb?: number;
  git?: boolean;
  watch?: boolean;
  readOnly?: boolean;
  /** answer https on the hub's port too, with hitl's own certificate (hitl https on|off; default off) */
  https?: boolean;
  /** the machine dashboard (hitl machine): off unless on */
  machine?: MachineConfig;
}

export interface MachineConfig {
  on?: boolean;
  /** "resume" (paused until you resume) or the time the pause ends (ISO) */
  paused?: string;
  /** notifications when a reading crosses a line (machine alerts) */
  alerts?: AlertRule[];
}

export function userConfigPath(): string {
  return process.env['HITL_CONFIG'] ? path.resolve(process.env['HITL_CONFIG']) : path.join(configDir(), 'config.json');
}

/** Change your settings file (keeping what else is in it). */
export function updateUserConfig(fn: (c: UserConfig) => void): UserConfig {
  const c = userConfig();
  fn(c);
  fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  writeAtomic(userConfigPath(), JSON.stringify(c, null, 2) + '\n');
  return c;
}

export function userConfig(): UserConfig {
  const file = userConfigPath();
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as UserConfig;
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/** The hub's token: made once, kept in the config folder. */
export function hubToken(): string {
  const file = path.join(configDir(), 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    // make one
  }
  fs.mkdirSync(configDir(), { recursive: true });
  const t = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

// ── the running hub ──

export interface HubState {
  pid: number;
  port: number;
  host: string;
  token: string;
  version: string;
  started: string;
  /** the URL path it serves under ("/" unless --base) */
  base?: string;
}

const hubFile = () => path.join(configDir(), 'hub.json');

export function writeHubState(s: HubState): void {
  fs.mkdirSync(configDir(), { recursive: true });
  writeAtomic(hubFile(), JSON.stringify(s, null, 2) + '\n');
}

export function clearHubState(pid: number): void {
  const s = readHubState();
  if (s && s.pid === pid) fs.rmSync(hubFile(), { force: true });
}

export function readHubState(): HubState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(hubFile(), 'utf8')) as HubState;
    return s && typeof s.port === 'number' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Is a hitl listening there? Resolves with its version, or undefined. */
export function ping(port: number, timeout = 1500, base = '/'): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: base + 'api/ping', timeout }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => {
        try {
          const d = JSON.parse(body) as { app?: string; version?: string };
          resolve(d.app === 'hitl' ? (d.version ?? '?') : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

/** The running hub, if there is one. */
export async function runningHub(): Promise<HubState | undefined> {
  const s = readHubState();
  if (!s) return undefined;
  return (await ping(s.port, 1500, s.base ?? '/')) ? s : undefined;
}

const cliPath = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

/** The hub, started in the background if it isn't running. */
export async function ensureHub(): Promise<HubState> {
  const running = await runningHub();
  if (running) return running;
  fs.mkdirSync(configDir(), { recursive: true });
  const log = fs.openSync(path.join(configDir(), 'hub.log'), 'a');
  const child = spawn(process.execPath, [cliPath(), 'serve', '--background'], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    const s = await runningHub();
    if (s) return s;
  }
  throw new Error(`The hitl server didn't start; see ${path.join(configDir(), 'hub.log')}`);
}

// ── links ──

/** virtual adapters (WSL, Hyper-V, Docker, VMs): a phone can't reach these */
const VIRTUAL = /vethernet|wsl|hyper-v|docker|vmnet|virtualbox|vbox|^br-|^veth|^virbr|loopback/i;

export function lanAddresses(): string[] {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((n) => n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/** Links to a page: this computer first, then every address other devices can use. */
export function links(port: number, host: string, token: string, hash = '', base = '/', https = !!userConfig().https): string[] {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const everywhere = host === '0.0.0.0' || host === '::';
  const local = everywhere || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  const out = [`http://${local}:${port}${base}${q}${hash}`];
  if (everywhere) for (const ip of lanAddresses()) out.push(`http://${ip}:${port}${base}${q}${hash}`);
  // https on the same port, for devices that installed hitl's certificate (notifications need it off this computer)
  if (https && everywhere) for (const ip of lanAddresses()) out.push(`https://${ip}:${port}${base}${q}${hash}`);
  return out;
}

/**
 * A URL path to serve under, as "/a/b/": "test/path", "/test/path", "/test/path/" and "https://host/test/path" all
 * work. Git Bash turns an argument like /test/path into C:/Program Files/Git/test/path before we see it: that is
 * refused with how to avoid it, since it would silently serve everything under the wrong path.
 */
export function normaliseBase(raw: string, from = 'command line'): string {
  let b = raw.trim().replace(/\\/g, '/');
  if (/^https?:[/][/]/i.test(b)) b = new URL(b).pathname;
  if (/^[a-z]:[/]/i.test(b))
    throw new Error(
      `base looks like a Windows path (${raw}, from ${from}). Git Bash rewrites arguments that start with "/": write it without the leading slash (--base test/path) or set MSYS_NO_PATHCONV=1.`,
    );
  b = '/' + b.split('/').filter(Boolean).join('/') + '/';
  if (b === '//') b = '/';
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(b)) throw new Error(`base can only use URL path characters (got ${raw})`);
  if (b.split('/').some((p) => p === '..' || p === '.')) throw new Error(`base can't contain . or .. (got ${raw})`);
  return b;
}
