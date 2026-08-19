// config.test.js
//
// The whole point of src/config.js is PRECEDENCE, so most of this file is about which
// layer wins, not about individual values. Every test builds its own temp directory and
// passes an explicit `env` object rather than touching process.env, so the suite is
// order-independent and does not care what the developer's shell happens to export.
//
// `searchUp: false` is used wherever a test means "there is no config file": config.js
// walks UP from cwd by default, and a temp dir under /tmp could in principle sit below
// someone's stray replayright.config.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  configFromCliArgs,
  defaults,
  resolveOutputPath,
  resolveSitesDir,
  resolveOutputFormat,
  envNameFor,
  CONFIG_FILENAME,
  TYPES,
} = require('../src/config');

const {
  REPEAT_DEFAULT_TIMES,
  RESOLVE_WAIT_MS,
  SETTLE_TIMEOUT_MS,
  HEADLESS_PROBE_TIMEOUT_MS,
} = require('../src/constants');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-config-test-'));
}

function writeConfig(dir, object) {
  const file = path.join(dir, CONFIG_FILENAME);
  fs.writeFileSync(file, typeof object === 'string' ? object : JSON.stringify(object, null, 2));
  return file;
}

// The documented default shape, written out longhand rather than imported, so that a
// change to DEFAULTS has to be made deliberately in two places.
const DOCUMENTED_DEFAULTS = {
  sitesDir: './sites',
  browser: {
    channel: null,
    args: [],
    viewport: null,
    userAgent: null,
    locale: null,
    timezoneId: null,
    proxy: null,
  },
  display: { mode: 'auto', screen: '1920x1080x24' },
  profile: { persist: true, clearTracking: false, dir: null },
  timeouts: { resolveWaitMs: 8000, settleMs: 10000, probeMs: 10000 },
  repeat: { defaultTimes: 5, maxTimes: 50 },
  output: { path: 'sites/{id}/output.csv', format: 'auto' },
  log: { format: 'text' },
};

// ---------------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------------

test('defaults alone produce the documented shape', () => {
  const dir = tmpDir();
  const config = loadConfig({ cwd: dir, env: {}, searchUp: false });
  assert.deepStrictEqual(config, DOCUMENTED_DEFAULTS);
});

test('the default timeouts and repeat count come from constants.js, not a second copy', () => {
  const config = defaults();
  assert.strictEqual(config.timeouts.resolveWaitMs, RESOLVE_WAIT_MS);
  assert.strictEqual(config.timeouts.settleMs, SETTLE_TIMEOUT_MS);
  assert.strictEqual(config.timeouts.probeMs, HEADLESS_PROBE_TIMEOUT_MS);
  assert.strictEqual(config.repeat.defaultTimes, REPEAT_DEFAULT_TIMES);
});

test('defaults() hands back a fresh copy each time, so a caller cannot poison the module', () => {
  const first = defaults();
  first.timeouts.settleMs = 1;
  first.browser.args.push('--boom');
  const second = defaults();
  assert.strictEqual(second.timeouts.settleMs, SETTLE_TIMEOUT_MS);
  assert.deepStrictEqual(second.browser.args, []);
});

test('__meta is present but non-enumerable, so the config still deep-equals a plain object', () => {
  const dir = tmpDir();
  const config = loadConfig({ cwd: dir, env: {}, searchUp: false });
  assert.deepStrictEqual(config.__meta.layers, ['defaults']);
  assert.strictEqual(config.__meta.configPath, null);
  assert.ok(!Object.keys(config).includes('__meta'));
  assert.ok(!JSON.parse(JSON.stringify(config)).__meta);
});

// ---------------------------------------------------------------------------------
// layer 2: replayright.config.json
// ---------------------------------------------------------------------------------

