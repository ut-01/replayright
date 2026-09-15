// Unit tests for output.js's append-mode primitives (readJsonl/appendJsonl/
// mergeAppendRecords), which back output.mode: 'append' (see config.js). Pure and
// fast - the end-to-end wiring through cli.js's play/verify is covered separately
// in test/output-append.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonl, appendJsonl, mergeAppendRecords, toCsv } = require('../src/output');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayright-output-test-'));
  return path.join(dir, 'output.records.jsonl');
}

// --- readJsonl / appendJsonl ------------------------------------------------------

test('readJsonl returns an empty array when the file does not exist yet', () => {
  assert.deepStrictEqual(readJsonl(tmpFile()), []);
});

test('appendJsonl then readJsonl round-trips records, growing the file across calls', () => {
  const file = tmpFile();
  appendJsonl(file, [{ Title: 'A' }, { Title: 'B' }]);
  appendJsonl(file, [{ Title: 'C' }]);
  assert.deepStrictEqual(readJsonl(file), [{ Title: 'A' }, { Title: 'B' }, { Title: 'C' }]);
});

test('appendJsonl is a no-op for an empty record list (does not create the file)', () => {
  const file = tmpFile();
  appendJsonl(file, []);
  assert.strictEqual(fs.existsSync(file), false);
});

test('readJsonl skips a corrupt line rather than failing the whole read', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"Title":"A"}\nnot json at all\n{"Title":"B"}\n');
  assert.deepStrictEqual(readJsonl(file), [{ Title: 'A' }, { Title: 'B' }]);
});

// --- mergeAppendRecords -------------------------------------------------------------

test('mergeAppendRecords with no dedupeKey collapses exact-duplicate rows', () => {
  const merged = mergeAppendRecords([{ Title: 'A' }], [{ Title: 'A' }, { Title: 'B' }], null);
  assert.deepStrictEqual(merged, [{ Title: 'A' }, { Title: 'B' }]);
});

test('mergeAppendRecords with no dedupeKey keeps a changed row as an additional row', () => {
  const merged = mergeAppendRecords([{ Title: 'A', Price: '10' }], [{ Title: 'A', Price: '12' }], null);
  assert.deepStrictEqual(merged, [{ Title: 'A', Price: '10' }, { Title: 'A', Price: '12' }]);
});

test('mergeAppendRecords with a dedupeKey upserts: the latest value wins, at the first-seen position', () => {
  const existing = [{ Title: 'A', Price: '10' }, { Title: 'B', Price: '20' }];
  const merged = mergeAppendRecords(existing, [{ Title: 'A', Price: '11' }], ['Title']);
  assert.deepStrictEqual(merged, [{ Title: 'A', Price: '11' }, { Title: 'B', Price: '20' }]);
});

test('mergeAppendRecords with a dedupeKey appends a genuinely new key at the end', () => {
  const merged = mergeAppendRecords([{ Title: 'A' }], [{ Title: 'B' }], ['Title']);
  assert.deepStrictEqual(merged, [{ Title: 'A' }, { Title: 'B' }]);
});

test('mergeAppendRecords collapses duplicates already sitting in existingRecords, not just against newRecords', () => {
  // Simulates output.records.jsonl having accumulated the same item twice across two
  // earlier runs before dedupeKey correctness is ever exercised by a third run - the
  // JSONL file itself is an unbounded raw append log (see mergeAppendRecords's own
  // comment), so a fresh merge must not trust it to already be deduped.
  const existing = [{ Title: 'A', Price: '10' }, { Title: 'A', Price: '11' }];
  const merged = mergeAppendRecords(existing, [{ Title: 'A', Price: '12' }], ['Title']);
  assert.deepStrictEqual(merged, [{ Title: 'A', Price: '12' }], 'only one row for "A" should survive, with the latest value');
});

test('mergeAppendRecords with a multi-field dedupeKey joins the fields', () => {
  const existing = [{ Title: 'A', Location: 'X', Price: '10' }];
  const merged = mergeAppendRecords(
    existing,
    [{ Title: 'A', Location: 'Y', Price: '99' }, { Title: 'A', Location: 'X', Price: '12' }],
    ['Title', 'Location']
  );
  assert.deepStrictEqual(merged, [
    { Title: 'A', Location: 'X', Price: '12' },
    { Title: 'A', Location: 'Y', Price: '99' },
  ]);
});

test('the merged, deduped set serializes through toCsv exactly like any other record list', () => {
  const merged = mergeAppendRecords([{ Title: 'A' }], [{ Title: 'A' }, { Title: 'B' }], ['Title']);
  assert.strictEqual(toCsv(merged), 'Title\r\nA\r\nB\r\n');
});
