// A flow referencing a {{env:NAME}} placeholder (see src/secrets.js) whose env var
// isn't set must fail immediately - before Xvfb/Chromium/any browser work - rather
// than deep inside a step failure. Proven via the real CLI (same execSync pattern as
// test/exit-codes.test.js) so the preflight check in cli.js's cmdPlay/cmdVerify is
// exercised end-to-end, not just interpret.js's per-step resolution (see
// test/secrets.test.js for that).
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

function writeSecretFlow(sitesDir, siteId) {
  const siteDir = path.join(sitesDir, siteId);
  fs.mkdirSync(siteDir, { recursive: true });
  const flow = {
    siteId,
    startUrl: fixture('fill', 'index.html'),
    verified: true,
    requiresHeaded: false,
    steps: [
      {
        kind: 'repeat',
        times: 1,
        body: [
          { kind: 'action', scope: 'page', selectors: ['#secret-field'], action: { name: 'fill', text: '{{env:REPLAYRIGHT_TEST_PREFLIGHT_SECRET}}' } },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(flow, null, 2));
  return siteDir;
}

function run(args, env) {
  try {
    const stdout = execSync(`node ${JSON.stringify(CLI)} ${args}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

test('play fails fast, naming the missing variable, when a fill placeholder is unresolved', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-secrets-preflight-'));
  const siteId = 'secrets-preflight-play';
  const siteDir = writeSecretFlow(sitesDir, siteId);
  const env = { ...process.env };
  delete env.REPLAYRIGHT_TEST_PREFLIGHT_SECRET;

  try {
    const { status, stderr } = run(`play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, env);

    assert.notStrictEqual(status, 0);
    assert.match(stderr, /REPLAYRIGHT_TEST_PREFLIGHT_SECRET/);

    // No run-record should exist at all - the check runs before any browser work,
    // so play() itself never got far enough to write one.
    const dir = runsDir(siteDir);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    assert.strictEqual(files.length, 0, 'no run-record should be written when the preflight check fails');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('play succeeds once the referenced environment variable is set', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-secrets-preflight-'));
  const siteId = 'secrets-preflight-play-ok';
  writeSecretFlow(sitesDir, siteId);

  try {
    const { status } = run(
      `play --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`,
      { REPLAYRIGHT_TEST_PREFLIGHT_SECRET: 'hunter2' }
    );
    assert.strictEqual(status, 0);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('verify fails fast, naming the missing variable, when a fill placeholder is unresolved', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-secrets-preflight-'));
  const siteId = 'secrets-preflight-verify';
  writeSecretFlow(sitesDir, siteId);
  const env = { ...process.env };
  delete env.REPLAYRIGHT_TEST_PREFLIGHT_SECRET;

  try {
    const { status, stderr } = run(`verify --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, env);

    assert.notStrictEqual(status, 0);
    assert.match(stderr, /REPLAYRIGHT_TEST_PREFLIGHT_SECRET/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