test('a missing replayright.config.json is not an error - defaults still load', () => {
  const dir = tmpDir();
  assert.ok(!fs.existsSync(path.join(dir, CONFIG_FILENAME)));
  const config = loadConfig({ cwd: dir, env: {}, searchUp: false });
  assert.deepStrictEqual(config, DOCUMENTED_DEFAULTS);
});

test('a config file overriding one nested key leaves its siblings alone (deep merge)', () => {
  const dir = tmpDir();
  writeConfig(dir, { timeouts: { settleMs: 20000 } });
  const config = loadConfig({ cwd: dir, env: {}, searchUp: false });

  assert.strictEqual(config.timeouts.settleMs, 20000);
  // The proof: the two siblings the file said nothing about are untouched...
  assert.strictEqual(config.timeouts.resolveWaitMs, RESOLVE_WAIT_MS);
  assert.strictEqual(config.timeouts.probeMs, HEADLESS_PROBE_TIMEOUT_MS);
  // ...and so is every other top-level section.
  assert.deepStrictEqual(config.display, DOCUMENTED_DEFAULTS.display);
  assert.deepStrictEqual(config.repeat, DOCUMENTED_DEFAULTS.repeat);
  assert.strictEqual(config.__meta.configPath, path.join(dir, CONFIG_FILENAME));
});

test('the config-file search walks up to a parent directory', () => {
  const root = tmpDir();
  writeConfig(root, { display: { screen: '800x600x24' } });
  const nested = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });

  const found = loadConfig({ cwd: nested, env: {} });
  assert.strictEqual(found.display.screen, '800x600x24');
  assert.strictEqual(found.__meta.configPath, path.join(root, CONFIG_FILENAME));

  // ...and does not, with searchUp disabled.
  const notFound = loadConfig({ cwd: nested, env: {}, searchUp: false });
  assert.strictEqual(notFound.display.screen, '1920x1080x24');
  assert.strictEqual(notFound.__meta.configPath, null);
});

test('the nearest config file wins over one further up', () => {
  const root = tmpDir();
  writeConfig(root, { display: { screen: '800x600x24' } });
  const nested = path.join(root, 'inner');
  fs.mkdirSync(nested);
  writeConfig(nested, { display: { screen: '640x480x24' } });

  const config = loadConfig({ cwd: nested, env: {} });
  assert.strictEqual(config.display.screen, '640x480x24');
});

test('a malformed replayright.config.json throws a clear, actionable error', () => {
  const dir = tmpDir();
  // Trailing comma - the single most common way a hand-edited JSON config breaks.
  writeConfig(dir, '{ "timeouts": { "settleMs": 20000, } }');
  assert.throws(
    () => loadConfig({ cwd: dir, env: {}, searchUp: false }),
    (err) => {
      assert.match(err.message, /not valid JSON/);
      // Names the file, so the user knows WHICH config broke...
      assert.ok(err.message.includes(path.join(dir, CONFIG_FILENAME)), 'error should name the offending file');
      // ...and says what a good one looks like.
      assert.match(err.message, /trailing commas/);
      return true;
    }
  );
});

test('a config file that is not a JSON object is rejected', () => {
  const dir = tmpDir();
  writeConfig(dir, '[1, 2, 3]');
  assert.throws(() => loadConfig({ cwd: dir, env: {}, searchUp: false }), /must contain a JSON object/);
});

test('an unknown key in the config file throws and lists the valid keys', () => {
  const dir = tmpDir();
  writeConfig(dir, { timeouts: { settleMS: 20000 } });
  assert.throws(
    () => loadConfig({ cwd: dir, env: {}, searchUp: false }),
    (err) => {
      assert.match(err.message, /unknown config key "timeouts\.settleMS"/);
      assert.match(err.message, /resolveWaitMs/);
      return true;
    }
  );
});

test('an explicitly named config file that does not exist IS an error', () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: {}, configPath: 'nope.json' }),
    /Config file not found/
  );
  assert.throws(
    () => loadConfig({ cwd: dir, env: { REPLAYRIGHT_CONFIG_PATH: 'nope.json' } }),
    /REPLAYRIGHT_CONFIG_PATH/
  );
});

