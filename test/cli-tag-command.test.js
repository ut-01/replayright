// cli-tag-command.test.js - `tag --id=<id> --add/--remove=<name>` (src/cli.js's cmdTag),
// the first code to ever write flow.json's top-level "tags" array - previously exclusively
// hand-edited (see sites/_template/README.md's "run --all and tags" section, and
// enumerateSitesForRun's --tag filter in cli.js). Closes the loop end-to-end: a tag added
// this way is picked up by `run --all --tag=<name>`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

function makeSite(sitesDir, siteId, tags) {
  const dir = path.join(sitesDir, siteId);
  fs.mkdirSync(dir, { recursive: true });
  const flow = {
    startUrl: fixture('paged', 'page1.html'),
    steps: [{ kind: 'action', action: { name: 'click' }, selectors: ['button'] }],
    verified: false,
    requiresHeaded: false,
  };
  if (tags) flow.tags = tags;
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(flow, null, 2));
  return dir;
}

function readTags(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8')).tags;
}

test('tag --add adds a tag to an untagged flow', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-tag-cmd-'));
  const siteId = 'untagged-site';
  try {
    const dir = makeSite(sitesDir, siteId, undefined);
    execSync(`node ${JSON.stringify(CLI)} tag --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --add=daily`, { stdio: 'pipe' });
    assert.deepStrictEqual(readTags(dir), ['daily']);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('tag --add does not duplicate an already-present tag', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-tag-cmd-'));
  const siteId = 'already-tagged-site';
  try {
    const dir = makeSite(sitesDir, siteId, ['daily']);
    execSync(`node ${JSON.stringify(CLI)} tag --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --add=daily`, { stdio: 'pipe' });
    assert.deepStrictEqual(readTags(dir), ['daily']);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('tag --remove removes a present tag and no-ops on an absent one', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-tag-cmd-'));
  const siteId = 'remove-tag-site';
  try {
    const dir = makeSite(sitesDir, siteId, ['daily', 'jobs']);
    execSync(`node ${JSON.stringify(CLI)} tag --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --remove=daily`, { stdio: 'pipe' });
    assert.deepStrictEqual(readTags(dir), ['jobs']);

    execSync(`node ${JSON.stringify(CLI)} tag --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --remove=not-there`, { stdio: 'pipe' });
    assert.deepStrictEqual(readTags(dir), ['jobs'], 'removing an absent tag is a no-op, not an error');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('add and remove in the same call both apply', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-tag-cmd-'));
  const siteId = 'add-and-remove-site';
  try {
    const dir = makeSite(sitesDir, siteId, ['jobs']);
    execSync(`node ${JSON.stringify(CLI)} tag --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --add=daily --remove=jobs`, { stdio: 'pipe' });
    assert.deepStrictEqual(readTags(dir), ['daily']);
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('a tag added via the CLI is picked up by run --all --tag=<name>', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-tag-cmd-'));
  const siteId = 'run-all-tag-site';
  try {
    makeSite(sitesDir, siteId, undefined);
    execSync(`node ${JSON.stringify(CLI)} tag --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --add=nightly`, { stdio: 'pipe' });

    // The fixture flow's fake "button" selector never resolves, so the batch itself fails
    // (exit 1) - irrelevant here. What this test checks is only that enumerateSitesForRun's
    // --tag filter picked up the tag `tag --add` just wrote, which shows up as this site
    // being attempted (and reported) at all, on either stdout or the thrown error's output.
    let output;
    try {
      output = execSync(
        `node ${JSON.stringify(CLI)} run --all --tag=nightly --sites-dir=${JSON.stringify(sitesDir)} --headless=true`,
        { encoding: 'utf8' }
      );
    } catch (err) {
      output = (err.stdout || '') + (err.stderr || '');
    }
    assert(output.includes(siteId), 'run --all --tag=nightly should have attempted the newly-tagged site');
    assert(output.includes('1 site(s) tagged "nightly"'), 'the tag filter should have matched exactly the tagged site');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
