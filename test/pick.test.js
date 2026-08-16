// Regression test for the item-selection algorithm, against a fixture that reproduces the
// structure of a real careers listing.
//
// The original failure: recording Apple careers picked `section` as the repeating unit
// (2 items) because the item was forced to be a direct child of the picked container. The
// relative selector to the job link then matched 20 elements inside each section, which
// worked on item 0 and threw a strict-mode violation on item 1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { recordSite, sitePaths } = require('../src/record');
const { verifyFlow } = require('../src/verify');

const SITE_ID = '_test_nested';
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'nested', 'index.html')).href;

test.after(() => fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true }));

let flow;

test('the repeating unit is the job row, not a decoy level', async () => {
  ({ flow } = await recordSite({
    siteId: SITE_ID,
    url: fixture,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-pick-')),
    drive: async (page) => {
      await page.getByRole('button', { name: 'playright:F:arm' }).click();

      // Container: the padded area of #search-results, which is the div itself.
      const box = await page.locator('#search-results').boundingBox();
      await page.mouse.click(box.x + 6, box.y + 6);

      // Item: a job link, nested four levels below the container.
      const link = await page.locator('a.link-inline').first().boundingBox();
      await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2);

      // One per-item step: click that row's link.
      await page.locator('li.rc-accordion-item').first().locator('a.link-inline').click();
      await page.getByRole('button', { name: 'playright:F:close' }).click();
    },
  }));

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.ok(foreach, `expected a foreach, got ${JSON.stringify(flow.steps.map((s) => s.kind))}`);

  assert.strictEqual(foreach.itemSelectors[0], 'li.rc-accordion-item',
    `should pick the job row, not a decoy level; got ${JSON.stringify(foreach.itemSelectors)}`);
  assert.strictEqual(foreach.expectedCount, 20,
    'should count 20 rows, not the 2 sections or the 4 columns');

  // And the per-item step must be uniquely addressable within one row - the exact
  // property whose absence produced "resolved to 20 elements" at replay.
  const itemStep = foreach.body.find((s) => s.scope === 'item');
  assert.ok(itemStep, 'the link click should be recorded as a per-item step');
  assert.ok(itemStep.relativeSelectors.length >= 1);
});

test('replaying it opens all 20 rows, one per iteration', async () => {
  assert.ok(flow, 'depends on the recording test above');

  const { ok, reasons, stats } = await verifyFlow(flow, { headless: true, minDelayMs: 0, maxDelayMs: 0, resolveWaitMs: 2000 });

  assert.strictEqual(stats.foreachIterations, 20, 'every row should be visited exactly once');
  assert.deepStrictEqual(stats.errors, [], 'no ambiguous or unresolved selectors');
  assert.ok(ok, `should verify clean; reasons: ${reasons.join('; ')}`);
});
