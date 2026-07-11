/**
 * The built-in themes.
 *
 * A theme is a bundle of slot templates plus which image asset keys to use.
 * Every string is a template; available placeholders are filled from the
 * aggregated session state:
 *
 *   See `PRESENCE_PLACEHOLDERS` in `src/core/placeholders.ts` (includes
 *   {usage} for a dedicated "usage: 5h … · wk …" row).
 *
 * Empty placeholders collapse gracefully (no "Coding " with a trailing blank).
 * Privacy is simply a function of which placeholders a theme uses — the safe
 * default (`minimal`) reveals nothing about the user's work.
 *
 * Image keys must stay within the set the Discord application provides (see
 * `assets.ts`); an unknown key renders nothing. The `THEME_MANIFEST` below is
 * the single source of truth for which built-in themes exist and how the
 * `vdp config` picker describes them — add a theme once, here.
 */
import type { Theme, ThemeName } from '../types';

/** A selectable built-in theme — every `ThemeName` except the `custom` editor. */
export type BuiltInThemeName = Exclude<ThemeName, 'custom'>;

const REPO_URL = 'https://github.com/younesfdj/vibecoder-discord-presence';

export const THEMES: Record<string, Theme> = {
  minimal: {
    details: 'Coding with Claude Code',
    state: '',
    largeImage: { key: 'logo', text: 'Claude Code' },
    smallImage: { key: '', text: '' },
    timer: true,
    buttons: [],
    // No state line; let the compact status show the activity from details.
    statusDisplay: 'details',
  },

  developer: {
    details: '{activity} · {model} · {project} ({branch})',
    state: '{usage}',
    largeImage: { key: 'logo', text: 'Claude Code · {model}' },
    smallImage: { key: '', text: '' },
    timer: true,
    buttons: [{ label: '⭐ Star on GitHub', url: REPO_URL }],
    // Compact status shows the activity line; usage stays on the full card row.
    statusDisplay: 'details',
  },

  focus: {
    details: 'In a deep work session 🎯',
    state: 'Focused for {elapsed}',
    largeImage: { key: 'focus', text: 'Deep work' },
    smallImage: { key: 'status-focus', text: 'Focusing' },
    timer: true,
    buttons: [],
    statusDisplay: 'state',
  },

  playful: {
    details: '🤖 vibecoding with Claude',
    state: 'shipping {project} · Using {model}',
    largeImage: { key: 'logo', text: 'vibecoder' },
    smallImage: { key: 'status-{state}', text: '{activity}' },
    timer: true,
    buttons: [{ label: 'get vibecoder', url: REPO_URL }],
    statusDisplay: 'state',
  },

  chaos: {
    details: '🚀 {activity} — 📂 {project} · {model} · {tokens} · {cost} · ⌛ {elapsed}',
    state: '{usage}',
    largeImage: { key: 'logo', text: '✨ locked in · {model} · no thoughts only vibes 🔥' },
    smallImage: { key: 'status-{state}', text: '{activity} fr fr 💯' },
    timer: true,
    buttons: [
      { label: '🔥 join the vibe', url: REPO_URL },
      { label: '✨ star (real)', url: REPO_URL },
    ],
    statusDisplay: 'details',
  },

  // Retro-terminal aesthetic. Privacy-leaning: shows the machine activity and
  // elapsed time, but never the project, branch, or file — safe to stream.
  // `{activity}` is always populated live (the hook sets "Idle" at worst); if it
  // ever resolves empty the line collapses to a bare "claude@code:~$" prompt
  // rather than a dangling cursor.
  terminal: {
    details: 'claude@code:~$ {activity}',
    state: '[ {state} ] · uptime {elapsed}',
    largeImage: { key: 'logo', text: 'claude@code:~$' },
    smallImage: { key: 'status-{state}', text: '{state}' },
    timer: true,
    buttons: [],
    statusDisplay: 'details',
  },

  // Momentum / ship-it vibe. Expressive: surfaces the project and model to
  // convey active shipping, with a single GitHub button.
  shipper: {
    details: '🚢 Shipping {project}',
    state: '{model} · {elapsed} in flow',
    largeImage: { key: 'logo', text: 'shipping {project} 🚀' },
    smallImage: { key: 'status-{state}', text: '{activity}' },
    timer: true,
    buttons: [{ label: '🚀 ship with vibecoder', url: REPO_URL }],
    statusDisplay: 'state',
  },
};

export const DEFAULT_THEME = 'minimal';

/**
 * One catalog entry per selectable built-in theme. This is the single source of
 * truth for the `vdp config` picker — its choices are derived from this list, so
 * adding a theme here (and to `THEMES` + the `ThemeName` union) is all it takes.
 * A test asserts these stay in sync, so drift can't merge.
 */
export interface ThemeManifestEntry {
  /** The theme key — must match a `THEMES` entry and the `ThemeName` union. */
  name: BuiltInThemeName;
  /** One-line vibe shown next to the name in the picker. */
  description: string;
}

export const THEME_MANIFEST: readonly ThemeManifestEntry[] = [
  { name: 'minimal', description: 'privacy-safe, nothing about your work' },
  { name: 'developer', description: 'project, branch, model, plan usage' },
  { name: 'focus', description: 'deep-work timer' },
  { name: 'playful', description: 'vibey' },
  { name: 'chaos', description: '🚀 every stat, all the emojis, peak vibes' },
  { name: 'terminal', description: '>_ retro hacker prompt, privacy-safe' },
  { name: 'shipper', description: '🚢 momentum & ship-it energy' },
];
