// structured-reports.test.js - Phase 6.1: --log=json (NDJSON) and the per-run
// sites/<id>/runs/<iso>.json report written by play/verify.
//
// Drives a real recording (via recordSite()'s `drive` seam, same pattern as
// test/record.test.js) into a temp sitesDir, then shells out to the actual CLI
// (execSync) for the play/verify runs under test - the thing that matters here is
// exactly what a cron job or cloud agent would see on stdout and on disk, so going
// through cli.js's real argv path (not calling its internals directly) is deliberate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { recordSite } = require('../src/record');
const { runsDir } = require('../src/run-record');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

async function recordMinimalFlow(siteId, sitesDir) {
  return recordSite({
    siteId,
    url: fixture('paged', 'page1.html'),
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    sitesDir,
    drive: async (page) => {
      await page.getByRole('button', { name: 'playright:R:start' }).click();
      const next = await page.locator('#next').boundingBox();
      await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);
      await page.getByRole('button', { name: 'playright:R:end' }).click();
    },
  });
}

// Both `stdout` (the merge of stdout+stderr, since logWarn/logError go through
// console.warn/console.error - i.e. stderr - and a cloud agent tailing this process
// would read both streams together) and `stdoutOnly` (info-level lines only) are
// returned, since some assertions care specifically about one or the other.
function run(args, opts = {}) {
  try {
    const stdout = execSync(`node ${JSON.stringify(CLI)} ${args} 2>&1`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { stdout, status: 0 };
  } catch (err) {
    // play/verify may legitimately exit non-zero; execSync throws on that, so surface
    // stdout/status the same way either way rather than letting the test crash.
    return { stdout: err.stdout?.toString() ?? '', status: err.status };
  }
}

test('--log=json produces one valid JSON object per line, with plausible fields', async () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-structured-'));
  const siteId = 'json-log-check';
  try {
    await recordMinimalFlow(siteId, sitesDir);

    const { stdout } = run(`play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true --log=json`);

    const lines = stdout.split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 0, 'expected at least one log line');

    for (const line of lines) {
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `line was not valid JSON: ${line}`);
      assert.match(parsed.level, /^(info|warn|error)$/);
      assert.ok(parsed.ts && !Number.isNaN(Date.parse(parsed.ts)), 'ts should be a parseable ISO timestamp');
      assert.strictEqual(typeof parsed.event, 'string');
      assert.strictEqual(typeof parsed.message, 'string');
    }

    // The play-completed line specifically should carry the play siteId and event tag.
    const completed = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'play-completed');
    assert.ok(completed, 'expected a play-completed line');
    assert.strictEqual(completed.siteId, siteId);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('default text log output is unchanged: "[iso] message" / "[iso] WARN ..." lines', async () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-structured-'));
  const siteId = 'text-log-check';
  try {
    await recordMinimalFlow(siteId, sitesDir);

    const { stdout } = run(`play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    const lines = stdout.split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 0, 'expected at least one log line');
    for (const line of lines) {
      assert.throws(() => JSON.parse(line), `text-mode line unexpectedly parsed as valid JSON: ${line}`);
      assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/, `line did not start with an ISO-bracket timestamp: ${line}`);
    }
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('play writes sites/<id>/runs/<iso>.json with fields matching the actual run', async () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-structured-'));
  const siteId = 'run-record-check';
  try {
    await recordMinimalFlow(siteId, sitesDir);

    const { status } = run(`play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    const dir = runsDir(path.join(sitesDir, siteId));
    assert.ok(fs.existsSync(dir), 'runs/ directory should have been created');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, 1, `expected exactly one run record, got ${JSON.stringify(files)}`);

    const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.strictEqual(record.command, 'play');
    assert.strictEqual(record.siteId, siteId);
    assert.strictEqual(record.exitCode, status ?? 0);
    assert.strictEqual(typeof record.durationMs, 'number');
    assert.ok(record.durationMs >= 0);
    assert.ok(record.counts.repeatIterations >= 1, 'the single repeat block should have run at least once');
    assert.ok(record.drift && ['OK', 'WARNING', 'BROKEN'].includes(record.drift.status));
    // First run ever for this site: no baseline yet, so drift can only be OK.
    assert.strictEqual(record.drift.status, 'OK');
    assert.strictEqual(record.exitCode, 0);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('a run-record write failure degrades to a warning, not a crash - play still completes with its real exit code', async () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-structured-'));
  const siteId = 'run-record-write-fails';
  try {
    await recordMinimalFlow(siteId, sitesDir);

    // Make sites/<id>/runs impossible to create as a directory by pre-creating it as a
    // plain file - fs.mkdirSync(..., {recursive:true}) then throws EEXIST/ENOTDIR
    // instead of silently succeeding.
    fs.writeFileSync(path.join(sitesDir, siteId, 'runs'), 'not a directory');

    const { stdout, status } = run(`play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true --log=json`);

    // The run itself still completed and reported its real (successful) exit code -
    // the run-record write failure must not have taken the process down or flipped it
    // to a failure exit code of its own.
    assert.strictEqual(status ?? 0, 0);

    const lines = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const warning = lines.find((l) => l.event === 'run-record-write-failed');
    assert.ok(warning, 'expected a run-record-write-failed warning line');
    assert.strictEqual(warning.level, 'warn');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
