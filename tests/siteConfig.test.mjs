import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const siteConfigPath = path.resolve(currentDir, '../extension/siteConfig.js');
const siteConfigSource = fs.readFileSync(siteConfigPath, 'utf8');

function loadSiteConfig() {
  const sandbox = {};
  const context = vm.createContext(sandbox);
  vm.runInContext(siteConfigSource, context, { filename: 'siteConfig.js' });
  return { api: context.ColorfulSiteConfig, context };
}

test('siteConfig.js is idempotent across repeated injections in the same context', () => {
  const { api, context } = loadSiteConfig();
  assert.ok(api);
  assert.doesNotThrow(() => {
    vm.runInContext(siteConfigSource, context, { filename: 'siteConfig.js' });
  });
  assert.equal(typeof context.ColorfulSiteConfig.resolveConfigWithMeta, 'function');
});

test('normalizeHostname trims whitespace, lowercases, strips trailing dots, and preserves bracketed IPv6', () => {
  const { api } = loadSiteConfig();
  assert.equal(api.normalizeHostname('  Docs.Example.COM... '), 'docs.example.com');
  assert.equal(api.normalizeHostname('[::1]'), '[::1]');
  assert.equal(api.normalizeHostname(''), '');
  assert.equal(api.normalizeHostname(null), '');
});

test('isIPv4 and isIPv6 validate network literals accurately', () => {
  const { api } = loadSiteConfig();
  assert.equal(api.isIPv4('127.0.0.1'), true);
  assert.equal(api.isIPv4('192.168.1.255'), true);
  assert.equal(api.isIPv4('256.0.0.1'), false);
  assert.equal(api.isIPv4('example.com'), false);
  assert.equal(api.isIPv6('[::1]'), true);
  assert.equal(api.isIPv6('2001:db8::1'), true);
  assert.equal(api.isIPv6('127.0.0.1'), false);
});

test('getAncestorHostnames avoids splitting IPv4/IPv6/localhost and skips common 2-label public suffixes', () => {
  const { api } = loadSiteConfig();
  assert.deepEqual(api.getAncestorHostnames('a.b.example.com'), ['b.example.com', 'example.com']);
  assert.deepEqual(api.getAncestorHostnames('127.0.0.1'), []);
  assert.deepEqual(api.getAncestorHostnames('[::1]'), []);
  assert.deepEqual(api.getAncestorHostnames('localhost'), []);
  assert.deepEqual(api.getAncestorHostnames('app.service.co.uk'), ['service.co.uk']);
  assert.deepEqual(api.getAncestorHostnames('docs.team.com.cn'), ['team.com.cn']);
});

test('Notebook alias helpers map roots and subdomains symmetrically without false suffix matches', () => {
  const { api } = loadSiteConfig();
  assert.equal(api.getAliasHostname('notebook.google'), 'notebook.google.com');
  assert.equal(api.getAliasHostname('notebook.google.com'), 'notebook.google');
  assert.equal(api.getAliasHostname('foo.notebook.google'), 'foo.notebook.google.com');
  assert.equal(api.getAliasHostname('foo.notebook.google.com'), 'foo.notebook.google');
  assert.equal(api.getAliasHostname('notebook.google.evil'), null);
  assert.deepEqual(api.getWriteKeys('foo.notebook.google'), ['foo.notebook.google', 'foo.notebook.google.com']);
  assert.deepEqual(api.getWriteKeys('docs.example.com'), ['docs.example.com']);
});

test('resolveConfigWithMeta reports exact override, alias, inherited, and inheritedFallback accurately', () => {
  const { api } = loadSiteConfig();
  const stored = {
    'example.com': { enabled: true, themeMode: 'system', darkActiveColor: '#112233' },
    'app.example.com': { enabled: false, themeMode: 'fixed', activeColor: '#445566' },
    'notebook.google.com': { enabled: true, themeMode: 'system' }
  };

  const exactWithParent = api.resolveConfigWithMeta('app.example.com', stored);
  assert.equal(exactWithParent.source, 'exact');
  assert.equal(exactWithParent.matchedKey, 'app.example.com');
  assert.equal(exactWithParent.hasExactOverride, true);
  assert.equal(exactWithParent.config.enabled, false);
  assert.equal(exactWithParent.inheritedFallback?.matchedKey, 'example.com');

  const inherited = api.resolveConfigWithMeta('docs.example.com', stored);
  assert.equal(inherited.source, 'inherited');
  assert.equal(inherited.matchedKey, 'example.com');
  assert.equal(inherited.hasExactOverride, false);
  assert.equal(inherited.inheritedFallback, null);

  const aliasMatch = api.resolveConfigWithMeta('notebook.google', stored);
  assert.equal(aliasMatch.source, 'alias');
  assert.equal(aliasMatch.matchedKey, 'notebook.google.com');
  assert.equal(aliasMatch.hasExactOverride, true);

  const missing = api.resolveConfigWithMeta('notexample.com', stored);
  assert.equal(missing.source, 'none');
  assert.equal(missing.config, null);
  assert.equal(missing.hasExactOverride, false);
});

