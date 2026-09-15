// picker-preview.test.js - the level stepper's "Preview" button (src/ui/overlay.js's
// togglePreviewDetail/previewDetails), which surfaces the same ranked-candidate
// breakdown window.__playright.pickPreview() computes, but live and inline instead of
// requiring a devtools console round-trip (kanban task #17). Same recordSite()-driven-
// headlessly harness as test/picker-level.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { recordSite, sitePaths } = require('../src/record');

const FLUSH_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'flush', 'index.html')).href;

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
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-preview-test-')),
    drive,
  });
  return { flow };
}

async function clickCenter(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const levelButton = (page, which) => page.getByRole('button', { name: `playright:ui:level:${which}` });

test('the Preview button shows the ranked-candidate breakdown for an item-pick level, and hides for the container stage', async () => {
  const seen = {};
  await record('_test_level_preview', FLUSH_URL, async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    // Container stage: the stepper opens (a <tr> can't be clicked directly), starting
    // at the clicked cell itself; step up to the table body before committing. This
    // stage has no previewDetails() - the button should not even be shown, at any level.
    await clickCenter(page, page.locator('#jobs td.title').first());
    seen.containerPreviewVisible = await page.locator('[data-pr="level-preview"]').isVisible();
    await levelButton(page, 'up').click();
    await levelButton(page, 'up').click();
    await levelButton(page, 'use').click();

    // Item stage: a class-less cell where chooseItem() climbs to the row - this stage
    // does define previewDetails(), so the button should be visible and clicking it
    // reveals the ranked candidate list inline, no devtools needed.
    await clickCenter(page, page.locator('#jobs tr').first().locator('td').nth(1));
    seen.itemPreviewVisible = await page.locator('[data-pr="level-preview"]').isVisible();
    seen.detailHiddenBefore = await page.locator('[data-pr="level-preview-detail"]').isHidden();

    await levelButton(page, 'preview').click();
    seen.detailVisibleAfter = await page.locator('[data-pr="level-preview-detail"]').isVisible();
    seen.detailText = await page.locator('[data-pr="level-preview-detail"]').textContent();

    // Toggling again collapses it.
    await levelButton(page, 'preview').click();
    seen.detailHiddenAfterToggle = await page.locator('[data-pr="level-preview-detail"]').isHidden();

    // Moving to a different level (up to the row) should collapse a stale detail panel
    // rather than showing detail for the level the user has since left.
    await levelButton(page, 'preview').click();
    await levelButton(page, 'up').click();
    seen.detailHiddenAfterLevelChange = await page.locator('[data-pr="level-preview-detail"]').isHidden();

    await levelButton(page, 'use').click();
    await page.locator('#jobs tr').first().locator('button.apply').click();
    await page.getByRole('button', { name: 'playright:F:close' }).click();
  });

  assert.strictEqual(seen.containerPreviewVisible, false, 'container stage has no previewDetails(), so no button');
  assert.strictEqual(seen.itemPreviewVisible, true, 'item stage defines previewDetails(), so the button shows');
  assert.strictEqual(seen.detailHiddenBefore, true, 'detail starts collapsed');
  assert.strictEqual(seen.detailVisibleAfter, true, 'clicking Preview reveals the breakdown');
  assert.match(seen.detailText, /Ranked candidates:/);
  assert.match(seen.detailText, /Occurrence count/);
  assert.match(seen.detailText, /Item tag:/);
  assert.strictEqual(seen.detailHiddenAfterToggle, true, 'clicking Preview again collapses it');
  assert.strictEqual(seen.detailHiddenAfterLevelChange, true, 'moving to a different level collapses stale detail');
});
