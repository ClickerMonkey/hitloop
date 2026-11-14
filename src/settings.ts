// Settings for one project: hitl's defaults, then your config file (~/.config/hitl/config.json), then the project's
// own .hitl/config.json, then the command line.
import fs from 'node:fs';
import path from 'node:path';
import { userConfig, type UserConfig } from './hub/registry.js';
import { DEFAULT_SETTINGS, type ProjectSettings } from './workspace.js';

export function projectSettings(root: string, overrides: Partial<ProjectSettings> = {}, user: UserConfig = userConfig()): ProjectSettings {
  let own: Partial<ProjectSettings> = {};
  try {
    own = JSON.parse(fs.readFileSync(path.join(root, '.hitl', 'config.json'), 'utf8')) as Partial<ProjectSettings>;
  } catch {
    own = {};
  }
  const pick = <K extends keyof ProjectSettings>(k: K): ProjectSettings[K] => {
    const v = overrides[k] ?? own[k] ?? (user as Partial<ProjectSettings>)[k] ?? DEFAULT_SETTINGS[k];
    return v as ProjectSettings[K];
  };
  const list = (k: 'exclude' | 'hide') => [...(user[k] ?? []), ...(Array.isArray(own[k]) ? own[k] : []), ...(overrides[k] ?? [])].map(String);
  return {
    exclude: list('exclude'),
    hide: list('hide'),
    showSecrets: !!pick('showSecrets'),
    maxFileMb: Number(pick('maxFileMb')) || 5,
    git: pick('git') !== false,
    watch: pick('watch') !== false,
    author: String(pick('author') ?? ''),
    readOnly: !!pick('readOnly'),
  };
}
