#!/usr/bin/env node
// cli.js - record | play | verify | emit | list
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { chromium } = require('playwright');

const { recordSite, sitePaths: recordSitePaths, countSteps } = require('./record');
const { verifyFlow } = require('./verify');
const { runFlow } = require('./interpret');
const { emitFlow } = require('./emit');
const { writeOutput, toCsv, toJson } = require('./output');
const drift = require('./drift');
const { probeRequiresHeaded } = require('./headless-probe');
const { logInfo, logWarn, logError, setLogFormat, setLogSiteId, EVENT } = require('./log');
const { buildRunRecord, writeRunRecord } = require('./run-record');
const { CHROMIUM_ARGS } = require('./constants');
const { ensureDisplay } = require('./display');
const { loadConfig, resolveOutputPath, resolveOutputFormat, resolveSitesDir, defaults, CONFIG_FILENAME } = require('./config');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMMANDS = ['record', 'play', 'verify', 'emit', 'list', 'init'];

function usage() {
  console.log(`playRight - record a web flow once, replay it every day.

Usage: node src/cli.js <command> [options]

  record --id <id> --url <url>   Record a flow. Use the R/F buttons in the browser to
                                 mark loops, then close the window. The recording is
                                 replayed immediately to verify it.
  play   --id <id>               Replay from the configured sites directory. Exits
                                 non-zero if the drift check reports BROKEN.
  verify --id <id>               Replay and report, without updating the fingerprint.
  emit   --id <id>               Write a readable .js view of the flow (debug only).
  init                           Scaffold a replayright.config.json in the current
                                 directory with all defaults and explanations.
  list                           List recorded sites.

Options:
  --headless[=true|false]        Default: false for record/verify; for play, true unless
                                 the flow was auto-detected (or --requires-headed) as
                                 needing headed mode.
  --requires-headed[=true|false] record/verify only. Skip the automatic "does this site
                                 block a plain HTTP request" probe and set flow.json's
                                 requiresHeaded directly.
  --clear-tracking               record only. Wipe cookies/storage from the profile dir
                                 before and after recording, so the session starts and
                                 ends logged-out. Off by default - the profile persists
                                 so cookie banners and logins survive between sessions.
  --times <n>                    Override every repeat block's iteration count.
  --out <path>                   play/verify only. Where to write extracted rows (CSV or
                                 JSON by extension). Default sites/<id>/output.csv.
                                 Written only if the flow tags at least one field.
  --sites-dir <path>             Where per-site recordings live. Default ./sites.
  --display <auto|off|:N>        How to get a real X display for a headed browser on a
                                 Linux box with no DISPLAY (e.g. an unattended cloud
                                 runner). "auto" (default) starts a scoped Xvfb on a free
                                 display number; "off" disables that and lets the launch
                                 fail naturally if no DISPLAY exists; ":N" pins a display
                                 number. No-op when DISPLAY is already set or on non-Linux.
  --screen <WxHxD>                Xvfb screen spec when Xvfb is started. Default 1920x1080x24.
  --disable-dev-shm-usage        play/verify only. Disable /dev/shm usage (useful in
                                 containers with small /dev/shm). Opt-in flag.
  --disable-gpu                  play/verify only. Disable GPU acceleration. Opt-in flag.
  --no-sandbox                   play/verify only. Disable Chromium sandbox (required
                                 when running as root in containers, but is an attack
                                 surface otherwise). Opt-in flag.
  --log <text|json>              Log output format. "text" (default) is today's
                                 human-readable "[iso] message" line. "json" is one JSON
                                 object per line (NDJSON) - level/ts/siteId/event/path/
                                 message - for a machine consumer. play/verify also write
                                 a per-run sites/<id>/runs/<iso>.json report regardless
                                 of this flag.
`);
}

function loadFlow(siteId, sitesDir) {
  const { flow: flowPath } = sitePaths(siteId, sitesDir);
  if (!fs.existsSync(flowPath)) {
    throw new Error(`No flow for "${siteId}" (expected ${path.relative(process.cwd(), flowPath)}). Record it first.`);
  }
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  if (!flow.steps?.length) throw new Error(`${path.relative(process.cwd(), flowPath)} has no steps.`);
  return flow;
}

// Applied recursively so a one-off `--times 2` smoke run does not need flow.json edited.
// This stays cli.js's own post-load step rather than something config.js does: rewriting
// every repeat block's `times` is a stronger statement than "the default for blocks that
// name none" (config's repeat.defaultTimes), and doing it here keeps that distinction
// visible instead of hiding a mutation inside the config loader.
function overrideTimes(steps, times) {
  for (const step of steps || []) {
    if (step.kind === 'repeat') step.times = times;
    if (step.body) overrideTimes(step.body, times);
  }
}