test('REPLAYRIGHT_CONFIG_PATH points at a file directly and skips the search', () => {
  const dir = tmpDir();
  const elsewhere = path.join(dir, 'custom.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ log: { format: 'json' } }));
  writeConfig(dir, { log: { format: 'text' } });

  const config = loadConfig({ cwd: dir, env: { REPLAYRIGHT_CONFIG_PATH: elsewhere } });
  assert.strictEqual(config.log.format, 'json');
  assert.strictEqual(config.__meta.configPath, elsewhere);
});

// ---------------------------------------------------------------------------------
// layer 3: environment
// ---------------------------------------------------------------------------------

test('env var names are derived from the config path, one per leaf', () => {
  assert.strictEqual(envNameFor('timeouts.settleMs'), 'REPLAYRIGHT_TIMEOUTS_SETTLE_MS');
  assert.strictEqual(envNameFor('display.mode'), 'REPLAYRIGHT_DISPLAY_MODE');
  assert.strictEqual(envNameFor('browser.userAgent'), 'REPLAYRIGHT_BROWSER_USER_AGENT');
  assert.strictEqual(envNameFor('sitesDir'), 'REPLAYRIGHT_SITES_DIR');
  assert.strictEqual(envNameFor('repeat.defaultTimes'), 'REPLAYRIGHT_REPEAT_DEFAULT_TIMES');
  // Every leaf in the schema has one, and they are all distinct (config.js asserts the
  // second part at load time; this makes the guarantee visible).
  const names = new Set(Object.keys(TYPES).map(envNameFor));
  assert.strictEqual(names.size, Object.keys(TYPES).length);
});

test('env overrides apply, and take precedence over the config file', () => {
  const dir = tmpDir();
  writeConfig(dir, { timeouts: { settleMs: 20000 }, display: { screen: '800x600x24' } });

  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '30000' },
  });

  assert.strictEqual(config.timeouts.settleMs, 30000, 'env beats the config file');
  assert.strictEqual(config.display.screen, '800x600x24', 'and does not disturb the rest of the file');
  assert.deepStrictEqual(config.__meta.layers, ['defaults', 'file', 'env']);
});

test('env values are coerced to the schema type, not left as strings', () => {
  const dir = tmpDir();
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: {
      REPLAYRIGHT_TIMEOUTS_PROBE_MS: '2500',
      REPLAYRIGHT_PROFILE_PERSIST: 'false',
      REPLAYRIGHT_PROFILE_CLEAR_TRACKING: 'yes',
      REPLAYRIGHT_BROWSER_ARGS: '--no-sandbox,--disable-gpu',
      REPLAYRIGHT_BROWSER_VIEWPORT: '1280x720',
      REPLAYRIGHT_BROWSER_PROXY: '{"server":"http://127.0.0.1:8080"}',
      REPLAYRIGHT_BROWSER_CHANNEL: 'chrome',
    },
  });

  assert.strictEqual(config.timeouts.probeMs, 2500);
  assert.strictEqual(config.profile.persist, false);
  assert.strictEqual(config.profile.clearTracking, true);
  assert.deepStrictEqual(config.browser.args, ['--no-sandbox', '--disable-gpu']);
  assert.deepStrictEqual(config.browser.viewport, { width: 1280, height: 720 });
  assert.deepStrictEqual(config.browser.proxy, { server: 'http://127.0.0.1:8080' });
  assert.strictEqual(config.browser.channel, 'chrome');
});

test('a nullable key can be explicitly unset from the environment', () => {
  const dir = tmpDir();
  writeConfig(dir, { browser: { channel: 'chrome' } });
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: { REPLAYRIGHT_BROWSER_CHANNEL: 'null' },
  });
  assert.strictEqual(config.browser.channel, null);
});

