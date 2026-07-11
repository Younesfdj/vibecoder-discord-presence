import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, THEME_MANIFEST, DEFAULT_THEME } from '../src/themes/index';
import { findUnknownAssetKeys, validateThemeAssets } from '../src/themes/assets';

// Asset-key guard: a theme that references an image key the Discord app doesn't
// provide renders a silent blank image. Every built-in theme must stay within
// the known-good set — this is the regression guard that makes that impossible.
test('every built-in theme references only known Discord asset keys', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    const unknown = findUnknownAssetKeys(theme);
    assert.deepEqual(
      unknown,
      [],
      `theme "${name}" references unknown asset key(s): ${unknown.join(', ')}`,
    );
    assert.equal(validateThemeAssets(theme), true, `theme "${name}" should validate`);
  }
});

test('findUnknownAssetKeys flags an unknown key', () => {
  const broken = { ...THEMES.minimal!, largeImage: { key: 'not-a-real-asset', text: '' } };
  assert.deepEqual(findUnknownAssetKeys(broken), ['not-a-real-asset']);
  assert.equal(validateThemeAssets(broken), false);
});

test('status-{state} expands to the full activity-state family and all are valid', () => {
  // terminal uses `status-{state}`; it must validate, proving the family is allowed.
  assert.equal(validateThemeAssets(THEMES.terminal!), true);
});

test('empty image keys are allowed (no badge / no large image)', () => {
  assert.equal(validateThemeAssets(THEMES.minimal!), true);
  assert.equal(validateThemeAssets(THEMES.developer!), true);
});

// Registry / picker parity: the manifest is the single source of truth. Assert
// it can't drift from THEMES — every manifest entry has a definition and vice
// versa — so the config picker (derived from the manifest) always offers exactly
// the themes that exist.
test('every manifest entry has a matching THEMES definition', () => {
  for (const entry of THEME_MANIFEST) {
    assert.ok(THEMES[entry.name], `manifest lists "${entry.name}" but THEMES has no such theme`);
    assert.ok(
      entry.description.trim().length > 0,
      `manifest entry "${entry.name}" needs a description`,
    );
  }
});

test('every built-in theme is listed in the manifest', () => {
  const manifestNames = new Set<string>(THEME_MANIFEST.map((e) => e.name));
  for (const name of Object.keys(THEMES)) {
    assert.ok(manifestNames.has(name), `THEMES has "${name}" but the manifest omits it`);
  }
});

test('manifest has no duplicate theme names', () => {
  const names = THEME_MANIFEST.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, 'duplicate theme names in manifest');
});

test('the default theme exists and is in the manifest', () => {
  assert.ok(THEMES[DEFAULT_THEME], 'DEFAULT_THEME has no definition');
  assert.ok(
    THEME_MANIFEST.some((e) => e.name === DEFAULT_THEME),
    'DEFAULT_THEME not in manifest',
  );
});

test('the two new themes are present', () => {
  assert.ok(THEMES.terminal, 'terminal theme missing');
  assert.ok(THEMES.shipper, 'shipper theme missing');
});
