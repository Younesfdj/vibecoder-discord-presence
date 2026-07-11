/**
 * Config loading and resolution.
 *
 * Reads config.json, resolves the active theme from THEMES, applies the user's
 * `overrides` on top, and resolves the Discord application (client) id. Anything
 * missing or invalid falls back to DEFAULT_CONFIG (the privacy-safe `minimal`
 * theme) so the daemon always has something sane to render.
 *
 * Overrides are merged shallowly: providing `largeImage` in overrides replaces
 * the whole slot, it does not deep-merge individual fields. That keeps the model
 * obvious — a key you set wins outright.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from './paths';
import { DEFAULT_THEME, THEMES } from '../themes/index';
import type { Theme, UserConfig } from '../types';

/** What a brand-new install runs with until the user changes anything. */
export const DEFAULT_CONFIG: UserConfig = {
  theme: DEFAULT_THEME as UserConfig['theme'],
  overrides: {},
};

/**
 * Discord application id the presence is published under. The image asset keys
 * the themes reference (`logo`, `status-editing`, …) live on this application.
 *
 * This is the shared "ClaudeCode" application every install publishes under by
 * default. A client id is a public identifier, not a secret. Override per-machine
 * with the VDP_DISCORD_CLIENT_ID env var or a `clientId` field in config.json.
 */
export const DEFAULT_CLIENT_ID = '1511730102499541123';

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Read and shallow-validate config.json, falling back to defaults. */
export function readUserConfig(configPath: string): UserConfig {
  try {
    const raw = stripBom(readFileSync(configPath, 'utf8'));
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CONFIG;
    return {
      theme:
        typeof parsed.theme === 'string'
          ? (parsed.theme as UserConfig['theme'])
          : DEFAULT_CONFIG.theme,
      overrides:
        typeof parsed.overrides === 'object' && parsed.overrides !== null ? parsed.overrides : {},
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : undefined,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Resolve the effective theme (base theme + overrides) from a parsed config.
 *
 * Built-in themes use `THEMES[name]` as the base. The `custom` theme has no
 * base entry — overrides are the full theme the editor saved — so we start from
 * a neutral empty shell (not `minimal`) to avoid leaking privacy-safe defaults
 * into slots the user intentionally left blank.
 */
export function resolveTheme(config: UserConfig): Theme {
  if (config.theme === 'custom') {
    return { ...EMPTY_THEME, ...(config.overrides ?? {}) } as Theme;
  }
  const base = THEMES[config.theme] ?? THEMES[DEFAULT_THEME];
  return { ...base, ...(config.overrides ?? {}) } as Theme;
}

/** Neutral shell used when loading a saved custom theme (all slots empty). */
export const EMPTY_THEME: Theme = {
  details: '',
  state: '',
  largeImage: { key: '', text: '' },
  smallImage: { key: '', text: '' },
  timer: false,
  buttons: [],
  statusDisplay: 'name',
};

/** Resolve which Discord application id to publish under (env > config > default). */
export function resolveClientId(config: UserConfig): string {
  return process.env.VDP_DISCORD_CLIENT_ID || config.clientId || DEFAULT_CLIENT_ID;
}

/** Convenience: resolve the effective theme straight from a config file path. */
export function loadConfig(path: string): Theme {
  return resolveTheme(readUserConfig(path));
}

/**
 * Write config.json atomically (temp file + rename). Atomicity matters because
 * the daemon hot-reads this file every tick — a reader must never see a
 * half-written file.
 */
export function saveUserConfig(config: UserConfig): void {
  const dest = configPath();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, dest);
}