test('a malformed env value throws and names the variable', () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: 'twenty' } }),
    /REPLAYRIGHT_TIMEOUTS_SETTLE_MS="twenty" is not a number/
  );
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: { REPLAYRIGHT_PROFILE_PERSIST: 'maybe' } }),
    /REPLAYRIGHT_PROFILE_PERSIST="maybe" is not a boolean/
  );
});

test('an unknown REPLAYRIGHT_* var warns instead of throwing - the environment is a shared namespace', () => {
  const dir = tmpDir();
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: { REPLAYRIGHT_VERSION: '1.2.3', REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '11000' },
  });
  assert.strictEqual(config.timeouts.settleMs, 11000);
  assert.strictEqual(config.__meta.warnings.length, 1);
  assert.match(config.__meta.warnings[0], /REPLAYRIGHT_VERSION/);
});

// ---------------------------------------------------------------------------------
// layer 4: flow.config
// ---------------------------------------------------------------------------------

test('flow.config overrides take precedence over env', () => {
  const dir = tmpDir();
  writeConfig(dir, { timeouts: { settleMs: 20000 } });
  const flow = {
    startUrl: 'https://example.com',
    steps: [],
    config: { timeouts: { settleMs: 40000 } },
  };

  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '30000' },
    flow,
  });

  assert.strictEqual(config.timeouts.settleMs, 40000);
  assert.deepStrictEqual(config.__meta.layers, ['defaults', 'file', 'env', 'flow']);
});

test('a flow with no config key is simply not a layer', () => {
  const dir = tmpDir();
  const config = loadConfig({ cwd: dir, searchUp: false, env: {}, flow: { steps: [] } });
  assert.deepStrictEqual(config, DOCUMENTED_DEFAULTS);
  assert.deepStrictEqual(config.__meta.layers, ['defaults']);
});

test('flowConfig passed directly wins over flow.config', () => {
  const dir = tmpDir();
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: {},
    flow: { config: { log: { format: 'text' } } },
    flowConfig: { log: { format: 'json' } },
  });
  assert.strictEqual(config.log.format, 'json');
});

test('an unknown key in flow.config throws, naming the flow as the source', () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: {}, flow: { config: { timeout: 1 } } }),
    (err) => {
      assert.match(err.message, /flow\.json "config"/);
      assert.match(err.message, /unknown config key "timeout"/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------------
// layer 5: CLI, and the full chain
// ---------------------------------------------------------------------------------

test('CLI overrides take precedence over everything', () => {
  const dir = tmpDir();
  writeConfig(dir, { display: { screen: '800x600x24' } });
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: { REPLAYRIGHT_DISPLAY_SCREEN: '1024x768x24' },
    flow: { config: { display: { screen: '1440x900x24' } } },
    cliArgs: { screen: '640x480x24' },
  });
  assert.strictEqual(config.display.screen, '640x480x24');
  assert.deepStrictEqual(config.__meta.layers, ['defaults', 'file', 'env', 'flow', 'cli']);
});

test('full precedence chain: the same key set at all four non-default layers, CLI wins', () => {
  const dir = tmpDir();
  writeConfig(dir, { timeouts: { settleMs: 20000 } });

  const layered = (extra) => loadConfig({
    cwd: dir,
    searchUp: false,
    env: {},
    ...extra,
  });

  // Peel the layers off one at a time; each removal exposes exactly the layer below.
  const all = layered({
    env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '30000' },
    flow: { config: { timeouts: { settleMs: 40000 } } },
    cliOverrides: { timeouts: { settleMs: 50000 } },
  });
  assert.strictEqual(all.timeouts.settleMs, 50000, 'CLI wins over flow, env and file');

  const noCli = layered({
    env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '30000' },
    flow: { config: { timeouts: { settleMs: 40000 } } },
  });
  assert.strictEqual(noCli.timeouts.settleMs, 40000, 'flow wins over env and file');

  const noFlow = layered({ env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '30000' } });
  assert.strictEqual(noFlow.timeouts.settleMs, 30000, 'env wins over file');

  const fileOnly = layered({});
  assert.strictEqual(fileOnly.timeouts.settleMs, 20000, 'file wins over defaults');

  const bare = loadConfig({ cwd: tmpDir(), env: {}, searchUp: false });
  assert.strictEqual(bare.timeouts.settleMs, SETTLE_TIMEOUT_MS, 'and defaults are the floor');
});

