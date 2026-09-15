// End-to-end coverage of output.mode: 'append' (see config.js, src/output.js,
// cli.js's writeConfiguredOutput) through the real CLI - `verify` run twice in a
// row against the same static fixture, same shape as test/output-path.test.js's
// own execSync pattern. Confirms sites/<id>/output.records.jsonl accumulates every
// run's rows while output.csv stays deduped to one row per item.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

// Same 5-row static fixture test/extract.test.js uses (test/fixtures/paged/page1.html) -
// deterministic content, so re-running against it twice produces identical rows,
// which is exactly what makes it a good append/dedupe test target.
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
        body: [
          { kind: 'extract', key: 'Title', relativeSelectors: ['.card-link'] },
          { kind: 'extract', key: 'Location', relativeSelectors: ['.loc'] },
        ],
      },
    ],
  };
}

function readCsvRows(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\r\n');
  return lines.slice(1); // drop the header
}

test('output.mode: append accumulates rows in output.records.jsonl and keeps output.csv deduped', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-output-append-'));
  const siteId = 'append-mode-site';
  const siteDir = path.join(sitesDir, siteId);
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(extractFlow(siteId), null, 2));

  // Per-site flow.config, not a repo-wide replayright.config.json - keeps this test
  // independent of cwd/config-file discovery, same reasoning test/exit-codes.test.js
  // documents for hand-building flow.json directly. output.path is pinned to an
  // absolute path under siteDir - by default it resolves against cwd (rootDir),
  // not --sites-dir, so leaving it at the default would write output.csv outside
  // the temp dir this test cleans up.
  const flow = JSON.parse(fs.readFileSync(path.join(siteDir, 'flow.json'), 'utf8'));
  flow.config = { output: { mode: 'append', dedupeKey: ['Title'], path: path.join(siteDir, 'output.csv') } };
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(flow, null, 2));

  try {
    execSync(`node ${JSON.stringify(CLI)} verify --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, { stdio: 'pipe' });
    execSync(`node ${JSON.stringify(CLI)} verify --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, { stdio: 'pipe' });

    const jsonlPath = path.join(siteDir, 'output.records.jsonl');
    const jsonlLines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    assert.strictEqual(jsonlLines.length, 10, 'the raw JSONL history accumulates all 5 rows from each of the 2 runs');

    const csvPath = path.join(siteDir, 'output.csv');
    const csvRows = readCsvRows(csvPath);
    assert.strictEqual(csvRows.length, 5, 'output.csv stays deduped to one row per unique Title, not 10');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('output.mode: overwrite (the default) is unaffected - output.csv reflects only the latest run', () => {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-output-overwrite-'));
  const siteId = 'overwrite-mode-site';
  const siteDir = path.join(sitesDir, siteId);
  fs.mkdirSync(siteDir, { recursive: true });
  const flow = extractFlow(siteId);
  flow.config = { output: { path: path.join(siteDir, 'output.csv') } };
  fs.writeFileSync(path.join(siteDir, 'flow.json'), JSON.stringify(flow, null, 2));

  try {
    execSync(`node ${JSON.stringify(CLI)} verify --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, { stdio: 'pipe' });
    execSync(`node ${JSON.stringify(CLI)} verify --id=${siteId} --sites-dir=${JSON.stringify(sitesDir)} --headless=true`, { stdio: 'pipe' });

    assert.strictEqual(fs.existsSync(path.join(siteDir, 'output.records.jsonl')), false, 'no JSONL history in overwrite mode');
    const csvRows = readCsvRows(path.join(siteDir, 'output.csv'));
    assert.strictEqual(csvRows.length, 5, 'output.csv has exactly this run\'s rows, same as before this feature existed');
  } finally {
    fs.rmSync(sitesDir, { recursive: true, force: true });
  }
});
