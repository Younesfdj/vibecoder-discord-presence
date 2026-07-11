/**
 * Claude plan usage (5-hour + weekly windows).
 *
 * Mirrors how ccshare reads the on-device Claude Code OAuth session and polls
 * Anthropic's OAuth usage endpoint:
 *   - Never mint or refresh a token — only read what Claude Code stored.
 *   - Skip the poll when the token is missing/expired (Claude Code refreshes
 *     on its next run).
 *   - Trust the endpoint's utilization % verbatim; never estimate from tokens.
 *
 * Credential sources (freshest-wins — see {@link readCredentials}):
 *   1. `<configDir>/.credentials.json` if still live
 *   2. macOS Keychain (`Claude Code-credentials` / hashed variant)
 *   3. First readable-but-expired source as a last resort (so callers can
 *      report "expired" rather than "none")
 *
 * The daemon wraps this so a missing token or network blip just omits the
 * percentages from the presence card.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeDir } from '../core/paths';

const pExecFile = promisify(execFile);

// ── Credentials (ccshare identity/credentials.ts) ──────────────────────────

/** The OAuth token Claude Code already stored. We read it; we never mint one. */
export interface Credentials {
  accessToken: string;
  expiresAt: number; // epoch ms
  refreshToken?: string;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

/** Always verify before using the token. Treats missing/NaN expiry as expired. */
export function isTokenExpired(
  c: Pick<Credentials, 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  return !Number.isFinite(c.expiresAt) || now >= c.expiresAt;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseCredentials(raw: string): Credentials {
  const j = JSON.parse(raw) as any;
  const o = j?.claudeAiOauth ?? j;
  if (!o || typeof o.accessToken !== 'string' || o.accessToken.length === 0) {
    throw new Error('credentials JSON missing claudeAiOauth.accessToken');
  }
  return {
    accessToken: o.accessToken,
    expiresAt: Number(o.expiresAt),
    refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : undefined,
    subscriptionType: o.subscriptionType ?? null,
    rateLimitTier: o.rateLimitTier ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** macOS keychain service names to try, plain first then the hashed variant. */
function keychainServices(configDir: string): string[] {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return ['Claude Code-credentials', `Claude Code-credentials-${hash}`];
}

/** Reads each macOS keychain service, returning the raw JSON blobs it finds. */
async function readKeychainDefault(services: string[]): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const blobs: string[] = [];
  for (const svc of services) {
    try {
      const { stdout } = await pExecFile('security', ['find-generic-password', '-s', svc, '-w']);
      blobs.push(stdout);
    } catch {
      // service not present — try the next name
    }
  }
  return blobs;
}

export interface ReadCredentialsOptions {
  /** Epoch ms used to judge freshness. Defaults to `Date.now()`. */
  now?: number;
  /** Overrides the macOS keychain read (raw JSON blobs). A testing seam. */
  readKeychain?: (services: string[]) => Promise<string[]>;
}

/**
 * Read the stored credentials for an account's config dir, or null if none.
 *
 * Every source is only a *cache* of the OAuth token Claude Code minted, and any
 * of them can go stale: on macOS the plaintext file is Claude Code's fallback
 * when the keychain is briefly locked, and it is never deleted once the keychain
 * recovers — so it can linger with a long-expired token while the keychain holds
 * the live one. Never let an expired source shadow a live one: return the first
 * *fresh* token found, and only fall back to an expired source when nothing
 * fresher exists anywhere.
 */
export async function readCredentials(
  configDir: string,
  opts: ReadCredentialsOptions = {},
): Promise<Credentials | null> {
  const now = opts.now ?? Date.now();
  const readKeychain = opts.readKeychain ?? readKeychainDefault;

  const useIfFresh = (c: Credentials): Credentials | null =>
    isTokenExpired(c, now) ? null : c;

  // First readable-but-expired source, kept as a last resort so a caller still
  // sees "expired" rather than a bare "no credentials".
  let stale: Credentials | null = null;

  // 1. plaintext file (Linux + universal fallback). Missing *or* malformed files
  //    are a soft miss — on darwin the keychain is often the live source while a
  //    stale/corrupt plaintext file is just Claude Code's leftover fallback.
  try {
    const c = parseCredentials(await readFile(join(configDir, '.credentials.json'), 'utf8'));
    const fresh = useIfFresh(c);
    if (fresh) return fresh;
    stale ??= c;
  } catch {
    // ENOENT, bad JSON, missing accessToken, unreadable — try keychain next.
  }

  // 2. macOS keychain — source of truth on darwin. A live token here must win
  //    over a stale file above, so we always consult it when the file wasn't fresh.
  const blobs = await readKeychain(keychainServices(configDir));
  for (const blob of blobs) {
    let c: Credentials;
    try {
      c = parseCredentials(blob);
    } catch {
      continue; // malformed keychain entry — try the next
    }
    const fresh = useIfFresh(c);
    if (fresh) return fresh;
    stale ??= c;
  }

  return stale;
}

// ── Usage poll (ccshare usage/poller.ts) ───────────────────────────────────

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA = 'oauth-2025-04-20';

export interface ClaudeUsage {
  /** 5-hour rolling window utilization (endpoint `pct`, verbatim). */
  usage5h?: number;
  /** Weekly window utilization (endpoint `pct`, verbatim). */
  usageWeekly?: number;
}

/** Thrown on 401 / expired token so callers can skip the tick, not crash. */
export class UsageAuthError extends Error {
  override name = 'UsageAuthError';
}

/** Thrown on any other non-2xx (e.g. 429 rate-limit). */
export class UsageRequestError extends Error {
  override name = 'UsageRequestError';
  constructor(readonly status: number) {
    super(`usage endpoint returned ${status}`);
  }
}

interface CapNode {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * Parse the usage payload into 5h + weekly percentages. Caps that are `null`
 * (not on the plan) are skipped — never rendered as 0. `utilization` is taken
 * verbatim when finite; we never derive it from tokens.
 */
export function parseUsage(body: unknown): ClaudeUsage {
  const obj = (body ?? {}) as Record<string, CapNode | null | undefined>;
  const usage: ClaudeUsage = {};

  const five = obj.five_hour;
  if (five && typeof five.utilization === 'number' && Number.isFinite(five.utilization)) {
    usage.usage5h = five.utilization;
  }

  const week = obj.seven_day;
  if (week && typeof week.utilization === 'number' && Number.isFinite(week.utilization)) {
    usage.usageWeekly = week.utilization;
  }

  return usage;
}

/** Bound a hung usage request so the daemon tick cannot stall forever. */
export const POLL_TIMEOUT_MS = 5_000;

export interface PollOptions {
  version?: string;
  fetchImpl?: typeof fetch;
  /** Override the default {@link POLL_TIMEOUT_MS} (ms). `0` disables the timeout. */
  timeoutMs?: number;
}

/**
 * Read the account-wide tank. Caller must have verified `now < expiresAt` first.
 * 401 → {@link UsageAuthError}; other non-2xx → {@link UsageRequestError}.
 * Abort/timeout also rejects (callers map that into fail-open / stale cache).
 */
export async function pollUsage(
  accessToken: string,
  opts: PollOptions = {},
): Promise<ClaudeUsage> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const signal =
    timeoutMs > 0 && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await f(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA,
      'User-Agent': `claude-code/${opts.version ?? '1.0.0'}`,
    },
    ...(signal ? { signal } : {}),
  });

  if (res.status === 401) {
    throw new UsageAuthError('usage endpoint returned 401 (token expired?)');
  }
  if (!res.ok) {
    throw new UsageRequestError(res.status);
  }

  return parseUsage(await res.json());
}

// ── Daemon-facing wrapper ──────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: number;
  usage: ClaudeUsage;
}

