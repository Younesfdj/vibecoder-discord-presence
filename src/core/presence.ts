/**
 * Presence rendering: turn (resolved theme + aggregated state) into the
 * payload the Discord layer sends.
 *
 * Fills `{placeholder}` tokens from state, collapses ones that resolve to empty
 * so we never ship "Coding ()" or a dangling " · ", resolves image asset keys
 * (e.g. `status-{state}` -> `status-editing`), and maps everything onto
 * Discord's fixed slots. Pure and deterministic — `now` is passed in, not read.
 */
import type { AggregatedState, PresencePayload, Theme } from '../types';

type Values = Record<string, string>;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function buildValues(state: AggregatedState, now: number): Values {
  return {
    project: state.project ?? '',
    branch: state.branch ?? '',
    model: state.model ?? '',
    activity: state.activity ?? '',
    file: state.file ?? '',
    tokens: state.tokens != null ? formatTokens(state.tokens) : '',
    cost: state.cost != null ? `$${state.cost.toFixed(2)}` : '',
    elapsed: formatElapsed(now - state.startedAt),
    sessionCount: String(state.sessionCount),
    // Drives the `status-{state}` badge; also available as a text token.
    state: state.state ?? 'idle',
  };
}

/**
 * Tidy a template after substitution so collapsed placeholders don't leave
 * litter: empty `()`, doubled or dangling `·` separators, and runs of spaces.
 */
function tidy(s: string): string {
  return s
    .replace(/\(\s*\)/g, '') // "()"
    .replace(/\[\s*\]/g, '') // "[]"
    .replace(/\s+/g, ' ') // collapse whitespace runs
    .replace(/·(\s*·)+/g, '·') // "· ·" -> "·"
    .replace(/^\s*·\s*/, '') // leading separator
    .replace(/\s*·\s*$/, '') // trailing separator
    .trim();
}

function interpolate(template: string, values: Values): string {
  return tidy(template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ''));
}

/**
 * Discord rejects any Rich Presence field that exceeds 128 characters.
 * When that happens the RPC library throws synchronously, and the caller's
 * bare try/catch in discord.ts treats every throw as a dead socket — forcing
 * a reconnect on the next tick, which fails the same way, forever.
 *
 * Truncating here, before the payload leaves this module, keeps the fields
 * within spec and stops that loop from ever starting.
 */
function truncate(s: string, limit = 128): string {
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

export function renderPresence(theme: Theme, state: AggregatedState, now: number): PresencePayload {
  const values = buildValues(state, now);
  const payload: PresencePayload = {};

  const details = interpolate(theme.details, values);
  if (details) payload.details = truncate(details);

  const stateLine = interpolate(theme.state, values);
  if (stateLine) payload.state = truncate(stateLine);

  const largeKey = interpolate(theme.largeImage.key, values);
  if (largeKey) {
    payload.largeImageKey = largeKey;
    const largeText = interpolate(theme.largeImage.text, values);
    if (largeText) payload.largeImageText = truncate(largeText);
  }

  const smallKey = interpolate(theme.smallImage.key, values);
  if (smallKey) {
    payload.smallImageKey = smallKey;
    const smallText = interpolate(theme.smallImage.text, values);
    if (smallText) payload.smallImageText = truncate(smallText);
  }

  if (theme.timer) payload.startTimestamp = state.startedAt;

  // Choose what the compact member-list status shows. Only switch away from the
  // app name when the target line actually rendered something — otherwise the
  // compact status would go blank.
  if (theme.statusDisplay === 'state' && payload.state) payload.statusDisplayType = 1;
  else if (theme.statusDisplay === 'details' && payload.details) payload.statusDisplayType = 2;

  const buttons = theme.buttons
    .map((b) => ({ label: interpolate(b.label, values), url: b.url }))
    .filter((b) => b.label && b.url)
    .slice(0, 2); // Discord allows at most two buttons
  if (buttons.length > 0) payload.buttons = buttons;

  return payload;
}
