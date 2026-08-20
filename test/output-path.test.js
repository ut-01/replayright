// output-path.test.js - regression test for a bug found during review: writeConfiguredOutput()
// in both cli.js and index.js hardcoded { baseDir: REPO_ROOT } when calling
// resolveOutputPath(), so a relative output.path (the default is "sites/{id}/output.csv")
// always resolved against replayright's OWN install directory instead of
// config.__meta.rootDir (cwd, or a discovered replayright.config.json's directory) - the
// same rootDir resolveSitesDir() already used correctly. The bug only shows up when the
// command is invoked from somewhere OTHER than replayright's own repo root - e.g. `npx
// replayright play` run from a project that depends on it, which is cwd = that project,
// not cwd = node_modules/replayright. So the regression test below deliberately runs the
// CLI (and, for the index.js path, changes process.cwd()) from a temp "pretend calling
// project" directory rather than relying on the test runner's own cwd - reusing the
// REPO_ROOT the test runner happens to start from would make the bug invisible even with
// the fix reverted, exactly the mistake the first version of this test made.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const REPO_ROOT = path.join(__dirname, '..');
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

// A foreach + extract flow (same shape as test/extract.test.js's hand-built flows) so
// verify writes a real output file, not just an empty run.
function extractFlow(siteId) {
  return {
    siteId,
    startUrl: fixture('paged', 'page1.html'),
    verified: false,
    requiresHeaded: false,
    steps: [
      {
        kind: 'foreach',
        parentSelectors: ['#results'],
        itemSelectors: ['li.card'],
        body: [{ kind: 'extract', key: 'Title', relativeSelectors: ['.card-link'] }],
      },
    ],
  };
}

test('verify, invoked from another project\'s directory, writes output.csv relative to THAT directory - not replayright\'s own install dir', async () => {
  // Stands in for "some other project that depends on replayright" - has its own
  // sites/<id>/flow.json, and the CLI is invoked with cwd set to here, the same way
  // `npx replayright` would be invoked from a consuming project's own directory.
  const callingProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-calling-project-'));
  const siteId = 'output-path-regression';
  const siteDir = path.join(callingProjectDir, 'sites', siteId);
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(extractFlow(siteId), null, 2));

  const repoRootLeftover = path.join(REPO_ROOT, 'sites', siteId);

  try {
    execSync(`node ${JSON.stringify(CLI)} verify --id=${siteId} --headless=true`, {
      cwd: callingProjectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const expectedOutPath = path.join(siteDir, 'output.csv');
    assert.ok(
      fs.existsSync(expectedOutPath),
      `expected output.csv next to the flow it came from, at ${expectedOutPath}`
    );
    const csv = fs.readFileSync(expectedOutPath, 'utf8');
    assert.match(csv, /Title/);

    // The bug this guards against: output.csv landing under replayright's OWN sites/
    // directory instead, because output.path resolution ignored where the command was
    // actually invoked from.
    assert.ok(
      !fs.existsSync(path.join(repoRootLeftover, 'output.csv')),
      "output.csv should not have been written under replayright's own sites/ directory"
    );
  } finally {
    fs.rmSync(callingProjectDir, { recursive: true, force: true });
    fs.rmSync(repoRootLeftover, { recursive: true, force: true });
  }
});

test("index.js's verify(), called with process.cwd() set to another project's directory, writes output.csv there too", async () => {
  const callingProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-calling-project-'));
  const siteId = 'output-path-regression-lib';
  const siteDir = path.join(callingProjectDir, 'sites', siteId);
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(extractFlow(siteId), null, 2));

  const repoRootLeftover = path.join(REPO_ROOT, 'sites', siteId);
  const originalCwd = process.cwd();

  try {
    process.chdir(callingProjectDir);
    // Fresh require so nothing about config.js's own state (there isn't any module-level
    // cwd caching, but this keeps the test honest about exercising a real fresh call)
    // carries over from another test file.
    delete require.cache[require.resolve('../index')];
    const { verify } = require('../index');
    const result = await verify({ siteId, headless: true });

    const expectedOutPath = path.join(siteDir, 'output.csv');
    assert.ok(fs.existsSync(expectedOutPath));
    // realpathSync on both sides: macOS resolves os.tmpdir() through a /tmp -> /private/tmp
    // symlink inconsistently between mkdtempSync's return value and process.chdir()'s
    // effect on a later path.resolve(), which is a platform quirk, not what this test is
    // checking - the actual claim is "same directory tree as the calling project."
    assert.strictEqual(fs.realpathSync(result.outputPath), fs.realpathSync(expectedOutPath));
    assert.ok(!fs.existsSync(path.join(repoRootLeftover, 'output.csv')));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(callingProjectDir, { recursive: true, force: true });
    fs.rmSync(repoRootLeftover, { recursive: true, force: true });
  }
});
