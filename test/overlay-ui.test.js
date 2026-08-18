// overlay-ui.test.js
//
// Tests for Phase 2.2 UI redesign: toast styling, focus-visible reachability,
// and R-open/F-open indicator state.
//
// Uses the `drive` seam from recordSite() to mount the overlay during recording,
// then tests DOM state and styles via page.evaluate().
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

const SITE_ID = '_test_overlay_ui';

// Clean up after tests
test.after(() => {
  fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true });
});

// --- Test 1: Toast tones ---

// Note on triggers: `say(text, tone)` in src/ui/overlay.js is deliberately called
// with 'good' only on genuine SUCCESS (an R block closing cleanly, or F resolving a
// valid container+item pair), with 'bad' only on genuine ERRORS (a pick landing
// outside the container, an unaddressable repeating unit, ...), and with a falsy/null
// tone - which `say()` folds to 'neutral' - for everything still in progress (R
// starting, F arming, a step-1-of-2/step-2-of-2 prompt, a cancellation). Starting R or
// simply arming F therefore never produces a 'good' or 'bad' toast; the tests below
// drive the overlay to the actual state that does.

test('toast renders with good tone: green stripe, checkmark icon, dark background', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Arm F, pick a valid container, then a valid repeating item - a clean F pick
    // is the actual 'good' path (see src/ui/overlay.js pickItem()'s `chosen.exact`
    // branch), mirrored on the R side by closing an open repeat block.
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    const list = await page.locator('#results').boundingBox();
    await page.mouse.click(list.x + 6, list.y + 6);

    const card = await page.locator('#results li.card').first().boundingBox();
    await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);

    // Wait for toast to appear and finish its enter transition
    await page.waitForFunction(() => {
      const toast = document.querySelector('.pr-toast.pr-toast--good');
      return toast && toast.classList.contains('is-visible');
    }, { timeout: 5000 });

    // Test the toast properties
    const toastState = await page.evaluate(() => {
      const toast = document.querySelector('.pr-toast.pr-toast--good');
      if (!toast) return { exists: false };
      const icon = toast.querySelector('[data-pr="toast-icon"]')?.textContent;
      const text = toast.querySelector('[data-pr="toast-text"]')?.textContent;
      const classes = toast.className;
      const style = window.getComputedStyle(toast);
      return {
        exists: true,
        icon,
        text,
        classes,
        borderColor: style.borderLeftColor,
        borderStyle: style.borderLeftStyle,
        backgroundColor: style.backgroundColor,
      };
    });

    assert.strictEqual(toastState.exists, true, 'good tone toast should exist');
    assert.ok(
      toastState.classes.includes('pr-toast--good'),
      `toast should have pr-toast--good class, got: ${toastState.classes}`
    );
    assert.strictEqual(
      toastState.icon,
      '✓',
      `expected checkmark icon for good tone, got: ${toastState.icon}`
    );
    assert.ok(
      toastState.text && toastState.text.includes('Matched'),
      `expected the successful-pick headline, got: ${toastState.text}`
    );
    // Accent stripe: the green (#34c759) left border, not just background color.
    assert.strictEqual(
      toastState.borderColor,
      'rgb(52, 199, 89)',
      `expected green accent stripe for good tone, got: ${toastState.borderColor}`
    );
    assert.strictEqual(toastState.borderStyle, 'solid', 'accent stripe should be a solid border');
    // Background: the toast chrome (dark, semi-opaque) is shared across tones -
    // only the accent stripe changes - so this asserts it is actually painted.
    assert.ok(
      /^rgba\(17, 17, 17,/.test(toastState.backgroundColor),
      `expected the toast background to be painted, got: ${toastState.backgroundColor}`
    );
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_good_toast',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_good_toast').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

