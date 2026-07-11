# Contributing

Thanks for your interest in improving vibecoder! This guide covers local setup,
the quality gate, and how to add a new theme.

## Prerequisites

- **Node.js 18+**
- **npm** (the repo uses `package-lock.json`)
- The **Discord desktop app** if you want to see Rich Presence end-to-end
  (browser Discord can't display it)

## Setup

```sh
git clone https://github.com/<your-fork>/vibecoder-discord-presence.git
cd vibecoder-discord-presence
npm install
```

## Development loop

```sh
npm run dev        # run the CLI from source (e.g. `npm run dev -- config`)
npm run build      # bundle to dist/ (tsup)
```

To exercise it against a real Claude Code + Discord session, build first, then
point the hooks at your build:

```sh
npm run build
node dist/vdp.js install
node dist/vdp.js status     # check hook / daemon / Discord state
node dist/vdp.js uninstall  # clean up when done
```

## Quality gate

Please make sure all of these pass before opening a PR — CI runs the same set:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run format` applies Prettier if your editor doesn't.

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `ci:`, `perf:`. Keep
each commit focused, and prefer several small, coherent commits over one large
one.

## Pull requests

- Keep each PR to a single, coherent change — it's much easier to review and merge.
- Include tests for new logic where it makes sense.
- Update the README if you change user-facing behavior.
- Describe what changed and why; screenshots help for anything visual.

## Adding a theme

A theme is a bundle of template strings plus the Discord image assets it uses.
Themes live in [`src/themes/index.ts`](src/themes/index.ts).

1. **Add your theme** to the `THEMES` record. Each slot (`details`, `state`,
   image tooltips) is a template; available placeholders are filled from the
   live session:

   ```
   {project} {branch} {model} {activity} {file} {tokens} {cost}
   {elapsed} {sessionCount} {state} {usage5h} {usageWeekly} {usage}
   ```

   Full catalog: [`src/core/placeholders.ts`](src/core/placeholders.ts).
   Put `{usage}` alone on a line for a dedicated `usage: 5h … · wk …` row
   (preferred over hardcoding the `usage:` prefix around empty tokens).

   Empty placeholders collapse gracefully, so a theme degrades cleanly when a
   field isn't available yet. The same placeholders work in **custom** themes
   via `vdp config` (preview sample data includes plan usage).

2. **Register the name** in the `ThemeName` union in
   [`src/types.ts`](src/types.ts) so it type-checks, and make sure it's
   selectable in the `vdp config` picker
   ([`src/commands/config.ts`](src/commands/config.ts)).

3. **Stay within the existing image assets.** Image keys (`largeImage.key`,
   `smallImage.key`) must reference art already uploaded to the Discord
   application — currently `logo`, `focus`, and the `status-<state>` family
   (e.g. `status-editing`). **Discord renders nothing — silently, with no
   error — for an unknown key**, and contributors can't upload new assets to
   the shared app, so don't introduce new image keys.

4. **Mind the limits.** Discord shows at most two text lines, two images, and
   two buttons, and truncates long lines (~128 chars). Keep it tidy.

5. **Respect privacy where it fits.** The default `minimal` theme reveals
   nothing about your work. Consider offering a privacy-safe variant that omits
   `{project}`, `{branch}`, and `{file}`.

6. **Preview it** with `npm run dev -- config` (pick your theme to see a live
   ASCII render of the card), and add a test if your theme exercises new
   rendering behavior.

## Questions

Open an issue — a bug report or feature request template will guide you, or pick
a blank issue for anything else.