/** How long a successful (or empty) fetch is reused before hitting the API again. */
const CACHE_TTL_MS = 60_000;

let cache: CacheEntry | null = null;

export interface FetchClaudeUsageOptions {
  configDir?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  readKeychain?: ReadCredentialsOptions['readKeychain'];
  version?: string;
}

/**
 * Fetch 5h + weekly utilization for the presence card.
 *
 * Flow matches ccshare's live poll: read credentials → skip if expired → poll.
 * Never throws; missing/expired auth or network errors yield `{}` so the rest
 * of the presence keeps working.
 */
export async function fetchClaudeUsage(
  nowOrOpts: number | FetchClaudeUsageOptions = {},
): Promise<ClaudeUsage> {
  const opts: FetchClaudeUsageOptions =
    typeof nowOrOpts === 'number' ? { now: nowOrOpts } : nowOrOpts;
  const now = opts.now ?? Date.now();
  const configDir = opts.configDir ?? claudeDir();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.usage;
  }

  try {
    const creds = await readCredentials(configDir, {
      now,
      readKeychain: opts.readKeychain,
    });
    // Never poll with a missing/expired token — Claude Code refreshes on next run.
    if (!creds || isTokenExpired(creds, now)) {
      cache = { fetchedAt: now, usage: {} };
      return {};
    }

    const usage = await pollUsage(creds.accessToken, {
      fetchImpl: opts.fetchImpl,
      version: opts.version,
    });
    cache = { fetchedAt: now, usage };
    return usage;
  } catch {
    // Auth, network, timeout, malformed credentials — fail open. Prefer the last
    // successful usage (stale-while-error) so a single blip does not blank the
    // presence card for a full CACHE_TTL. Advance fetchedAt so we do not hammer
    // the API every tick while the outage lasts.
    if (cache && (cache.usage.usage5h != null || cache.usage.usageWeekly != null)) {
      cache = { fetchedAt: now, usage: cache.usage };
      return cache.usage;
    }
    cache = { fetchedAt: now, usage: {} };
    return {};
  }
}

/** Test helper: wipe the in-memory cache between cases. */
export function clearClaudeUsageCache(): void {
  cache = null;
}
