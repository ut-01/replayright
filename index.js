// index.js - the programmatic API. `require('replayright')` gets record/verify/play/list/
// loadFlow as plain async functions that return data, so replayright can be embedded in
// another Node program instead of only driven from argv.
//
// This is NOT a thinner cli.js. src/cli.js owns argv parsing, --help text, process.exit
// and (Phase 6.1) structured run-report writing / --log=json; none of that belongs here.
// What DOES belong here is the orchestration cli.js's command functions do around the
// underlying modules (config resolution, display/Xvfb setup, output writing, run
// records) - a library caller needs the exact same plumbing a CLI invocation gets, just
// supplied via a function argument instead of a parsed flag. So the small handful of
// helpers below (runFlowOptionsFrom, writeConfiguredOutput, withPage, overrideTimes,
// resolveRequiresHeaded) are deliberate, parallel copies of cli.js's own - calling the
// same src/*.js modules cli.js calls, never cli.js itself. Keep them in sync by hand if
// cli.js's version of one of them changes; do not import cli.js to avoid the
// duplication, since cli.js also carries argv/--help/process.exit concerns a library
// must never pull in.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { recordSite, sitePaths: sitePathsFor, countSteps } = require('./src/record');
const { verifyFlow } = require('./src/verify');
const { runFlow } = require('./src/interpret');
const { emitFlow } = require('./src/emit');
const { toCsv, toJson } = require('./src/output');
const drift = require('./src/drift');
const { probeRequiresHeaded } = require('./src/headless-probe');
const { setLogFormat, setLogSiteId } = require('./src/log');
const { buildRunRecord, writeRunRecord } = require('./src/run-record');
const { CHROMIUM_ARGS } = require('./src/constants');
const { ensureDisplay } = require('./src/display');
const { loadConfig, resolveOutputPath, resolveOutputFormat, resolveSitesDir } = require('./src/config');

const REPO_ROOT = __dirname;

// --- shared orchestration helpers (parallel to cli.js's own, see the header comment) --

// Maps a library caller's options object onto loadConfig()'s `cliOverrides` - a
// CONFIG-SHAPED partial, unlike cli.js's `cliArgs` which is flag-shaped (and goes
// through configFromCliArgs() in src/config.js). There is no argv here, so options are
// named after the config keys they set directly (e.g. `browserArgs` for
// `browser.args`, `screen` for `display.screen`) rather than after CLI flags
// (`--disable-dev-shm-usage` etc.) - a caller who wants extra Chromium args just passes
// the array. `headless`/`requiresHeaded` are deliberately NOT mapped here, same as
// cli.js: they are decided per-call from the function's own option and flow.requiresHeaded,
// not through the config schema (see src/config.js's configFromCliArgs comment).
function configOverridesFrom(options = {}) {
  return {
    sitesDir: options.sitesDir,
    browser: {
      channel: options.browserChannel,
      args: options.browserArgs,
      viewport: options.viewport,
      userAgent: options.userAgent,
      locale: options.locale,
      timezoneId: options.timezoneId,
      proxy: options.proxy,
    },
    display: {
      mode: options.display,
      screen: options.screen,
    },
    profile: {
      persist: options.persist,
      clearTracking: options.clearTracking,
      dir: options.profileDir,
    },
    timeouts: {
      resolveWaitMs: options.resolveWaitMs,
      settleMs: options.settleMs,
      probeMs: options.probeMs,
    },
    repeat: {
      // `times` also seeds repeat.defaultTimes, same as cli.js's `--times` does via
      // configFromCliArgs - a repeat block with no `times` of its own then agrees with
      // the override too. The forced rewrite of every block that DOES name one is a
      // separate step (overrideTimes(), applied in verify()/play() below), not config's
      // job - see cli.js's comment on why that distinction matters.
      defaultTimes: options.times ?? options.repeatDefaultTimes,
      maxTimes: options.repeatMaxTimes,
    },
    output: {
      path: options.outputPath ?? options.out,
      format: options.outputFormat,
    },
    log: {
      format: options.logFormat,
    },
  };
}

// Same rewrite cli.js's overrideTimes() does: forces every repeat block's `times`,
// recursively, so a one-off smoke run does not need flow.json edited by hand.
function overrideTimes(steps, times) {
  for (const step of steps || []) {
    if (step.kind === 'repeat') step.times = times;
    if (step.body) overrideTimes(step.body, times);
  }
}

