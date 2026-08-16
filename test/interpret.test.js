// Phase 2 gate: the interpreter's loop semantics, proven against local HTML rather
// than against a live careers site. Everything here is deterministic and offline.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { runFlow } = require('../src/interpret');
const candidates = require('../src/candidates');

const fixture = (...parts) => pathToFileURL(path.join(__dirname, 'fixtures', ...parts)).href;

// Zero throttle: the delays exist to be polite to real sites, and 30 navigations at
// ~1s each would make this suite useless as a fast feedback loop.
const FAST = { minDelayMs: 0, maxDelayMs: 0, resolveWaitMs: 300 };

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

async function withPage(fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

// --- the flagship case: repeat over pages, foreach over cards, nested -----------

const pagedFlow = {
  siteId: 'fixture-paged',
  startUrl: fixture('paged', 'page1.html'),
  steps: [
    {
      kind: 'repeat',
      times: 5,
      untilGone: '#next',
      settle: { selector: '#results', timeoutMs: 3000 },
      body: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['internal:role=link', '.card-link'],
          expectedCount: 5,
          body: [
            // The card itself is the click target - the empty relative selector.
            { kind: 'action', scope: 'item', relativeSelectors: [''], action: { name: 'click' } },
            // On the detail page now: page-scoped, not item-scoped.
            { kind: 'action', scope: 'page', selectors: ['#show-desc'], action: { name: 'click' } },
            { kind: 'action', scope: 'page', selectors: ['#back'], action: { name: 'click' } },
          ],
        },
        { kind: 'action', scope: 'page', selectors: ['#next'], action: { name: 'click' } },
      ],
    },
  ],
};

test('nested repeat/foreach visits every card on every page', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(pagedFlow, { page, ...FAST });

    // 3 pages, 5 cards each - the nesting the old flat postprocessor lost entirely.
    assert.strictEqual(stats.repeatIterations, 3, 'should stop at page 3, not run all 5 iterations');
    assert.strictEqual(stats.foreachIterations, 15, 'should visit 5 cards on each of 3 pages');
    assert.deepStrictEqual(stats.errors, [], 'no step should fail');
    assert.match(page.url(), /page3\.html$/, 'should end on the last page');
  });
});

test('untilGone exits on a DISABLED control without waiting for a timeout', async () => {
  await withPage(async (page) => {
    const started = Date.now();
    const stats = await runFlow(pagedFlow, { page, ...FAST });
    const elapsed = Date.now() - started;

    // page3's "Next Page" is present but disabled. Without the pre-click check,
    // Playwright would wait ~30s for it to become enabled and then fail.
    assert.strictEqual(stats.repeatIterations, 3);
    assert.deepStrictEqual(stats.errors, []);
    assert.ok(elapsed < 60000, `should not have burned an actionability timeout (took ${elapsed}ms)`);
  });
});

// --- "Load More" appends to the same list instead of replacing it -------------

const loadMoreFlow = {
  siteId: 'fixture-loadmore',
  startUrl: fixture('loadmore', 'index.html'),
  steps: [
    {
      kind: 'repeat',
      times: 5,
      untilGone: '#load-more',
      settle: { selector: '#results', timeoutMs: 3000 },
      body: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['li.card'],
          body: [
            { kind: 'action', scope: 'item', relativeSelectors: ['.card-link'], action: { name: 'click' } },
          ],
        },
        { kind: 'action', scope: 'page', selectors: ['#load-more'], action: { name: 'click' } },
      ],
    },
  ],
};

test('a "Load More" control that appends in place does not re-visit items already seen', async () => {
  await withPage(async (page) => {
    // A click on a card-link would normally navigate via its href; every card here
    // uses an in-page #fragment link, so clicking is side-effect-free and just proves
    // which items the body actually touched (count-based, since there is no extract
    // step yet to compare titles against).
    const stats = await runFlow(loadMoreFlow, { page, ...FAST });

    // 3 initial cards + 3 + 3 appended by two "Load More" clicks = 9 unique items.
    // Without resuming from where the previous round left off, this would instead
    // process 3 + 6 + 9 = 18 (re-walking every earlier item each round).
    assert.strictEqual(stats.repeatIterations, 3, 'should stop once "Load More" is disabled');
    assert.strictEqual(stats.foreachIterations, 9, 'should visit each of the 9 cards exactly once');
    assert.deepStrictEqual(stats.errors, []);
  });
});

