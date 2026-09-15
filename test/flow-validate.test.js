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
  const { errors } = validateFlow(baseFlow([{ kind: 'wait', text: 'foo' }]));
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

test('a well-formed assert step of every check type has no errors', () => {
  const { errors } = validateFlow(baseFlow([
    { kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-equals', value: 'Open roles' } },
    { kind: 'assert', scope: 'page', selectors: ['h1'], check: { type: 'text-contains', value: 'Open' } },
    { kind: 'assert', scope: 'page', selectors: ['li.card'], check: { type: 'count', op: 'gte', count: 1 } },
    { kind: 'assert', scope: 'page', selectors: ['a.card-link'], check: { type: 'attribute', attribute: 'href', value: 'job.html' } },
    { kind: 'assert', scope: 'page', check: { type: 'url', value: 'example.com' } },
  ]));
  assert.deepStrictEqual(errors, []);
});

test('flags an assert step with an unknown check type', () => {
  const { errors } = validateFlow(baseFlow([{ kind: 'assert', selectors: ['h1'], check: { type: 'glow' } }]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /unknown assert check type/);
});

test('flags an assert "count" check with more than one selector', () => {
  const { errors } = validateFlow(baseFlow([
    { kind: 'assert', selectors: ['a', 'b'], check: { type: 'count', count: 1 } },
  ]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /exactly one selector/);
});

test('flags an assert "attribute" check missing the attribute name', () => {
  const { errors } = validateFlow(baseFlow([
    { kind: 'assert', selectors: ['a'], check: { type: 'attribute', value: 'x' } },
  ]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /needs an "attribute" name/);
});

test('flags an assert "url" check missing "value", and a "text-equals" check missing selectors', () => {
  const { errors: urlErrors } = validateFlow(baseFlow([{ kind: 'assert', check: { type: 'url' } }]));
  assert.strictEqual(urlErrors.length, 1);
  assert.match(urlErrors[0], /needs a "value"/);

  const { errors: textErrors } = validateFlow(baseFlow([{ kind: 'assert', check: { type: 'text-equals', value: 'x' } }]));
  assert.strictEqual(textErrors.length, 1);
  assert.match(textErrors[0], /non-empty selectors array/);
});

test('flags a flow with no steps at all, and a flow missing startUrl', () => {
  assert.strictEqual(validateFlow({ startUrl: 'https://x', steps: [] }).errors.length, 1);
  assert.strictEqual(validateFlow({ steps: [{ kind: 'action', action: { name: 'click' }, selectors: ['a'] }] }).errors.length, 1);
});