test('toast renders with neutral tone: gray stripe, dot icon', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Arm F - triggers a neutral tone toast
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const fBtn = host.shadowRoot.querySelector('[data-pr="f-btn"]');
      fBtn.click();
    });

    // Wait for neutral toast to appear
    await page.waitForFunction(() => {
      const toast = document.querySelector('.pr-toast.pr-toast--neutral');
      return toast && toast.classList.contains('is-visible');
    }, { timeout: 3000 });

    // Test the toast properties
    const toastState = await page.evaluate(() => {
      const toast = document.querySelector('.pr-toast.pr-toast--neutral');
      if (!toast) return { exists: false };
      const icon = toast.querySelector('[data-pr="toast-icon"]')?.textContent;
      const classes = toast.className;
      const style = window.getComputedStyle(toast);
      return {
        exists: true,
        icon,
        classes,
        borderColor: style.borderLeftColor,
        backgroundColor: style.backgroundColor,
      };
    });

    assert.strictEqual(toastState.exists, true, 'neutral tone toast should exist');
    assert.ok(
      toastState.classes.includes('pr-toast--neutral'),
      `toast should have pr-toast--neutral class, got: ${toastState.classes}`
    );
    assert.strictEqual(
      toastState.icon,
      '•',
      `expected dot icon for neutral tone, got: ${toastState.icon}`
    );
    // Accent stripe: gray (#8e8e93), distinct from good's green and bad's red.
    assert.strictEqual(
      toastState.borderColor,
      'rgb(142, 142, 147)',
      `expected gray accent stripe for neutral tone, got: ${toastState.borderColor}`
    );
    assert.ok(
      /^rgba\(17, 17, 17,/.test(toastState.backgroundColor),
      `expected the toast background to be painted, got: ${toastState.backgroundColor}`
    );
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_neutral_toast',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_neutral_toast').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

