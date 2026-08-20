// exit-codes.test.js - Phase 6.3: play's distinct exit codes (src/constants.js#EXIT_CODE).
//
// Hand-built flow.json (same pattern test/interpret.test.js uses). Every step here lives
// inside a `repeat` block - interpret.js only gives per-step error handling
// (handleError/recordStepError, which is what turns a thrown SELECTOR_UNRESOLVED into a
// recorded stats.errors entry instead of an uncaught throw) to steps running inside a
// repeat's body. A bare top-level action/foreach has no such protection, since every real
// recording's body lives inside R by construction (CLAUDE.md) - so these flows use a
// `repeat` with times:1 and no `untilGone`, purely to get realistic error handling, not to
// exercise looping itself.
//
// Also deliberately NOT using a repeat's own loop-advance action to trigger
// SELECTOR_UNRESOLVED - a missing "next page" control is the NORMAL way a repeat ends (see
// structured-reports.test.js's "skipping the loop-advance action - no element matches"),
// not an error, so that path can never exercise exit code 11. A plain non-advance action
// step is what actually throws it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { EXIT_CODE } = require('../src/constants');
const { runsDir } = require('../src/run-record');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

test('play exits with EXIT_CODE.SELECTOR_UNRESOLVED (11), not a generic 1, when a step cannot resolve', async () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-exitcode-'));
  const siteId = 'exit-code-unresolved';
  const siteDir = path.join(sitesDir, siteId);
  fs.mkdirSync(siteDir, { recursive: true });

  const flow = {
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
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(flow, null, 2));

  try {
    let status = 0;
    try {
      execSync(`node ${JSON.stringify(CLI)} play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
    }

    assert.strictEqual(status, EXIT_CODE.SELECTOR_UNRESOLVED);
    assert.strictEqual(status, 11);

    const dir = runsDir(siteDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);
    const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.strictEqual(record.exitCode, EXIT_CODE.SELECTOR_UNRESOLVED);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('play exits with EXIT_CODE.ZERO_ACTIONS (12) when the flow completes but performs no actions', async () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-exitcode-'));
  const siteId = 'exit-code-zero-actions';
  const siteDir = path.join(sitesDir, siteId);
  fs.mkdirSync(siteDir, { recursive: true });

  // A repeat that runs (one iteration, no errors) but whose body performs no actions
  // at all - the cleanest way to reach EXIT_CODE.ZERO_ACTIONS without also tripping a
  // SELECTOR_UNRESOLVED (which would take priority per the documented order and is
  // covered by the test above).
  const flow = {
    siteId,
    startUrl: fixture('paged', 'page1.html'),
    verified: true,
    requiresHeaded: false,
    steps: [
      { kind: 'repeat', times: 1, body: [] },
    ],
  };
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(flow, null, 2));

  try {
    let status = 0;
    try {
      execSync(`node ${JSON.stringify(CLI)} play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
    }

    assert.strictEqual(status, EXIT_CODE.ZERO_ACTIONS);
    assert.strictEqual(status, 12);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