// The subset of a resolved config that interpret.js's runFlow (and, via it, verifyFlow)
// actually consumes.
function runFlowOptionsFrom(config) {
  return {
    resolveWaitMs: config.timeouts.resolveWaitMs,
    settleTimeoutMs: config.timeouts.settleMs,
    repeatDefaultTimes: config.repeat.defaultTimes,
    repeatMaxTimes: config.repeat.maxTimes,
    chromiumArgs: config.browser.args,
  };
}

// output.path/format come from config (defaults reproduce sites/<id>/output.csv,
// extension-sniffed).
function writeConfiguredOutput(config, siteId, records) {
  const outPath = resolveOutputPath(config, siteId, { baseDir: REPO_ROOT });
  const format = resolveOutputFormat(config, outPath);
  if (!records || !records.length) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, format === 'json' ? toJson(records) : toCsv(records));
  return outPath;
}

// A headed launch needs a real X display; see src/display.js and cli.js's identical
// helper for the full reasoning. Duplicated here rather than imported from cli.js.
async function withPage(headless, fn, displayArgs = {}, extraArgs = []) {
  const displayHandle = headless ? { dispose: () => {} } : await ensureDisplay({ mode: displayArgs.display, screen: displayArgs.screen });
  try {
    const allArgs = [...CHROMIUM_ARGS, ...extraArgs];
    const browser = await chromium.launch({ headless, args: allArgs });
    try {
      const context = await browser.newContext();
      return await fn(await context.newPage());
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    displayHandle.dispose();
  }
}

// Sets flow.requiresHeaded, either from an explicit override or from the "curl
// equivalent" probe. Mirrors cli.js's resolveRequiresHeaded, minus the narration
// (logInfo) - a library caller gets the result on `flow.requiresHeaded` and, from
// record()/verify(), on the returned object; it does not need it printed for it.
async function resolveRequiresHeaded(flow, options, config) {
  if (options.requiresHeaded !== undefined) {
    flow.requiresHeaded = options.requiresHeaded;
    return { requiresHeaded: options.requiresHeaded, reason: 'set explicitly via options.requiresHeaded' };
  }
  const probe = await probeRequiresHeaded(flow.startUrl, { timeoutMs: config?.timeouts?.probeMs });
  flow.requiresHeaded = probe.requiresHeaded;
  return probe;
}

// Reads and parses sites/<id>/flow.json under an already-RESOLVED sitesDir. Split from
// the exported loadFlow() below so verify()/play() - which already resolved sitesDir for
// other reasons (paths.failures, output, etc.) - read the file without re-resolving
// config a second time.
function readFlowFile(sitesDir, siteId) {
  const { flow: flowPath } = sitePathsFor(siteId, sitesDir);
  if (!fs.existsSync(flowPath)) {
    throw new Error(`No flow for "${siteId}" (expected ${flowPath}). Record it first.`);
  }
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  if (!flow.steps?.length) throw new Error(`${flowPath} has no steps.`);
  return flow;
}

// --- the public API ------------------------------------------------------------------

// record({ siteId, url, ...options }) -> { flow, paths, warnings, verified, verify,
// emittedPath }. Wraps recordSite() (src/record.js) with the same config resolution and
// display/Xvfb setup cli.js's cmdRecord does, plus the self-verify replay it folds in -
// minus argv parsing, --help text and process.exit.
//
// `options.drive` is the same test seam recordSite() itself exposes (see
// test/record.test.js): a function called with the live page instead of waiting for a
// person to close the browser, which is what lets `record()` be exercised headlessly in
// test/index-api.test.js.
async function record(options = {}) {
  const { siteId, url } = options;
  if (!siteId || !url) throw new Error('record() needs { siteId, url }');

  // No flow exists yet, so this is defaults -> file -> env -> options; the flow.config
  // layer has nothing to contribute for a fresh recording, same as cli.js's cmdRecord.
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: configOverridesFrom(options) });
  setLogFormat(config.log.format);
  setLogSiteId(siteId);
  const resolvedSitesDir = resolveSitesDir(config);

  // Recording is always headed by design (CLAUDE.md) - the R/F buttons need a real
  // window - and the self-verify replay below defaults headed too, so one Xvfb instance
  // covers the whole call. `options.headless: true` (the `drive` test seam) skips this
  // just like it does in recordSite() itself.
  const displayHandle = options.headless
    ? { dispose: () => {} }
    : await ensureDisplay({ mode: config.display.mode, screen: config.display.screen });
  try {
    const { flow, paths, warnings } = await recordSite({
      siteId,
      url,
      drive: options.drive,
      headless: options.headless ?? false,
      userDataDir: options.userDataDir,
      viewport: options.viewport,
      clearTracking: config.profile.clearTracking,
      persist: config.profile.persist,
      dir: config.profile.dir,
      display: config.display.mode,
      screen: config.display.screen,
      chromiumArgs: config.browser.args,
      sitesDir: resolvedSitesDir,
    });

    if (!flow.steps.length) {
      return { flow, paths, warnings, verified: false, verify: null, emittedPath: null };
    }

    await resolveRequiresHeaded(flow, options, config);

    const verifyResult = await verifyFlow(flow, {
      headless: options.headless ?? false,
      artifactsDir: paths.failures,
      ...runFlowOptionsFrom(config),
    });

    // `verified` is recorded in the file so `play` can warn when a flow was never proven
    // to work - see cli.js's cmdRecord for the full reasoning.
    flow.verified = verifyResult.ok;
    fs.writeFileSync(paths.flow, JSON.stringify(flow, null, 2));

    const emittedPath = path.join(paths.dir, 'flow.js');
    fs.writeFileSync(emittedPath, emitFlow(flow));

    return { flow, paths, warnings, verified: verifyResult.ok, verify: verifyResult, emittedPath };
  } finally {
    displayHandle.dispose();
  }
}