test('toast renders with bad tone: red stripe, error icon', async () => {
  const drive = async (page) => {
    // Verify overlay is loaded
    const hasPlayright = await page.evaluate(() => typeof window.__playright !== 'undefined');
    if (!hasPlayright) throw new Error('Overlay not loaded');

    // Arm F, then pick a valid container - required first, since fState only
    // reaches 'item' (where a bad pick is possible) after a container is chosen.
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    const list = await page.locator('#results').boundingBox();
    await page.mouse.click(list.x + 6, list.y + 6);

    // Wait for the item-picking prompt (fState === 'item'). TITLE_F.item in
    // src/ui/overlay.js reads "Click one repeating item inside the container" -
    // lowercase, so match against that rather than an all-caps guess.
    await page.waitForFunction(() => {
      const host = document.getElementById('playright-overlay');
      const fBtn = host.shadowRoot.querySelector('[data-pr="f-btn"]');
      return fBtn && fBtn.title && fBtn.title.includes('one repeating item');
    }, { timeout: 5000 });

    // The toast element already exists (from the "step 1/2" and "step 2/2" prompts).
    // overlay.js's pickItem() error branch calls `say(..., 'bad')` and then
    // immediately re-arms with `pickParent()`, whose own `say(..., null)` overwrites
    // the toast with a fresh neutral prompt in the SAME synchronous tick - so the
    // 'bad' state never survives to the next animation frame for a polling-based
    // `waitForFunction` to observe (it flashes and is gone before any repaint).
    // Instrument the toast-text span's setter instead, so every `say()` call this
    // tick is captured in call order regardless of how quickly it gets overwritten -
    // `say()` always sets className, then icon, then text, in that order, so by the
    // time text is written the class for THAT call is already in place.
    await page.evaluate(() => {
      window.__toastHistory = [];
      const textEl = document.querySelector('[data-pr="toast-text"]');
      const toastEl = textEl.closest('.pr-toast');
      const iconEl = toastEl.querySelector('[data-pr="toast-icon"]');
      const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      Object.defineProperty(textEl, 'textContent', {
        configurable: true,
        get() { return desc.get.call(textEl); },
        set(v) {
          desc.set.call(textEl, v);
          window.__toastHistory.push({ classes: toastEl.className, icon: iconEl.textContent, text: v });
        },
      });
    });

    // Pick something OUTSIDE the chosen container - overlay.js's pickItem() rejects
    // this with `say(..., 'bad')` ("That element is not inside the container...").
    const heading = await page.locator('h1').boundingBox();
    await page.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);

    // Let the click's synchronous handlers (and the immediate re-arm that follows
    // them) finish, then read back everything `say()` was called with this tick.
    await page.waitForFunction(() => window.__toastHistory && window.__toastHistory.length > 0, {
      timeout: 5000,
    });
    const history = await page.evaluate(() => window.__toastHistory);
    const badEntry = history.find((h) => h.classes.includes('pr-toast--bad'));

    assert.ok(
      badEntry,
      `expected a 'bad' tone toast to have been raised at some point, got history: ${JSON.stringify(history)}`
    );
    assert.strictEqual(
      badEntry.icon,
      '⊘',
      `expected error icon for bad tone, got: ${badEntry.icon}`
    );
    assert.ok(
      badEntry.text && badEntry.text.includes('not inside the container'),
      `expected the out-of-container error text, got: ${badEntry.text}`
    );

    // Accent stripe + background: computed on the live toast node forced back into
    // the bad-tone class, since CSS painting is deterministic from the class alone
    // (verified directly by the good/neutral tests) - this confirms the stylesheet
    // actually maps pr-toast--bad to the right colors.
    const style = await page.evaluate(() => {
      const toast = document.querySelector('.pr-toast');
      const prevClass = toast.className;
      toast.className = 'pr-toast pr-toast--bad is-visible';
      const cs = window.getComputedStyle(toast);
      const result = { borderColor: cs.borderLeftColor, backgroundColor: cs.backgroundColor };
      toast.className = prevClass;
      return result;
    });
    assert.strictEqual(
      style.borderColor,
      'rgb(255, 59, 48)',
      `expected red accent stripe for bad tone, got: ${style.borderColor}`
    );
    assert.ok(
      /^rgba\(17, 17, 17,/.test(style.backgroundColor),
      `expected the toast background to be painted, got: ${style.backgroundColor}`
    );
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_bad_toast',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_bad_toast').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

// --- Test 2: R-open/F-open indicator state ---

test('open-strip shows "R OPEN" when R button is active', async () => {
  const drive = async (page) => {
    // Initially, strip should be hidden
    let stripText = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.textContent;
    });

    assert.strictEqual(stripText, '', 'strip should be empty when nothing is open');

    // Click R to start
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const rBtn = host.shadowRoot.querySelector('[data-pr="r-btn"]');
      rBtn.click();
    });

    // Check that strip now shows "R OPEN"
    stripText = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.textContent;
    });

    assert.strictEqual(
      stripText,
      'R open',
      'strip should show "R OPEN" when R button is active'
    );

    // Verify strip is not hidden
    const stripHidden = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.hidden;
    });

    assert.strictEqual(stripHidden, false, 'strip should not be hidden when R is open');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_r_open',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_r_open').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

test('open-strip shows "F OPEN" when F is armed', async () => {
  const drive = async (page) => {
    // Click F to arm it
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const fBtn = host.shadowRoot.querySelector('[data-pr="f-btn"]');
      fBtn.click();
    });

    // Check that strip now shows "F OPEN"
    const stripText = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.textContent;
    });

    assert.strictEqual(
      stripText,
      'F open',
      'strip should show "F OPEN" when F is armed'
    );

    // Verify strip is not hidden
    const stripHidden = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.hidden;
    });

    assert.strictEqual(stripHidden, false, 'strip should not be hidden when F is open');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_f_open',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_f_open').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

test('open-strip shows "R OPEN · F OPEN" when both are active', async () => {
  const drive = async (page) => {
    // Click R to start repeat
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const rBtn = host.shadowRoot.querySelector('[data-pr="r-btn"]');
      rBtn.click();
    });

    // Click F to arm foreach
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const fBtn = host.shadowRoot.querySelector('[data-pr="f-btn"]');
      fBtn.click();
    });

    // Wait for picker to appear
    await page.waitForFunction(() => {
      return document.querySelector('[role="button"][aria-label*="pick"]') !== null;
    }, { timeout: 3000 });

    // Check that strip now shows "R OPEN · F OPEN"
    const stripText = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.textContent;
    });

    assert.strictEqual(
      stripText,
      'R open · F open',
      'strip should show both markers when both are open'
    );
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_both_open',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_both_open').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

