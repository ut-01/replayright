// End-to-end: drive a real recording session against a local fixture, assert the
// resulting flow.json has the right shape, then replay it.
//
// Recording is the part of this system that is hardest to trust, because normally it
// needs a person clicking things. recordSite()'s `drive` seam removes that excuse.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { chromium } = require('playwright');

const { recordSite, sitePaths } = require('../src/record');
const { runFlow } = require('../src/interpret');
const { verifyFlow } = require('../src/verify');
const { emitFlow } = require('../src/emit');

const SITE_ID = '_test_paged';
const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

test.after(() => {
  fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true });
});

// R wraps the whole loop; F marks the per-card body inside it. The click that advances
// to the next page is the LAST thing recorded inside R, which is what lets
// finalizeRepeat's trailing-click inference name it as the advance control.
async function driveRecording(page) {
  await page.getByRole('button', { name: 'playright:R:start' }).click();

  await page.getByRole('button', { name: 'playright:F:arm' }).click();

  // Pick the container: the list has padding, so its top-left corner is the <ul>
  // itself rather than any card.
  const list = await page.locator('#results').boundingBox();
  await page.mouse.click(list.x + 6, list.y + 6);

  // Pick one item: the centre of the first card.
  const card = await page.locator('#results li.card').first().boundingBox();
  await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);

  // Per-item body. The first click is on the card's link (inside the item), then we are
  // on the detail page, so the rest is page-level.
  await page.locator('#results li.card').first().locator('a.card-link').click();
  await page.getByRole('button', { name: 'Show description' }).click();
  await page.getByRole('button', { name: 'Back to results' }).click();

  await page.getByRole('button', { name: 'playright:F:close' }).click();

  const next = await page.locator('#next').boundingBox();
  await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);

  await page.getByRole('button', { name: 'playright:R:end' }).click();
}

let recorded;

test('a driven recording produces a nested repeat > foreach flow', async () => {
  const { flow, warnings } = await recordSite({
    siteId: SITE_ID,
    url: fixture('paged', 'page1.html'),
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive: driveRecording,
  });
  recorded = flow;

  assert.strictEqual(flow.steps.length, 1, `expected a single top-level repeat, got ${JSON.stringify(flow.steps.map((s) => s.kind))}`);

  const repeat = flow.steps[0];
  assert.strictEqual(repeat.kind, 'repeat');
  assert.ok(repeat.untilGone, 'the repeat should have identified its advance control');
  assert.match(repeat.untilGone, /#next|Next Page/i);
  assert.ok(repeat.settle?.selector, 'the repeat should settle on the list container');

  // The nesting the old flat postprocessor lost entirely.
  const foreach = repeat.body.find((s) => s.kind === 'foreach');
  assert.ok(foreach, `repeat body should contain a foreach, got ${JSON.stringify(repeat.body.map((s) => s.kind))}`);
  assert.strictEqual(foreach.expectedCount, 5, 'should have counted 5 items at record time');
  assert.ok(foreach.parentSelectors.length >= 1);
  assert.ok(foreach.itemSelectors.length >= 1);

  // Candidates must be ranked by ROBUSTNESS, not specificity. `sc-9f8a1b` is a
  // build-generated class that changes on every deploy, so it must never be what the
  // daily run depends on first.
  assert.strictEqual(foreach.itemSelectors[0], 'li.card',
    `expected the hash-free selector first, got ${JSON.stringify(foreach.itemSelectors)}`);
  assert.ok(!/sc-9f8a1b/.test(foreach.itemSelectors[0]), 'primary candidate must not depend on a hashed class');
  assert.ok(foreach.itemSelectors.length >= 2, 'should have kept fallbacks behind the primary');

  // Scope detection: the card click is per-item; the steps that follow happened on the
  // job's detail page, which is recognised from the URL each action was recorded at.
  const shape = foreach.body.map((s) => [s.scope, s.action.name]);
  const itemSteps = foreach.body.filter((s) => s.scope === 'item');
  const detailSteps = foreach.body.filter((s) => s.scope === 'detail');
  assert.strictEqual(itemSteps.length, 1, `expected exactly 1 per-item step, got ${JSON.stringify(shape)}`);
  assert.ok(detailSteps.length >= 2, `the detail-page clicks should be detail-scoped, got ${JSON.stringify(shape)}`);

  // The click that leaves the list is tagged so replay can open it in its own tab instead
  // of navigating the list away, and the step that came back is tagged so replay can
  // close that tab instead of clicking a back button that no longer applies.
  assert.strictEqual(itemSteps[0].opensDetail, true, 'the item click should be marked as opening the detail');
  assert.strictEqual(foreach.body[foreach.body.length - 1].returnsToList, true, 'the last detail step should be marked as returning to the list');

  // The minimal unique relative selector, not a deep ancestor chain: the chain would
  // break on any layout change, which is how a real recording lost its click target.
  assert.strictEqual(itemSteps[0].relativeSelectors[0], 'a',
    `expected the shortest unique relative selector, got ${JSON.stringify(itemSteps[0].relativeSelectors)}`);

  // No overlay noise leaked into the replayable flow.
  const json = JSON.stringify(flow);
  assert.ok(!json.includes('playright:'), 'no marker or picker action should survive into the flow');

  assert.deepStrictEqual(
    warnings.filter((w) => w.type === 'foreach-without-item-steps'), [],
    'scope detection should not have failed'
  );
});

test('the recorded flow replays and verifies clean', async () => {
  assert.ok(recorded, 'depends on the recording test above');

  const { ok, reasons, stats } = await verifyFlow(recorded, {
    headless: true,
    minDelayMs: 0,
    maxDelayMs: 0,
    resolveWaitMs: 2000,
  });

  assert.strictEqual(stats.repeatIterations, 3, 'should walk all three fixture pages');
  assert.strictEqual(stats.foreachIterations, 15, 'should visit 5 cards on each of 3 pages');
  assert.ok(ok, `the freshly recorded flow should verify; reasons: ${reasons.join('; ')}`);
});

// The whole point of opening the detail in its own tab: the list page is never navigated,
// so it cannot be lost mid-loop. This is the failure that read "item list no longer
// resolves" when the same-tab click destroyed the list on the first item.
test('replay never navigates the list page away from the listing', async () => {
  assert.ok(recorded, 'depends on the recording test above');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const listVisited = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) listVisited.push(frame.url());
    });

    const stats = await runFlow(recorded, { page, minDelayMs: 0, maxDelayMs: 0, resolveWaitMs: 2000 });

    assert.strictEqual(stats.foreachIterations, 15);
    assert.deepStrictEqual(stats.errors, []);

    const wentToDetail = listVisited.filter((u) => u.includes('job.html'));
    assert.deepStrictEqual(wentToDetail, [],
      `the list page must never open a detail page; it visited ${JSON.stringify(wentToDetail)}`);

    // It should only ever have been on the three listing pages.
    const pages = [...new Set(listVisited.filter((u) => u.includes('page')).map((u) => u.split('/').pop()))];
    assert.deepStrictEqual(pages.sort(), ['page1.html', 'page2.html', 'page3.html']);
  } finally {
    await browser.close();
  }
});

test('the emitted script is a readable view of the same structure', () => {
  assert.ok(recorded, 'depends on the recording test above');
  const js = emitFlow(recorded);

  assert.match(js, /FOR READING ONLY/);
  assert.match(js, /for \(let page_i = 0; page_i < 5; page_i\+\+\)/);
  assert.match(js, /const items = parent\.locator\("li\.card"\)/);
  assert.match(js, /const item = items\.nth\(i\)/);
});
