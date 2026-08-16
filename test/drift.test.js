// Drift detection is the tripwire for a scheduled run, so its failure modes matter more
// than its happy path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const drift = require('../src/drift');
const { driftSelectorsFor, classifyDrift, saveFingerprint, loadPreviousFingerprint } = drift;

const SITE_ID = '_test_drift';
const siteDir = path.resolve(__dirname, '..', 'sites', SITE_ID);

test.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));

test('watched selectors are derived from the flow, not maintained by hand', () => {
  const flow = {
    steps: [{
      kind: 'repeat', untilGone: '#next', body: [
        { kind: 'foreach', parentSelectors: ['#results', '.fallback'], itemSelectors: ['li.card'], body: [] },
      ],
    }],
  };

  const names = driftSelectorsFor(flow);
  assert.deepStrictEqual(names.map((s) => s.selector), ['#next', '#results', 'li.card']);
  // Only primary candidates: a fallback already being in use is reported by the
  // interpreter as it happens, and watching it here would mask that.
  assert.ok(!names.some((s) => s.selector === '.fallback'));
});

test('a selector going from matching to not matching is BROKEN', () => {
  const previous = { selectorCounts: { items: 20 }, foreachIterations: 20 };
  const current = { selectorCounts: { items: 0 }, foreachIterations: 0 };
  const { status, issues } = classifyDrift(previous, current);

  assert.strictEqual(status, 'BROKEN');
  assert.ok(issues.some((i) => i.name === 'items'));
  assert.ok(issues.some((i) => i.name === 'foreachIterations'));
});

test('a large but partial drop is a WARNING, not a failure', () => {
  const { status } = classifyDrift(
    { selectorCounts: { items: 20 }, foreachIterations: 20 },
    { selectorCounts: { items: 4 }, foreachIterations: 4 }
  );
  assert.strictEqual(status, 'WARNING');
});

test('no history means OK - there is nothing to compare against', () => {
  assert.strictEqual(classifyDrift(null, { selectorCounts: { items: 0 } }).status, 'OK');
});

// The regression that matters most: a broken run must NOT become the new baseline, or the
// breakage is invisible from the second day onward.
test('a BROKEN run does not poison the baseline', () => {
  fs.rmSync(siteDir, { recursive: true, force: true });

  const good = { siteId: SITE_ID, selectorCounts: { items: 20 }, foreachIterations: 20 };
  assert.strictEqual(saveFingerprint(SITE_ID, good, 'OK'), true);
  assert.deepStrictEqual(loadPreviousFingerprint(SITE_ID).selectorCounts, { items: 20 });

  const broken = { siteId: SITE_ID, selectorCounts: { items: 0 }, foreachIterations: 0 };
  assert.strictEqual(saveFingerprint(SITE_ID, broken, 'BROKEN'), false, 'should refuse to advance the baseline');
  assert.deepStrictEqual(
    loadPreviousFingerprint(SITE_ID).selectorCounts, { items: 20 },
    'the last known good fingerprint must survive a broken run'
  );

  // So the NEXT run is still judged against the good baseline and stays BROKEN.
  assert.strictEqual(classifyDrift(loadPreviousFingerprint(SITE_ID), broken).status, 'BROKEN');

  // Every run is still recorded for forensics, broken ones included.
  const history = fs.readFileSync(path.join(siteDir, 'history.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(history.length, 2);
  assert.deepStrictEqual(history.map((line) => JSON.parse(line).status), ['OK', 'BROKEN']);
});
