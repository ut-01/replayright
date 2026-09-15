// cli-list-command.test.js - richer `list` output (src/cli.js's cmdList): aligned
// columns, tags, and last-run status pulled from sites/<id>/runs/<iso>.json
// (src/run-record.js), plus a --porcelain escape hatch that reproduces the original
// plain tab-separated format for any script parsing `list`'s output.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function writeFlow(sitesDir, siteId, extra = {}) {
  const dir = path.join(sitesDir, siteId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify({
    startUrl: 'https://example.com',
    steps: [{ kind: 'action', action: { name: 'click' }, selectors: ['button'] }],
    verified: false,
    requiresHeaded: false,
    ...extra,
  }, null, 2));
  return dir;
}

function writeRunRecord(siteDir, startedAtIso, record) {
  const dir = path.join(siteDir, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const filename = startedAtIso.replace(/[:.]/g, '-') + '.json';
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({ startedAt: startedAtIso, ...record }, null, 2));
}

test('list shows tags and "never run" for a freshly-recorded site with no runs/ yet', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-list-cmd-'));
  try {
    writeFlow(sitesDir, 'fresh-site', { tags: ['daily', 'jobs'] });
    const output = execSync(`node ${JSON.stringify(CLI)} list --sites-dir=${JSON.stringify(sitesDir)}`, { encoding: 'utf8' });
    assert.match(output, /fresh-site/);
    assert.match(output, /daily,jobs/);
    assert.match(output, /never run/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('list shows the most recent run\'s outcome and a "-" for an untagged site', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-list-cmd-'));
  try {
    const siteDir = writeFlow(sitesDir, 'run-history-site');
    writeRunRecord(siteDir, '2026-01-01T00:00:00.000Z', { exitCode: 0, drift: { status: 'OK' } });
    writeRunRecord(siteDir, '2026-01-02T00:00:00.000Z', { exitCode: 10, drift: { status: 'BROKEN' } });

    const output = execSync(`node ${JSON.stringify(CLI)} list --sites-dir=${JSON.stringify(sitesDir)}`, { encoding: 'utf8' });
    assert.match(output, /run-history-site/);
    assert.match(output, /BROKEN @ 2026-01-02/, 'should show the most recent run, not the oldest');
    assert(!output.includes('2026-01-01'), 'should not show the older run');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('list --porcelain reproduces the original plain tab-separated format', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-list-cmd-'));
  try {
    writeFlow(sitesDir, 'porcelain-site', { tags: ['daily'], verified: true });
    const output = execSync(`node ${JSON.stringify(CLI)} list --sites-dir=${JSON.stringify(sitesDir)} --porcelain`, { encoding: 'utf8' });
    assert.strictEqual(
      output.trim(),
      'porcelain-site\tverified\theadless\t1 steps\thttps://example.com'
    );
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
