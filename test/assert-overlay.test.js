// The "A" sigil: real-browser coverage that the overlay button + dropdown + picker
// actually produce a correct `assert` flow.json step, and that no chrome (the select,
// the text inputs, the picker's own click) leaks into the recorded flow. ir.test.js
// already covers the marker<->payload pairing as a pure function against synthetic
// events; this proves the real DOM/marker/__pwEvent wiring those tests assume.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { recordSite, sitePaths } = require('../src/record');
const { MARKER_PREFIX } = require('../src/constants');

const PAGE1_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'paged', 'page1.html')).href;

const SITE_IDS = [];
test.after(() => {
  for (const id of SITE_IDS) fs.rmSync(sitePaths(id).dir, { recursive: true, force: true });
});

async function record(siteId, url, drive) {
  SITE_IDS.push(siteId);
  return recordSite({
    siteId,
    url,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-assert-overlay-test-')),
    drive,
  });
}

async function clickCenter(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('picking an element with the default "Element exists" type produces a count assert', async () => {
  const { flow } = await record('_test_assert_exists', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
    await clickCenter(page, page.locator('h1'));
  });

  assert.strictEqual(flow.steps.length, 1);
  const step = flow.steps[0];
  assert.strictEqual(step.kind, 'assert');
  assert.strictEqual(step.scope, 'page');
  assert.deepStrictEqual(step.check, { type: 'count', op: 'gte', count: 1 });
  assert.ok(step.selectors.length >= 1, JSON.stringify(step));
  // No overlay chrome (the select, the picker's own marker click) leaked in.
  assert.ok(!JSON.stringify(flow).includes(MARKER_PREFIX));
});

test('"Element not found" produces count eq 0; "Multiple elements found" produces count gt 1', async () => {
  const { flow } = await record('_test_assert_count_variants', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.locator('select[aria-label="playright:ui:assert-type"]').selectOption('not-exists');
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
    await clickCenter(page, page.locator('h1'));

    // The panel stays open after a pick (only its inputs reset) - no need to press A
    // again before arming the next one.
    await page.locator('select[aria-label="playright:ui:assert-type"]').selectOption('multiple');
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
    await clickCenter(page, page.locator('li.card').first());
  });

  assert.strictEqual(flow.steps.length, 2);
  assert.deepStrictEqual(flow.steps[0].check, { type: 'count', op: 'eq', count: 0 });
  assert.deepStrictEqual(flow.steps[1].check, { type: 'count', op: 'gt', count: 1 });
});

test('"Text equals" reads the typed value, relative to the picked element', async () => {
  const { flow } = await record('_test_assert_text_equals', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.locator('select[aria-label="playright:ui:assert-type"]').selectOption('text-equals');
    await page.locator('input[aria-label="playright:ui:assert-value"]').fill('Open roles');
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
    await clickCenter(page, page.locator('h1'));
  });

  assert.strictEqual(flow.steps.length, 1);
  assert.deepStrictEqual(flow.steps[0].check, { type: 'text-equals', value: 'Open roles' });
  assert.ok(!JSON.stringify(flow).includes(MARKER_PREFIX));
});

test('"Attribute equals" carries both the attribute name and the expected value', async () => {
  const { flow } = await record('_test_assert_attribute', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.locator('select[aria-label="playright:ui:assert-type"]').selectOption('attribute');
    await page.locator('input[aria-label="playright:ui:assert-attr"]').fill('id');
    await page.locator('input[aria-label="playright:ui:assert-value"]').fill('next');
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
    await clickCenter(page, page.locator('#next'));
  });

  assert.strictEqual(flow.steps.length, 1);
  assert.deepStrictEqual(flow.steps[0].check, { type: 'attribute', attribute: 'id', value: 'next' });
});

test('a URL check needs no pick - "Capture" fires immediately with the current page URL', async () => {
  const { flow } = await record('_test_assert_url_capture', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.locator('select[aria-label="playright:ui:assert-type"]').selectOption('url-contains');
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
  });

  assert.strictEqual(flow.steps.length, 1);
  const step = flow.steps[0];
  assert.strictEqual(step.check.type, 'url');
  assert.strictEqual(step.check.op, 'contains');
  assert.match(step.check.value, /page1\.html$/);
  assert.ok(!('selectors' in step), 'a url check has nothing to pick, so no selectors key');
});

test('the Pick-target/Capture button stays disabled until a required value is filled in', async () => {
  await record('_test_assert_disabled_until_ready', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.locator('select[aria-label="playright:ui:assert-type"]').selectOption('text-contains');
    assert.strictEqual(
      await page.getByRole('button', { name: 'playright:assert:pick' }).isDisabled(),
      true,
      'no value typed yet',
    );
    await page.locator('input[aria-label="playright:ui:assert-value"]').fill('roles');
    assert.strictEqual(await page.getByRole('button', { name: 'playright:assert:pick' }).isDisabled(), false);
  });
});

test('an assert recorded while a repeat is open nests as a page-scoped step inside it', async () => {
  const { flow } = await record('_test_assert_inside_repeat', PAGE1_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:R:start' }).click();
    await page.getByRole('button', { name: 'playright:ui:assert-toggle' }).click();
    await page.getByRole('button', { name: 'playright:assert:pick' }).click();
    await clickCenter(page, page.locator('h1'));
    await page.getByRole('button', { name: 'playright:R:end' }).click();
  });

  assert.strictEqual(flow.steps.length, 1);
  assert.strictEqual(flow.steps[0].kind, 'repeat');
  assert.strictEqual(flow.steps[0].body.length, 1);
  assert.strictEqual(flow.steps[0].body[0].kind, 'assert');
  assert.strictEqual(flow.steps[0].body[0].scope, 'page');
});
