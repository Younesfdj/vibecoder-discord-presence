/**
 * Background daemon.
 *
 * Singleton (guarded by the lockfile). Owns the Discord connection. On a fixed
 * tick it:
 *   - reads session markers, drops ones whose heartbeat is stale (crash-safe),
 *   - aggregates the live sessions into one state,
 *   - renders the active theme into a presence payload,
 *   - pushes it to Discord (the Discord layer reconnects transparently),
 *   - clears presence and self-exits once no sessions remain for a grace period.
 *
 * It's spawned detached by the SessionStart hook, so there's no console to talk
 * to; health is surfaced through the status file (see core/daemon-state) which
 * `vdp status` reads.
 *
 * Facts the hook can't cheaply know (model, branch, tokens) are enriched here
 * from the current session's transcript before rendering.
 */
import {
  acquireLock,
  clearDaemonStatus,
  releaseLock,
  writeDaemonStatus,
} from '../core/daemon-state';
import { configPath } from '../core/paths';
import { readUserConfig, resolveClientId, resolveTheme } from '../core/config';
import { PRUNE_AFTER_MS, aggregate, readMarkers, removeSessionMarker } from '../core/state';
import { readTranscriptMeta } from '../provider/transcript';
import { fetchClaudeUsage } from '../provider/claude-usage';
import { renderPresence } from '../core/presence';
import { DiscordPresence } from './discord';

/** How often we reconcile markers -> Discord. */
const TICK_MS = 15 * 1000;
/** How long with zero live sessions before the daemon clears presence and exits. */
const IDLE_GRACE_MS = 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startDaemon(_args: string[] = []): Promise<void> {
  if (!acquireLock(Date.now())) return; // another daemon already owns the lock

  // The Discord app id is fixed for the connection's lifetime (changing it needs
  // a reconnect), so resolve it once. The theme, by contrast, is re-read every
  // tick below so `vdp config` edits apply to the live card without a restart.
  const discord = new DiscordPresence(resolveClientId(readUserConfig(configPath())));

  let running = true;
  const shutdown = async (): Promise<void> => {
    running = false;
    await discord.clearActivity();
    await discord.destroy();
    clearDaemonStatus();
    releaseLock();
  };

  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('exit', () => releaseLock()); // last-ditch synchronous cleanup

  // Backstop: the discord-rpc IPC transport can let a socket 'error' (rejected
  // handshake, ECONNRESET) go unhandled during the connect window before our
  // own listener is attached — that would crash the daemon. A background
  // presence daemon must survive a flaky Discord connection, so swallow known
  // connection errors and let the loop reconnect. Anything else is a real
  // fault: shut down cleanly rather than keep running in a bad state.
  const RECOVERABLE = new Set([
    'ECONNRESET',
    'EPIPE',
    'ECONNREFUSED',
    'ENOENT',
    'EBADF',
    'ERR_STREAM_DESTROYED',
  ]);
  process.on('uncaughtException', (err) => {
    if (RECOVERABLE.has((err as NodeJS.ErrnoException).code ?? '')) return;
    void shutdown().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', () => {
    // In-flight RPC rejections are already handled by the Discord layer.
  });

  let idleSince: number | null = null;
  while (running) {
    const now = Date.now();
    const markers = readMarkers();
    const state = aggregate(markers, now);

    // Delete abandoned markers (a session that never fired SessionEnd) so they
    // don't pile up on disk over time.
    for (const m of markers) {
      if (now - m.heartbeat > PRUNE_AFTER_MS) removeSessionMarker(m.id);
    }

    if (state) {
      idleSince = null;
      // Fill model/branch/tokens from the transcript (hook-provided values win).
      const meta = readTranscriptMeta(state.transcriptPath);
      state.model ??= meta.model;
      state.branch ??= meta.branch;
      state.tokens ??= meta.tokens;
      // Plan quota % from Claude's OAuth usage API (device session token).
      const usage = await fetchClaudeUsage(now);
      state.usage5h = usage.usage5h;
      state.usageWeekly = usage.usageWeekly;
      const theme = resolveTheme(readUserConfig(configPath()));
      await discord.setActivity(renderPresence(theme, state, now));
      writeDaemonStatus({
        pid: process.pid,
        connected: discord.isConnected,
        sessionCount: state.sessionCount,
        activity: state.activity,
        updatedAt: now,
      });
    } else {
      if (idleSince === null) idleSince = now;
      await discord.clearActivity();
      writeDaemonStatus({
        pid: process.pid,
        connected: discord.isConnected,
        sessionCount: 0,
        updatedAt: now,
      });
      if (now - idleSince >= IDLE_GRACE_MS) break;
    }

    await sleep(TICK_MS);
  }

  await shutdown();
}
