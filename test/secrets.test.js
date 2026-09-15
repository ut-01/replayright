// {{env:NAME}} placeholders in a recorded fill step's text, resolved at replay time
// only (see src/secrets.js). Proven both as a pure unit (resolveSecrets/findSecretRefs)
// and end-to-end through runFlow against a local fixture.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { resolveSecrets, findSecretRefs } = require('../src/secrets');
const { runFlow } = require('../src/interpret');

const fixture = (...parts) => pathToFileURL(path.join(__dirname, 'fixtures', ...parts)).href;
const FAST = { minDelayMs: 0, maxDelayMs: 0, resolveWaitMs: 300 };

// Wrapped in a `repeat` (times: 1) because only repeat/foreach catch and record an
// action failure into stats.errors - a bare top-level action step would instead
// reject runFlow()'s promise entirely, which is not what this suite is testing.
const fillFlow = (text) => ({
  siteId: 'fixture-fill',
  startUrl: fixture('fill', 'index.html'),
  steps: [
    {
      kind: 'repeat',
      times: 1,
      body: [
        { kind: 'action', scope: 'page', selectors: ['#secret-field'], action: { name: 'fill', text } },
      ],
    },
  ],
});

// --- resolveSecrets: pure unit ---------------------------------------------------

test('resolveSecrets substitutes a {{env:NAME}} placeholder', () => {
  assert.strictEqual(resolveSecrets('{{env:MY_SECRET}}', { MY_SECRET: 'hunter2' }), 'hunter2');
});

test('resolveSecrets leaves a literal value with no placeholder untouched', () => {
  assert.strictEqual(resolveSecrets('plain-value', {}), 'plain-value');
});

test('resolveSecrets substitutes a placeholder embedded in surrounding text', () => {
  assert.strictEqual(resolveSecrets('Bearer {{env:TOKEN}}', { TOKEN: 'abc123' }), 'Bearer abc123');
});

test('resolveSecrets throws a clear error when the env var is unset', () => {
  assert.throws(
    () => resolveSecrets('{{env:MISSING_VAR}}', {}),
    /Missing environment variable "MISSING_VAR"/
  );
});

// --- findSecretRefs: pure unit ---------------------------------------------------

test('findSecretRefs collects placeholder names from fill steps, including nested ones', () => {
  const steps = [
    { kind: 'action', action: { name: 'fill', text: '{{env:A}}' } },
    { kind: 'action', action: { name: 'click' } },
    {
      kind: 'repeat',
      body: [
        { kind: 'action', action: { name: 'fill', text: 'no placeholder here' } },
        { kind: 'action', action: { name: 'fill', text: '{{env:B}}-{{env:A}}' } },
      ],
    },
  ];
  assert.deepStrictEqual(findSecretRefs(steps).sort(), ['A', 'B']);
});

test('findSecretRefs returns an empty list for a flow with no placeholders', () => {
  assert.deepStrictEqual(findSecretRefs([{ kind: 'action', action: { name: 'fill', text: 'plain' } }]), []);
});

// --- end-to-end through runFlow --------------------------------------------------

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

test('a {{env:NAME}} placeholder is resolved against the real value at replay time', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(fillFlow('{{env:MY_TEST_SECRET}}'), {
      page,
      ...FAST,
      env: { MY_TEST_SECRET: 'correct-horse-battery-staple' },
    });
    assert.deepStrictEqual(stats.errors, [], 'the fill step should succeed');
    assert.strictEqual(await page.locator('#secret-field').inputValue(), 'correct-horse-battery-staple');
  });
});

test('a normal literal fill value with no placeholder behaves exactly as before', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(fillFlow('plain value'), { page, ...FAST });
    assert.deepStrictEqual(stats.errors, [], 'the fill step should succeed');
    assert.strictEqual(await page.locator('#secret-field').inputValue(), 'plain value');
  });
});

test('a missing env var fails the fill step rather than typing the literal placeholder', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(fillFlow('{{env:NEVER_SET_VAR}}'), { page, ...FAST, env: {} });
    assert.ok(stats.errors.length > 0, 'the fill step should be recorded as a failure');
    assert.match(stats.errors[0].message, /NEVER_SET_VAR/);
    assert.strictEqual(await page.locator('#secret-field').inputValue(), '', 'the placeholder string must never reach the page');
  });
});