// verify({ siteId, ...options }) -> verifyFlow()'s own result ({ ok, reasons, stats,
// shapeProblems, advisories }) plus { outputPath, runRecordPath }. Wraps verifyFlow()
// (src/verify.js) with config resolution, mirroring cli.js's cmdVerify - including the
// sites/<id>/runs/<iso>.json structured report Phase 6.1 added there, so a library
// caller gets the same on-disk record a CLI `verify` run produces.
async function verify(options = {}) {
  const { siteId } = options;
  if (!siteId) throw new Error('verify() needs { siteId }');

  const startedAt = new Date();
  const runStart = Date.now();

  const config = loadConfig({ cwd: process.cwd(), cliOverrides: configOverridesFrom(options) });
  setLogFormat(config.log.format);
  setLogSiteId(siteId);
  const resolvedSitesDir = resolveSitesDir(config);
  const flow = readFlowFile(resolvedSitesDir, siteId);

  // Loaded AFTER the flow so flow.json's own `config` key takes part as the flow.config
  // layer, one step under the caller's own options - same precedence cli.js uses.
  const configWithFlow = loadConfig({ cwd: process.cwd(), flow, cliOverrides: configOverridesFrom(options) });
  setLogFormat(configWithFlow.log.format);

  // Resolved and persisted BEFORE any `times` override below - a one-off smoke-run
  // convenience must never leak into the saved flow.json.
  await resolveRequiresHeaded(flow, options, configWithFlow);
  const paths = sitePathsFor(siteId, resolvedSitesDir);
  fs.writeFileSync(paths.flow, JSON.stringify(flow, null, 2));

  if (options.times) overrideTimes(flow.steps, options.times);

  // verify defaults headed too ("replay headed + per-step report"), same as cli.js.
  const verifyHeadless = options.headless ?? false;
  const displayHandle = verifyHeadless
    ? { dispose: () => {} }
    : await ensureDisplay({ mode: configWithFlow.display.mode, screen: configWithFlow.display.screen });
  try {
    const result = await verifyFlow(flow, {
      headless: verifyHeadless,
      artifactsDir: paths.failures,
      ...runFlowOptionsFrom(configWithFlow),
    });

    const outputPath = writeConfiguredOutput(configWithFlow, siteId, result.stats.records);
    const exitCode = result.ok ? 0 : 1;

    const runRecordPath = writeRunRecord(paths.dir, buildRunRecord({
      command: 'verify',
      siteId,
      startedAt,
      durationMs: Date.now() - runStart,
      exitCode,
      stats: result.stats,
      outputPath,
    }));

    return { ...result, outputPath, exitCode, runRecordPath };
  } finally {
    displayHandle.dispose();
  }
}