test('cliOverrides is merged after cliArgs, so it wins', () => {
  const dir = tmpDir();
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: {},
    cliArgs: { screen: '640x480x24' },
    cliOverrides: { display: { screen: '320x240x24' } },
  });
  assert.strictEqual(config.display.screen, '320x240x24');
});

test('configFromCliArgs maps cli.js flags onto the config shape', () => {
  const patch = configFromCliArgs({
    display: ':50',
    screen: '640x480x24',
    out: '/tmp/rows.json',
    times: 3,
    clearTracking: true,
    disableDevShmUsage: true,
    disableGpu: false,
    noSandbox: true,
  });
  assert.strictEqual(patch.display.mode, ':50');
  assert.strictEqual(patch.display.screen, '640x480x24');
  assert.strictEqual(patch.output.path, '/tmp/rows.json');
  assert.strictEqual(patch.repeat.defaultTimes, 3);
  assert.strictEqual(patch.profile.clearTracking, true);
  assert.deepStrictEqual(patch.browser.args, ['--disable-dev-shm-usage', '--no-sandbox']);
});

test('flags that were not passed do not clobber lower layers', () => {
  const dir = tmpDir();
  writeConfig(dir, {
    display: { mode: ':7', screen: '800x600x24' },
    profile: { clearTracking: true },
    output: { path: 'out/{id}.csv' },
    repeat: { defaultTimes: 9 },
    browser: { args: ['--mute-audio'] },
  });

  // Exactly what cli.js builds when the user typed no relevant flags at all: booleans
  // defaulted to false, everything else undefined.
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: {},
    cliArgs: {
      display: undefined,
      screen: undefined,
      out: undefined,
      times: undefined,
      clearTracking: false,
      disableDevShmUsage: false,
      disableGpu: false,
      noSandbox: false,
    },
  });

  assert.strictEqual(config.display.mode, ':7');
  assert.strictEqual(config.display.screen, '800x600x24');
  assert.strictEqual(config.profile.clearTracking, true);
  assert.strictEqual(config.output.path, 'out/{id}.csv');
  assert.strictEqual(config.repeat.defaultTimes, 9);
  assert.deepStrictEqual(config.browser.args, ['--mute-audio']);
});

// ---------------------------------------------------------------------------------
// merge semantics and validation
// ---------------------------------------------------------------------------------

test('arrays replace wholesale rather than concatenating across layers', () => {
  const dir = tmpDir();
  writeConfig(dir, { browser: { args: ['--mute-audio', '--foo'] } });
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: { REPLAYRIGHT_BROWSER_ARGS: '--no-sandbox' },
  });
  assert.deepStrictEqual(config.browser.args, ['--no-sandbox']);
});

test('an object-valued leaf (browser.proxy) is one value, not a sub-tree with known keys', () => {
  const dir = tmpDir();
  writeConfig(dir, { browser: { proxy: { server: 'http://p:1', username: 'u', password: 'p' } } });
  const config = loadConfig({ cwd: dir, searchUp: false, env: {} });
  assert.deepStrictEqual(config.browser.proxy, { server: 'http://p:1', username: 'u', password: 'p' });
});

test('a value of the wrong type is rejected after merging', () => {
  const dir = tmpDir();
  writeConfig(dir, { timeouts: { settleMs: 'soon' } });
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: {} }),
    /config value "timeouts.settleMs" must be a finite number/
  );
});

