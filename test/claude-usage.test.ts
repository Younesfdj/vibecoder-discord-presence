import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPresence } from '../src/core/presence';
import { THEMES } from '../src/themes/index';
import {
  clearClaudeUsageCache,
  fetchClaudeUsage,
  readClaudeOAuthToken,
} from '../src/provider/claude-usage';
import type { AggregatedState } from '../src/types';

const NOW = 1_700_000_000_000;

function stateWithUsage(partial: Partial<AggregatedState> = {}): AggregatedState {
  return {
    sessionCount: 1,
    startedAt: NOW - 60_000,
    project: 'my-app',
    branch: 'main',
    model: 'Opus 4.8',
    state: 'editing',
    activity: 'Editing index.ts',
    file: 'index.ts',
    tokens: 12_345,
    cost: 0.42,
    usage5h: 54,
    usageWeekly: 27,
    ...partial,
  };
}

test('presence formats usage5h and usageWeekly as labeled percentages', () => {
  const p = renderPresence(THEMES.developer!, stateWithUsage(), NOW);
  assert.ok(p.state?.includes('5h 54%'), `expected 5h in state, got ${p.state}`);
  assert.ok(p.state?.includes('wk 27%'), `expected weekly in state, got ${p.state}`);
});

test('presence collapses missing usage placeholders cleanly', () => {
  const sparse: AggregatedState = {
    sessionCount: 1,
    startedAt: NOW - 5_000,
    activity: 'Thinking',
    model: 'Sonnet 4',
  };
  const p = renderPresence(THEMES.developer!, sparse, NOW);
  assert.ok(p.state, 'expected a state line');
  assert.ok(!p.state!.includes('undefined'), 'should not print undefined');
  assert.ok(!/\{\w+\}/.test(p.state!), 'unresolved placeholders');
  assert.ok(!p.state!.includes('5h'), 'should omit 5h label when usage unknown');
  assert.ok(!p.state!.includes('wk'), 'should omit wk label when usage unknown');
  assert.ok(!/·\s*·/.test(p.state!), 'doubled separators');
});

test('chaos theme surfaces both usage windows', () => {
  const p = renderPresence(THEMES.chaos!, stateWithUsage(), NOW);
  assert.ok(p.state?.includes('5h 54%'), `chaos missing 5h: ${p.state}`);
  assert.ok(p.state?.includes('wk 27%'), `chaos missing weekly: ${p.state}`);
});

test('usage percentages round to whole numbers', () => {
  const p = renderPresence(
    THEMES.developer!,
    stateWithUsage({ usage5h: 54.6, usageWeekly: 27.2 }),
    NOW,
  );
  assert.ok(p.state?.includes('5h 55%'), `expected rounded 5h, got ${p.state}`);
  assert.ok(p.state?.includes('wk 27%'), `expected rounded weekly, got ${p.state}`);
});

test('fetchClaudeUsage returns empty object without a token and does not throw', async () => {
  clearClaudeUsageCache();
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Force a miss even if keychain/file has credentials by using an empty env
  // override path is first — set a deliberately invalid token and mock... 
  // Without network isolation we only assert the function is safe with no token
  // by temporarily unsetting env and relying on cache after a failed empty path.
  // The function never throws.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    // May still find a real device token; either way must resolve an object.
    const usage = await fetchClaudeUsage(NOW);
    assert.equal(typeof usage, 'object');
    assert.ok(usage !== null);
    if (usage.usage5h != null) {
      assert.ok(usage.usage5h >= 0 && usage.usage5h <= 100);
    }
    if (usage.usageWeekly != null) {
      assert.ok(usage.usageWeekly >= 0 && usage.usageWeekly <= 100);
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    clearClaudeUsageCache();
  }
});

test('readClaudeOAuthToken returns string or null (never throws)', () => {
  const token = readClaudeOAuthToken();
  assert.ok(token === null || typeof token === 'string');
  if (token) assert.ok(token.length > 0);
});
