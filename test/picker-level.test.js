// Picker level stepper: reaching elements that cannot be clicked directly because their
// children tile them completely (a <tr> under its <td>s, a gapless <ul> under its <li>s).
//
// The first block unit-tests the pure helpers in src/ui/selectors.js against a real
// Chromium layout (hit-testing has no meaning without one). Everything after it drives
// real recording sessions (recordSite's `drive` seam) through the stepper's real
// buttons and keys - __debugLevelState() is only ever READ, to assert on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { recordSite, sitePaths } = require('../src/record');
const { verifyFlow } = require('../src/verify');

const FLUSH_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'flush', 'index.html')).href;
const CLIMB_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'climb', 'index.html')).href;
const SELECTORS_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'selectors.js'), 'utf8');

const SITE_IDS = [];
test.after(() => {
  for (const id of SITE_IDS) fs.rmSync(sitePaths(id).dir, { recursive: true, force: true });
});

async function record(siteId, url, drive) {
  SITE_IDS.push(siteId);
  const { flow } = await recordSite({
    siteId,
    url,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-level-test-')),
    drive,
  });
  const { actionLog } = JSON.parse(fs.readFileSync(sitePaths(siteId).actions, 'utf8'));
  return { flow, actions: actionLog.map((entry) => entry.action || entry) };
}

const levelState = (page) => page.evaluate(() => window.__playright.__debugLevelState());
const levelButton = (page, which) => page.getByRole('button', { name: `playright:ui:level:${which}` });

async function clickCenter(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// --- pure helpers, real layout ---------------------------------------------------

test('levelChain and isHitReachable against real layout', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(FLUSH_URL);
    await page.addScriptTag({ content: SELECTORS_JS });

    const result = await page.evaluate(() => {
      const td = document.querySelector('#jobs tr td');
      const tbody = document.querySelector('#jobs tbody');
      const reach = (sel) => isHitReachable(document.querySelector(sel), (x, y) => document.elementFromPoint(x, y));

      // Two children separated by a 1px gap: technically a pixel of parent, but not
      // one anyone can click - must count as unreachable.
      const gap = document.createElement('div');
      gap.id = 'one-px-gap';
      gap.style.cssText = 'display:flex;gap:1px;width:200px;position:absolute;left:700px;top:20px';
      gap.innerHTML = '<div style="flex:1;height:40px;background:#eee"></div><div style="flex:1;height:40px;background:#ddd"></div>';
      document.body.appendChild(gap);

      return {
        chain: levelChain(td, tbody).map((el) => levelLabel(el)),
        chainToBody: levelChain(td, document.body).map((el) => el.tagName.toLowerCase()),
        outside: levelChain(td, document.querySelector('#gapless')),
        tr: reach('#jobs tr'),
        tbody: reach('#jobs tbody'),
        gapless: reach('#gapless'),
        tableWrap: reach('#table-wrap'),
        body: reach('body'),
        li: reach('#gapless li'),
        onePxGap: reach('#one-px-gap'),
      };
    });

    assert.deepStrictEqual(result.chain, ['td.title', 'tr.job', 'tbody']);
    assert.deepStrictEqual(result.chainToBody, ['td', 'tr', 'tbody', 'table', 'div', 'body'], 'never climbs into <html>');
    assert.strictEqual(result.outside, null, 'a bound that is not an ancestor yields null');
    assert.strictEqual(result.tr, false, 'a <tr> is completely covered by its cells');
    assert.strictEqual(result.tbody, false);
    assert.strictEqual(result.gapless, false, 'a gapless list is completely covered by its items');
    assert.strictEqual(result.onePxGap, false, 'a 1px gap is not a usable click target');
    assert.strictEqual(result.tableWrap, true, 'padding is a real click target');
    assert.strictEqual(result.body, true, "body's 8px margin is a real click target");
    assert.strictEqual(result.li, true, 'an element with its own text is directly clickable');
  } finally {
    await browser.close();
  }
});

// --- the motivating case: table rows ------------------------------------------------

