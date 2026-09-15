// cli-validate-command.test.js - `validate --id=<id>` (src/cli.js's cmdValidate), a static
// no-browser/no-network shape check over src/flow-validate.js. execSync-against-a-tmp-
// sites-dir pattern, same as test/cli-tag-command.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function writeFlow(sitesDir, siteId, flow) {
  const dir = path.join(sitesDir, siteId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(flow, null, 2));
}

test('validate exits 0 and reports valid for a well-formed flow', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-validate-cmd-'));
  const siteId = 'valid-flow';
  try {
    writeFlow(sitesDir, siteId, {
      startUrl: 'https://example.com',
      steps: [{ kind: 'action', action: { name: 'click' }, selectors: ['button'] }],
    });
    const output = execSync(`node ${JSON.stringify(CLI)} validate --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)}`, { encoding: 'utf8' });
    assert.match(output, /structurally valid/);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('validate exits 1 and names the bad step for a broken flow', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-validate-cmd-'));
  const siteId = 'broken-flow';
  try {
    writeFlow(sitesDir, siteId, {
      startUrl: 'https://example.com',
      steps: [{ kind: 'foreach', body: [{ kind: 'extract' }] }],
    });
    let threw = false;
    try {
      execSync(`node ${JSON.stringify(CLI)} validate --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)}`, { stdio: 'pipe', encoding: 'utf8' });
    } catch (err) {
      threw = true;
      const combined = (err.stdout || '') + (err.stderr || '');
      assert.match(combined, /parentSelectors/);
      assert.match(combined, /missing "key"/);
      assert.strictEqual(err.status, 1);
    }
    assert.ok(threw, 'validate should exit non-zero for a structurally broken flow');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
