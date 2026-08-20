// batch-run.test.js - Phase 6.2: `run --all [--concurrency=N] [--tag=<tag>]`.
//
// Hand-builds flow.json files directly into a temp sitesDir (same pattern as
// test/exit-codes.test.js and test/cli-ergonomics.test.js) rather than recording -
// what's under test here is the batch aggregation/filtering/isolation logic in cli.js's
// cmdRun, not recording or a single play() run (those are covered elsewhere). Every real
// play() run underneath still shells out through the actual CLI (execSync), so what's
// asserted is exactly what a cron job or cloud agent driving `run --all` would see on
// stdout and on disk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { runsDir } = require('../src/run-record');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

// A "good" flow: one repeat iteration that clicks the paged fixture's real #next link -
// one real action, no unresolved selector, nothing aborted, so play() exits 0.
function goodFlow(siteId, extra = {}) {
  return {
    siteId,
    startUrl: fixture('paged', 'page1.html'),
    verified: true,
    requiresHeaded: false,
    steps: [
      {
        kind: 'repeat',
        times: 1,
        body: [
          { kind: 'action', scope: 'page', selectors: ['#next'], action: { name: 'click' } },
        ],
      },
    ],
    ...extra,
  };
}

// A "broken" flow: same shape as test/exit-codes.test.js's SELECTOR_UNRESOLVED case - a
// plain action step (not the loop-advance) targeting a selector that cannot possibly
// resolve, which play() reports as EXIT_CODE.SELECTOR_UNRESOLVED (11).
function brokenFlow(siteId) {
  return {
    siteId,
    startUrl: fixture('paged', 'page1.html'),
    verified: true,
    requiresHeaded: false,
    steps: [
      {
        kind: 'repeat',
        times: 1,
        body: [
          { kind: 'action', scope: 'page', selectors: ['#this-selector-does-not-exist-anywhere'], action: { name: 'click' } },
        ],
      },
    ],
  };
}

function writeSite(sitesDir, siteId, flowOrRawText) {
  const dir = path.join(sitesDir, siteId);
  fs.mkdirSync(dir, { recursive: true });
  const contents = typeof flowOrRawText === 'string' ? flowOrRawText : JSON.stringify(flowOrRawText, null, 2);
  fs.writeFileSync(path.join(dir, 'flow.json'), contents);
  return dir;
}

// Merges stdout+stderr (logWarn/logError go through console.warn/console.error, i.e.
// stderr) the same way test/structured-reports.test.js's run() does, and never throws on
// a non-zero exit - `run --all` legitimately exits 1 when a site failed.
function runCli(args, opts = {}) {
  try {
    const stdout = execSync(`node ${JSON.stringify(CLI)} ${args} 2>&1`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: err.stdout?.toString() ?? '', status: err.status };
  }
}

function tmpSitesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-batch-run-'));
}

