// run-record.js - Phase 6.1 structured reports.
//
// One JSON file per run of `play` (mandatory - it's what a cron job runs unattended) and
// `verify` (also written, on the same judgment call: a cloud agent re-running verify
// wants the same machine-readable record `play` gets). Written to
// sites/<id>/runs/<iso>.json so a cloud agent can read what happened without scraping
// stdout - the run's own exit code, counts, fallbacks/warnings/errors, drift status and
// output path, all in one place.
//
// Filename: the ISO timestamp of the run's START, sanitized for a filesystem - colons
// and dots aren't valid in a Windows filename (this project is Linux/macOS in practice,
// but sanitizing costs nothing and keeps that door open):
//   2026-08-19T14:30:00.000Z -> 2026-08-19T14-30-00-000Z
const fs = require('fs');
const path = require('path');
const { logWarn, EVENT } = require('./log');

function sanitizeTimestamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

function runsDir(siteDir) {
  return path.join(siteDir, 'runs');
}

// Builds the plain-object contents of one run record. Split from writeRunRecord() so
// callers/tests can inspect the shape without touching disk.
//
//   command      'play' | 'verify'
//   siteId
//   startedAt    Date - when this run began
//   durationMs   wall-clock ms for the whole run
//   exitCode     the process exit code this run actually produced (0 or 1)
//   stats        interpret.js's stats object (actions/repeatIterations/foreachIterations/
//                fallbacks/warnings/errors/aborted) - counts and the fallback/warning/
//                error lists are lifted straight from it, so this can never drift out of
//                sync with what interpret.js actually tracks.
//   driftStatus  'OK' | 'WARNING' | 'BROKEN', or null when this run kind doesn't drift-check
//   driftIssues  drift.classifyDrift()'s issues array, or null
//   outputPath   the resolved --out path actually written this run, or null
function buildRunRecord({
  command,
  siteId,
  startedAt,
  durationMs,
  exitCode,
  stats,
  driftStatus = null,
  driftIssues = null,
  outputPath = null,
}) {
  return {
    command,
    siteId,
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode,
    counts: {
      actions: stats?.actions ?? 0,
      repeatIterations: stats?.repeatIterations ?? 0,
      foreachIterations: stats?.foreachIterations ?? 0,
    },
    fallbacks: stats?.fallbacks ?? [],
    warnings: stats?.warnings ?? [],
    errors: stats?.errors ?? [],
    aborted: stats?.aborted ?? null,
    drift: driftStatus ? { status: driftStatus, issues: driftIssues || [] } : null,
    outputPath,
  };
}

// Never throws. A run record is meta-information ABOUT the run; the run itself already
// happened and its exit code is already decided by the time this is called. Disk full,
// permissions, a `runs` path that collides with an existing file - any of that degrades
// to a warning, not a crash, so a bad filesystem on the meta-record side can never take
// down the actual scheduled job. Returns the path written, or null on failure.
function writeRunRecord(siteDir, record) {
  const dir = runsDir(siteDir);
  const filePath = path.join(dir, `${sanitizeTimestamp(record.startedAt)}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
    return filePath;
  } catch (err) {
    logWarn(`could not write run record to ${path.relative(process.cwd(), filePath)}: ${err.message}`, {
      event: EVENT.RUN_RECORD_WRITE_FAILED,
      siteId: record.siteId,
    });
    return null;
  }
}

module.exports = { buildRunRecord, writeRunRecord, runsDir, sanitizeTimestamp };
