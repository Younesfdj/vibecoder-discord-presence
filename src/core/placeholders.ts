/**
 * Presence template placeholders — single source of truth for docs, the
 * `vdp config` customizer, and rendering.
 *
 * Themes (built-in or custom) may use any of these as `{name}` in details,
 * state, image tooltips, or button labels. Empty values collapse so a missing
 * field never leaves "Coding ()" or a dangling separator.
 */
export interface PlaceholderInfo {
  /** Token name without braces (e.g. `project` for `{project}`). */
  name: string;
  /** One-line description for the config tip / CONTRIBUTING. */
  description: string;
}

/**
 * Every placeholder `renderPresence` fills. Order is the suggested tip order
 * (identity → activity → stats → plan usage).
 */
export const PRESENCE_PLACEHOLDERS: readonly PlaceholderInfo[] = [
  { name: 'project', description: 'project folder name' },
  { name: 'branch', description: 'git branch' },
  { name: 'model', description: 'Claude model label' },
  { name: 'activity', description: 'human activity text (e.g. Editing foo.ts)' },
  { name: 'file', description: 'current file basename' },
  { name: 'tokens', description: 'session output tokens (e.g. 12.3k)' },
  { name: 'cost', description: 'session cost (e.g. $0.42)' },
  { name: 'elapsed', description: 'time since session start' },
  { name: 'sessionCount', description: 'number of live sessions' },
  { name: 'state', description: 'machine activity keyword (idle, editing, …)' },
  {
    name: 'usage',
    description: 'full plan-quota row — "usage: 5h 54% · wk 27%" (use alone on a line)',
  },
  { name: 'usage5h', description: '5-hour window only — "5h 54%"' },
  { name: 'usageWeekly', description: 'weekly window only — "wk 27%"' },
] as const;

/** `{name}` forms, for tips and docs. */
export const PRESENCE_PLACEHOLDER_TOKENS: readonly string[] = PRESENCE_PLACEHOLDERS.map(
  (p) => `{${p.name}}`,
);

/** Compact one-line tip for the config command banner. */
export function placeholderTipLine(): string {
  return PRESENCE_PLACEHOLDER_TOKENS.join(' ');
}

/**
 * Slightly longer tip for field editors — highlights how to put plan usage on
 * its own Discord row without double-labeling.
 */
export function usagePlaceholderHint(): string {
  return (
    'Plan usage: put {usage} alone on a line for "usage: 5h … · wk …". ' +
    'Or compose with {usage5h} / {usageWeekly} (e.g. "{usage5h} · {usageWeekly}").'
  );
}
