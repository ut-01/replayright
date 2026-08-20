// log.js - the generic half of jscrape's src/util.js. The LinkedIn-specific parts
// (USER_AGENT, BLOCKED_STATUSES, extractJobId) are deliberately not carried over.
const { MIN_DELAY_MS, MAX_DELAY_MS } = require('./constants');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomDelay(minMs = MIN_DELAY_MS, maxMs = MAX_DELAY_MS) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

// ---------------------------------------------------------------------------------
// Structured logging (Phase 6.1)
// ---------------------------------------------------------------------------------
//
// Two output modes, switched process-wide by setLogFormat() - cli.js flips it once per
// invocation, from config.log.format (file/env/flow.config/--log=json, see config.js):
//
//   'text' (default) - today's "[iso] message" / "[iso] WARN message" line, byte-for-
//                      byte unchanged from before this phase. Every call site that never
//                      passes `meta` produces exactly the same text it always has.
//   'json'           - one JSON object per line - NDJSON/JSONL, deliberately NOT a JSON
//                      array, so a streaming consumer (a cloud agent tailing the process)
//                      can parse each line as it arrives instead of waiting for the run
//                      to finish and the array to close.
//
// Every call site keeps calling logInfo/logWarn/logError(message) exactly as before; an
// OPTIONAL second `meta` object lets a call site opportunistically attach structure that
// only matters in json mode - `event`, `path`, `siteId`, or any other field. A call site
// that never passes `meta` still produces a valid json line: `event` falls back to
// EVENT.GENERIC, and `siteId` falls back to whatever setLogSiteId() last recorded (or is
// omitted entirely - some log lines, e.g. a bad CLI flag, happen before a site id is
// known at all).
//
// ---------------------------------------------------------------------------------
// EVENT VOCABULARY
// ---------------------------------------------------------------------------------
// Deliberately small and closed. A new call site should reach for one of these before
// inventing a new tag - Phase 6.2 (batch running) and any future consumer of the json
// log / run records key off this exact set:
//
//   generic                    no more specific event applies (the default)
//   requires-headed-resolved   flow.requiresHeaded was set, explicitly or via the probe
//   recording-started          record: the browser is up, R/F overlay is armed
//   recording-completed        record: actions -> steps folded, about to self-verify
//   verify-report              verify: the per-step verification report (verify.js)
//   play-started                play: about to run the flow
//   play-completed              play: the run finished (totals line)
//   step-fallback                a candidate resolved on a non-primary selector
//   step-warning                  a step produced a non-fatal warning
//   step-failed                    a step failed outright
//   output-written                  CSV/JSON rows were written to --out
//   drift-ok                        drift check passed
//   drift-detected                   drift check came back WARNING or BROKEN
//   run-record-write-failed          writing sites/<id>/runs/<iso>.json itself failed
//   run-batch-started                run --all: the site list has been resolved, about to start
//   run-site-completed               run --all: one site's play() finished (or threw)
//   run-batch-completed              run --all: every site has been attempted
//
const EVENT = {
  GENERIC: 'generic',
  REQUIRES_HEADED_RESOLVED: 'requires-headed-resolved',
  RECORDING_STARTED: 'recording-started',
  RECORDING_COMPLETED: 'recording-completed',
  VERIFY_REPORT: 'verify-report',
  PLAY_STARTED: 'play-started',
  PLAY_COMPLETED: 'play-completed',
  STEP_FALLBACK: 'step-fallback',
  STEP_WARNING: 'step-warning',
  STEP_FAILED: 'step-failed',
  OUTPUT_WRITTEN: 'output-written',
  DRIFT_OK: 'drift-ok',
  DRIFT_DETECTED: 'drift-detected',
  RUN_RECORD_WRITE_FAILED: 'run-record-write-failed',
  RUN_BATCH_STARTED: 'run-batch-started',
  RUN_SITE_COMPLETED: 'run-site-completed',
  RUN_BATCH_COMPLETED: 'run-batch-completed',
};

let logFormat = 'text';
let currentSiteId;

// cli.js calls this once per invocation (as early as possible - see cli.js's use of the
// raw --log flag before config is even loaded, and again once config.log.format is known
// from the full file/env/flow/CLI merge). Anything other than the literal 'json' means
// text - an unrecognised value is not a reason to make logging itself fail.
function setLogFormat(format) {
  logFormat = format === 'json' ? 'json' : 'text';
}

function getLogFormat() {
  return logFormat;
}

// The site a command is currently operating on, so log lines don't have to pass siteId
// individually at every call site. Not all commands have one (`list`, a bad CLI flag
// before --id is even parsed) - those log lines simply omit siteId.
function setLogSiteId(siteId) {
  currentSiteId = siteId;
}

function clearLogSiteId() {
  currentSiteId = undefined;
}

function emitJsonLine(level, message, meta, stream) {
  const line = { level, ts: new Date().toISOString() };
  const siteId = meta.siteId !== undefined ? meta.siteId : currentSiteId;
  if (siteId !== undefined) line.siteId = siteId;
  line.event = meta.event || EVENT.GENERIC;
  if (meta.path !== undefined) line.path = meta.path;
  line.message = message;
  // Any other opportunistic field a call site passed (candidateIndex, selector, type,
  // ...) rides along too, without clobbering the fields fixed above.
  for (const key of Object.keys(meta)) {
    if (key === 'siteId' || key === 'event' || key === 'path') continue;
    line[key] = meta[key];
  }
  stream(JSON.stringify(line));
}

// toISOString() is always UTC, so every log line is timestamped in UTC regardless of
// the machine's local timezone - useful when runs are compared across machines, or
// scheduled via cron in some other zone.
function logInfo(message, meta = {}) {
  if (logFormat === 'json') return emitJsonLine('info', message, meta, console.log);
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logWarn(message, meta = {}) {
  if (logFormat === 'json') return emitJsonLine('warn', message, meta, console.warn);
  console.warn(`[${new Date().toISOString()}] WARN ${message}`);
}

function logError(message, meta = {}) {
  if (logFormat === 'json') return emitJsonLine('error', message, meta, console.error);
  console.error(`[${new Date().toISOString()}] ERROR ${message}`);
}

module.exports = {
  sleep,
  randomDelay,
  logInfo,
  logWarn,
  logError,
  setLogFormat,
  getLogFormat,
  setLogSiteId,
  clearLogSiteId,
  EVENT,
};
