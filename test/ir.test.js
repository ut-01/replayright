// IR assembly, driven with a synthetic action stream. This is the trickiest logic in the
// system (marker stack, nesting, out-of-band scope pairing) and it is a pure function, so
// it deserves direct tests rather than only being covered end-to-end.
const test = require('node:test');
const assert = require('node:assert');

const { buildFlow } = require('../src/ir');
const { MARKER_PREFIX } = require('../src/constants');

// How Playwright records a click on an overlay button: the aria-label becomes the
// accessible name inside a role selector. Confirmed against playwright-core 1.62.1.
const marker = (meaning) => ({ name: 'click', selector: `internal:role=button[name="${MARKER_PREFIX}${meaning}"i]`, clickCount: 1 });
const click = (name) => ({ name: 'click', selector: `internal:role=link[name="${name}"i]`, clickCount: 1 });
const button = (name) => ({ name: 'click', selector: `internal:role=button[name="${name}"i]`, clickCount: 1 });
const fill = (name, text) => ({ name: 'fill', selector: `internal:role=textbox[name="${name}"i]`, text });

const log = (...actions) => actions.map((action, seq) => ({ seq, action }));

const scopeEvent = (overrides = {}) => ({
  type: 'F', phase: 'scope', parents: ['#results'], items: ['li.card', 'li'], count: 20, ...overrides,
});
const bodyEvent = (n, inItem, text, rel) => ({ type: 'F', phase: 'bodyEvent', n, inItem, text, rel });

test('markers nest into repeat > foreach via the stack', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'https://example.test/',
    actionLog: log(
      { name: 'navigate', url: 'https://example.test/' },
      marker('R:start'),
      marker('F:arm'),
      click('Frontend Engineer'),
      button('Back to results'),
      marker('F:close'),
      button('Next Page'),
      marker('R:end')
    ),
    overlayEvents: [
      scopeEvent(),
      bodyEvent(0, true, 'Frontend Engineer', ['']),
      bodyEvent(1, false, 'Back to results', null),
    ],
  });

  assert.strictEqual(flow.startUrl, 'https://example.test/');
  assert.strictEqual(flow.steps.length, 1);

  const repeat = flow.steps[0];
  assert.strictEqual(repeat.kind, 'repeat');
  assert.deepStrictEqual(repeat.body.map((s) => s.kind), ['foreach', 'action']);
  assert.match(repeat.untilGone, /Next Page/);
  assert.strictEqual(repeat.settle.selector, '#results');

  const foreach = repeat.body[0];
  assert.strictEqual(foreach.expectedCount, 20);
  assert.deepStrictEqual(foreach.body.map((s) => s.scope), ['item', 'page']);
  assert.deepStrictEqual(warnings, []);
});

test('the item selector prefers Playwright\'s generalized selector when the item is the click target', () => {
  const { flow } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('F:arm'), click('Frontend Engineer'), marker('F:close')),
    overlayEvents: [scopeEvent(), bodyEvent(0, true, 'Frontend Engineer', [''])],
  });

  // The per-item step targets the item itself, so its recorded selector with the
  // accessible-name filter stripped matches every sibling - the most robust option, ahead
  // of the structural ones.
  assert.deepStrictEqual(flow.steps[0].itemSelectors, ['internal:role=link', 'li.card', 'li']);
});

test('a trailing fill is NOT nominated as the loop-advance control', () => {
  // Regression: a real careers page whose repeat block ended in a fill had that textbox
  // marked as the advance control, which would make replay skip a genuine step whenever
  // the field happened to be disabled.
  const { flow } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('R:start'), fill('Search by role or keyword', 'engineer'), marker('R:end')),
    overlayEvents: [],
  });

  assert.strictEqual(flow.steps[0].kind, 'repeat');
  assert.strictEqual(flow.steps[0].untilGone, undefined, 'only a trailing click may be the advance control');
});

test('scope pairing ignores an observation that does not match the action', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('F:arm'), click('Frontend Engineer'), marker('F:close')),
    // The observation describes something else entirely - order alone would have handed
    // this action the wrong scope, which is what the old blind FIFO did.
    overlayEvents: [scopeEvent(), bodyEvent(0, true, 'Completely Unrelated Widget', ['.x'])],
  });

  assert.strictEqual(flow.steps[0].body[0].scope, 'page', 'must not trust a mismatched observation');
  assert.ok(warnings.some((w) => w.type === 'scope-uncertain'));
});

test('a foreach whose body never touches the item is flagged', () => {
  const { warnings } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('F:arm'), button('Some page button'), marker('F:close')),
    overlayEvents: [scopeEvent(), bodyEvent(0, false, 'Some page button', null)],
  });

  // Otherwise every iteration would repeat identical page-level actions N times.
  assert.ok(warnings.some((w) => w.type === 'foreach-without-item-steps'));
});

test('an unclosed block is closed at the end of the recording, with a warning', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('R:start'), button('Next Page')),
    overlayEvents: [],
  });

  assert.strictEqual(flow.steps.length, 1);
  assert.strictEqual(flow.steps[0].kind, 'repeat', 'the steps must not be lost');
  assert.ok(warnings.some((w) => w.type === 'unclosed-block'));
});

test('closing a block that was never opened is ignored, not fatal', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('R:end'), button('Somewhere')),
    overlayEvents: [],
  });

  assert.deepStrictEqual(flow.steps.map((s) => s.kind), ['action']);
  assert.ok(warnings.some((w) => w.type === 'unbalanced-marker'));
});

test('picker clicks and session actions never reach the flow', () => {
  const { flow } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(
      { name: 'openPage', url: 'about:blank' },
      { name: 'navigate', url: 'u' },
      marker('pick'),
      marker('pick'),
      button('Real Button'),
      { name: 'closePage' }
    ),
    overlayEvents: [],
  });

  assert.strictEqual(flow.steps.length, 1);
  assert.ok(!JSON.stringify(flow).includes(MARKER_PREFIX));
});

test('fallback selectors captured during recording are carried into the flow', () => {
  const enriched = button('Next Page');
  enriched.__fallbacks = ['a#next', 'div > a:nth-of-type(2)'];

  const { flow } = buildFlow({ siteId: 's', url: 'u', actionLog: log(enriched), overlayEvents: [] });

  assert.deepStrictEqual(flow.steps[0].selectors, [
    'internal:role=button[name="Next Page"i]',
    'a#next',
    'div > a:nth-of-type(2)',
  ]);
});
