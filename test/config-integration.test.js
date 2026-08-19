// config-integration.test.js
//
// Phase 5.1 (src/config.js) proved precedence in isolation - a config file/env var/
// flow.config/CLI patch produces the right MERGED VALUE. This file proves the other half:
// that a value resolved by loadConfig() actually changes what src/interpret.js's runFlow
// does at runtime, once cli.js's threading (Phase 5.2) hands it down. Nothing here touches
// process.env directly; every test builds its own env object, same discipline as
// test/config.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { loadConfig } = require('../src/config');
const { runFlow } = require('../src/interpret');

const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-config-integration-'));
}

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

async function withPage(fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

// --- timeouts.settleMs, via an env var, actually bounds how long runFlow waits --------

test('REPLAYRIGHT_TIMEOUTS_SETTLE_MS shortens how long a stalled settle condition is '
  + 'waited on, instead of the constants.js default', async () => {
  await withPage(async (page) => {
    // No config file at all - this env var is the only override. `expand/index.html`'s
    // `#results` never changes (the repeat body is empty, nothing clicks anything), so
    // the settle check is guaranteed to run out its full timeout exactly once (after
    // iteration 0, not after the last iteration - see interpret.js's runRepeat).
    const config = loadConfig({
      cwd: tmpDir(),
      searchUp: false,
      env: { REPLAYRIGHT_TIMEOUTS_SETTLE_MS: '250' },
    });
    assert.strictEqual(config.timeouts.settleMs, 250, 'sanity: config.js resolved the override');

    const flow = {
      siteId: 'fixture-settle-config',
      startUrl: fixture('expand', 'index.html'),
      steps: [
        {
          kind: 'repeat',
          times: 2,
          // No settle.timeoutMs of its own - must fall back to ctx.opts.settleTimeoutMs,
          // which cli.js populates from config.timeouts.settleMs.
          settle: { selector: '#results' },
          body: [],
        },
      ],
    };

    const started = Date.now();
    const stats = await runFlow(flow, {
      page,
      minDelayMs: 0,
      maxDelayMs: 0,
      resolveWaitMs: 300,
      settleTimeoutMs: config.timeouts.settleMs,
    });
    const elapsed = Date.now() - started;

    // Well under constants.js's SETTLE_TIMEOUT_MS default (10000ms) - if settleTimeoutMs
    // were not actually threaded through, this run would take >= 10s instead of ~250ms.
    assert.ok(elapsed < 3000, `expected the run to respect the 250ms override, took ${elapsed}ms`);

    const settleWarning = stats.warnings.find((w) => w.type === 'settle-timeout');
    assert.ok(settleWarning, `expected a settle-timeout warning, got ${JSON.stringify(stats.warnings)}`);
    assert.match(settleWarning.message, /250ms/, 'the warning should name the configured timeout, not the constants.js default');
  });
});

// --- repeat.maxTimes, via a config file, caps iterations below what untilGone allows ---

const loadMoreFlow = {
  siteId: 'fixture-loadmore-maxtimes',
  startUrl: fixture('loadmore', 'index.html'),
  steps: [
    {
      kind: 'repeat',
      times: 5,
      untilGone: '#load-more',
      settle: { selector: '#results', timeoutMs: 3000 },
      body: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['li.card'],
          body: [
            { kind: 'action', scope: 'item', relativeSelectors: ['.card-link'], action: { name: 'click' } },
          ],
        },
        { kind: 'action', scope: 'page', selectors: ['#load-more'], action: { name: 'click' } },
      ],
    },
  ],
};

test('repeat.maxTimes from a replayright.config.json file caps a repeat block below '
  + 'what its own untilGone control would otherwise allow', async () => {
  await withPage(async (page) => {
    const dir = tmpDir();
    // defaultTimes must come down too - config.js validates defaultTimes <= maxTimes,
    // and this flow's own `times: 5` never consults defaultTimes anyway (it only backs
    // a repeat block that names no `times` of its own).
    fs.writeFileSync(
      path.join(dir, 'replayright.config.json'),
      JSON.stringify({ repeat: { maxTimes: 2, defaultTimes: 2 } })
    );
    const config = loadConfig({ cwd: dir, env: {} });
    assert.strictEqual(config.repeat.maxTimes, 2, 'sanity: the file was picked up');
    assert.strictEqual(config.__meta.layers.includes('file'), true);

    const stats = await runFlow(loadMoreFlow, {
      page,
      minDelayMs: 0,
      maxDelayMs: 0,
      resolveWaitMs: 300,
      repeatDefaultTimes: config.repeat.defaultTimes,
      repeatMaxTimes: config.repeat.maxTimes,
    });

    // Without the cap this flow runs 3 iterations (see test/interpret.test.js's "Load
    // More" case) - the #load-more button is still enabled after round 2, but
    // repeat.maxTimes stops the loop anyway.
    assert.strictEqual(stats.repeatIterations, 2, 'repeat.maxTimes should have capped the loop at 2');
    assert.strictEqual(stats.foreachIterations, 6, '2 rounds of 3 items each');
  });
});

// --- the default config (no file, no env, no flow.config) changes nothing -------------

test('a bare loadConfig() (no file/env/flow.config) reproduces exactly today\'s '
  + 'unbounded-by-maxTimes behaviour, because repeat.maxTimes defaults to constants.js '
  + 'headroom no real flow hits', async () => {
  await withPage(async (page) => {
    const config = loadConfig({ cwd: tmpDir(), env: {}, searchUp: false });
    assert.strictEqual(config.repeat.maxTimes, 50, 'sanity: this is the documented default, not a special test value');

    const stats = await runFlow(loadMoreFlow, {
      page,
      minDelayMs: 0,
      maxDelayMs: 0,
      resolveWaitMs: 300,
      repeatDefaultTimes: config.repeat.defaultTimes,
      repeatMaxTimes: config.repeat.maxTimes,
    });

    // Same 3 iterations as running with no config awareness at all (test/interpret.test.js) -
    // the default maxTimes of 50 never engages for a loop this short.
    assert.strictEqual(stats.repeatIterations, 3);
    assert.strictEqual(stats.foreachIterations, 9);
  });
});

// --- a runFlow() caller that knows nothing about config.js is completely unaffected ----

test('runFlow() called exactly as every pre-Phase-5.2 test calls it (no settleTimeoutMs/'
  + 'repeatDefaultTimes/repeatMaxTimes options) behaves identically to before this phase', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(loadMoreFlow, { page, minDelayMs: 0, maxDelayMs: 0, resolveWaitMs: 300 });
    assert.strictEqual(stats.repeatIterations, 3, 'HARD_LOOP_CEILING alone still bounds it, exactly as before config.js existed');
    assert.strictEqual(stats.foreachIterations, 9);
    assert.deepStrictEqual(stats.errors, []);
  });
});
