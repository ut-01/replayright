#!/usr/bin/env node
// cli.js - record | play | verify | emit | list
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { chromium } = require('playwright');

const { recordSite, sitePaths, countSteps } = require('./record');
const { verifyFlow } = require('./verify');
const { runFlow } = require('./interpret');
const { emitFlow } = require('./emit');
const { writeOutput } = require('./output');
const drift = require('./drift');
const { probeRequiresHeaded } = require('./headless-probe');
const { logInfo, logWarn, logError } = require('./log');
const { CHROMIUM_ARGS } = require('./constants');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITES_DIR = path.join(REPO_ROOT, 'sites');
const COMMANDS = ['record', 'play', 'verify', 'emit', 'list'];

function usage() {
  console.log(`playRight - record a web flow once, replay it every day.

Usage: node src/cli.js <command> [options]

  record --id <id> --url <url>   Record a flow. Use the R/F buttons in the browser to
                                 mark loops, then close the window. The recording is
                                 replayed immediately to verify it.
  play   --id <id>               Replay sites/<id>/flow.json. Exits non-zero if the
                                 drift check reports BROKEN.
  verify --id <id>               Replay and report, without updating the fingerprint.
  emit   --id <id>               Write a readable .js view of the flow (debug only).
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
`);
}

function loadFlow(siteId) {
  const { flow: flowPath } = sitePaths(siteId);
  if (!fs.existsSync(flowPath)) {
    throw new Error(`No flow for "${siteId}" (expected ${path.relative(REPO_ROOT, flowPath)}). Record it first.`);
  }
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  if (!flow.steps?.length) throw new Error(`${path.relative(REPO_ROOT, flowPath)} has no steps.`);
  return flow;
}

// Applied recursively so a one-off `--times 2` smoke run does not need flow.json edited.
function overrideTimes(steps, times) {
  for (const step of steps || []) {
    if (step.kind === 'repeat') step.times = times;
    if (step.body) overrideTimes(step.body, times);
  }
}

async function withPage(headless, fn) {
  const browser = await chromium.launch({ headless, args: CHROMIUM_ARGS });
  try {
    const context = await browser.newContext();
    return await fn(await context.newPage());
  } finally {
    await browser.close().catch(() => {});
  }
}

// Sets flow.requiresHeaded, either from an explicit --requires-headed override or from the
// "curl equivalent" probe (see headless-probe.js). Shared by record and verify - both
// re-check on every run rather than diagnosing once and trusting it forever, since a site's
// bot-protection posture can change over time just as its selectors can.
async function resolveRequiresHeaded(flow, args) {
  if (args.requiresHeaded !== undefined) {
    flow.requiresHeaded = args.requiresHeaded;
    logInfo(`requiresHeaded set explicitly via --requires-headed=${args.requiresHeaded}`);
    return;
  }
  const probe = await probeRequiresHeaded(flow.startUrl);
  flow.requiresHeaded = probe.requiresHeaded;
  logInfo(`headless capability: ${probe.reason} -> requiresHeaded=${probe.requiresHeaded}`);
}

async function cmdRecord(args) {
  if (!args.id || !args.url) throw new Error('record needs --id <id> and --url <url>');

  const { flow, paths } = await recordSite({ siteId: args.id, url: args.url, clearTracking: args.clearTracking });
  if (!flow.steps.length) process.exitCode = 1;
  if (!flow.steps.length) return;

  await resolveRequiresHeaded(flow, args);

  logInfo('');
  logInfo('Replaying the recording now to check it actually works...');
  const { ok } = await verifyFlow(flow, {
    headless: args.headless ?? false,
    artifactsDir: paths.failures,
  });

  // `verified` is recorded in the file so `play` can warn when a flow was never proven
  // to work - a scheduled job silently running an unverified flow is how the previous
  // versions produced empty output for days without anyone noticing.
  flow.verified = ok;
  fs.writeFileSync(paths.flow, JSON.stringify(flow, null, 2));

  const emitted = path.join(paths.dir, 'flow.js');
  fs.writeFileSync(emitted, emitFlow(flow));
  logInfo(`Readable view written to ${path.relative(REPO_ROOT, emitted)} (debug only - flow.json is what runs).`);

  if (!ok) process.exitCode = 1;
}

async function cmdVerify(args) {
  const flow = loadFlow(args.id);

  // Resolved and persisted BEFORE any `--times` override below - that override is a
  // one-off smoke-run convenience and must never leak into the saved flow.json.
  await resolveRequiresHeaded(flow, args);
  fs.writeFileSync(sitePaths(args.id).flow, JSON.stringify(flow, null, 2));

  if (args.times) overrideTimes(flow.steps, args.times);
  const { ok, stats } = await verifyFlow(flow, {
    headless: args.headless ?? false,
    artifactsDir: sitePaths(args.id).failures,
  });

  const outPath = args.out || path.join(sitePaths(args.id).dir, 'output.csv');
  const written = writeOutput(outPath, stats.records);
  if (written) logInfo(`wrote ${stats.records.length} row(s) to ${path.relative(REPO_ROOT, written)}`);

  if (!ok) process.exitCode = 1;
}