test('open-strip hides when all blocks are closed', async () => {
  const drive = async (page) => {
    // Start R
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const rBtn = host.shadowRoot.querySelector('[data-pr="r-btn"]');
      rBtn.click();
    });

    // Verify R is open
    let stripText = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.textContent;
    });
    assert.strictEqual(stripText, 'R open', 'strip should show "R OPEN" when R is open');

    // Close R by clicking it again
    await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const rBtn = host.shadowRoot.querySelector('[data-pr="r-btn"]');
      rBtn.click();
    });

    // Verify strip is now hidden
    const stripHidden = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const strip = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return strip.hidden;
    });

    assert.strictEqual(stripHidden, true, 'strip should be hidden when all blocks are closed');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_closed',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_closed').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

// window.__playright.restore(state) is the path actually exercised in production:
// overlay.js re-runs on every navigation (addInitScript), so Node re-announces
// whichever blocks were logically still open on its side. These directly drive
// restore() rather than the R/F buttons, since a navigation mid-recording is exactly
// when the DOM (and any in-page block state) has just been wiped and rebuilt fresh.
test('open-strip reflects state set via window.__playright.restore(), not just button clicks', async () => {
  const drive = async (page) => {
    // Fresh mount: nothing open, strip hidden.
    let strip = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const el = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return { text: el.textContent, hidden: el.hidden };
    });
    assert.strictEqual(strip.hidden, true, 'strip should start hidden');

    // Simulate Node re-announcing an in-flight R block after a navigation.
    await page.evaluate(() => window.__playright.restore({ rOpen: true, fOpen: false }));
    strip = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const el = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return { text: el.textContent, hidden: el.hidden };
    });
    assert.strictEqual(strip.text, 'R open', 'restore({rOpen:true}) should show "R open"');
    assert.strictEqual(strip.hidden, false, 'strip should be visible after restore(rOpen)');

    // The R button itself should also reflect the restored state (active + aria-label
    // set to the "end" marker, since the next press must close, not re-open).
    const rBtnState = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const rBtn = host.shadowRoot.querySelector('[data-pr="r-btn"]');
      return { isActive: rBtn.classList.contains('is-active'), ariaLabel: rBtn.getAttribute('aria-label') };
    });
    assert.strictEqual(rBtnState.isActive, true, 'R button should show active state after restore');
    assert.strictEqual(
      rBtnState.ariaLabel,
      'playright:R:end',
      'restore(rOpen) should flip the R marker to the close-phase label'
    );

    // A second restore() call, this time also re-announcing an in-flight F body
    // (the "detached item" case: the per-item element from the old document is gone,
    // so F falls back to page scope, but the block is still logically open).
    await page.evaluate(() => window.__playright.restore({ rOpen: true, fOpen: true }));
    strip = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const el = host.shadowRoot.querySelector('[data-pr="open-strip"]');
      return { text: el.textContent, hidden: el.hidden };
    });
    assert.strictEqual(
      strip.text,
      'R open · F open',
      'restore({rOpen:true, fOpen:true}) should show both markers'
    );
    assert.strictEqual(strip.hidden, false, 'strip should stay visible with both restored open');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_restore',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_restore').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

// --- Test 3: Focus-visible reachability ---