test('a table row is reachable: container steps to tbody, item steps from a cell up to its row', async () => {
  const seen = {};
  const { flow, actions } = await record('_test_level_table', FLUSH_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    // Container: a cell. Its <tr> cannot be clicked, so the stepper opens instead of
    // committing the <td> - suggesting the level with the most repeating children.
    await clickCenter(page, page.locator('#jobs td.title').first());
    seen.container = await levelState(page);
    seen.panelVisible = await page.locator('[data-pr="level-panel"]').isVisible();
    await levelButton(page, 'use').click();

    // Item: a class-less cell, where chooseItem() on its own would settle for the <td>
    // (15 of them) because nothing addresses the cell uniquely within its row.
    await clickCenter(page, page.locator('#jobs tr').first().locator('td').nth(1));
    seen.itemStart = await levelState(page);
    await levelButton(page, 'up').click();
    seen.itemUp = await levelState(page);
    await levelButton(page, 'use').click();
    seen.afterUse = await levelState(page);

    await page.locator('#jobs tr').first().locator('button.apply').click();
    await page.getByRole('button', { name: 'playright:F:close' }).click();
  });

  assert.ok(seen.panelVisible, 'the stepper panel is shown');
  assert.strictEqual(seen.container.current, 'tbody', `container should start at tbody, got ${JSON.stringify(seen.container)}`);
  assert.strictEqual(seen.container.labels[0], 'td.title', 'down stops at the element actually clicked');
  assert.strictEqual(seen.container.labels.at(-1), 'body', 'up stops at <body>');
  assert.strictEqual(seen.container.info.tone, 'good');

  assert.strictEqual(seen.itemStart.current, 'td', 'item starts where chooseItem would have landed');
  assert.deepStrictEqual(seen.itemStart.labels, ['td', 'tr.job'], 'item levels stop below the container');
  assert.strictEqual(seen.itemUp.current, 'tr.job');
  assert.strictEqual(seen.itemUp.info.tone, 'good', JSON.stringify(seen.itemUp.info));
  assert.strictEqual(seen.afterUse, null, 'Use commits and closes the stepper');

  assert.deepStrictEqual(flow.steps.map((s) => s.kind), ['foreach'], 'stepper clicks leave no steps behind');
  const foreach = flow.steps[0];
  assert.ok(foreach.parentSelectors.some((sel) => /(^|\s)tbody$/.test(sel)), JSON.stringify(foreach.parentSelectors));
  assert.ok(foreach.itemSelectors.includes('tr.job'), JSON.stringify(foreach.itemSelectors));
  assert.strictEqual(foreach.expectedCount, 5, 'five rows, not fifteen cells');
  assert.ok(foreach.body.some((s) => s.scope === 'item'), 'the Apply click is scoped to the row');
  assert.ok(actions.some((a) => (a.selector || '').includes('playright:ui:level:use')), 'the Use click was recorded, and dropped as a ui marker');

  const { ok, reasons, stats } = await verifyFlow(flow, { headless: true, minDelayMs: 0, maxDelayMs: 0, resolveWaitMs: 2000 });
  assert.strictEqual(stats.foreachIterations, 5);
  assert.ok(ok, `should verify clean; reasons: ${reasons.join('; ')}`);
});

// --- keyboard, without leaking press steps -------------------------------------------

test('arrow keys, Enter and Escape drive the stepper and are never recorded as press steps', async () => {
  const seen = {};
  const { flow, actions } = await record('_test_level_keys', FLUSH_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    await clickCenter(page, page.locator('#gapless li').nth(1));
    seen.start = await levelState(page);
    await page.keyboard.press('ArrowUp');
    seen.up = await levelState(page);
    await page.keyboard.press('Escape');
    seen.escaped = await levelState(page);

    await clickCenter(page, page.locator('#gapless li').nth(1));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    seen.down = await levelState(page);
    await page.keyboard.press('Enter');
    seen.entered = await levelState(page);

    // The item itself: an <li> directly inside the container has no parent level to
    // offer, so this is a plain single-click commit.
    await clickCenter(page, page.locator('#gapless li').first());
    seen.itemFrozen = await levelState(page);

    await page.locator('#gapless li').first().click();
    await page.getByRole('button', { name: 'playright:F:close' }).click();

    // Control: with no stepper open the same key MUST reach the recorder, or the
    // assertion below would pass vacuously.
    await page.locator('#gapless li').first().click();
    await page.keyboard.press('ArrowDown');
  });

  assert.strictEqual(seen.start.current, 'ul#gapless');
  assert.strictEqual(seen.up.current, 'div#list-wrap');
  assert.strictEqual(seen.escaped, null, 'Escape returns to picking');
  assert.strictEqual(seen.down.current, 'ul#gapless');
  assert.strictEqual(seen.entered, null, 'Enter commits');
  assert.strictEqual(seen.itemFrozen, null, 'a pick with nothing hidden commits on one click');

  const presses = actions.filter((a) => a.name === 'press');
  assert.deepStrictEqual(presses.map((a) => a.key), ['ArrowDown'],
    `only the control keypress is recorded, got ${JSON.stringify(actions.map((a) => a.name))}`);
  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.ok(foreach, JSON.stringify(flow.steps));
  assert.ok(foreach.parentSelectors.includes('ul#gapless'), JSON.stringify(foreach.parentSelectors));
  assert.ok(foreach.itemSelectors.includes('li.entry'), JSON.stringify(foreach.itemSelectors));
  assert.strictEqual(foreach.expectedCount, 4);
});

