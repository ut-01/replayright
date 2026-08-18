// Phase 2.0 spike: can the overlay live inside an OPEN shadow root?
//
// Real CSS files want a shadow root, because otherwise the site's own stylesheet bleeds
// into the toolbar. But the whole marker mechanism rests on ONE assumption: that clicking
// `<button aria-label="playright:R:start">` is recorded by Playwright's own selector
// generator as `internal:role=button[name="playright:R:start"i]`, which
// generalize.js#parseMarker then reads the marker's meaning back out of. Locators are
// *expected* to pierce open shadow roots. This proves it instead of assuming it.
//
// Three questions, in the order they can fail:
//   1. does a role locator even find the button through the shadow boundary?
//   2. does the RECORDER generate a selector parseMarker still understands?
//   3. does the resulting flow still come out with the R block folded correctly?
//
// Modelled on record.test.js: recordSite()'s `drive` seam replaces "wait for a human to
// close the browser" with a callback, which is what makes recording testable at all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { chromium } = require('playwright');

const { recordSite, sitePaths } = require('../src/record');
const { parseMarker, isOverlayAction, nameFilterValue } = require('../src/generalize');
const { MARKER_PREFIX, CHROMIUM_ARGS } = require('../src/constants');

const SITE_ID = '_test_shadow';
const FIXTURE = pathToFileURL(path.join(__dirname, 'fixtures', 'shadow', 'page.html')).href;

const R_START = `${MARKER_PREFIX}R:start`;
const R_END = `${MARKER_PREFIX}R:end`;

test.after(() => {
  fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true });
});

// Phase 2.1 moves the overlay itself into the shadow root, so at that point there is
// exactly one `playright:R:start` on the page. Recording today still injects the
// light-DOM overlay from inpage.js, which would make the name ambiguous and push the
// generator into emitting a disambiguated selector - measuring the wrong thing. Drop it,
// leaving the fixture's shadow-mounted button as the only marker control. It stays gone:
// the overlay is mounted once per document and never re-mounted on a timer, and this
// flow never navigates.
async function unmountLightDomOverlay(page) {
  const removed = await page.evaluate(() => {
    const el = document.getElementById('playright-overlay');
    el?.remove();
    return Boolean(el);
  });
  assert.ok(removed, 'the light-DOM overlay should have been present to remove');
}

// --- 1. the locator question -------------------------------------------------------

test('a role locator pierces an open shadow root', async () => {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(FIXTURE);

    const marker = page.getByRole('button', { name: R_START });
    assert.strictEqual(await marker.count(), 1,
      'the shadow-mounted marker button should be reachable by accessible name');

    // Attached is not enough - an action target has to be actionable, and the overlay's
    // whole job is to be clickable on top of the site.
    assert.ok(await marker.isVisible(), 'the shadow-mounted button should be visible');
    await marker.click();
    assert.strictEqual(await page.getByRole('button', { name: R_END }).count(), 1,
      'the click should have reached the button inside the shadow root');
  } finally {
    await browser.close();
  }
});

// --- 2. the recorder question (the actual spike) -----------------------------------

let recorded;
let actionLog;

test('the recorder generates a parseMarker-compatible selector for a shadow-DOM marker', async () => {
  const { flow } = await recordSite({
    siteId: SITE_ID,
    url: FIXTURE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-shadow-test-')),
    drive: async (page) => {
      await unmountLightDomOverlay(page);

      await page.getByRole('button', { name: R_START }).click();
      await page.getByRole('button', { name: 'Do a thing' }).click();
      await page.getByRole('button', { name: R_END }).click();
    },
  });
  recorded = flow;

  // recordSite returns the folded flow, not the raw stream; the stream is the forensics
  // file, which is where the selector Playwright actually generated survives.
  ({ actionLog } = JSON.parse(fs.readFileSync(sitePaths(SITE_ID).actions, 'utf8')));

  const marked = actionLog
    .map((entry) => ({ selector: entry.action.selector, marker: parseMarker(entry.action, MARKER_PREFIX) }))
    .filter((e) => e.marker);

  assert.deepStrictEqual(
    marked.map((e) => e.marker),
    [{ kind: 'R', phase: 'start' }, { kind: 'R', phase: 'end' }],
    `parseMarker should read both presses back out of the shadow-DOM selectors; the recorder produced ${
      JSON.stringify(actionLog.map((entry) => entry.action.selector))}`
  );

  // The exact shape the mechanism is documented to depend on. Asserted with `match`, not
  // equality: a benign chained prefix would still parse, and the criterion is that the
  // name filter is there to be read.
  for (const { selector } of marked) {
    assert.match(selector, /internal:role=button\[name="playright:R:(start|end)"i\]/,
      'the shadow-DOM button should still get a role locator keyed on its accessible name');
  }

  // The other half of the prefix's job: identifying overlay actions for REMOVAL. If this
  // failed, marker presses would survive as real steps in every recorded flow.
  for (const entry of actionLog) {
    const isMarker = Boolean(parseMarker(entry.action, MARKER_PREFIX));
    assert.strictEqual(isOverlayAction(entry.action, MARKER_PREFIX), isMarker,
      `isOverlayAction disagreed with parseMarker on ${entry.action.selector}`);
  }

  // Guards the fixture's hardcoded aria-label against a MARKER_PREFIX change.
  assert.strictEqual(nameFilterValue(marked[0].selector), R_START);
});

// --- 3. does the whole mechanism still work end to end? ----------------------------

test('the shadow-DOM marker still folds into a repeat block', () => {
  assert.ok(recorded, 'depends on the recording test above');

  assert.strictEqual(recorded.steps.length, 1,
    `expected a single top-level repeat, got ${JSON.stringify(recorded.steps.map((s) => s.kind))}`);

  const repeat = recorded.steps[0];
  assert.strictEqual(repeat.kind, 'repeat');
  assert.strictEqual(repeat.body.length, 1, 'the light-DOM click should be the only body step');

  // No overlay noise leaked into the replayable flow - the same invariant record.test.js
  // asserts, re-checked now that the overlay is behind a shadow boundary.
  assert.ok(!JSON.stringify(recorded).includes(MARKER_PREFIX),
    'no marker action should survive into the flow');
});