// Real Tab-key navigation (not scripted .focus()) is what actually triggers Chromium's
// :focus-visible heuristic - a script-driven .focus() on a <button> does NOT set
// :focus-visible in Chromium, so the earlier version of this test (checking the CSS
// text for the literal string ":focus-visible") could pass even if the selector never
// matched anything real. This drives an actual keyboard Tab walk and asks the browser
// itself whether each button is showing its focus ring.
test('toolbar buttons are keyboard-navigable via Tab, with :focus-visible ring shown', async () => {
  const drive = async (page) => {
    const dataPrOfActive = () => {
      const host = document.getElementById('playright-overlay');
      const active = host.shadowRoot.activeElement;
      return active ? active.getAttribute('data-pr') : null;
    };
    const activeIsFocusVisible = () => {
      const host = document.getElementById('playright-overlay');
      const active = host.shadowRoot.activeElement;
      return !!(active && active.matches(':focus-visible'));
    };
    const activeOutline = () => {
      const host = document.getElementById('playright-overlay');
      const active = host.shadowRoot.activeElement;
      if (!active) return null;
      const cs = getComputedStyle(active);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    };

    // Walk Tab forward (bounded) until the R button is the focused element. The
    // fixture page has several real links ahead of the overlay in DOM order (the
    // overlay host is appended last, as document.body's final child), so this must
    // walk through them rather than assume R is reachable in one press.
    let sawR = false;
    let sawF = false;
    let outlineAtR = null;
    let outlineAtF = null;
    for (let i = 0; i < 25 && !(sawR && sawF); i++) {
      await page.keyboard.press('Tab');
      const which = await page.evaluate(dataPrOfActive);
      if (which === 'r-btn' && !sawR) {
        sawR = true;
        assert.strictEqual(
          await page.evaluate(activeIsFocusVisible),
          true,
          'R button should be :focus-visible after Tab-reaching it'
        );
        outlineAtR = await page.evaluate(activeOutline);
      }
      if (which === 'f-btn' && !sawF) {
        sawF = true;
        assert.strictEqual(
          await page.evaluate(activeIsFocusVisible),
          true,
          'F button should be :focus-visible after Tab-reaching it'
        );
        outlineAtF = await page.evaluate(activeOutline);
      }
    }

    assert.ok(sawR, 'Tab navigation should reach the R button (start/end marker)');
    assert.ok(sawF, 'Tab navigation should reach the F button (arm/close marker)');

    // The :focus-visible rule (overlay.css) actually paints a visible ring, not just
    // matches the selector with no visual effect.
    assert.notStrictEqual(outlineAtR.outlineStyle, 'none', 'R button should show a focus outline');
    assert.ok(parseFloat(outlineAtR.outlineWidth) > 0, 'R button focus outline should have width');
    assert.notStrictEqual(outlineAtF.outlineStyle, 'none', 'F button should show a focus outline');
    assert.ok(parseFloat(outlineAtF.outlineWidth) > 0, 'F button focus outline should have width');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_focus',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_focus').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});

test('all toolbar buttons are keyboard-accessible (native button elements)', async () => {
  const drive = async (page) => {
    // Verify buttons are native button elements for keyboard accessibility
    const buttonsAccessible = await page.evaluate(() => {
      const host = document.getElementById('playright-overlay');
      const rBtn = host.shadowRoot.querySelector('[data-pr="r-btn"]');
      const fBtn = host.shadowRoot.querySelector('[data-pr="f-btn"]');

      return {
        rIsButton: rBtn.tagName === 'BUTTON',
        fIsButton: fBtn.tagName === 'BUTTON',
        rHasType: rBtn.type === 'button',
        fHasType: fBtn.type === 'button'
      };
    });

    assert.strictEqual(buttonsAccessible.rIsButton, true, 'R should be a button element');
    assert.strictEqual(buttonsAccessible.fIsButton, true, 'F should be a button element');
    assert.strictEqual(buttonsAccessible.rHasType, true, 'R button should have type="button"');
    assert.strictEqual(buttonsAccessible.fHasType, true, 'F button should have type="button"');
  };

  const { flow } = await recordSite({
    siteId: SITE_ID + '_accessible',
    url: FIXTURE_URL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-test-')),
    drive,
  });

  fs.rmSync(sitePaths(SITE_ID + '_accessible').dir, { recursive: true, force: true });
  assert.ok(flow, 'recording should complete');
});