// --- fields: an unaddressable pick opens the stepper instead of a retry loop ---------

// Card 1's two `.wrap > span.dup` branches are structurally identical (see the climb
// fixture), so neither the span nor its wrap can be addressed uniquely inside the item.
test('an unaddressable field pick opens the stepper and can be stepped up to the item root', async () => {
  const seen = {};
  const { flow } = await record('_test_level_field', CLIMB_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();
    const list = await page.locator('#results').boundingBox();
    await page.mouse.click(list.x + 6, list.y + 6);
    const card = await page.locator('#results li.card').first().boundingBox();
    await page.mouse.click(card.x + 4, card.y + 4);

    await page.getByRole('button', { name: 'playright:field:pick:Description' }).click();
    await clickCenter(page, page.locator('#card-1 span.dup').first());
    seen.start = await levelState(page);
    seen.useDisabled = await levelButton(page, 'use').isDisabled();
    seen.downDisabled = await levelButton(page, 'down').isDisabled();

    await levelButton(page, 'up').click();
    seen.wrap = await levelState(page);
    // Crumbs are buttons too: jump straight to the item root.
    await page.getByRole('button', { name: 'playright:ui:level:at:2' }).click();
    seen.root = await levelState(page);
    seen.upDisabled = await levelButton(page, 'up').isDisabled();
    await levelButton(page, 'use').click();

    await page.getByRole('button', { name: 'playright:F:close' }).click();
  });

  assert.deepStrictEqual(seen.start.labels, ['span.dup', 'div.wrap', 'li#card-1'], 'field levels stop at the item root');
  assert.strictEqual(seen.start.info.tone, 'bad');
  assert.ok(seen.useDisabled, 'Use is disabled on an unaddressable level');
  assert.ok(seen.downDisabled, 'cannot step below the element clicked');
  assert.strictEqual(seen.wrap.info.tone, 'bad');
  assert.strictEqual(seen.root.current, 'li#card-1');
  assert.strictEqual(seen.root.info.tone, 'good');
  assert.ok(seen.upDisabled, 'cannot step above the item root');

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  const extract = foreach && foreach.body.find((s) => s.kind === 'extract');
  assert.ok(extract, JSON.stringify(flow.steps));
  assert.strictEqual(extract.key, 'Description');
  assert.deepStrictEqual(extract.relativeSelectors, ['']);
});

// --- forcing, staleness, cancel --------------------------------------------------------

test('Shift-click forces the stepper; a detached selection cannot be used; F cancels cleanly', async () => {
  const seen = {};
  const { flow } = await record('_test_level_misc', CLIMB_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    const list = await page.locator('#results').boundingBox();
    // page.mouse.click() has no modifiers option - hold Shift on the keyboard instead
    // (a bare Shift keydown is never recorded as a press).
    await page.keyboard.down('Shift');
    await page.mouse.click(list.x + 6, list.y + 6);
    await page.keyboard.up('Shift');
    seen.forced = await levelState(page);

    await page.evaluate(() => document.querySelector('#results').remove());
    await levelButton(page, 'up').click();
    seen.stale = await levelState(page);
    seen.useDisabled = await levelButton(page, 'use').isDisabled();

    // F while the stepper is open cancels the whole F - nothing is sent, nothing kept.
    await page.getByRole('button', { name: 'playright:F:arm' }).click();
    seen.afterCancel = await levelState(page);
    seen.panelHidden = await page.locator('[data-pr="level-panel"]').isHidden();
  });

  assert.strictEqual(seen.forced.current, 'ul#results', 'a pick that needed no help still opens on Shift-click');
  assert.strictEqual(seen.stale.info.tone, 'bad');
  assert.match(seen.stale.info.text, /page changed/);
  assert.ok(seen.useDisabled);
  assert.strictEqual(seen.afterCancel, null);
  assert.ok(seen.panelHidden);
  assert.ok(!flow || !flow.steps.some((s) => s.kind === 'foreach'), 'a cancelled F leaves no foreach');
});