test('item-scoped actions act on the right item, with no navigation', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-expand',
      startUrl: fixture('expand', 'index.html'),
      steps: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['.card'],
          expectedCount: 5,
          body: [{ kind: 'action', scope: 'item', relativeSelectors: ['.toggle'], action: { name: 'click' } }],
        },
      ],
    };

    const urlBefore = page.url.bind(page);
    const stats = await runFlow(flow, { page, ...FAST });

    assert.strictEqual(stats.foreachIterations, 5);
    assert.deepStrictEqual(stats.errors, []);
    assert.match(page.url(), /expand\/index\.html$/, 'in-place expand must not navigate');

    // Every card's own description revealed - i.e. each iteration acted on its own
    // item rather than repeatedly on whichever .toggle happened to be first.
    const visible = await page.locator('#results .desc:visible').count();
    assert.strictEqual(visible, 5, 'each of the 5 cards should have been expanded');
    void urlBefore;
  });
});

// --- resilience ---------------------------------------------------------------

test('a dead primary selector falls through to the next candidate and warns', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-fallback',
      startUrl: fixture('expand', 'index.html'),
      steps: [
        {
          kind: 'foreach',
          // Primary parent selector is gone; the fallback is the real one.
          parentSelectors: ['#results-renamed-by-a-redesign', '#results'],
          itemSelectors: ['.card'],
          body: [{ kind: 'action', scope: 'item', relativeSelectors: ['.nope', '.toggle'], action: { name: 'click' } }],
        },
      ],
    };

    const stats = await runFlow(flow, { page, ...FAST });

    assert.strictEqual(stats.foreachIterations, 5, 'the run should survive on fallbacks');
    assert.deepStrictEqual(stats.errors, []);
    assert.ok(stats.fallbacks.length >= 2, `expected fallback warnings, got ${JSON.stringify(stats.fallbacks)}`);
    assert.ok(
      stats.fallbacks.every((f) => f.candidateIndex === 1),
      'each fallback should report which candidate index won'
    );
    // Deduped: one warning per underlying change, not one per foreach iteration.
    assert.ok(stats.fallbacks.length <= 4, `fallback warnings should be deduped, got ${stats.fallbacks.length}`);
  });
});

test('a shrinking item list is detected instead of iterating stale indexes', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-shrink',
      startUrl: fixture('shrink', 'index.html'),
      steps: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['.card'],
          expectedCount: 5,
          body: [{ kind: 'action', scope: 'item', relativeSelectors: ['.act'], action: { name: 'click' } }],
        },
      ],
    };

    const stats = await runFlow(flow, { page, ...FAST });

    const reset = stats.warnings.find((w) => w.type === 'list-reset');
    assert.ok(reset, `expected a list-reset warning, got ${JSON.stringify(stats.warnings)}`);
    assert.match(reset.message, /list shrank from 5 to \d+/);
    assert.ok(stats.foreachIterations < 5, 'should stop early rather than index past the end');
  });
});

test('an unresolvable step reports every candidate it tried', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-broken',
      startUrl: fixture('expand', 'index.html'),
      steps: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['.card'],
          body: [{ kind: 'action', scope: 'item', relativeSelectors: ['.gone-a', '.gone-b'], action: { name: 'click' } }],
        },
      ],
    };

    const stats = await runFlow(flow, { page, ...FAST, maxConsecutiveErrors: 2 });

    assert.ok(stats.errors.length >= 1, 'the failure should be recorded');
    assert.strictEqual(stats.foreachIterations, 0, 'no iteration should count as completed');
    assert.ok(stats.aborted, 'consecutive failures should abort the run');
  });
});

test('an item-scoped step outside any foreach is rejected as malformed', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-malformed',
      startUrl: fixture('expand', 'index.html'),
      steps: [{ kind: 'action', scope: 'item', relativeSelectors: [''], action: { name: 'click' } }],
    };

    await assert.rejects(() => runFlow(flow, { page, ...FAST }), /item-scoped but is not inside a foreach/);
  });
});

// --- candidates.isGoneOrDisabled ----------------------------------------------

test('isGoneOrDisabled distinguishes missing, disabled and live controls', async () => {
  await withPage(async (page) => {
    await page.goto(fixture('paged', 'page3.html'));
    assert.deepStrictEqual(await candidates.isGoneOrDisabled(page, '#next'), { gone: true, reason: 'element is disabled' });
    assert.strictEqual((await candidates.isGoneOrDisabled(page, '#no-such-thing')).gone, true);

    await page.goto(fixture('paged', 'page1.html'));
    assert.strictEqual((await candidates.isGoneOrDisabled(page, '#next')).gone, false);
  });
});
