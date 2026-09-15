// cli-config-command.test.js - `config --id=<id>` prints the fully-resolved effective
// config exactly as loadConfig() would build it for a real play/verify run (src/cli.js's
// cmdConfig), so a user can see what value is actually in effect after all 5 layers
// merge without tracing loadConfig() by hand. Same execSync-against-a-tmp-cwd pattern as
// test/cli-ergonomics.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function extractJsonBlock(output) {
  // cmdConfig prints JSON.stringify(config, null, 2) followed by "# ..." comment lines -
  // parse just the JSON object at the top.
  const end = output.indexOf('\n# resolved from layers:');
  assert.notStrictEqual(end, -1, 'output should contain the "# resolved from layers:" marker');
  return JSON.parse(output.slice(0, end));
}

test('config prints the resolved config, reflecting a replayright.config.json override', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-config-cmd-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'replayright.config.json'),
      JSON.stringify({ timeouts: { settleMs: 9999 } }, null, 2)
    );
    const output = execSync(`node ${JSON.stringify(CLI)} config --id=no-such-site`, {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    const config = extractJsonBlock(output);
    assert.strictEqual(config.timeouts.settleMs, 9999, 'file layer should override the default settleMs');
    assert(output.includes('defaults -> file'), 'layers line should show defaults -> file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('config reflects flow.config and a CLI flag, at the documented precedence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-config-cmd-'));
  const siteId = 'config-cmd-site';
  const siteDir = path.join(tmpDir, 'sites', siteId);
  try {
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(
      path.join(siteDir, 'flow.json'),
      JSON.stringify({
        startUrl: 'https://example.com',
        steps: [{ kind: 'action', action: { name: 'click' }, selectors: ['button'] }],
        verified: false,
        requiresHeaded: false,
        config: { timeouts: { settleMs: 1111 }, repeat: { defaultTimes: 3 } },
      }, null, 2)
    );

    // No CLI --times override: flow.config's repeat.defaultTimes should win over the default.
    const withoutOverride = extractJsonBlock(
      execSync(`node ${JSON.stringify(CLI)} config --id=${siteId} --sites-dir=${JSON.stringify(path.join(tmpDir, 'sites'))}`, {
        cwd: tmpDir,
        encoding: 'utf8',
      })
    );
    assert.strictEqual(withoutOverride.timeouts.settleMs, 1111, 'flow.config layer should apply');
    assert.strictEqual(withoutOverride.repeat.defaultTimes, 3, 'flow.config layer should apply');

    // --times on the CLI should win over flow.config's repeat.defaultTimes (CLI is the
    // highest layer per config.js's loadConfig()).
    const withOverride = extractJsonBlock(
      execSync(`node ${JSON.stringify(CLI)} config --id=${siteId} --sites-dir=${JSON.stringify(path.join(tmpDir, 'sites'))} --times=7`, {
        cwd: tmpDir,
        encoding: 'utf8',
      })
    );
    assert.strictEqual(withOverride.repeat.defaultTimes, 7, 'CLI --times should win over flow.config');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('config works for a site with no flow.json yet, warning instead of failing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-config-cmd-'));
  try {
    const output = execSync(`node ${JSON.stringify(CLI)} config --id=never-recorded`, {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const config = extractJsonBlock(output);
    assert.strictEqual(config.sitesDir, './sites', 'should print plain defaults with no flow/config file present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
