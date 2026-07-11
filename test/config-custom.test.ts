import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleState } from '../src/commands/config';
import { EMPTY_THEME, readUserConfig, resolveTheme } from '../src/core/config';
import {
  PRESENCE_PLACEHOLDERS,
  PRESENCE_PLACEHOLDER_TOKENS,
  placeholderTipLine,
  usagePlaceholderHint,
} from '../src/core/placeholders';
import { renderPresence } from '../src/core/presence';
import { THEMES } from '../src/themes/index';
import type { Theme, UserConfig } from '../src/types';

const NOW = 1_700_000_000_000;

test('sampleState fills every presence placeholder (config preview)', () => {
  const state = sampleState(NOW);
  // One token that exercises all placeholders so none stay empty in the preview.
  const mega: Theme = {
    details: PRESENCE_PLACEHOLDER_TOKENS.join(' · '),
    state: '{usage}',
    largeImage: { key: 'logo', text: '{model}' },
    smallImage: { key: 'status-{state}', text: '{activity}' },
    timer: true,
    buttons: [{ label: '{project}', url: 'https://example.com' }],
    statusDisplay: 'details',
  };
  const p = renderPresence(mega, state, NOW);
  assert.ok(p.details);
  // No unresolved braces left.
  assert.ok(!/\{\w+\}/.test(p.details!), `unresolved in details: ${p.details}`);
  assert.equal(p.state, 'usage: 5h 54% · wk 27%');
  // Spot-check a few values landed.
  assert.ok(p.details!.includes('my-app'));
  assert.ok(p.details!.includes('Opus 4.8'));
  assert.ok(p.details!.includes('5h 54%'));
  assert.ok(p.details!.includes('12.3k'));
  assert.ok(p.buttons?.[0]?.label === 'my-app');
});

test('custom theme with {usage} row resolves and renders without minimal bleed', () => {
  const custom: Theme = {
    details: 'Working on {project}',
    state: '{usage}',
    largeImage: { key: 'logo', text: '{model}' },
    smallImage: { key: '', text: '' },
    timer: true,
    buttons: [],
    statusDisplay: 'details',
  };
  const cfg: UserConfig = { theme: 'custom', overrides: custom };
  const resolved = resolveTheme(cfg);
  // Must not inherit minimal's "Coding with Claude Code" when details is set.
  assert.equal(resolved.details, 'Working on {project}');
  assert.equal(resolved.state, '{usage}');
  // Empty custom slots stay empty (EMPTY_THEME shell), not minimal defaults.
  assert.equal(resolved.smallImage.key, '');
  assert.equal(resolved.statusDisplay, 'details');

  const p = renderPresence(resolved, sampleState(NOW), NOW);
  assert.equal(p.details, 'Working on my-app');
  assert.equal(p.state, 'usage: 5h 54% · wk 27%');
  assert.equal(p.statusDisplayType, 2); // details compact
});

test('custom theme re-edit seed: full overrides win over EMPTY_THEME', () => {
  const overrides: Theme = {
    ...EMPTY_THEME,
    details: 'hi {activity}',
    state: '{usage}',
    timer: true,
    statusDisplay: 'state',
    largeImage: { key: 'logo', text: 'x' },
  };
  const resolved = resolveTheme({ theme: 'custom', overrides });
  assert.equal(resolved.details, 'hi {activity}');
  assert.equal(resolved.state, '{usage}');
  assert.equal(resolved.timer, true);
  assert.equal(resolved.statusDisplay, 'state');
});

test('customizing developer preserves usage row when saved as custom', () => {
  // Mirrors config.ts: structuredClone(THEMES.developer) → save as custom overrides.
  const edited = structuredClone(THEMES.developer!);
  edited.details = 'Ship {project}';
  // leave state as '{usage}'
  const resolved = resolveTheme({ theme: 'custom', overrides: edited });
  const p = renderPresence(resolved, sampleState(NOW), NOW);
  assert.equal(p.details, 'Ship my-app');
  assert.equal(p.state, 'usage: 5h 54% · wk 27%');
});

test('custom template "usage: {usage5h} · {usageWeekly}" collapses when empty', () => {
  const theme: Theme = {
    ...EMPTY_THEME,
    details: 'Coding',
    state: 'usage: {usage5h} · {usageWeekly}',
  };
  const sparse = { sessionCount: 1, startedAt: NOW - 1000 };
  const p = renderPresence(theme, sparse, NOW);
  // Bare "usage:" must not remain after tidy.
  assert.equal(p.state, undefined);
  assert.equal(p.details, 'Coding');
});

test('custom template "usage: {usage5h} · {usageWeekly}" cleans partial windows', () => {
  const theme: Theme = {
    ...EMPTY_THEME,
    details: 'Coding',
    state: 'usage: {usage5h} · {usageWeekly}',
  };
  const onlyWk = renderPresence(
    theme,
    { sessionCount: 1, startedAt: NOW - 1000, usageWeekly: 27 },
    NOW,
  );
  assert.equal(onlyWk.state, 'usage: wk 27%');
  const only5h = renderPresence(
    theme,
    { sessionCount: 1, startedAt: NOW - 1000, usage5h: 54 },
    NOW,
  );
  assert.equal(only5h.state, 'usage: 5h 54%');
});

test('compact status falls back when usage state row is empty', () => {
  const theme: Theme = {
    ...EMPTY_THEME,
    details: 'Coding {project}',
    state: '{usage}',
    statusDisplay: 'state',
  };
  const sparse = { sessionCount: 1, startedAt: NOW - 1000, project: 'app' };
  const p = renderPresence(theme, sparse, NOW);
  // state collapsed → do not set statusDisplayType 1 (would blank the member list).
  assert.equal(p.state, undefined);
  assert.equal(p.statusDisplayType, undefined);
  assert.equal(p.details, 'Coding app');
});

test('placeholder catalog matches render keys used in a full template', () => {
  const names = new Set(PRESENCE_PLACEHOLDERS.map((p) => p.name));
  for (const required of [
    'project',
    'branch',
    'model',
    'activity',
    'file',
    'tokens',
    'cost',
    'elapsed',
    'sessionCount',
    'state',
    'usage',
    'usage5h',
    'usageWeekly',
  ]) {
    assert.ok(names.has(required), `missing placeholder catalog entry: ${required}`);
  }
  assert.ok(placeholderTipLine().includes('{usage}'));
  assert.ok(usagePlaceholderHint().includes('{usage}'));
  // Tokens already include "5h"/"wk" labels — tip must not suggest double-labeling.
  assert.ok(!usagePlaceholderHint().includes('5h {usage5h}'));
  assert.ok(usagePlaceholderHint().includes('{usage5h} · {usageWeekly}'));
});

test('readUserConfig + resolveTheme round-trips a custom usage theme from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-cfg-'));
  try {
    const path = join(dir, 'config.json');
    const saved: UserConfig = {
      theme: 'custom',
      overrides: {
        details: '{activity}',
        state: '{usage}',
        largeImage: { key: 'logo', text: 'Claude' },
        smallImage: { key: '', text: '' },
        timer: true,
        buttons: [],
        statusDisplay: 'details',
      },
    };
    await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`);
    const loaded = readUserConfig(path);
    assert.equal(loaded.theme, 'custom');
    const theme = resolveTheme(loaded);
    const p = renderPresence(theme, sampleState(NOW), NOW);
    assert.equal(p.details, 'Editing index.ts');
    assert.equal(p.state, 'usage: 5h 54% · wk 27%');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
