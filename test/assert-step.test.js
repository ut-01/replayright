// assert-step.test.js - interpret.js's runAssert(): the 'assert' step kind. Unlike
// 'extract', a failed assertion always fails the run, tagged with a distinct error code
// (ASSERT_FAILED, src/constants.js#EXIT_CODE.ASSERT_FAILED) so cli.js can report it
// separately from a vanished action target (SELECTOR_UNRESOLVED) or drift.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { runFlow } = require('../src/interpret');

const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;
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

// Every assert step here lives inside a `repeat` body, the same way exit-codes.test.js
// does it - that's what gives a thrown step error the handleError/recordStepError
// treatment (a recorded stats.errors entry) instead of an uncaught throw; a bare
// top-level step has no such protection, in interpret.js today, for any step kind.
function repeatOf(...body) {
  return { kind: 'repeat', times: 1, body };
}

async function runOne(step, extraOptions = {}) {
  return withPage((page) => runFlow({
    siteId: 'fixture-assert',
    startUrl: fixture('paged', 'page1.html'),
    steps: [repeatOf(step)],
  }, { page, ...FAST, ...extraOptions }));
}

test('a passing text-equals assertion does not fail the run and counts as an action', async () => {
  const stats = await runOne({ kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-equals', value: 'Open roles' } });
  assert.deepStrictEqual(stats.errors, []);
  assert.strictEqual(stats.actions, 1);
  assert.strictEqual(stats.steps.some((s) => s.kind === 'assert' && s.status === 'ok'), true);
});

test('a failing text-equals assertion is recorded as an ASSERT_FAILED error', async () => {
  const stats = await runOne({ kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-equals', value: 'Something else entirely' } });
  assert.strictEqual(stats.errors.length, 1);
  assert.strictEqual(stats.errors[0].type, 'ASSERT_FAILED');
  assert.match(stats.errors[0].message, /expected text to equal/);
});

test('text-contains passes on a substring and fails otherwise', async () => {
  const ok = await runOne({ kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-contains', value: 'roles' } });
  assert.deepStrictEqual(ok.errors, []);

  const bad = await runOne({ kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-contains', value: 'nope' } });
  assert.strictEqual(bad.errors[0]?.type, 'ASSERT_FAILED');
});

test('an attribute check reads the resolved element\'s attribute', async () => {
  const ok = await runOne({
    kind: 'assert', scope: 'page', selectors: ['a.card-link'],
    check: { type: 'attribute', attribute: 'href', value: 'job.html?j=p1-1' },
  });
  assert.deepStrictEqual(ok.errors, []);

  const bad = await runOne({
    kind: 'assert', scope: 'page', selectors: ['a.card-link'],
    check: { type: 'attribute', attribute: 'href', value: 'job.html?j=wrong' },
  });
  assert.strictEqual(bad.errors[0]?.type, 'ASSERT_FAILED');
});

test('count checks compare the element count of a single selector, zero included', async () => {
  const five = await runOne({ kind: 'assert', scope: 'page', selectors: ['li.card'], check: { type: 'count', op: 'eq', count: 5 } });
  assert.deepStrictEqual(five.errors, []);

  const atLeastOne = await runOne({ kind: 'assert', scope: 'page', selectors: ['li.card'], check: { type: 'count', op: 'gte', count: 1 } });
  assert.deepStrictEqual(atLeastOne.errors, []);

  const wrongCount = await runOne({ kind: 'assert', scope: 'page', selectors: ['li.card'], check: { type: 'count', op: 'eq', count: 99 } });
  assert.strictEqual(wrongCount.errors[0]?.type, 'ASSERT_FAILED');

  // Zero matches is a legitimate, intended outcome for a count check (e.g. "this banner
  // is gone") - it must not be treated as an unresolved selector.
  const zeroIsFine = await runOne({ kind: 'assert', scope: 'page', selectors: ['.does-not-exist-anywhere'], check: { type: 'count', op: 'eq', count: 0 } });
  assert.deepStrictEqual(zeroIsFine.errors, []);
});

test('a url check compares the current page URL, contains by default', async () => {
  const ok = await runOne({ kind: 'assert', scope: 'page', check: { type: 'url', value: 'page1.html' } });
  assert.deepStrictEqual(ok.errors, []);

  const bad = await runOne({ kind: 'assert', scope: 'page', check: { type: 'url', value: 'page2.html' } });
  assert.strictEqual(bad.errors[0]?.type, 'ASSERT_FAILED');
});

test('a text-equals assert whose target selector never resolves fails as ASSERT_FAILED, not SELECTOR_UNRESOLVED', async () => {
  const stats = await runOne({
    kind: 'assert', scope: 'page', selectors: ['.this-selector-does-not-exist-anywhere'],
    check: { type: 'text-equals', value: 'x' },
  });
  assert.strictEqual(stats.errors.length, 1);
  assert.strictEqual(stats.errors[0].type, 'ASSERT_FAILED');
});

test('an item-scoped assert reads relative to the current foreach entry', async () => {
  const stats = await withPage((page) => runFlow({
    siteId: 'fixture-assert-item',
    startUrl: fixture('paged', 'page1.html'),
    steps: [{
      kind: 'foreach',
      parentSelectors: ['#results'],
      itemSelectors: ['li.card'],
      body: [{ kind: 'assert', scope: 'item', relativeSelectors: ['.loc'], check: { type: 'count', op: 'eq', count: 1 } }],
    }],
  }, { page, ...FAST }));

  assert.deepStrictEqual(stats.errors, []);
  assert.strictEqual(stats.foreachIterations, 5);
});

test('an item-scoped assert outside any foreach throws a malformed-flow error', async () => {
  const stats = await runOne({ kind: 'assert', scope: 'item', relativeSelectors: [''], check: { type: 'count', count: 1 } });
  // Not an AssertionError - a genuinely malformed flow, same treatment runAction gives
  // an item-scoped action outside a foreach.
  assert.strictEqual(stats.errors.length, 1);
  assert.match(stats.errors[0].message, /not inside a foreach/);
});

// --- onAssert hook (in-process consumers) --------------------------------------

test('onAssert fires for a passing assert, synchronously, with passed: true', async () => {
  const seen = [];
  await runOne(
    { kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-equals', value: 'Open roles' } },
    { onAssert: (result) => seen.push(result) },
  );
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].passed, true);
  assert.strictEqual(seen[0].checkType, 'text-equals');
});

test('onAssert fires for a failing assert too, before the run records ASSERT_FAILED', async () => {
  const seen = [];
  const stats = await runOne(
    { kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-equals', value: 'nope' } },
    { onAssert: (result) => seen.push(result) },
  );
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].passed, false);
  assert.match(seen[0].message, /expected text to equal/);
  // Same outcome reaches the stats.errors channel out-of-process consumers already read.
  assert.strictEqual(stats.errors[0]?.type, 'ASSERT_FAILED');
});

test('a malformed-flow error (item scope outside a foreach) does not fire onAssert', async () => {
  const seen = [];
  await runOne(
    { kind: 'assert', scope: 'item', relativeSelectors: [''], check: { type: 'count', count: 1 } },
    { onAssert: (result) => seen.push(result) },
  );
  assert.strictEqual(seen.length, 0);
});
