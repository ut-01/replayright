// Parent-climb picker enhancement (bundled with Phase 3.2): clicking the same
// already-selected element again in the picker climbs to its parent, one level per
// repeated click - the fix for a child and its parent occupying nearly the same screen
// space, where elementFromPoint() can only ever return the innermost one.
//
// Both tests drive a real recording session (recordSite's `drive` seam) against
// test/fixtures/climb/index.html and exercise the actual production code in
// src/ui/overlay.js / src/ui/selectors.js - nothing here is a reimplementation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { recordSite, sitePaths } = require('../src/record');

const FIXTURE_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'climb', 'index.html')).href;
const SITE_ID = '_test_picker_climb';

test.after(() => fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true }));

// --- deterministic: climbFrom/ancestorAt via the __debugClimbClick test seam ----

test('clicking the same point repeatedly climbs the ancestor chain one level at a time', async () => {
  const drive = async (page) => {
    const span = await page.locator('#card-1 span.dup').first().boundingBox();
    const x = span.x + span.width / 2;
    const y = span.y + span.height / 2;

    const first = await page.evaluate(([px, py]) => window.__playright.__debugClimbClick(px, py), [x, y]);
    assert.strictEqual(first.tag, 'span', 'first click at a fresh point selects the innermost element, unchanged');
    assert.strictEqual(first.depth, 0);

    const second = await page.evaluate(([px, py]) => window.__playright.__debugClimbClick(px, py), [x, y]);
    assert.strictEqual(second.tag, 'div', 'clicking the same point again climbs to the parent');
    assert.strictEqual(second.depth, 1);

    const third = await page.evaluate(([px, py]) => window.__playright.__debugClimbClick(px, py), [x, y]);
    assert.strictEqual(third.tag, 'li', 'a third click at the same point climbs one level further');
    assert.strictEqual(third.id, 'card-1');
    assert.strictEqual(third.depth, 2);

    // A click at a genuinely different position must NOT continue the old climb - it
    // starts a fresh, un-climbed pick, exactly like the very first click above.
    const h1 = await page.locator('h1').boundingBox();
    const fresh = await page.evaluate(
      ([px, py]) => window.__playright.__debugClimbClick(px, py),
      [h1.x + h1.width / 2, h1.y + h1.height / 2]
    );
    assert.strictEqual(fresh.tag, 'h1');
    assert.strictEqual(fresh.depth, 0, 'a different position resets the climb to depth 0');

    // Explicit reset (mirrors what a fresh F/field arm does) brings the original point
    // back to depth 0 too.
    await page.evaluate(() => window.__playright.__debugClimbReset());
    const resetResult = await page.evaluate(([px, py]) => window.__playright.__debugClimbClick(px, py), [x, y]);
    assert.strictEqual(resetResult.tag, 'span');
    assert.strictEqual(resetResult.depth, 0, 'resetClimb() must bring the same point back to a fresh pick');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_debug',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-climb-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_debug').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

// --- integration: three real picker clicks climb a field pick to a working selector --

// Card 1's two `.wrap > span.dup` branches are structurally identical (see the fixture
// comment) - relativeCandidates() genuinely cannot address either the span or its
// immediate wrap div uniquely, so the FIRST two real clicks at the same spot are
// rejected by onFieldPick and retried (armField(key) again, preserving climb state,
// since a retry is not a fresh arm). Only the third click, having climbed two levels
// to the item root itself, succeeds - proving the picker's real click handler (not a
// standalone helper) is what calls climbFrom.
test('three real clicks at the same spot climb an unaddressable field pick to the item root', async () => {
  const drive = async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    const list = await page.locator('#results').boundingBox();
    await page.mouse.click(list.x + 6, list.y + 6);

    // Click the padding corner of the first card, not its centre - the centre would
    // land on a nested wrap/span, and the item pick itself (unrelated to field-climb)
    // needs to resolve to li.card.
    const card = await page.locator('#results li.card').first().boundingBox();
    await page.mouse.click(card.x + 4, card.y + 4);

    await page.getByRole('button', { name: 'playright:field:pick:Description' }).click();

    const span = await page.locator('#card-1 span.dup').first().boundingBox();
    const x = span.x + span.width / 2;
    const y = span.y + span.height / 2;

    // Click 1: lands on the span. Ambiguous - rejected, retried.
    await page.mouse.click(x, y);
    await page.waitForFunction(() => {
      const host = document.getElementById('playright-overlay');
      const fBtn = host.shadowRoot.querySelector('[data-pr="f-btn"]');
      return fBtn && fBtn.title && fBtn.title.includes('per-item block');
    }, { timeout: 5000 }).catch(() => {}); // best-effort settle; the assertions below are what matter

    // Click 2: same spot - climbs to the wrap div. Still ambiguous - rejected, retried.
    await page.mouse.click(x, y);

    // Click 3: same spot - climbs to the item root (li.card). Always addressable via
    // the empty relative selector. Succeeds.
    await page.mouse.click(x, y);

    await page.getByRole('button', { name: 'playright:F:close' }).click();
  };

  const { flow } = await recordSite({
    siteId: SITE_ID,
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-climb-test-')),
    drive,
  });

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.ok(foreach, `expected a foreach, got ${JSON.stringify(flow.steps.map((s) => s.kind))}`);

  const extract = foreach.body.find((s) => s.kind === 'extract');
  assert.ok(extract, `expected an extract step to have survived the climb, got ${JSON.stringify(foreach.body)}`);
  assert.strictEqual(extract.key, 'Description');
  assert.deepStrictEqual(
    extract.relativeSelectors,
    [''],
    'only the climbed-to item root (depth 2) is addressable for this deliberately ambiguous fixture'
  );
});