test('a closed-set value outside the set is rejected with the options listed', () => {
  const dir = tmpDir();
  writeConfig(dir, { output: { format: 'xlsx' } });
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: {} }),
    /must be one of auto, csv, json/
  );
});

test('display.mode is validated against the same grammar display.js accepts', () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: {}, cliOverrides: { display: { mode: 'yes' } } }),
    /must be "auto", "off", or ":<N>"/
  );
  for (const mode of ['auto', 'off', ':50']) {
    assert.strictEqual(loadConfig({ cwd: dir, searchUp: false, env: {}, cliOverrides: { display: { mode } } }).display.mode, mode);
  }
});

test('a non-nullable key cannot be nulled out', () => {
  const dir = tmpDir();
  writeConfig(dir, { display: { screen: null } });
  assert.throws(() => loadConfig({ cwd: dir, searchUp: false, env: {} }), /must not be null/);
});

test('repeat.defaultTimes above repeat.maxTimes is rejected with a way out', () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: {}, cliArgs: { times: 500 } }),
    /exceeds "repeat.maxTimes".*Raise repeat.maxTimes/s
  );
  // ...and raising the cap in the same run is enough.
  const config = loadConfig({
    cwd: dir,
    searchUp: false,
    env: {},
    cliArgs: { times: 500 },
    cliOverrides: { repeat: { maxTimes: 1000 } },
  });
  assert.strictEqual(config.repeat.defaultTimes, 500);
});

// ---------------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------------

test('resolveOutputPath substitutes {id} and reproduces cli.js\'s current default file', () => {
  const dir = tmpDir();
  const config = loadConfig({ cwd: dir, searchUp: false, env: {} });
  assert.strictEqual(resolveOutputPath(config, 'acme'), path.join(dir, 'sites', 'acme', 'output.csv'));
  assert.strictEqual(
    resolveOutputPath(config, 'acme', { baseDir: '/repo' }),
    path.join('/repo', 'sites', 'acme', 'output.csv')
  );
});

test('resolveOutputPath complains rather than writing to a literal "{id}" path', () => {
  const dir = tmpDir();
  const config = loadConfig({ cwd: dir, searchUp: false, env: {} });
  assert.throws(() => resolveOutputPath(config), /no site id was given/);
});

test('relative paths resolve against the config file\'s own directory, not the cwd', () => {
  const root = tmpDir();
  writeConfig(root, { sitesDir: './recordings' });
  const nested = path.join(root, 'deep', 'inside');
  fs.mkdirSync(nested, { recursive: true });

  const config = loadConfig({ cwd: nested, env: {} });
  assert.strictEqual(resolveSitesDir(config), path.join(root, 'recordings'));
});

test('resolveOutputFormat: "auto" defers to the extension, csv/json force it', () => {
  const dir = tmpDir();
  const auto = loadConfig({ cwd: dir, searchUp: false, env: {} });
  assert.strictEqual(resolveOutputFormat(auto, '/tmp/rows.json'), 'json');
  assert.strictEqual(resolveOutputFormat(auto, '/tmp/rows.csv'), 'csv');
  assert.strictEqual(resolveOutputFormat(auto, '/tmp/rows'), 'csv');

  const forced = loadConfig({ cwd: dir, searchUp: false, env: {}, cliOverrides: { output: { format: 'json' } } });
  assert.strictEqual(resolveOutputFormat(forced, '/tmp/rows.csv'), 'json');
});

// ---------------------------------------------------------------------------------
// the one thing that must never become configurable
// ---------------------------------------------------------------------------------

test('MARKER_PREFIX is not a config key - changing it would invalidate every recording', () => {
  const paths = Object.keys(TYPES).join(' ');
  assert.ok(!/marker/i.test(paths), 'no config key may expose the marker prefix');
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ cwd: dir, searchUp: false, env: {}, flowConfig: { markerPrefix: 'x:' } }),
    /unknown config key "markerPrefix"/
  );
});