// The subset of a resolved config that interpret.js's runFlow (and, via it, verifyFlow)
// actually consumes. Pulled out once so record/verify/play ask for it the same way.
function runFlowOptionsFrom(config) {
  return {
    resolveWaitMs: config.timeouts.resolveWaitMs,
    settleTimeoutMs: config.timeouts.settleMs,
    repeatDefaultTimes: config.repeat.defaultTimes,
    repeatMaxTimes: config.repeat.maxTimes,
    // browser.args is EXTRA args appended to constants.js's CHROMIUM_ARGS (see
    // config.js) - this already carries whatever --disable-dev-shm-usage/--disable-gpu/
    // --no-sandbox mapped to via configFromCliArgs, so cli.js has no need to rebuild
    // that list by hand a second time.
    chromiumArgs: config.browser.args,
  };
}

// Build site paths (flow.json, actions, failures dir) for a given sites directory.
// This wraps record.js's sitePaths but uses a resolved sitesDir from config instead of
// the hardcoded REPO_ROOT/sites.
function sitePaths(siteId, sitesDir) {
  const dir = path.join(sitesDir, siteId);
  return {
    dir,
    flow: path.join(dir, 'flow.json'),
    actions: path.join(dir, 'last-recording.actions.json'),
    failures: path.join(dir, 'failures'),
  };
}

// output.path/format come from config (defaults reproduce today's sites/<id>/output.csv,
// extension-sniffed). writeOutput() only looks at the path's extension, so an explicit
// output.format override (rather than 'auto') is applied by writing directly instead.
function writeConfiguredOutput(config, siteId, records) {
  const outPath = resolveOutputPath(config, siteId, { baseDir: REPO_ROOT });
  const format = resolveOutputFormat(config, outPath);
  if (!records || !records.length) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, format === 'json' ? toJson(records) : toCsv(records));
  return outPath;
}

// A headed launch needs a real X display. On a normal desktop DISPLAY is already set
// and ensureDisplay() is a no-op; on an unattended headless Linux box (the actual point
// of `play` on a `requiresHeaded` site) it stands up a scoped Xvfb here. Skipped
// entirely when going headless - no display is needed, and ensureDisplay() would only
// do pointless work (or worse, throw over a missing Xvfb binary nobody needed).
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
    // Same finally-tier as the browser close above, not a separate afterthought: an
    // orphaned Xvfb process is exactly the leak this module exists to prevent, and it
    // must be reaped on every exit path, including one where chromium.launch() itself
    // threw.
    displayHandle.dispose();
  }
}

// Sets flow.requiresHeaded, either from an explicit --requires-headed override or from the
// "curl equivalent" probe (see headless-probe.js). Shared by record and verify - both
// re-check on every run rather than diagnosing once and trusting it forever, since a site's
// bot-protection posture can change over time just as its selectors can.
async function resolveRequiresHeaded(flow, args, config) {
  if (args.requiresHeaded !== undefined) {
    flow.requiresHeaded = args.requiresHeaded;
    logInfo(`requiresHeaded set explicitly via --requires-headed=${args.requiresHeaded}`, { event: EVENT.REQUIRES_HEADED_RESOLVED });
    return;
  }
  const probe = await probeRequiresHeaded(flow.startUrl, { timeoutMs: config?.timeouts?.probeMs });
  flow.requiresHeaded = probe.requiresHeaded;
  logInfo(`headless capability: ${probe.reason} -> requiresHeaded=${probe.requiresHeaded}`, { event: EVENT.REQUIRES_HEADED_RESOLVED });
}