async function cmdPlay(args) {
  const flow = loadFlow(args.id);
  if (args.times) overrideTimes(flow.steps, args.times);
  if (!flow.verified) logWarn('this flow has never passed verification; run `verify --id ' + args.id + '` before trusting it');

  const paths = sitePaths(args.id);

  // `--headless` on the CLI still wins when passed explicitly; otherwise default to
  // headless UNLESS this site was auto-detected (or --requires-headed'd, at record/verify
  // time) as needing headed mode - see headless-probe.js.
  const { stats, fingerprint } = await withPage(args.headless ?? !flow.requiresHeaded, async (page) => {
    const runStats = await runFlow(flow, { page, artifactsDir: paths.failures });
    // Captured while the browser is still open and sitting on the final page.
    return { stats: runStats, fingerprint: await drift.captureFingerprint(page, flow, runStats) };
  });

  logInfo(`done: ${stats.actions} action(s), ${stats.repeatIterations} repeat iteration(s), ${stats.foreachIterations} item(s)`);
  for (const f of stats.fallbacks) logWarn(`${f.path} ${f.message}`);
  for (const w of stats.warnings) logWarn(`${w.path} ${w.type}: ${w.message}`);
  for (const e of stats.errors) logError(`${e.path} ${e.type}: ${e.message}`);

  const outPath = args.out || path.join(paths.dir, 'output.csv');
  const written = writeOutput(outPath, stats.records);
  if (written) logInfo(`wrote ${stats.records.length} row(s) to ${path.relative(REPO_ROOT, written)}`);

  const previous = drift.loadPreviousFingerprint(args.id);
  const { status, issues } = drift.classifyDrift(previous, fingerprint);

  if (status === 'OK') {
    logInfo(`drift check: OK ${JSON.stringify(fingerprint.selectorCounts)}`);
  } else {
    const log = status === 'BROKEN' ? logError : logWarn;
    log(`drift check: ${status}`);
    for (const issue of issues) log(`  [${issue.severity}] ${issue.reason}`);
  }

  if (!drift.saveFingerprint(args.id, fingerprint, status)) {
    logWarn('keeping the previous fingerprint as the baseline so this stays BROKEN until it is fixed');
  }

  // A selector that resolved to nothing means the site changed - structural, and always
  // worth a non-zero exit even on the very first run, when there is no baseline to
  // compare against. Other step failures may be transient and do not fail the run on
  // their own.
  const structural = stats.errors.filter((e) => e.type === 'SELECTOR_UNRESOLVED').length;
  if (structural) logError(`${structural} step(s) could not resolve any selector candidate`);
  if (status === 'BROKEN' || stats.aborted || structural > 0 || stats.actions === 0) process.exitCode = 1;
}

function cmdEmit(args) {
  const flow = loadFlow(args.id);
  const out = path.join(sitePaths(args.id).dir, 'flow.js');
  fs.writeFileSync(out, emitFlow(flow));
  logInfo(`wrote ${path.relative(REPO_ROOT, out)} (debug only - flow.json is what runs)`);
}

function cmdList() {
  if (!fs.existsSync(SITES_DIR)) return logInfo('no sites recorded yet');
  const entries = fs.readdirSync(SITES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_template')
    .filter((e) => fs.existsSync(path.join(SITES_DIR, e.name, 'flow.json')));

  if (!entries.length) return logInfo('no sites recorded yet');
  for (const entry of entries) {
    try {
      const flow = JSON.parse(fs.readFileSync(path.join(SITES_DIR, entry.name, 'flow.json'), 'utf8'));
      const headedness = flow.requiresHeaded ? 'headed' : 'headless';
      console.log(`${entry.name}\t${flow.verified ? 'verified' : 'UNVERIFIED'}\t${headedness}\t${countSteps(flow.steps)} steps\t${flow.startUrl}`);
    } catch (err) {
      console.log(`${entry.name}\t(unreadable flow.json: ${err.message})`);
    }
  }
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
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

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
  };
  if (command !== 'list' && !args.id) throw new Error(`${command} needs --id <id>`);

  if (command === 'record') return cmdRecord(args);
  if (command === 'play') return cmdPlay(args);
  if (command === 'verify') return cmdVerify(args);
  if (command === 'emit') return cmdEmit(args);
  if (command === 'list') return cmdList();
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
