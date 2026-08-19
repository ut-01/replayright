// cli-ergonomics.test.js - tests for CLI usability features like init, --sites-dir
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig, defaults } = require('../src/config');
const { execSync } = require('child_process');

test('init scaffolds a config file that can be round-tripped through the loader', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-test-'));
  const originalCwd = process.cwd();

  try {
    process.chdir(tmpDir);

    // Run init command
    execSync('node ' + path.join(originalCwd, 'src', 'cli.js') + ' init', {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpDir,
    });

    // Verify the config file was created
    const configPath = path.join(tmpDir, 'replayright.config.json');
    assert(fs.existsSync(configPath), 'replayright.config.json should exist after init');

    // Verify it can be parsed as JSON
    const configText = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(configText);
    assert(typeof parsed === 'object', 'config should be an object');
    assert(parsed.sitesDir !== undefined, 'config should have sitesDir key');

    // Round-trip test: load via config.js's loader and verify it matches defaults
    const config = loadConfig({ cwd: tmpDir, searchUp: false });
    const def = defaults();
    assert.strictEqual(config.sitesDir, def.sitesDir, 'sitesDir should match default');
    assert.strictEqual(config.repeat.defaultTimes, def.repeat.defaultTimes, 'repeat.defaultTimes should match default');
    assert.strictEqual(config.timeouts.settleMs, def.timeouts.settleMs, 'timeouts.settleMs should match default');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('init refuses to overwrite an existing config file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-test-'));
  const originalCwd = process.cwd();

  try {
    process.chdir(tmpDir);

    // Create a config file
    fs.writeFileSync(
      path.join(tmpDir, 'replayright.config.json'),
      JSON.stringify({ sitesDir: './custom-sites' }, null, 2)
    );

    // Run init command - should error
    let errorThrown = false;
    try {
      execSync('node ' + path.join(originalCwd, 'src', 'cli.js') + ' init', {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });
    } catch (err) {
      errorThrown = true;
      assert(err.stderr?.toString().includes('already exists') || err.message.includes('already exists'),
        'init should refuse to overwrite existing config');
    }
    assert(errorThrown, 'init should throw an error when config already exists');

    // Verify the config file was not modified
    const configText = fs.readFileSync(path.join(tmpDir, 'replayright.config.json'), 'utf8');
    const parsed = JSON.parse(configText);
    assert.strictEqual(parsed.sitesDir, './custom-sites', 'existing config should not be modified');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--sites-dir flag changes where sites are looked up', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-test-'));
  const originalCwd = process.cwd();
  const baseSitesDir = path.join(tmpDir, 'alternate-sites');
  const testSiteId = 'test-site-locations';

  try {
    process.chdir(tmpDir);

    // Create an alternate sites directory with a test site
    fs.mkdirSync(path.join(baseSitesDir, testSiteId, 'failures'), { recursive: true });
    const testFlow = {
      startUrl: 'https://example.com',
      steps: [{ kind: 'action', action: 'click', selector: 'button' }],
      verified: false,
      requiresHeaded: false,
    };
    fs.writeFileSync(
      path.join(baseSitesDir, testSiteId, 'flow.json'),
      JSON.stringify(testFlow, null, 2)
    );

    // Create a config that points to the alternate sites dir
    fs.writeFileSync(
      path.join(tmpDir, 'replayright.config.json'),
      JSON.stringify({ sitesDir: baseSitesDir }, null, 2)
    );

    // Test that list can find the site when using the config
    const listOutput = execSync('node ' + path.join(originalCwd, 'src', 'cli.js') + ' list', {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert(listOutput.includes(testSiteId), 'list should find the site in alternate sitesDir via config');

    // Test --sites-dir flag overrides config
    const altSitesDir = path.join(tmpDir, 'another-sites');
    fs.mkdirSync(path.join(altSitesDir, 'other-site', 'failures'), { recursive: true });
    fs.writeFileSync(
      path.join(altSitesDir, 'other-site', 'flow.json'),
      JSON.stringify(testFlow, null, 2)
    );

    const listWithFlag = execSync(
      'node ' + path.join(originalCwd, 'src', 'cli.js') + ' list --sites-dir ' + altSitesDir,
      { encoding: 'utf8', cwd: tmpDir }
    );
    assert(listWithFlag.includes('other-site'), 'list with --sites-dir should find sites in the flag-specified dir');
    assert(!listWithFlag.includes(testSiteId), 'list with --sites-dir should not find sites from config dir');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// The two tests above only ever seed flow.json by hand and read it back via `list` -
// they never exercise recordSite() itself. That gap is exactly how a real bug slipped
// through: cmdRecord resolved `resolvedSitesDir` from config but never passed it into
// recordSite(), which kept calling record.js's own module-level sitePaths(siteId) hardcoded
// to REPO_ROOT/sites. So --sites-dir silently had no effect on where a *recording* landed,
// even though verify/play/list all correctly honored it - a write/read split that would
// only surface as "verify can't find the flow it just recorded". This test drives an
// actual recording (via the same `drive` seam record.test.js uses) with sitesDir pointed
// at a temp dir, and asserts flow.json lands there - not under the repo's own sites/.
test('recordSite() honors an explicit sitesDir, not just verify/play/list', async () => {
  const { recordSite } = require('../src/record');
  const { pathToFileURL } = require('node:url');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-test-sitesdir-'));
  const altSitesDir = path.join(tmpDir, 'my-sites');
  const siteId = 'sitesdir-roundtrip-check';
  const repoSitesDir = path.join(__dirname, '..', 'sites');

  try {
    const { paths } = await recordSite({
      siteId,
      url: pathToFileURL(path.join(__dirname, 'fixtures', 'paged', 'page1.html')).href,
      headless: true,
      viewport: { width: 1280, height: 900 },
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
      sitesDir: altSitesDir,
      drive: async (page) => {
        await page.getByRole('button', { name: 'playright:R:start' }).click();
        await page.getByRole('button', { name: 'playright:R:end' }).click();
      },
    });

    assert.strictEqual(paths.dir, path.join(altSitesDir, siteId));
    assert.ok(fs.existsSync(paths.flow), 'flow.json should have been written under the explicit sitesDir');
    assert.ok(
      !fs.existsSync(path.join(repoSitesDir, siteId)),
      'nothing should have been written under the repo\'s own sites/ when an explicit sitesDir was given'
    );
  } finally {
    fs.rmSync(altSitesDir, { recursive: true, force: true });
    fs.rmSync(path.join(repoSitesDir, siteId), { recursive: true, force: true });
  }
});

test('init creates example config file with comments', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-test-'));
  const originalCwd = process.cwd();

  try {
    process.chdir(tmpDir);

    // Run init command
    execSync('node ' + path.join(originalCwd, 'src', 'cli.js') + ' init', {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpDir,
    });

    // Verify the example file was created
    const examplePath = path.join(tmpDir, 'replayright.config.example.jsonc');
    assert(fs.existsSync(examplePath), 'replayright.config.example.jsonc should exist after init');

    const exampleText = fs.readFileSync(examplePath, 'utf8');
    assert(exampleText.includes('//'), 'example file should contain comments');
    assert(exampleText.includes('sitesDir'), 'example file should document sitesDir');
    assert(exampleText.includes('timeouts'), 'example file should document timeouts');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