async function cmdRecord(args) {
  if (!args.id || !args.url) throw new Error('record needs --id <id> and --url <url>');

  // No flow exists yet, so this is defaults -> file -> env -> CLI; the flow.config layer
  // simply has nothing to contribute for a fresh recording.
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: args.sitesDir }, cliArgs: args });
  setLogFormat(config.log.format);
  const resolvedSitesDir = resolveSitesDir(config);

  // Recording is always headed - it needs a real Chromium window for the R/F buttons to
  // be clicked in - and the self-verify replay just below defaults headed too, so this
  // covers the whole command with one Xvfb instance rather than starting/stopping it
  // twice. On a normal desktop DISPLAY is already set and this is a no-op.
  const displayHandle = await ensureDisplay({ mode: config.display.mode, screen: config.display.screen });
  try {
    const { flow, paths } = await recordSite({
      siteId: args.id,
      url: args.url,
      clearTracking: config.profile.clearTracking,
      persist: config.profile.persist,
      dir: config.profile.dir,
      display: config.display.mode,
      screen: config.display.screen,
      chromiumArgs: config.browser.args,
      sitesDir: resolvedSitesDir,
    });
    if (!flow.steps.length) process.exitCode = 1;
    if (!flow.steps.length) return;

    await resolveRequiresHeaded(flow, args, config);

    logInfo('');
    logInfo('Replaying the recording now to check it actually works...');
    const { ok } = await verifyFlow(flow, {
      headless: args.headless ?? false,
      artifactsDir: paths.failures,
      ...runFlowOptionsFrom(config),
    });

    // `verified` is recorded in the file so `play` can warn when a flow was never proven
    // to work - a scheduled job silently running an unverified flow is how the previous
    // versions produced empty output for days without anyone noticing.
    flow.verified = ok;
    fs.writeFileSync(paths.flow, JSON.stringify(flow, null, 2));

    const emitted = path.join(paths.dir, 'flow.js');
    fs.writeFileSync(emitted, emitFlow(flow));
    logInfo(`Readable view written to ${path.relative(process.cwd(), emitted)} (debug only - flow.json is what runs).`);

    if (!ok) process.exitCode = 1;
  } finally {
    displayHandle.dispose();
  }
}

async function cmdVerify(args) {
  const startedAt = new Date();
  const runStart = Date.now();
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: args.sitesDir, log: { format: args.log } } });
  setLogFormat(config.log.format);
  const resolvedSitesDir = resolveSitesDir(config);
  const flow = loadFlow(args.id, resolvedSitesDir);

  // Loaded AFTER the flow so flow.json's own `config` key (per-site tuning a human wrote
  // down by hand) takes part as the flow.config layer, one step under CLI flags.
  const configWithCliArgs = loadConfig({ cwd: process.cwd(), flow, cliOverrides: { sitesDir: args.sitesDir }, cliArgs: args });
  setLogFormat(configWithCliArgs.log.format);

  // Resolved and persisted BEFORE any `--times` override below - that override is a
  // one-off smoke-run convenience and must never leak into the saved flow.json.
  await resolveRequiresHeaded(flow, args, configWithCliArgs);
  fs.writeFileSync(sitePaths(args.id, resolvedSitesDir).flow, JSON.stringify(flow, null, 2));

  if (args.times) overrideTimes(flow.steps, args.times);

  // verify defaults headed too ("replay headed + per-step report"), so it needs the
  // same Xvfb treatment as record on a headless Linux box. Skipped when explicitly run
  // headless.
  const verifyHeadless = args.headless ?? false;
  const displayHandle = verifyHeadless
    ? { dispose: () => {} }
    : await ensureDisplay({ mode: configWithCliArgs.display.mode, screen: configWithCliArgs.display.screen });
  try {
    const { ok, stats } = await verifyFlow(flow, {
      headless: verifyHeadless,
      artifactsDir: sitePaths(args.id, resolvedSitesDir).failures,
      ...runFlowOptionsFrom(configWithCliArgs),
    });

    const written = writeConfiguredOutput(configWithCliArgs, args.id, stats.records);
    if (written) logInfo(`wrote ${stats.records.length} row(s) to ${path.relative(process.cwd(), written)}`, { event: EVENT.OUTPUT_WRITTEN, path: written });

    if (!ok) process.exitCode = 1;

    writeRunRecord(sitePaths(args.id, resolvedSitesDir).dir, buildRunRecord({
      command: 'verify',
      siteId: args.id,
      startedAt,
      durationMs: Date.now() - runStart,
      exitCode: process.exitCode || 0,
      stats,
      outputPath: written,
    }));
  } finally {
    displayHandle.dispose();
  }
}

