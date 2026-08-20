// End-to-end coverage for index.js, the programmatic API (Phase 6.4). Everything runs
// against a temp sitesDir (via the `sitesDir` option, which flows into config.js's
// sitesDir mechanism - see Phase 5.4) so this never touches the repo's real sites/.
//
// record() is exercised through the same `drive` seam test/record.test.js uses, against
// the same `paged` fixture - recording is otherwise the one part of this system that
// cannot be tested without a person clicking things.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { record, verify, play, list, loadFlow } = require('../index');

const SITE_ID = '_test_index_api';
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Same shape as test/record.test.js's driveRecording: R wraps the whole loop, F marks
// the per-card body inside it, and the click that advances to the next page is the LAST
// thing recorded inside R.
async function driveRecording(page) {
  await page.getByRole('button', { name: 'playright:R:start' }).click();
  await page.getByRole('button', { name: 'playright:F:arm' }).click();

  const list = await page.locator('#results').boundingBox();
  await page.mouse.click(list.x + 6, list.y + 6);

  const card = await page.locator('#results li.card').first().boundingBox();
  await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);

  await page.locator('#results li.card').first().locator('a.card-link').click();
  await page.getByRole('button', { name: 'Show description' }).click();
  await page.getByRole('button', { name: 'Back to results' }).click();

  await page.getByRole('button', { name: 'playright:F:close' }).click();

  const next = await page.locator('#next').boundingBox();
  await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);

  await page.getByRole('button', { name: 'playright:R:end' }).click();
}

let sitesDir;
let recordedFlow;

test.after(() => {
  if (sitesDir) fs.rmSync(sitesDir, { recursive: true, force: true });
});

test('record() produces a flow via the drive seam, written under a temp sitesDir', async () => {
  sitesDir = tmpDir('replayright-index-api-sites-');

  const result = await record({
    siteId: SITE_ID,
    url: fixture('paged', 'page1.html'),
    sitesDir,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: tmpDir('replayright-index-api-profile-'),
    drive: driveRecording,
  });

  recordedFlow = result.flow;

  assert.ok(result.flow.steps.length, 'recorded flow should have steps');
  assert.strictEqual(result.flow.steps[0].kind, 'repeat');
  assert.strictEqual(result.verified, true,
    `expected the self-verify replay folded into record() to pass; reasons: ${JSON.stringify(result.verify?.reasons)}`);
  assert.ok(result.paths.dir.startsWith(sitesDir),
    'the site directory should live under the temp sitesDir, not the repo\'s real sites/');
  assert.ok(fs.existsSync(result.paths.flow), 'flow.json should be written');
  assert.ok(fs.existsSync(result.emittedPath), 'the debug flow.js view should be written too');

  // No leakage from the temp sitesDir into the repo's own sites/ directory.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'sites', SITE_ID)),
    'record() with an explicit sitesDir must never touch the repo sites/ directory');
});

test('verify() replays a recorded flow and reports, without touching fingerprint.json', async () => {
  assert.ok(recordedFlow, 'depends on the record() test above');

  const fingerprintPath = path.join(sitesDir, SITE_ID, 'fingerprint.json');
  assert.ok(!fs.existsSync(fingerprintPath), 'sanity: nothing has run play() yet');

  const result = await verify({ siteId: SITE_ID, sitesDir, headless: true });

  assert.strictEqual(result.ok, true, `verify() should pass on a flow that just verified clean; reasons: ${result.reasons.join('; ')}`);
  assert.strictEqual(result.stats.repeatIterations, 3, 'should walk all three fixture pages');
  assert.strictEqual(result.stats.foreachIterations, 15, 'should visit 5 cards on each of 3 pages');
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.runRecordPath && fs.existsSync(result.runRecordPath), 'a sites/<id>/runs/<iso>.json report should be written');

  assert.ok(!fs.existsSync(fingerprintPath), 'verify() must never write fingerprint.json - only play() updates the drift baseline');
});

test('play() runs a previously-recorded flow and returns stats', async () => {
  assert.ok(recordedFlow, 'depends on the record() test above');

  const result = await play({ siteId: SITE_ID, sitesDir, headless: true });

  assert.strictEqual(result.stats.repeatIterations, 3, 'should walk all three fixture pages');
  assert.strictEqual(result.stats.foreachIterations, 15, 'should visit 5 cards on each of 3 pages');
  assert.deepStrictEqual(result.stats.errors, []);
  assert.strictEqual(result.ok, true, 'play() should succeed on a flow that just verified clean');
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.wasVerified, true, 'flow.verified was true going into this run');
  assert.ok(result.fingerprint, 'should have captured a drift fingerprint');
  assert.strictEqual(result.driftStatus, 'OK', 'no prior fingerprint - first run always classifies OK');
  assert.ok(result.runRecordPath && fs.existsSync(result.runRecordPath), 'a sites/<id>/runs/<iso>.json report should be written');

  const runRecord = JSON.parse(fs.readFileSync(result.runRecordPath, 'utf8'));
  assert.strictEqual(runRecord.command, 'play');
  assert.strictEqual(runRecord.siteId, SITE_ID);
  assert.strictEqual(runRecord.counts.foreachIterations, 15);

  assert.ok(fs.existsSync(path.join(sitesDir, SITE_ID, 'fingerprint.json')),
    'play() (unlike verify()) should have advanced the drift fingerprint');
});

test('list() returns an array reflecting what is actually in the sites directory', async () => {
  const sites = await list({ sitesDir });

  assert.strictEqual(sites.length, 1);
  assert.strictEqual(sites[0].id, SITE_ID);
  assert.strictEqual(sites[0].verified, true);
  assert.strictEqual(typeof sites[0].steps, 'number');
  assert.ok(sites[0].steps > 0);
  assert.strictEqual(sites[0].startUrl, recordedFlow.startUrl);
});

test('list() returns an empty array for a sitesDir with nothing recorded', async () => {
  const emptyDir = tmpDir('replayright-index-api-empty-');
  try {
    const sites = await list({ sitesDir: emptyDir });
    assert.deepStrictEqual(sites, []);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('loadFlow() round-trips a flow.json', async () => {
  const flow = await loadFlow(SITE_ID, { sitesDir });

  assert.strictEqual(flow.siteId, recordedFlow.siteId);
  assert.strictEqual(flow.startUrl, recordedFlow.startUrl);
  assert.deepStrictEqual(flow.steps, recordedFlow.steps);
});

test('loadFlow() throws a clear error for a site that was never recorded', async () => {
  await assert.rejects(
    () => loadFlow('_no_such_site_at_all', { sitesDir }),
    /No flow for "_no_such_site_at_all"/
  );
});
