import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPresence } from '../src/core/presence';
import { THEMES } from '../src/themes/index';
import {
  clearClaudeUsageCache,
  fetchClaudeUsage,
  isTokenExpired,
  parseUsage,
  pollUsage,
  readCredentials,
  UsageAuthError,
  UsageRequestError,
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

const oauth = (accessToken: string, expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken,
      expiresAt,
      subscriptionType: 'max',
      rateLimitTier: null,
    },
  });

// A trimmed copy of the real /api/oauth/usage payload shape.
const liveBody = {
  five_hour: { utilization: 46, resets_at: '2026-06-29T21:10:00.85+00:00' },
  seven_day: { utilization: 19, resets_at: '2026-07-05T22:00:00.85+00:00' },
  seven_day_opus: null,
};

// ── Presence placeholders ──────────────────────────────────────────────────

test('developer puts usage on its own row', () => {
  const p = renderPresence(THEMES.developer!, stateWithUsage(), NOW);
  assert.equal(p.state, 'usage: 5h 54% · wk 27%');
  assert.ok(p.details && !p.details.includes('usage:'), 'usage must not mix into details');
  assert.ok(p.details?.includes('Editing index.ts'), 'activity stays on details');
});

test('presence collapses missing usage row cleanly', () => {
  const sparse: AggregatedState = {
    sessionCount: 1,
    startedAt: NOW - 5_000,
    activity: 'Thinking',
    model: 'Sonnet 4',
  };
  const p = renderPresence(THEMES.developer!, sparse, NOW);
  // No usage → state row omitted entirely (no dangling "usage:").
  assert.equal(p.state, undefined);
  assert.ok(p.details, 'details still render');
  assert.ok(!p.details!.includes('usage'), 'no usage litter in details');
});

test('chaos theme puts usage on its own row and keeps every-stat details', () => {
  const p = renderPresence(THEMES.chaos!, stateWithUsage({ sessionCount: 3 }), NOW);
  assert.equal(p.state, 'usage: 5h 54% · wk 27%');
  assert.ok(p.details && !p.details.includes('5h'), 'usage not mixed into details');
  assert.ok(p.details?.includes('main'), 'branch in details');
  assert.ok(p.details?.includes('×3'), 'sessionCount in details');
});

test('usage percentages round to whole numbers in the usage row', () => {
  const p = renderPresence(
    THEMES.developer!,
    stateWithUsage({ usage5h: 54.6, usageWeekly: 27.2 }),
    NOW,
  );
  assert.equal(p.state, 'usage: 5h 55% · wk 27%');
});

test('usage row works with only one window present', () => {
  const only5h = renderPresence(THEMES.developer!, stateWithUsage({ usageWeekly: undefined }), NOW);
  assert.equal(only5h.state, 'usage: 5h 54%');
  const onlyWk = renderPresence(THEMES.developer!, stateWithUsage({ usage5h: undefined }), NOW);
  assert.equal(onlyWk.state, 'usage: wk 27%');
});

// ── isTokenExpired ─────────────────────────────────────────────────────────

test('isTokenExpired: false before expiry, true at/after, true when missing', () => {
  assert.equal(isTokenExpired({ expiresAt: 2000 }, 1000), false);
  assert.equal(isTokenExpired({ expiresAt: 1000 }, 1000), true);
  assert.equal(isTokenExpired({ expiresAt: 500 }, 1000), true);
  assert.equal(isTokenExpired({ expiresAt: NaN }, 1000), true);
});

// ── readCredentials ────────────────────────────────────────────────────────