async function cmdPlay(args) {
  const startedAt = new Date();
  const runStart = Date.now();
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: args.sitesDir, log: { format: args.log } } });
  setLogFormat(config.log.format);
  const resolvedSitesDir = resolveSitesDir(config);
  const flow = loadFlow(args.id, resolvedSitesDir);
  const configWithCliArgs = loadConfig({ cwd: process.cwd(), flow, cliOverrides: { sitesDir: args.sitesDir }, cliArgs: args });
  setLogFormat(configWithCliArgs.log.format);

  if (args.times) overrideTimes(flow.steps, args.times);
  if (!flow.verified) logWarn('this flow has never passed verification; run `verify --id ' + args.id + '` before trusting it');

  const paths = sitePaths(args.id, resolvedSitesDir);

  // `--headless` on the CLI still wins when passed explicitly; otherwise default to
  // headless UNLESS this site was auto-detected (or --requires-headed'd, at record/verify
  // time) as needing headed mode - see headless-probe.js.
  const { stats, fingerprint } = await withPage(args.headless ?? !flow.requiresHeaded, async (page) => {
    const runStats = await runFlow(flow, { page, artifactsDir: paths.failures, ...runFlowOptionsFrom(configWithCliArgs) });
    // Captured while the browser is still open and sitting on the final page.
    return { stats: runStats, fingerprint: await drift.captureFingerprint(page, flow, runStats) };
  }, { display: configWithCliArgs.display.mode, screen: configWithCliArgs.display.screen }, configWithCliArgs.browser.args);

  logInfo(`done: ${stats.actions} action(s), ${stats.repeatIterations} repeat iteration(s), ${stats.foreachIterations} item(s)`, { event: EVENT.PLAY_COMPLETED });
  for (const f of stats.fallbacks) logWarn(`${f.path} ${f.message}`, { event: EVENT.STEP_FALLBACK, path: f.path });
  for (const w of stats.warnings) logWarn(`${w.path} ${w.type}: ${w.message}`, { event: EVENT.STEP_WARNING, path: w.path });
  for (const e of stats.errors) logError(`${e.path} ${e.type}: ${e.message}`, { event: EVENT.STEP_FAILED, path: e.path });

  const written = writeConfiguredOutput(configWithCliArgs, args.id, stats.records);
  if (written) logInfo(`wrote ${stats.records.length} row(s) to ${path.relative(process.cwd(), written)}`, { event: EVENT.OUTPUT_WRITTEN, path: written });

  const previous = drift.loadPreviousFingerprint(args.id, resolvedSitesDir);
  const { status, issues } = drift.classifyDrift(previous, fingerprint);

  if (status === 'OK') {
    logInfo(`drift check: OK ${JSON.stringify(fingerprint.selectorCounts)}`, { event: EVENT.DRIFT_OK });
  } else {
    const log = status === 'BROKEN' ? logError : logWarn;
    log(`drift check: ${status}`, { event: EVENT.DRIFT_DETECTED });
    for (const issue of issues) log(`  [${issue.severity}] ${issue.reason}`, { event: EVENT.DRIFT_DETECTED });
  }

  if (!drift.saveFingerprint(args.id, fingerprint, status, resolvedSitesDir)) {
    logWarn('keeping the previous fingerprint as the baseline so this stays BROKEN until it is fixed');
  }

  // A selector that resolved to nothing means the site changed - structural, and always
  // worth a non-zero exit even on the very first run, when there is no baseline to
  // compare against. Other step failures may be transient and do not fail the run on
  // their own.
  const structural = stats.errors.filter((e) => e.type === 'SELECTOR_UNRESOLVED').length;
  if (structural) logError(`${structural} step(s) could not resolve any selector candidate`);
  if (status === 'BROKEN' || stats.aborted || structural > 0 || stats.actions === 0) process.exitCode = 1;

  // Mandatory per Phase 6.1: one sites/<id>/runs/<iso>.json per `play` run, so a cloud
  // agent can read what happened without scraping stdout. Never allowed to become a new
  // failure mode itself - writeRunRecord() degrades to a warning on its own.
  writeRunRecord(paths.dir, buildRunRecord({
    command: 'play',
    siteId: args.id,
    startedAt,
    durationMs: Date.now() - runStart,
    exitCode: process.exitCode || 0,
    stats,
    driftStatus: status,
    driftIssues: issues,
    outputPath: written,
  }));
}

function cmdEmit(args) {
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: args.sitesDir, log: { format: args.log } } });
  setLogFormat(config.log.format);
  const resolvedSitesDir = resolveSitesDir(config);
  const flow = loadFlow(args.id, resolvedSitesDir);
  const out = path.join(sitePaths(args.id, resolvedSitesDir).dir, 'flow.js');
  fs.writeFileSync(out, emitFlow(flow));
  logInfo(`wrote ${path.relative(process.cwd(), out)} (debug only - flow.json is what runs)`);
}

