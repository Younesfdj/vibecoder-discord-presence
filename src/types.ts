/** Shared shapes used across the tool. */

export interface PresenceButton {
  label: string;
  url: string;
}

export interface ImageSlot {
  /** Discord asset key (uploaded in the Developer Portal), may contain placeholders. */
  key: string;
  /** Hover tooltip, may contain placeholders. */
  text: string;
}

/**
 * Which line Discord shows as the compact status (the member-list "Playing …"
 * slot): the app `name`, the `state` line, or the `details` line. Maps to
 * Discord's StatusDisplayType.
 */
export type StatusDisplay = 'name' | 'state' | 'details';

/** A theme is a bundle of slot templates + which image assets to use. */
export interface Theme {
  details: string;
  state: string;
  largeImage: ImageSlot;
  smallImage: ImageSlot;
  timer: boolean;
  buttons: PresenceButton[];
  /** What the compact member-list status shows. Defaults to `name`. */
  statusDisplay?: StatusDisplay;
}

export type ThemeName =
  | 'minimal'
  | 'developer'
  | 'focus'
  | 'playful'
  | 'chaos'
  | 'terminal'
  | 'shipper'
  | 'custom';

/**
 * Machine-readable activity keyword. Drives the small-image badge via the
 * `status-{state}` asset key. `activity` (below) is the human-facing text.
 */
export type ActivityState =
  | 'idle'
  | 'thinking'
  | 'editing'
  | 'running'
  | 'searching'
  | 'browsing'
  | 'delegating'
  | 'waiting';

/** The user's config file: pick a theme, optionally override slots. */
export interface UserConfig {
  theme: ThemeName;
  overrides?: Partial<Theme>;
  /** Override the Discord application id (defaults to the shared "vibecoder" app). */
  clientId?: string;
}

/** One live Claude Code session, written by the hook provider. */
export interface SessionMarker {
  id: string;
  startedAt: number; // epoch ms
  heartbeat: number; // epoch ms
  cwd?: string;
  transcriptPath?: string; // side-channel the daemon reads for model/tokens/branch
  project?: string;
  branch?: string;
  model?: string;
  state?: ActivityState; // machine keyword (badge)
  activity?: string; // human-facing text
  file?: string;
  tokens?: number;
  cost?: number;
}

/** Live sessions merged into a single view the daemon renders. */
export interface AggregatedState {
  sessionCount: number;
  startedAt: number; // earliest start across live sessions
  transcriptPath?: string; // current session's transcript, for daemon enrichment
  project?: string;
  branch?: string;
  model?: string;
  state?: ActivityState;
  activity?: string;
  file?: string;
  tokens?: number;
  cost?: number;
  /** Claude plan 5-hour rolling window utilization (0–100). */
  usage5h?: number;
  /** Claude plan weekly window utilization (0–100). */
  usageWeekly?: number;
}

/** What the Discord layer sends, mapped onto Discord's fixed slots. */
export interface PresencePayload {
  details?: string;
  state?: string;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp?: number;
  buttons?: PresenceButton[];
  /** Discord StatusDisplayType: 0 name, 1 state, 2 details. Omit for default. */
  statusDisplayType?: number;
}
