/**
 * `vdp config`
 *
 * Interactive presence customizer. Pick a theme and (optionally) edit every
 * slot — details, state, images, timer, buttons, compact-status mode — with a
 * live ASCII preview of the resulting Discord card. Saves to config.json, which
 * the daemon hot-reads, so changes hit your live card within a tick.
 *
 * Flags:
 *   --show    print the current config + preview and exit
 *   --reset   restore the default (privacy-safe `minimal`) theme
 *
 * The prompt library is imported lazily (this file is only loaded for the
 * `config` command) so it never weighs on the hook or daemon paths.
 */
import { Separator, confirm, input, select } from '@inquirer/prompts';
import { configPath } from '../core/paths';
import { DEFAULT_CONFIG, readUserConfig, resolveTheme, saveUserConfig } from '../core/config';
import { renderPresence } from '../core/presence';
import { THEMES, THEME_MANIFEST } from '../themes/index';
import { isProcessAlive, readLock } from '../core/daemon-state';
import { ui } from '../ui';
import type { AggregatedState, PresenceButton, StatusDisplay, Theme, UserConfig } from '../types';

const APP_NAME = 'ClaudeCode'; // the registered Discord application name (the bold headline)

/** Sample state used to render the preview so users see realistic text. */
function sampleState(now: number): AggregatedState {
  return {
    sessionCount: 1,
    startedAt: now - 83_000, // ~1m 23s ago
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
  };
}

function box(lines: string[], title: string): string {
  // Width is computed from RAW (uncolored) lengths; color is applied only to the
  // border/title afterwards so the alignment math is never thrown off by the
  // invisible ANSI escape codes.
  const width = Math.max(title.length + 2, ...lines.map((l) => l.length)) + 2;
  const top =
    ui.dim('┌─ ') +
    ui.title(title) +
    ui.dim(` ${'─'.repeat(Math.max(0, width - title.length - 3))}┐`);
  const body = lines.map((l) => `${ui.dim('│')} ${l.padEnd(width - 1)}${ui.dim('│')}`);
  const bottom = ui.dim(`└${'─'.repeat(width + 1)}┘`);
  return [top, ...body, bottom].join('\n');
}

/** Render an ASCII mock of the Discord card for a theme. */
function previewCard(theme: Theme): string {
  const now = Date.now();
  const p = renderPresence(theme, sampleState(now), now);

  const lines: string[] = [];
  lines.push(`icon:  ${p.largeImageKey ?? '(none)'}`);
  lines.push('');
  lines.push(APP_NAME);
  if (p.details) lines.push(p.details);
  if (p.state) lines.push(p.state);
  if (p.startTimestamp) lines.push('elapsed 01:23');
  if (p.smallImageKey)
    lines.push(`badge: ${p.smallImageKey}${p.smallImageText ? ` (${p.smallImageText})` : ''}`);
  if (p.buttons?.length) lines.push(p.buttons.map((b) => `[ ${b.label} ]`).join(' '));

  // Compact (member-list) line: 'name' keeps the "Playing <app>" form; the other
  // modes replace it with the chosen line's text (no "Playing" prefix).
  const compact =
    p.statusDisplayType === 1
      ? p.state || `Playing ${APP_NAME}`
      : p.statusDisplayType === 2
        ? p.details || `Playing ${APP_NAME}`
        : `Playing ${APP_NAME}`;

  return `${box(lines, 'Discord card preview')}\n  ${ui.dim('member list shows:')} ${ui.accent(compact)}`;
}

/** Truncate a value for compact display in a menu row. */
function short(s: string, max = 30): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || '(empty)';
}

/** Menu row: a left-aligned label + the field's current value in dim brackets. */
function row(label: string, value: string): string {
  return `${label.padEnd(28)} ${ui.dim(`[${value}]`)}`;
}

function editInput(message: string, current: string): Promise<string> {
  return input({ message, default: current, prefill: 'editable' });
}

/** Sub-editor for the (up to two) buttons. */
async function editButtons(currentButtons: PresenceButton[]): Promise<PresenceButton[]> {
  const buttons: PresenceButton[] = [];
  let addMore = await confirm({
    message: 'Add a button? (max 2)',
    default: currentButtons.length > 0,
  });
  while (addMore && buttons.length < 2) {
    const i = buttons.length;
    const label = await editInput(`Button ${i + 1} label:`, currentButtons[i]?.label ?? '');
    const url = await input({
      message: `Button ${i + 1} URL:`,
      default: currentButtons[i]?.url ?? '',
      prefill: 'editable',
      validate: (v) =>
        v.trim() === '' || /^https?:\/\//.test(v.trim()) || 'Must start with http(s)://',
    });
    if (label.trim() && url.trim()) buttons.push({ label: label.trim(), url: url.trim() });
    addMore =
      buttons.length < 2 ? await confirm({ message: 'Add another?', default: false }) : false;
  }
  return buttons;
}

/**
 * Menu-driven theme editor. Shows the live card, then a field list (each labeled
 * with which part of the card it maps to + its current value). Pick one field to
 * edit it and return to the menu; pick "Save & exit" to submit. Seeded from
 * `start`, so re-editing a saved custom theme loads its current values.
 *
 * Returns the edited theme, or null if the user discards.
 */
