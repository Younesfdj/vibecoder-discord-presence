import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPresence } from '../src/core/presence';
import { THEMES } from '../src/themes/index';
import { ACTIVITY_STATES } from '../src/themes/assets';
import type { AggregatedState } from '../src/types';

const NOW = 1_700_000_000_000;

/** A fully-populated state (every placeholder resolves to something). */
function richState(): AggregatedState {
  return {
    sessionCount: 2,
    startedAt: NOW - 90 * 60_000, // 1h 30m ago
    project: 'my-app',
    branch: 'feat/theme-pack',
    model: 'Opus 4.8',
    state: 'editing',
    activity: 'Editing index.ts',
    file: 'index.ts',
    tokens: 1_234_567,
    cost: 4.2,
  };
}

/** A sparse state: only the always-present fields, everything optional empty. */
function sparseState(): AggregatedState {
  return {
    sessionCount: 1,
    startedAt: NOW - 5_000,
  };
}

const NEW_THEMES = ['terminal', 'shipper'] as const;

// `tidy()` is meant to collapse litter. Assert the output never contains the
// telltale signs of an un-collapsed empty placeholder.
function assertTidy(s: string, ctx: string): void {
  assert.ok(!/\(\s*\)/.test(s), `${ctx}: leftover "()" in ${JSON.stringify(s)}`);
  assert.ok(!/\[\s*\]/.test(s), `${ctx}: leftover "[]" in ${JSON.stringify(s)}`);
  assert.ok(!/·\s*·/.test(s), `${ctx}: doubled "·" in ${JSON.stringify(s)}`);
  assert.ok(!/^\s*·/.test(s), `${ctx}: leading "·" in ${JSON.stringify(s)}`);
  assert.ok(!/·\s*$/.test(s), `${ctx}: trailing "·" in ${JSON.stringify(s)}`);
  assert.ok(!/ {2,}/.test(s), `${ctx}: double space in ${JSON.stringify(s)}`);
  assert.equal(s, s.trim(), `${ctx}: untrimmed in ${JSON.stringify(s)}`);
}

// A generous per-line budget; Discord truncates around 128 chars.
const LINE_BUDGET = 128;

for (const name of NEW_THEMES) {
  const theme = THEMES[name]!;

  test(`${name}: renders a non-empty details line in a rich state`, () => {
    const p = renderPresence(theme, richState(), NOW);
    assert.ok(p.details && p.details.length > 0, `${name} should produce details`);
  });

  test(`${name}: defines and renders a state line in a rich state`, () => {
    // Both new themes declare a state template; it should render with rich data.
    assert.ok(theme.state.length > 0, `${name} declares a state template`);
    const p = renderPresence(theme, richState(), NOW);
    assert.ok(p.state && p.state.length > 0, `${name} should produce a state line`);
  });

  test(`${name}: output is tidy and within budget across all activity states (rich)`, () => {
    for (const state of ACTIVITY_STATES) {
      const p = renderPresence(theme, { ...richState(), state }, NOW);
      if (p.details) {
        assertTidy(p.details, `${name}/${state}/details`);
        assert.ok(p.details.length <= LINE_BUDGET, `${name}/${state}: details too long`);
      }
      if (p.state) {
        assertTidy(p.state, `${name}/${state}/state`);
        assert.ok(p.state.length <= LINE_BUDGET, `${name}/${state}: state too long`);
      }
      // The badge key must resolve (status-{state} -> status-<state>).
      if (p.smallImageKey) {
        assert.ok(!p.smallImageKey.includes('{'), `${name}/${state}: unresolved badge key`);
      }
    }
  });

  test(`${name}: collapses gracefully in a sparse state (no litter, no unresolved tokens)`, () => {
    const p = renderPresence(theme, sparseState(), NOW);
    for (const line of [p.details, p.state, p.largeImageText, p.smallImageText]) {
      if (line) {
        assertTidy(line, `${name}/sparse`);
        assert.ok(
          !/\{\w+\}/.test(line),
          `${name}/sparse: unresolved placeholder in ${JSON.stringify(line)}`,
        );
        // Every rendered line must carry real content — not just leftover
        // punctuation/cursor glyphs from a collapsed placeholder (e.g. "> _").
        assert.ok(
          /[\p{L}\p{N}]/u.test(line),
          `${name}/sparse: line is only punctuation/glyphs: ${JSON.stringify(line)}`,
        );
      }
    }
  });

  test(`${name}: timer is enabled so startTimestamp is set`, () => {
    const p = renderPresence(theme, richState(), NOW);
    assert.equal(p.startTimestamp, richState().startedAt);
  });
}

test('terminal theme is privacy-safe: never leaks project, branch, or file', () => {
  const s: AggregatedState = {
    ...richState(),
    project: 'SECRET_PROJECT',
    branch: 'SECRET_BRANCH',
    file: 'SECRET_FILE.ts',
  };
  const p = renderPresence(THEMES.terminal!, s, NOW);
  const haystack = [
    p.details,
    p.state,
    p.largeImageText,
    p.smallImageText,
    ...(p.buttons?.map((b) => b.label) ?? []),
  ]
    .filter(Boolean)
    .join(' | ');
  assert.ok(!haystack.includes('SECRET_PROJECT'), 'terminal leaked the project name');
  assert.ok(!haystack.includes('SECRET_BRANCH'), 'terminal leaked the branch');
  assert.ok(!haystack.includes('SECRET_FILE'), 'terminal leaked the file');
});

test('renderPresence resolves status-{state} badge to a concrete key', () => {
  const p = renderPresence(THEMES.terminal!, { ...richState(), state: 'thinking' }, NOW);
  assert.equal(p.smallImageKey, 'status-thinking');
});

test('truncation: details and state are capped at 128 chars with an ellipsis', () => {
  // Simulate a deeply nested file path that inflates the rendered line past 128 chars.
  const longFile = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '.ts';
  const s: AggregatedState = { ...richState(), file: longFile, project: 'x'.repeat(50) };
  for (const name of NEW_THEMES) {
    const p = renderPresence(THEMES[name]!, s, NOW);
    if (p.details) {
      assert.ok(p.details.length <= 128, `${name}: details exceeded 128 chars`);
      if (p.details.length === 128) {
        assert.ok(p.details.endsWith('…'), `${name}: truncated details must end with ellipsis`);
      }
    }
    if (p.state) {
      assert.ok(p.state.length <= 128, `${name}: state exceeded 128 chars`);
      if (p.state.length === 128) {
        assert.ok(p.state.endsWith('…'), `${name}: truncated state must end with ellipsis`);
      }
    }
  }
});

test('truncation: short strings are returned unchanged', () => {
  const p = renderPresence(THEMES.terminal!, richState(), NOW);
  // richState uses short values; nothing should be truncated.
  if (p.details) assert.ok(!p.details.endsWith('…'), 'short details got truncated unexpectedly');
  if (p.state) assert.ok(!p.state.endsWith('…'), 'short state got truncated unexpectedly');
});