test('normalizeColor and normalizeConfig sanitize malformed values and preserve legacy fixed mode', () => {
  const { api } = loadSiteConfig();
  assert.equal(api.normalizeColor('#abc', '#000000'), '#AABBCC');
  assert.equal(api.normalizeColor('  #12af34 '), '#12AF34');
  assert.equal(api.normalizeColor('not-a-color', '#202124'), '#202124');
  assert.equal(api.normalizeColor(null, 'bad-fallback'), '#FFFFFF');

  const legacy = api.normalizeConfig({ enabled: true, color: '#336699' });
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.windowStateEnabled, false);
  assert.equal(legacy.themeMode, 'fixed');
  assert.equal(legacy.activeColor, '#336699');
  assert.equal(legacy.inactiveColor, '#336699');
  assert.equal(legacy.lightActiveColor, '#336699');
  assert.equal(legacy.darkActiveColor, '#336699');

  const empty = api.normalizeConfig(null);
  assert.equal(empty.enabled, false);
  assert.equal(empty.themeMode, 'system');
  assert.equal(empty.darkActiveColor, '#202124');
});

test('WCAG contrast calculation and preset matching work across light and dark palettes', () => {
  const { api } = loadSiteConfig();
  const onWhite = api.pickTitleForeground('#FFFFFF');
  assert.equal(onWhite.color, '#111827');
  assert.equal(onWhite.grade, 'AAA');
  assert.equal(onWhite.isDarkBackground, false);
  assert.ok(onWhite.ratio > 15);

  const onDark = api.pickTitleForeground('#0F172A');
  assert.equal(onDark.color, '#F8FAFC');
  assert.equal(onDark.grade, 'AAA');
  assert.equal(onDark.isDarkBackground, true);

  assert.equal(api.PRESETS.length, 6);
  for (const preset of api.PRESETS) {
    for (const colorValue of Object.values(preset.colors)) {
      assert.match(colorValue, /^#[0-9A-F]{6}$/);
    }
  }

  const midnight = api.PRESETS.find((item) => item.id === 'midnight-indigo');
  assert.equal(api.findMatchingPreset({ themeMode: 'system', ...midnight.colors })?.id, 'midnight-indigo');
  assert.equal(api.findMatchingPreset({ themeMode: 'fixed', activeColor: '#123456', inactiveColor: '#654321' }), null);
});

test('getEnabledRegistrationHosts and getStoredSiteEntries filter invalid hosts and deduplicate aliases/subdomains', () => {
  const { api } = loadSiteConfig();
  assert.equal(api.isValidRegistrationHost('localhost'), true);
  assert.equal(api.isValidRegistrationHost('127.0.0.1'), true);
  assert.equal(api.isValidRegistrationHost('[::1]'), false);
  assert.equal(api.isValidRegistrationHost('intranet'), false);
  assert.equal(api.isValidRegistrationHost('co.uk'), false);

  const stored = {
    'example.com': { enabled: true },
    'docs.example.com': { enabled: true },
    'disabled.org': { enabled: false },
    'notebook.google': { enabled: true },
    'notebook.google.com': { enabled: true },
    'co.uk': { enabled: true },
    '[::1]': { enabled: true }
  };

  assert.deepEqual(
    api.getEnabledRegistrationHosts(stored),
    ['example.com', 'notebook.google', 'notebook.google.com']
  );

  const entries = api.getStoredSiteEntries(stored);
  const notebookEntries = entries.filter((entry) => entry.hostname.startsWith('notebook.google'));
  assert.equal(notebookEntries.length, 1);
  assert.deepEqual(notebookEntries[0].removeKeys, ['notebook.google', 'notebook.google.com']);
  assert.equal(entries.some((entry) => entry.hostname === 'co.uk'), false);
});