async function editThemeMenu(start: Theme): Promise<Theme | null> {
  const t: Theme = structuredClone(start);
  for (;;) {
    console.log(`\n${previewCard(t)}\n`);
    const choice = await select({
      message: 'Pick a field to edit, or save:',
      choices: [
        { name: row('Details — top line', short(t.details)), value: 'details' },
        { name: row('State — second line', short(t.state)), value: 'state' },
        { name: row('Timer — elapsed clock', t.timer ? 'on' : 'off'), value: 'timer' },
        { name: row('Large image — big icon', t.largeImage.key), value: 'large' },
        { name: row('Small badge — corner', t.smallImage.key), value: 'small' },
        { name: row('Buttons', `${t.buttons.length} set`), value: 'buttons' },
        { name: row('Compact status — member list', t.statusDisplay ?? 'name'), value: 'status' },
        new Separator(),
        { name: ui.ok('✓ Save & exit'), value: '__save' },
        { name: ui.warn('✗ Discard changes'), value: '__cancel' },
      ],
    });

    switch (choice) {
      case '__save':
        return t;
      case '__cancel':
        return null;
      case 'details':
        t.details = await editInput('Details (top line):', t.details);
        break;
      case 'state':
        t.state = await editInput('State (second line):', t.state);
        break;
      case 'timer':
        t.timer = await confirm({ message: 'Show the elapsed timer?', default: t.timer });
        break;
      case 'large':
        t.largeImage = {
          key: await editInput('Large image asset key:', t.largeImage.key),
          text: await editInput('Large image tooltip:', t.largeImage.text),
        };
        break;
      case 'small':
        t.smallImage = {
          key: await editInput('Small badge asset key:', t.smallImage.key),
          text: await editInput('Small badge tooltip:', t.smallImage.text),
        };
        break;
      case 'status':
        t.statusDisplay = (await select({
          message: 'Compact member-list status shows:',
          default: t.statusDisplay ?? 'name',
          loop: false,
          choices: [
            { name: 'App name ("Playing ClaudeCode")', value: 'name' },
            { name: 'The state line (your activity)', value: 'state' },
            { name: 'The details line', value: 'details' },
          ],
        })) as StatusDisplay;
        break;
      case 'buttons':
        t.buttons = await editButtons(t.buttons);
        break;
    }
  }
}

function applyNote(): string {
  const lock = readLock();
  if (lock && isProcessAlive(lock.pid)) {
    return 'Your live card will update within ~15s.';
  }
  return 'It will apply next time you start Claude Code with Discord open.';
}

export async function config(args: string[] = []): Promise<void> {
  const current = readUserConfig(configPath());

  if (args.includes('--show')) {
    console.log(`${ui.dim('theme:')} ${ui.accent(current.theme)}\n`);
    console.log(previewCard(resolveTheme(current)));
    return;
  }

  if (args.includes('--reset')) {
    saveUserConfig(DEFAULT_CONFIG);
    console.log(`${ui.check} reset to the default ${ui.accent('"minimal"')} theme.`);
    console.log(`  ${ui.dim(applyNote())}`);
    return;
  }

  try {
    console.log(
      `\n${ui.title('Customize your Discord presence')} ${ui.dim('— Ctrl+C to cancel')}\n`,
    );
    console.log(
      ui.dim(
        'Tip: text fields accept placeholders like {project} {branch} {model} {file} {activity} {elapsed}.\n',
      ),
    );

    // Built-in choices are derived from the theme manifest (single source of
    // truth); `custom` is appended as the always-available escape hatch.
    const nameWidth = Math.max(
      'custom'.length,
      ...THEME_MANIFEST.map((entry) => entry.name.length),
    );
    const themeChoices = [
      ...THEME_MANIFEST.map((entry) => ({
        name: `${entry.name.padEnd(nameWidth)} — ${entry.description}`,
        value: entry.name,
      })),
      { name: `${'custom'.padEnd(nameWidth)} — edit every field yourself`, value: 'custom' },
    ];

    const theme = await select({
      message: 'Pick a theme:',
      default: current.theme,
      loop: false,
      choices: themeChoices,
    });

    let next: UserConfig;
    if (theme === 'custom') {
      // Seed the editor from the saved custom theme so re-editing loads it.
      const edited = await editThemeMenu(resolveTheme(current));
      if (!edited) {
        console.log(ui.warn('Cancelled — no changes saved.'));
        return;
      }
      next = { theme: 'custom', overrides: edited, clientId: current.clientId };
    } else {
      console.log(`\n${previewCard(THEMES[theme]!)}\n`);
      const action = await select({
        message: `Use "${theme}" as-is, or customize it?`,
        loop: false,
        choices: [
          { name: `Use ${theme} as-is`, value: 'asis' },
          { name: 'Customize — edit fields, then save', value: 'edit' },
        ],
      });
      if (action === 'asis') {
        next = { theme: theme as UserConfig['theme'], overrides: {}, clientId: current.clientId };
      } else {
        const edited = await editThemeMenu(structuredClone(THEMES[theme]!));
        if (!edited) {
          console.log(ui.warn('Cancelled — no changes saved.'));
          return;
        }
        next = { theme: 'custom', overrides: edited, clientId: current.clientId };
      }
    }

    saveUserConfig(next);
    console.log(`\n${ui.check} ${ui.bold('Saved')} ${ui.dim(`to ${configPath()}`)}`);
    console.log(`  ${ui.dim(applyNote())}`);
  } catch (err) {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (err instanceof Error && err.name === 'ExitPromptError') {
      console.log(ui.warn('\nCancelled — no changes saved.'));
      return;
    }
    throw err;
  }
}
