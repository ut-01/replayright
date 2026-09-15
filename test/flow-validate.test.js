// flow-validate.test.js - unit tests for src/flow-validate.js's validateFlow(), the pure
// structural check backing the `validate` CLI command (no browser, no network).
const test = require('node:test');
const assert = require('node:assert');

const { validateFlow } = require('../src/flow-validate');

function baseFlow(steps) {
  return { startUrl: 'https://example.com', steps };
}

test('a well-formed flow (action, foreach with nested extract, repeat) has no errors', () => {
  const flow = baseFlow([
    { kind: 'action', action: { name: 'click' }, selectors: ['button.start'] },
    {
      kind: 'repeat',
      times: 2,
      body: [
        {
          kind: 'foreach',
          parentSelectors: ['#results'],
          itemSelectors: ['li.card'],
          body: [{ kind: 'extract', key: 'Title', relativeSelectors: ['.title'] }],
        },
        { kind: 'action', action: { name: 'click' }, selectors: ['button.next'] },
      ],
    },
  ]);
  const { errors, warnings } = validateFlow(flow);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(warnings, []);
});

test('flags an unknown step kind', () => {
  const { errors } = validateFlow(baseFlow([{ kind: 'assert', text: 'foo' }]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /unknown step kind/);
});

test('flags an extract step outside any foreach as a warning, not an error', () => {
  const { errors, warnings } = validateFlow(baseFlow([{ kind: 'extract', key: 'Title' }]));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /not inside a foreach/);
});

test('flags an extract step missing "key"', () => {
  const { errors } = validateFlow(baseFlow([
    { kind: 'foreach', parentSelectors: ['ul'], itemSelectors: ['li'], body: [{ kind: 'extract' }] },
  ]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /missing "key"/);
});

test('flags an action step with an empty selectors array', () => {
  const { errors } = validateFlow(baseFlow([{ kind: 'action', action: { name: 'click' }, selectors: [] }]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /non-empty selectors array/);
});

test('does not require selectors for a page-level action (navigate/openPage/closePage)', () => {
  const { errors } = validateFlow(baseFlow([{ kind: 'action', action: { name: 'navigate', url: 'https://x' } }]));
  assert.deepStrictEqual(errors, []);
});

test('flags an unrecognized action name', () => {
  const { errors } = validateFlow(baseFlow([{ kind: 'action', action: { name: 'teleport' }, selectors: ['a'] }]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /unknown action name/);
});

test('flags a repeat/foreach step with an empty body', () => {
  const { errors } = validateFlow(baseFlow([{ kind: 'repeat', times: 1, body: [] }]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /non-empty "body" array/);
});

test('flags a foreach step missing parentSelectors/itemSelectors', () => {
  const { errors } = validateFlow(baseFlow([
    { kind: 'foreach', body: [{ kind: 'extract', key: 'X' }] },
  ]));
  assert.strictEqual(errors.length, 2);
  assert(errors.some((e) => /parentSelectors/.test(e)));
  assert(errors.some((e) => /itemSelectors/.test(e)));
});

test('flags a flow with no steps at all, and a flow missing startUrl', () => {
  assert.strictEqual(validateFlow({ startUrl: 'https://x', steps: [] }).errors.length, 1);
  assert.strictEqual(validateFlow({ steps: [{ kind: 'action', action: { name: 'click' }, selectors: ['a'] }] }).errors.length, 1);
});