test('run --all: a mixed batch aggregates a non-zero exit when at least one site fails', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'good-a', goodFlow('good-a'));
    writeSite(sitesDir, 'broken-a', brokenFlow('broken-a'));

    const { stdout, status } = runCli(`run --all --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 1, `expected a non-zero aggregate exit; output:\n${stdout}`);
    assert.match(stdout, /good-a: exit=0/);
    assert.match(stdout, /broken-a: exit=11/);
    assert.match(stdout, /1\/2 site\(s\) succeeded/);

    // Both sites were actually attempted - one site's failure did not stop the other.
    assert.ok(fs.readdirSync(runsDir(path.join(sitesDir, 'good-a'))).length >= 1);
    assert.ok(fs.readdirSync(runsDir(path.join(sitesDir, 'broken-a'))).length >= 1);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run --all: an all-success batch exits 0', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'good-a', goodFlow('good-a'));
    writeSite(sitesDir, 'good-b', goodFlow('good-b'));

    const { stdout, status } = runCli(`run --all --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 0, `expected a clean aggregate exit; output:\n${stdout}`);
    assert.match(stdout, /good-a: exit=0/);
    assert.match(stdout, /good-b: exit=0/);
    assert.match(stdout, /2\/2 site\(s\) succeeded/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run --all --tag=<tag> only plays sites carrying that tag', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'daily-a', goodFlow('daily-a', { tags: ['daily'] }));
    writeSite(sitesDir, 'daily-b', goodFlow('daily-b', { tags: ['daily', 'jobs'] }));
    writeSite(sitesDir, 'weekly-a', goodFlow('weekly-a', { tags: ['weekly'] }));
    writeSite(sitesDir, 'untagged-a', goodFlow('untagged-a'));

    const { stdout, status } = runCli(`run --all --tag=daily --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 0, `expected a clean aggregate exit; output:\n${stdout}`);
    assert.match(stdout, /2 site\(s\) tagged "daily"/);
    assert.match(stdout, /daily-a: exit=0/);
    assert.match(stdout, /daily-b: exit=0/);
    assert.doesNotMatch(stdout, /weekly-a/);
    assert.doesNotMatch(stdout, /untagged-a/);

    // The tagged sites actually ran (a runs/ dir exists); the untagged/differently-tagged
    // ones were never touched by play() at all, so their runs/ dir was never created.
    assert.ok(fs.existsSync(runsDir(path.join(sitesDir, 'daily-a'))));
    assert.ok(fs.existsSync(runsDir(path.join(sitesDir, 'daily-b'))));
    assert.ok(!fs.existsSync(runsDir(path.join(sitesDir, 'weekly-a'))));
    assert.ok(!fs.existsSync(runsDir(path.join(sitesDir, 'untagged-a'))));
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run --all: no site matching --tag is not treated as a failure', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'weekly-a', goodFlow('weekly-a', { tags: ['weekly'] }));

    const { stdout, status } = runCli(`run --all --tag=nope --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 0, `an empty tag match should not fail the batch; output:\n${stdout}`);
    assert.match(stdout, /no recorded sites tagged "nope"/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run --all: one site throwing an outright exception does not stop the rest of the batch', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'good-a', goodFlow('good-a'));
    // Not just a bad exitCode - flow.json itself fails to parse, so play() throws before
    // it ever gets to run anything for this site.
    writeSite(sitesDir, 'corrupt-a', '{ this is not valid json');
    writeSite(sitesDir, 'good-b', goodFlow('good-b'));

    const { stdout, status } = runCli(`run --all --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 1, `expected a non-zero aggregate exit; output:\n${stdout}`);
    assert.match(stdout, /good-a: exit=0/);
    assert.match(stdout, /good-b: exit=0/);
    // The broken site is reported with its thrown error as the reason, exit=1 (a plain
    // exception has no distinct EXIT_CODE of its own to report).
    assert.match(stdout, /corrupt-a: exit=1/);
    assert.match(stdout, /2\/3 site\(s\) succeeded/);

    // The two good sites actually ran despite corrupt-a throwing.
    assert.ok(fs.readdirSync(runsDir(path.join(sitesDir, 'good-a'))).length >= 1);
    assert.ok(fs.readdirSync(runsDir(path.join(sitesDir, 'good-b'))).length >= 1);
    // corrupt-a never got far enough to write a run record at all.
    assert.ok(!fs.existsSync(runsDir(path.join(sitesDir, 'corrupt-a'))));
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run --all --concurrency=1 (default, sequential) runs every site', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'good-a', goodFlow('good-a'));
    writeSite(sitesDir, 'good-b', goodFlow('good-b'));

    const { stdout, status } = runCli(`run --all --concurrency=1 --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 0, `output:\n${stdout}`);
    assert.match(stdout, /2\/2 site\(s\) succeeded/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run --all --concurrency=N with N greater than the site count does not crash', async () => {
  const sitesDir = tmpSitesDir();
  try {
    writeSite(sitesDir, 'good-a', goodFlow('good-a'));
    writeSite(sitesDir, 'good-b', goodFlow('good-b'));

    const { stdout, status } = runCli(`run --all --concurrency=10 --sites-dir=${JSON.stringify(sitesDir)} --headless=true`);

    assert.strictEqual(status, 0, `output:\n${stdout}`);
    assert.match(stdout, /good-a: exit=0/);
    assert.match(stdout, /good-b: exit=0/);
    assert.match(stdout, /2\/2 site\(s\) succeeded/);
    // The concurrency>1 caveat about interleaved siteId attribution should be surfaced.
    assert.match(stdout, /--concurrency=10/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('run without --all is a clear error, not a silent no-op', async () => {
  const sitesDir = tmpSitesDir();
  try {
    const { stdout, status } = runCli(`run --sites-dir=${JSON.stringify(sitesDir)}`);
    assert.notStrictEqual(status, 0);
    assert.match(stdout, /needs --all/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