function cmdList(args) {
  const config = loadConfig({ cwd: process.cwd(), cliOverrides: { sitesDir: args.sitesDir, log: { format: args.log } } });
  setLogFormat(config.log.format);
  const sitesDir = resolveSitesDir(config);
  if (!fs.existsSync(sitesDir)) return logInfo('no sites recorded yet');
  const entries = fs.readdirSync(sitesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_template')
    .filter((e) => fs.existsSync(path.join(sitesDir, e.name, 'flow.json')));

  if (!entries.length) return logInfo('no sites recorded yet');
  for (const entry of entries) {
    try {
      const flow = JSON.parse(fs.readFileSync(path.join(sitesDir, entry.name, 'flow.json'), 'utf8'));
      const headedness = flow.requiresHeaded ? 'headed' : 'headless';
      console.log(`${entry.name}\t${flow.verified ? 'verified' : 'UNVERIFIED'}\t${headedness}\t${countSteps(flow.steps)} steps\t${flow.startUrl}`);
    } catch (err) {
      console.log(`${entry.name}\t(unreadable flow.json: ${err.message})`);
    }
  }
}

function cmdInit() {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    throw new Error(`${CONFIG_FILENAME} already exists at ${configPath}. Remove it first if you want to regenerate it.`);
  }

  const defaultConfig = defaults();
  // Emit clean JSON with just the structure and values
  const configContent = JSON.stringify(defaultConfig, null, 2);
  fs.writeFileSync(configPath, configContent);
  logInfo(`Scaffold config written to ${configPath}`);

  // Also write an example file with comments for reference
  const examplePath = path.join(process.cwd(), 'replayright.config.example.jsonc');
  const exampleContent = buildExampleConfigWithComments();
  fs.writeFileSync(examplePath, exampleContent);
  logInfo(`Example config with comments written to ${examplePath}`);
}

