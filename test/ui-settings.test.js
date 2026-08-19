// ui-settings.test.js
//
// Tests for Phase 3.4 settings panel: toolbar position/orientation controls and
// marker drop-through in ir.js.
//
// Uses the `drive` seam from recordSite() to mount the overlay, interact with the
// settings panel, and verify that UI markers are not present in the resulting flow.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { recordSite, sitePaths } = require('../src/record');

const FIXTURE_URL = pathToFileURL(
  path.join(__dirname, 'fixtures', 'paged', 'page1.html')
).href;

const SITE_ID = '_test_ui_settings';

// Clean up after tests
test.after(() => {
  fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true });
});

test('settings panel opens and closes when gear button is clicked', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Settings panel should be hidden initially
    let panelHidden = await page.evaluate(() => {
      const panel = document.querySelector('[data-pr="settings-panel"]');
      return panel ? panel.hidden : 'not found';
    });
    assert.strictEqual(panelHidden, true, 'settings panel should be hidden initially');

    // Click the settings button
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();

    // Settings panel should now be visible
    panelHidden = await page.evaluate(() => {
      const panel = document.querySelector('[data-pr="settings-panel"]');
      return panel ? panel.hidden : 'not found';
    });
    assert.strictEqual(panelHidden, false, 'settings panel should be visible after clicking settings button');

    // Click the settings button again to close it
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();

    // Settings panel should be hidden again
    panelHidden = await page.evaluate(() => {
      const panel = document.querySelector('[data-pr="settings-panel"]');
      return panel ? panel.hidden : 'not found';
    });
    assert.strictEqual(panelHidden, true, 'settings panel should be hidden after clicking settings button again');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_toggle',
    url: FIXTURE_URL,
    drive,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
  });
  // The flow should contain no steps (just navigation)
  const steps = flow.steps || [];
  assert.strictEqual(steps.length, 0, 'flow should contain no steps from settings panel interactions');
});

test('toolbar position changes when position option is selected', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Open settings panel
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();

    // Get initial toolbar position
    const initialPos = await page.evaluate(() => {
      const host = document.querySelector('#playright-overlay');
      const style = window.getComputedStyle(host);
      return {
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
      };
    });

    // Verify we're starting at top-right (default)
    assert.notStrictEqual(initialPos.right, 'auto', 'initial position should have right set');

    // Click the top-left position option. Its accessible name is the marker itself
    // (playright:ui:position:top-left), not the visible "Top-Left" label - same
    // pattern as the R/F buttons and field pills, so the recorder captures the marker
    // directly off the real clicked element instead of a plain, unrecognised name.
    await page.getByRole('radio', { name: 'playright:ui:position:top-left' }).click();

    // Wait for position to update
    await page.waitForTimeout(100);

    // Get new toolbar position
    const newPos = await page.evaluate(() => {
      const host = document.querySelector('#playright-overlay');
      const style = window.getComputedStyle(host);
      return {
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
      };
    });

    // Verify the toolbar moved to top-left
    assert.notStrictEqual(newPos.left, 'auto', 'toolbar should have left set after moving to top-left');
    assert.notStrictEqual(initialPos.right, newPos.right, 'toolbar right position should have changed');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_position',
    url: FIXTURE_URL,
    drive,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
  });
  // The flow should contain no steps from position changes
  const steps = flow.steps || [];
  assert.strictEqual(steps.length, 0, 'flow should contain no steps from position changes');
});

test('toolbar orientation changes when orientation option is selected', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Open settings panel
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();

    // Get initial toolbar orientation
    const initialOrient = await page.evaluate(() => {
      const host = document.querySelector('#playright-overlay');
      const style = window.getComputedStyle(host);
      return style.flexDirection;
    });

    // Verify we're starting at column (vertical, default)
    assert.strictEqual(initialOrient, 'column', 'initial orientation should be column (vertical)');

    // Click the horizontal orientation option - accessible name is its marker, see
    // the position test above for why.
    await page.getByRole('radio', { name: 'playright:ui:orientation:horizontal' }).click();

    // Wait for orientation to update
    await page.waitForTimeout(100);

    // Get new toolbar orientation
    const newOrient = await page.evaluate(() => {
      const host = document.querySelector('#playright-overlay');
      const style = window.getComputedStyle(host);
      return style.flexDirection;
    });

    // Verify the toolbar orientation changed
    assert.strictEqual(newOrient, 'row', 'toolbar should have row flex-direction after changing to horizontal');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_orientation',
    url: FIXTURE_URL,
    drive,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
  });
  // The flow should contain no steps from orientation changes
  const steps = flow.steps || [];
  assert.strictEqual(steps.length, 0, 'flow should contain no steps from orientation changes');
});

test('UI markers are dropped from flow.json and never appear as steps', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Open settings panel, change position and orientation. Radios are located by
    // their marker (their actual accessible name), not their visible label - see the
    // position/orientation tests above.
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();
    await page.getByRole('radio', { name: 'playright:ui:position:bottom-right' }).click();
    await page.getByRole('radio', { name: 'playright:ui:orientation:horizontal' }).click();
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();

    // Also do a real action to ensure the flow is not empty
    await page.getByRole('button', { name: 'playright:R:start' }).click();
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_markers',
    url: FIXTURE_URL,
    drive,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
  });

  // Helper to find all action selections in the flow tree
  function collectAllSelectors(node) {
    const selectors = [];
    function walk(n) {
      if (n.kind === 'action' && n.selectors) {
        selectors.push(...n.selectors);
      }
      if (n.body) {
        for (const child of n.body) walk(child);
      }
    }
    for (const step of (node.steps || [])) walk(step);
    return selectors;
  }

  const allSelectors = collectAllSelectors(flow);

  // Check that no selectors contain the UI marker prefix
  for (const selector of allSelectors) {
    if (typeof selector === 'string') {
      assert.ok(
        !selector.includes('ui:position'),
        `found ui:position marker in flow: ${selector}`
      );
      assert.ok(
        !selector.includes('ui:orientation'),
        `found ui:orientation marker in flow: ${selector}`
      );
      assert.ok(
        !selector.includes('ui:settings'),
        `found ui:settings marker in flow: ${selector}`
      );
    }
  }
});

test('settings panel is appended to document.documentElement with data-playright-chrome', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Open settings panel to ensure it's created
    await page.getByRole('button', { name: 'playright:ui:settings' }).click();

    // Verify the panel is in the light DOM and has the right attributes
    const panelInfo = await page.evaluate(() => {
      const panel = document.querySelector('[data-pr="settings-panel"]');
      if (!panel) return { exists: false };
      return {
        exists: true,
        isUnderHtml: panel.parentElement === document.documentElement,
        hasChromeMark: panel.hasAttribute('data-playright-chrome'),
        parent: panel.parentElement?.tagName,
      };
    });

    assert.strictEqual(panelInfo.exists, true, 'settings panel should exist');
    assert.strictEqual(panelInfo.isUnderHtml, true, 'settings panel should be a direct child of document.documentElement');
    assert.strictEqual(panelInfo.hasChromeMark, true, 'settings panel should have data-playright-chrome attribute');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_markers',
    url: FIXTURE_URL,
    drive,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
  });
  // Just verify the flow exists
  assert.ok(flow, 'flow should be generated');
});
