// The Claude Code hooks hitl can add to a project (opt-in): one tells Claude what the human said whenever they send it a
// message; the other stops Claude finishing while an approval or a blocking question is waiting. They live in the
// project's .claude/settings.json; `hitl hooks`, `hitl init --hook/--stop-hook` and the page's settings change them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How Claude Code should start hitl: through npx once it's published, else this copy. */
export function launcher(): { command: string; args: string[]; line: string } {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  if (/[\\/]_npx[\\/]|[\\/]node_modules[\\/]hitl[\\/]/.test(cli)) {
    return process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', 'hitl@latest'], line: 'cmd /c npx -y hitl@latest' }
      : { command: 'npx', args: ['-y', 'hitl@latest'], line: 'npx -y hitl@latest' };
  }
  return { command: process.execPath, args: [cli], line: `"${process.execPath}" "${cli}"` };
}

export type HookList = { matcher?: string; hooks: { type: string; command: string }[] }[];
export type Settings = { hooks?: Record<string, HookList> };

export function setHooks(root: string, want: { prompt?: boolean; stop?: boolean }): string[] {
  const file = path.join(root, '.claude', 'settings.json');
  let settings: Settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  } catch {
    settings = {};
  }
  const l = launcher();
  const out: string[] = [];
  const isOurs = (cmd: string, which: string) => /hitl/.test(cmd) && new RegExp(` hook${which === 'stop' ? ' stop' : '( prompt)?'}$`).test(cmd);
  const apply = (event: string, which: 'prompt' | 'stop', on: boolean | undefined, label: string) => {
    if (on === undefined) return;
    settings.hooks ??= {};
    const list = (settings.hooks[event] ??= []);
    const has = list.some((h) => h.hooks?.some((x) => isOurs(x.command, which)));
    if (on && !has) {
      list.push({ hooks: [{ type: 'command', command: `${l.line} hook ${which}` }] });
      out.push(`✓ ${label}: on`);
    } else if (!on && has) {
      settings.hooks[event] = list.map((h) => ({ ...h, hooks: h.hooks.filter((x) => !isOurs(x.command, which)) })).filter((h) => h.hooks.length);
      if (!settings.hooks[event]?.length) delete settings.hooks[event];
      out.push(`✓ ${label}: off`);
    } else out.push(`✓ ${label}: already ${on ? 'on' : 'off'}`);
  };
  apply('UserPromptSubmit', 'prompt', want.prompt, 'News hook (tells Claude what you said when you send a message)');
  apply('Stop', 'stop', want.stop, "Stop hook (Claude can't finish while an approval or blocking question waits)");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return out;
}


/** which of hitl's hooks are on in a project */
export function hookStatus(root: string): { prompt: boolean; stop: boolean } {
  let s: Settings = {};
  try {
    s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as Settings;
  } catch {
    s = {};
  }
  const has = (ev: string, re: RegExp) => !!s.hooks?.[ev]?.some((x) => x.hooks?.some((c) => /hitl/.test(c.command) && re.test(c.command)));
  return { prompt: has('UserPromptSubmit', / hook( prompt)?$/), stop: has('Stop', / hook stop$/) };
}