// Build a .jsonc (JSON with comments) example config explaining every key.
// Uses actual defaults from config.js to ensure they stay in sync.
function buildExampleConfigWithComments() {
  const def = defaults();
  return `{
  // Where per-site recordings live. Relative paths resolve against the directory the
  // config file was found in. Default is ${JSON.stringify(def.sitesDir)} (the repo's own sites/).
  "sitesDir": ${JSON.stringify(def.sitesDir)},

  "browser": {
    // Playwright browser channel ('chrome', 'msedge', ...). null = bundled Chromium,
    // which is what every recording so far was made against.
    "channel": ${JSON.stringify(def.browser.channel)},

    // EXTRA Chromium args, appended to the hardcoded defaults - not a replacement for them.
    // Used for environment-specific additions like '--no-sandbox' in a container.
    // Arrays REPLACE across config layers rather than concatenating.
    "args": ${JSON.stringify(def.browser.args)},

    // Viewport size: { width, height } or null to let Playwright pick its own default.
    "viewport": ${JSON.stringify(def.browser.viewport)},

    // User agent string or null to use the default.
    "userAgent": ${JSON.stringify(def.browser.userAgent)},

    // Browser locale like 'de-DE' or null.
    "locale": ${JSON.stringify(def.browser.locale)},

    // Timezone ID like 'Europe/Berlin' or null.
    "timezoneId": ${JSON.stringify(def.browser.timezoneId)},

    // Proxy configuration: { server, bypass?, username?, password? } or null.
    "proxy": ${JSON.stringify(def.browser.proxy)}
  },

  "display": {
    // How to get a real X display for headed mode on headless Linux.
    // 'auto' (default) starts a scoped Xvfb; 'off' disables it; ':N' pins a display number.
    "mode": ${JSON.stringify(def.display.mode)},

    // Xvfb screen spec when Xvfb is started. Default ${JSON.stringify(def.display.screen)}.
    "screen": ${JSON.stringify(def.display.screen)}
  },

  "profile": {
    // Recording profiles persist in os.tmpdir()/playright-profile-<id> so cookie banners
    // and logins survive between sessions. false = throwaway profile dir per recording.
    "persist": ${JSON.stringify(def.profile.persist)},

    // Wipe cookies/storage before and after recording, so the session starts and ends
    // logged-out. OFF by default: on by default is fatal for any flow behind a login.
    "clearTracking": ${JSON.stringify(def.profile.clearTracking)},

    // Override the profile directory entirely. null = use the os.tmpdir() convention.
    "dir": ${JSON.stringify(def.profile.dir)}
  },

  "timeouts": {
    // Wait time for selectors to resolve (ms). Increased for slow sites.
    "resolveWaitMs": ${JSON.stringify(def.timeouts.resolveWaitMs)},

    // Maximum time for page content to settle after navigation (ms).
    "settleMs": ${JSON.stringify(def.timeouts.settleMs)},

    // Headless probe timeout - how long to wait for the probe to complete (ms).
    "probeMs": ${JSON.stringify(def.timeouts.probeMs)}
  },

  "repeat": {
    // Default iteration count for repeat blocks that don't specify their own 'times'.
    "defaultTimes": ${JSON.stringify(def.repeat.defaultTimes)},

    // Upper bound on any single repeat block's 'times', whether from flow.json or --times.
    // Prevents accidental high iteration counts.
    "maxTimes": ${JSON.stringify(def.repeat.maxTimes)}
  },

  "output": {
    // Template path for output files. {id} is substituted with the site id.
    // Default sites/{id}/output.csv reproduces today's behavior.
    "path": ${JSON.stringify(def.output.path)},

    // Output format: 'auto' (extension-based), 'csv', or 'json'.
    "format": ${JSON.stringify(def.output.format)}
  },

  "log": {
    // Log format: 'text' (human-readable) or 'json' (structured, reserved for future use).
    "format": ${JSON.stringify(def.log.format)}
  }
}
`;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;

  const { values } = parseArgs({
    args: command ? argv.slice(1) : argv,
    options: {
      id: { type: 'string' },
      url: { type: 'string' },
      headless: { type: 'string' },
      'requires-headed': { type: 'string' },
      'clear-tracking': { type: 'boolean' },
      times: { type: 'string' },
      out: { type: 'string' },
      'sites-dir': { type: 'string' },
      display: { type: 'string' },
      screen: { type: 'string' },
      'disable-dev-shm-usage': { type: 'boolean' },
      'disable-gpu': { type: 'boolean' },
      'no-sandbox': { type: 'boolean' },
      log: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  // Best-effort, ahead of config.js even being loaded: a raw --log=json on the command
  // line should already apply to an "unknown command" or arg-parsing error below. Each
  // command's own loadConfig() call re-applies setLogFormat() once config.log.format is
  // fully resolved (file/env/flow.config/CLI merged), which is authoritative when this
  // flag is absent but a config file or env var still asks for json.
  if (values.log !== undefined) setLogFormat(values.log);

  if (values.help || !command) { usage(); process.exitCode = command ? 0 : 1; return; }
  if (!COMMANDS.includes(command)) { logError(`unknown command "${command}"`); usage(); process.exitCode = 1; return; }

  const args = {
    id: values.id,
    url: values.url,
    // `--headless` alone means true; `--headless=false` means false; absent means "let
    // the command decide". Bare `--headless false` also works via parseArgs.
    headless: values.headless === undefined ? undefined : values.headless !== 'false',
    // Same shape as `headless` - explicit override, skipping the automatic probe entirely
    // when set (record/verify only; play/emit/list ignore it).
    requiresHeaded: values['requires-headed'] === undefined ? undefined : values['requires-headed'] !== 'false',
    clearTracking: values['clear-tracking'] ?? false,
    times: values.times ? Number(values.times) : undefined,
    out: values.out,
    sitesDir: values['sites-dir'],
    // Passed straight through to ensureDisplay() as { mode, screen }; undefined means
    // "use its defaults" ('auto' mode, 1920x1080x24 screen).
    display: values.display,
    screen: values.screen,
    // Chromium args for server/container environments (play/verify only).
    // These are opt-in flags that append to CHROMIUM_ARGS from constants.js.
    disableDevShmUsage: values['disable-dev-shm-usage'] ?? false,
    disableGpu: values['disable-gpu'] ?? false,
    // --no-sandbox is a security tradeoff: required when running as root in containers,
    // but it disables a genuine sandbox escape protection otherwise. Never default it on.
    noSandbox: values['no-sandbox'] ?? false,
    log: values.log,
  };
  if (command !== 'init' && command !== 'list' && !args.id) throw new Error(`${command} needs --id <id>`);

  // siteId context for json log lines from here on, even for commands (emit/list) that
  // don't get a run-record. Set as early as the id is actually known.
  if (args.id) setLogSiteId(args.id);

  if (command === 'record') return cmdRecord(args);
  if (command === 'play') return cmdPlay(args);
  if (command === 'verify') return cmdVerify(args);
  if (command === 'emit') return cmdEmit(args);
  if (command === 'init') return cmdInit();
  if (command === 'list') return cmdList(args);
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