// play({ siteId, ...options }) -> interpret.js's runFlow() stats plus drift capture
// (src/drift.js), mirroring cli.js's cmdPlay - including the sites/<id>/runs/<iso>.json
// structured report Phase 6.1 added there. Checked cli.js immediately before writing
// this: that report-writing HAS landed (src/run-record.js, wired into cmdPlay), so
// play() reproduces it rather than leaving a follow-up.
async function play(options = {}) {
  const { siteId } = options;
  if (!siteId) throw new Error('play() needs { siteId }');

  const startedAt = new Date();
  const runStart = Date.now();

  const config = loadConfig({ cwd: process.cwd(), cliOverrides: configOverridesFrom(options) });
  setLogFormat(config.log.format);
  setLogSiteId(siteId);
  const resolvedSitesDir = resolveSitesDir(config);
  const flow = readFlowFile(resolvedSitesDir, siteId);
  const configWithFlow = loadConfig({ cwd: process.cwd(), flow, cliOverrides: configOverridesFrom(options) });
  setLogFormat(configWithFlow.log.format);

  if (options.times) overrideTimes(flow.steps, options.times);

  const paths = sitePathsFor(siteId, resolvedSitesDir);
  const wasVerified = !!flow.verified;

  // `options.headless` wins when passed explicitly; otherwise default to headless UNLESS
  // this site was auto-detected (or requiresHeaded'd, at record/verify time) as needing
  // headed mode - see src/headless-probe.js.
  const { stats, fingerprint } = await withPage(options.headless ?? !flow.requiresHeaded, async (page) => {
    const runStats = await runFlow(flow, { page, artifactsDir: paths.failures, ...runFlowOptionsFrom(configWithFlow) });
    // Captured while the browser is still open and sitting on the final page.
    return { stats: runStats, fingerprint: await drift.captureFingerprint(page, flow, runStats) };
  }, { display: configWithFlow.display.mode, screen: configWithFlow.display.screen }, configWithFlow.browser.args);

  const outputPath = writeConfiguredOutput(configWithFlow, siteId, stats.records);

  const previous = drift.loadPreviousFingerprint(siteId, resolvedSitesDir);
  const { status: driftStatus, issues: driftIssues } = drift.classifyDrift(previous, fingerprint);
  const fingerprintSaved = drift.saveFingerprint(siteId, fingerprint, driftStatus, resolvedSitesDir);

  // Same exit-worthy conditions as cli.js's cmdPlay, returned as data instead of
  // process.exitCode: a selector that resolved to nothing is always worth failing on,
  // even on the very first run when there is no drift baseline yet.
  const structuralErrors = stats.errors.filter((e) => e.type === 'SELECTOR_UNRESOLVED').length;
  const ok = !(driftStatus === 'BROKEN' || stats.aborted || structuralErrors > 0 || stats.actions === 0);
  const exitCode = ok ? 0 : 1;

  const runRecordPath = writeRunRecord(paths.dir, buildRunRecord({
    command: 'play',
    siteId,
    startedAt,
    durationMs: Date.now() - runStart,
    exitCode,
    stats,
    driftStatus,
    driftIssues,
    outputPath,
  }));

  return {
    ok,
    exitCode,
    wasVerified,
    stats,
    fingerprint,
    driftStatus,
    driftIssues,
    fingerprintSaved,
    structuralErrors,
    outputPath,
    runRecordPath,
  };
}

// list({ sitesDir } = {}) -> the array cli.js's cmdList prints, as data. The underlying
// enumeration (readdir sites/, skip _template, skip anything without a flow.json, read
// each flow.json for its summary fields) is a handful of lines duplicated directly here
// rather than extracted out of cli.js - extracting it would mean editing cli.js's
// command functions, which is off-limits while Phase 6.1 is in flight there.
async function list(options = {}) {
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: options.sitesDir } });
  const sitesDir = resolveSitesDir(config);
  if (!fs.existsSync(sitesDir)) return [];

  const entries = fs.readdirSync(sitesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_template')
    .filter((e) => fs.existsSync(path.join(sitesDir, e.name, 'flow.json')));

  return entries.map((entry) => {
    const flowPath = path.join(sitesDir, entry.name, 'flow.json');
    try {
      const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
      return {
        id: entry.name,
        verified: !!flow.verified,
        requiresHeaded: !!flow.requiresHeaded,
        steps: countSteps(flow.steps),
        startUrl: flow.startUrl,
      };
    } catch (err) {
      return { id: entry.name, error: err.message };
    }
  });
}

// loadFlow(siteId, { sitesDir } = {}) -> the parsed sites/<id>/flow.json, resolved
// through the same config layering (file/env/options) every other function here uses -
// so a caller who only wants to inspect a flow does not need to hand-resolve sitesDir
// itself.
async function loadFlow(siteId, options = {}) {
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: options.sitesDir } });
  const resolvedSitesDir = resolveSitesDir(config);
  return readFlowFile(resolvedSitesDir, siteId);
}

module.exports = { record, verify, play, list, loadFlow };
