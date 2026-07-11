/**
 * Claude subscription usage (5-hour + weekly windows).
 *
 * Reads the on-device Claude Code OAuth session token and calls Anthropic's
 * OAuth usage endpoint — the same source that powers Claude Code's /usage
 * view. Used by the daemon to enrich presence with plan quota percentages.
 *
 * Credential sources (first match wins):
 *   1. CLAUDE_CODE_OAUTH_TOKEN env
 *   2. macOS Keychain service "Claude Code-credentials"
 *   3. ~/.claude/.credentials.json (or $CLAUDE_CONFIG_DIR)
 *
 * Never throws — a missing token or network blip just yields empty usage so
 * the presence card keeps working without the percentages.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir } from '../core/paths';

export interface ClaudeUsage {
  /** 5-hour rolling window utilization, 0–100. */
  usage5h?: number;
  /** Weekly window utilization, 0–100. */
  usageWeekly?: number;
}

interface OAuthWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface OAuthUsageResponse {
  five_hour?: OAuthWindow | null;
  seven_day?: OAuthWindow | null;
}

interface ClaudeAiOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

interface CredentialsFile {
  claudeAiOauth?: ClaudeAiOauth;
}

interface CacheEntry {
  fetchedAt: number;
  usage: ClaudeUsage;
}

/** How long a successful (or empty) fetch is reused before hitting the API again. */
const CACHE_TTL_MS = 60_000;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

let cache: CacheEntry | null = null;

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseCredentialsJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(stripBom(raw)) as CredentialsFile;
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Read the OAuth access token from Claude Code's on-device credentials. */
export function readClaudeOAuthToken(): string | null {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (raw) {
        const token = parseCredentialsJson(raw);
        if (token) return token;
        // Some setups store the bare token as the password.
        if (raw.startsWith('sk-ant-')) return raw;
      }
    } catch {
      // fall through to file
    }
  }

  try {
    const path = join(claudeDir(), '.credentials.json');
    const raw = readFileSync(path, 'utf8');
    return parseCredentialsJson(raw);
  } catch {
    return null;
  }
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function mapResponse(body: OAuthUsageResponse): ClaudeUsage {
  const usage: ClaudeUsage = {};
  const five = body.five_hour?.utilization;
  const week = body.seven_day?.utilization;
  if (typeof five === 'number') usage.usage5h = clampPercent(five);
  if (typeof week === 'number') usage.usageWeekly = clampPercent(week);
  return usage;
}

/**
 * Fetch 5h + weekly utilization from the Anthropic OAuth usage API.
 * Results are cached briefly so the daemon tick doesn't spam the endpoint.
 */
export async function fetchClaudeUsage(now = Date.now()): Promise<ClaudeUsage> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.usage;
  }

  const token = readClaudeOAuthToken();
  if (!token) {
    cache = { fetchedAt: now, usage: {} };
    return {};
  }

  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      cache = { fetchedAt: now, usage: {} };
      return {};
    }

    const body = (await res.json()) as OAuthUsageResponse;
    const usage = mapResponse(body);
    cache = { fetchedAt: now, usage };
    return usage;
  } catch {
    // Keep a short negative cache so a flaky network doesn't retry every tick.
    cache = { fetchedAt: now, usage: {} };
    return {};
  }
}

/** Test helper: wipe the in-memory cache between cases. */
export function clearClaudeUsageCache(): void {
  cache = null;
}