test('readCredentials returns null when no credentials exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    assert.equal(await readCredentials(dir, { readKeychain: async () => [] }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials reads claudeAiOauth from a plaintext .credentials.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    await writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok',
          expiresAt: 1893456000000,
          refreshToken: 'ref',
          subscriptionType: 'pro',
          rateLimitTier: null,
        },
      }),
    );
    const creds = await readCredentials(dir, { readKeychain: async () => [] });
    assert.deepEqual(creds, {
      accessToken: 'tok',
      expiresAt: 1893456000000,
      refreshToken: 'ref',
      subscriptionType: 'pro',
      rateLimitTier: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials uses a live keychain token even when a stale plaintext file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    const now = 10_000;
    await writeFile(join(dir, '.credentials.json'), oauth('stale-file', 5_000));
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => [oauth('live-keychain', 20_000)],
    });
    assert.equal(creds?.accessToken, 'live-keychain');
    assert.equal(isTokenExpired(creds!, now), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials uses a fresh file without consulting the keychain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    const now = 10_000;
    let keychainReads = 0;
    await writeFile(join(dir, '.credentials.json'), oauth('fresh-file', 20_000));
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => {
        keychainReads++;
        return [];
      },
    });
    assert.equal(creds?.accessToken, 'fresh-file');
    assert.equal(keychainReads, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials falls back to the expired file when no fresher source exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    const now = 10_000;
    await writeFile(join(dir, '.credentials.json'), oauth('stale-file', 5_000));
    const creds = await readCredentials(dir, { now, readKeychain: async () => [] });
    assert.equal(creds?.accessToken, 'stale-file');
    assert.equal(isTokenExpired(creds!, now), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials skips a malformed keychain entry and keeps looking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    const now = 10_000;
    await writeFile(join(dir, '.credentials.json'), oauth('stale-file', 5_000));
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => ['}{ not json', oauth('live-keychain', 20_000)],
    });
    assert.equal(creds?.accessToken, 'live-keychain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials soft-fails a malformed plaintext file and tries keychain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    const now = 10_000;
    await writeFile(join(dir, '.credentials.json'), '{ not valid json');
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => [oauth('live-keychain', 20_000)],
    });
    assert.equal(creds?.accessToken, 'live-keychain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials soft-fails a credentials file missing accessToken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-creds-'));
  try {
    const now = 10_000;
    await writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { expiresAt: 20_000 } }),
    );
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => [oauth('from-keychain', 20_000)],
    });
    assert.equal(creds?.accessToken, 'from-keychain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── parseUsage / pollUsage ─────────────────────────────────────────────────

test('parseUsage maps available caps, skips null, trusts utilization verbatim', () => {
  const usage = parseUsage(liveBody);
  assert.deepEqual(usage, { usage5h: 46, usageWeekly: 19 });
});

test('parseUsage skips non-finite utilization (NaN/Infinity)', () => {
  assert.deepEqual(parseUsage({ five_hour: { utilization: NaN } }), {});
  assert.deepEqual(parseUsage({ five_hour: { utilization: Infinity } }), {});
  assert.deepEqual(parseUsage({ five_hour: { utilization: '46' } }), {});
  assert.deepEqual(parseUsage({ five_hour: { utilization: 0 } }), { usage5h: 0 });
});

test('pollUsage sends oauth headers and parses the body', async () => {
  let seen: { url: string; headers: Record<string, string>; hasSignal: boolean } | null = null;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      hasSignal: init?.signal != null,
    };
    return new Response(JSON.stringify(liveBody), { status: 200 });
  }) as typeof fetch;

  const usage = await pollUsage('tok-123', { fetchImpl, version: '9.9.9' });
  assert.deepEqual(usage, { usage5h: 46, usageWeekly: 19 });
  assert.equal(seen!.headers.Authorization, 'Bearer tok-123');
  assert.equal(seen!.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen!.headers['User-Agent'], 'claude-code/9.9.9');
  assert.equal(seen!.hasSignal, true, 'pollUsage must pass an AbortSignal timeout');
});

test('pollUsage throws UsageAuthError on 401', async () => {
  const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
  await assert.rejects(() => pollUsage('tok', { fetchImpl }), UsageAuthError);
});

test('pollUsage throws UsageRequestError carrying the status on other failures', async () => {
  const fetchImpl = (async () => new Response('', { status: 429 })) as typeof fetch;
  try {
    await pollUsage('tok', { fetchImpl });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof UsageRequestError);
    assert.equal(err.status, 429);
  }
});

// ── fetchClaudeUsage wrapper ───────────────────────────────────────────────

test('fetchClaudeUsage skips poll when token is expired', async () => {
  clearClaudeUsageCache();
  const dir = await mkdtemp(join(tmpdir(), 'vdp-fetch-'));
  let polled = false;
  try {
    await writeFile(join(dir, '.credentials.json'), oauth('stale', 5_000));
    const usage = await fetchClaudeUsage({
      configDir: dir,
      now: 10_000,
      readKeychain: async () => [],
      fetchImpl: (async () => {
        polled = true;
        return new Response(JSON.stringify(liveBody), { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(usage, {});
    assert.equal(polled, false);
  } finally {
    clearClaudeUsageCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchClaudeUsage polls with a live token and returns utilization', async () => {
  clearClaudeUsageCache();
  const dir = await mkdtemp(join(tmpdir(), 'vdp-fetch-'));
  try {
    await writeFile(join(dir, '.credentials.json'), oauth('live-tok', 20_000));
    const usage = await fetchClaudeUsage({
      configDir: dir,
      now: 10_000,
      readKeychain: async () => [],
      fetchImpl: (async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer live-tok');
        return new Response(JSON.stringify(liveBody), { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(usage, { usage5h: 46, usageWeekly: 19 });
  } finally {
    clearClaudeUsageCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchClaudeUsage never throws on network/auth failure', async () => {
  clearClaudeUsageCache();
  const dir = await mkdtemp(join(tmpdir(), 'vdp-fetch-'));
  try {
    await writeFile(join(dir, '.credentials.json'), oauth('live-tok', 20_000));
    const usage = await fetchClaudeUsage({
      configDir: dir,
      now: 10_000,
      readKeychain: async () => [],
      fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
    });
    assert.deepEqual(usage, {});
  } finally {
    clearClaudeUsageCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchClaudeUsage keeps last good usage after a transient poll failure', async () => {
  clearClaudeUsageCache();
  const dir = await mkdtemp(join(tmpdir(), 'vdp-fetch-'));
  try {
    await writeFile(join(dir, '.credentials.json'), oauth('live-tok', 100_000));
    const ok = await fetchClaudeUsage({
      configDir: dir,
      now: 10_000,
      readKeychain: async () => [],
      fetchImpl: (async () => new Response(JSON.stringify(liveBody), { status: 200 })) as typeof fetch,
    });
    assert.deepEqual(ok, { usage5h: 46, usageWeekly: 19 });

    // After TTL, a 401 must not wipe the previous percentages.
    const recovered = await fetchClaudeUsage({
      configDir: dir,
      now: 10_000 + 61_000,
      readKeychain: async () => [],
      fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
    });
    assert.deepEqual(recovered, { usage5h: 46, usageWeekly: 19 });
  } finally {
    clearClaudeUsageCache();
    await rm(dir, { recursive: true, force: true });
  }
});
