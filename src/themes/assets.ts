/**
 * Discord image-asset keys: what the registered application actually provides.
 *
 * A theme references images by asset key (e.g. `logo`, `status-editing`). Those
 * keys must be uploaded to the Discord application's art assets — Discord renders
 * NOTHING (silently, no error) for an unknown key. Contributors can't upload new
 * assets to the shared app, so every built-in theme must stay within the known
 * set below. The `validateThemeAssets` guard backs a test that makes shipping an
 * unknown key impossible.
 *
 * Keys may contain the `{state}` placeholder (e.g. `status-{state}`), which the
 * render engine expands to `status-<activity-state>`. We validate those against
 * the full `status-<state>` family rather than the literal placeholder string.
 */
import type { ActivityState, Theme } from '../types';

/** Every activity state, used to expand the `status-{state}` asset family. */
export const ACTIVITY_STATES: readonly ActivityState[] = [
  'idle',
  'thinking',
  'editing',
  'running',
  'searching',
  'browsing',
  'delegating',
  'waiting',
];

/**
 * The asset keys the Discord application is known to provide. This is the union
 * of keys the shipped themes already rely on:
 *   - `logo`            the app/brand icon
 *   - `focus`           the deep-work large image
 *   - `status-<state>`  one badge per activity state (+ `status-focus`)
 */
export const ALLOWED_ASSET_KEYS: ReadonlySet<string> = new Set<string>([
  'logo',
  'focus',
  'status-focus',
  ...ACTIVITY_STATES.map((s) => `status-${s}`),
]);

/**
 * Expand an asset key template to the concrete key(s) it can resolve to.
 * `status-{state}` expands to the whole `status-<state>` family; a key with no
 * `{state}` token resolves to itself. (Only `{state}` is meaningful for image
 * keys; other placeholders never appear in asset keys.)
 */
function expandAssetKey(key: string): string[] {
  if (key.includes('{state}')) {
    return ACTIVITY_STATES.map((s) => key.replace('{state}', s));
  }
  return [key];
}

/**
 * Validate a single theme's image keys against {@link ALLOWED_ASSET_KEYS}.
 * Returns the list of unknown keys (empty when the theme is valid). Pure.
 */
export function findUnknownAssetKeys(theme: Theme): string[] {
  const keys = [theme.largeImage.key, theme.smallImage.key];
  const unknown: string[] = [];
  for (const key of keys) {
    // Empty key means "no image" — not an asset reference.
    if (!key) continue;
    for (const resolved of expandAssetKey(key)) {
      if (!ALLOWED_ASSET_KEYS.has(resolved)) unknown.push(resolved);
    }
  }
  return unknown;
}

/** True when every image key a theme references is a known Discord asset. */
export function validateThemeAssets(theme: Theme): boolean {
  return findUnknownAssetKeys(theme).length === 0;
}
