// Phase 3.2: field extraction. Covers the whole pipeline - ir.js folding
// `field:pick:<key>` markers into `extract` steps, interpret.js's runExtract
// accumulating rows in stats.records, and output.js turning those rows into CSV/JSON -
// plus a driven end-to-end recording that exercises the real in-page overlay code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { buildFlow } = require('../src/ir');
const { runFlow } = require('../src/interpret');
const { verifyFlow, auditShape } = require('../src/verify');
const { recordSite, sitePaths } = require('../src/record');
const { writeOutput, toCsv, toJson, collectColumns } = require('../src/output');
const { MARKER_PREFIX } = require('../src/constants');

const fixture = (...p) => pathToFileURL(path.join(__dirname, 'fixtures', ...p)).href;

// --- ir.js: field markers fold into `extract` steps -----------------------------

const marker = (meaning) => ({ name: 'click', selector: `internal:role=button[name="${MARKER_PREFIX}${meaning}"i]`, clickCount: 1 });
const log = (...actions) => actions.map((action, seq) => ({ seq, action }));
const scopeEvent = (overrides = {}) => ({
  type: 'F', phase: 'scope', parents: ['#results'], items: ['li.card', 'li'], count: 5, ...overrides,
});
const fieldEvent = (rel, tag = 'a', text = 'Frontend Engineer') => ({ type: 'field', rel, tag, text });

test('a field pick inside an F body produces an extract step', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'https://example.test/',
    actionLog: log(
      marker('F:arm'),
      marker('field:pick:Title'),
      marker('F:close')
    ),
    overlayEvents: [scopeEvent(), fieldEvent(['.card-link'])],
  });

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.ok(foreach, 'expected a foreach');
  assert.strictEqual(foreach.body.length, 1);
  assert.strictEqual(foreach.body[0].kind, 'extract');
  assert.strictEqual(foreach.body[0].key, 'Title');
  assert.deepStrictEqual(foreach.body[0].relativeSelectors, ['.card-link']);
  // A field-only body is a legitimate "scrape this listing" shape, not a
  // scope-detection failure - it must not be flagged.
  assert.deepStrictEqual(warnings.filter((w) => w.type === 'foreach-without-item-steps'), []);
});

test('multiple fields in one iteration each produce their own extract step, in order', () => {
  const { flow } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(
      marker('F:arm'),
      marker('field:pick:Title'),
      marker('field:pick:Location'),
      marker('field:pick:Posted date'),
      marker('F:close')
    ),
    overlayEvents: [
      scopeEvent(),
      fieldEvent(['.card-link'], 'a', 'Frontend Engineer'),
      fieldEvent(['.loc'], 'span', 'Bangalore'),
      fieldEvent(['.posted'], 'span', '3 days ago'),
    ],
  });

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.deepStrictEqual(foreach.body.map((s) => [s.kind, s.key]), [
    ['extract', 'Title'],
    ['extract', 'Location'],
    ['extract', 'Posted date'],
  ]);
});

test('a custom field label with a colon survives the marker round-trip intact', () => {
  const { flow } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('F:arm'), marker('field:pick:Salary: Base'), marker('F:close')),
    overlayEvents: [scopeEvent(), fieldEvent(['.salary'])],
  });

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.strictEqual(foreach.body[0].key, 'Salary: Base');
});

test('a field marker outside a foreach is dropped with a warning, not pushed to the flow', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('field:pick:Title')),
    overlayEvents: [],
  });

  assert.strictEqual(flow.steps.length, 0);
  assert.ok(warnings.some((w) => w.type === 'field-outside-foreach'));
});

test('an armed field with no captured pick is dropped with a warning', () => {
  const { flow, warnings } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('F:arm'), marker('field:pick:Title'), marker('F:close')),
    overlayEvents: [scopeEvent()], // no matching field payload queued
  });

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.deepStrictEqual(foreach.body, []);
  assert.ok(warnings.some((w) => w.type === 'field-without-pick'));
});

test('no marker or picker action from the field pills leaks into the flow', () => {
  const { flow } = buildFlow({
    siteId: 's',
    url: 'u',
    actionLog: log(marker('F:arm'), marker('field:pick:Title'), marker('F:close')),
    overlayEvents: [scopeEvent(), fieldEvent(['.card-link'])],
  });
  assert.ok(!JSON.stringify(flow).includes(MARKER_PREFIX));
});

// --- interpret.js: runExtract accumulates rows, never throws --------------------

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

function extractFlow(overrides = {}) {
  return {
    siteId: 'fixture-extract',
    startUrl: fixture('paged', 'page1.html'),
    steps: [
      {
        kind: 'foreach',
        parentSelectors: ['#results'],
        itemSelectors: ['li.card'],
        expectedCount: 5,
        body: [
          { kind: 'extract', key: 'Title', relativeSelectors: ['.card-link'] },
          { kind: 'extract', key: 'Location', relativeSelectors: ['.loc'] },
          { kind: 'extract', key: 'Missing', relativeSelectors: ['.nope-does-not-exist'] },
        ],
      },
    ],
    ...overrides,
  };
}

test('extraction produces one row per foreach iteration with the tagged fields', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(extractFlow(), { page, ...FAST });

    assert.deepStrictEqual(stats.errors, []);
    assert.strictEqual(stats.foreachIterations, 5);
    assert.strictEqual(stats.records.length, 5, 'one row per item');

    assert.deepStrictEqual(stats.records[0], {
      Title: 'Frontend Engineer',
      Location: 'Bangalore',
      Missing: null,
    });
    assert.deepStrictEqual(stats.records[4], {
      Title: 'QA Engineer',
      Location: 'Delhi',
      Missing: null,
    });
  });
});

test('a field that will not resolve writes null and does not abort the run', async () => {
  await withPage(async (page) => {
    const stats = await runFlow(extractFlow(), { page, ...FAST });

    assert.strictEqual(stats.aborted, undefined, 'an unresolved field must not abort the run');
    assert.deepStrictEqual(stats.errors, [], 'a missing field is a warning, not an error');
    assert.ok(stats.records.every((r) => r.Missing === null));
    assert.ok(stats.warnings.some((w) => w.type === 'extract-unresolved'));
  });
});

test('an extract step outside any foreach writes null rather than throwing', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-extract-malformed',
      startUrl: fixture('paged', 'page1.html'),
      steps: [{ kind: 'extract', key: 'Title', relativeSelectors: ['.card-link'] }],
    };
    const stats = await runFlow(flow, { page, ...FAST });
    assert.strictEqual(stats.aborted, undefined);
    assert.deepStrictEqual(stats.errors, []);
  });
});

test('a nested repeat/foreach accumulates rows across every page', async () => {
  await withPage(async (page) => {
    const flow = {
      siteId: 'fixture-extract-paged',
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
              itemSelectors: ['li.card'],
              expectedCount: 5,
              body: [
                { kind: 'extract', key: 'Title', relativeSelectors: ['.card-link'] },
                { kind: 'extract', key: 'Location', relativeSelectors: ['.loc'] },
              ],
            },
            { kind: 'action', scope: 'page', selectors: ['#next'], action: { name: 'click' } },
          ],
        },
      ],
    };

    const stats = await runFlow(flow, { page, ...FAST });

    assert.strictEqual(stats.repeatIterations, 3);
    assert.strictEqual(stats.foreachIterations, 15);
    assert.strictEqual(stats.records.length, 15, 'one row per item across all 3 pages');
    assert.deepStrictEqual(stats.errors, []);

    const titles = stats.records.map((r) => r.Title);
    assert.ok(titles.includes('Frontend Engineer'));
    assert.ok(titles.includes('Engineering Manager'), 'should include a title from the last page');
  });
});

// --- verify.js: an extract step with no candidates is a shape problem -----------

test('auditShape flags an extract step with no selector candidates', () => {
  const flow = extractFlow();
  flow.steps[0].body.push({ kind: 'extract', key: 'Broken', relativeSelectors: [] });
  const { problems } = auditShape(flow);
  assert.ok(problems.some((p) => p.includes('Broken') && p.includes('no selector candidates')));
});

test('a field-only foreach body (no click/fill) is not flagged as having no per-item steps', () => {
  const { problems } = auditShape(extractFlow());
  assert.deepStrictEqual(problems.filter((p) => p.includes('no per-item steps')), []);
});

// --- output.js: CSV/JSON, column order by first-seen field ----------------------

test('toCsv orders columns by first-seen field and quotes only when needed', () => {
  const records = [
    { Title: 'Frontend Engineer', Location: 'Bangalore' },
    { Location: 'Pune', Title: 'Backend Engineer', Extra: 'x' },
    { Title: 'Has, a comma', Location: 'Say "hi"' },
  ];
  const csv = toCsv(records);
  const lines = csv.trim().split('\r\n');

  assert.strictEqual(lines[0], 'Title,Location,Extra', 'columns ordered by first-seen field, Extra appended last');
  assert.strictEqual(lines[1], 'Frontend Engineer,Bangalore,');
  assert.strictEqual(lines[2], 'Backend Engineer,Pune,x');
  assert.strictEqual(lines[3], '"Has, a comma","Say ""hi""",');
});

test('toJson round-trips the records verbatim', () => {
  const records = [{ Title: 'A', Location: null }, { Title: 'B', Location: 'X' }];
  assert.deepStrictEqual(JSON.parse(toJson(records)), records);
});

test('collectColumns is first-seen order, de-duplicated', () => {
  const columns = collectColumns([{ b: 1, a: 2 }, { a: 3, c: 4 }, { b: 5 }]);
  assert.deepStrictEqual(columns, ['b', 'a', 'c']);
});

test('writeOutput picks CSV or JSON by extension and skips writing when there are no records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playright-output-test-'));
  try {
    const csvPath = path.join(dir, 'out.csv');
    const jsonPath = path.join(dir, 'out.json');
    const emptyPath = path.join(dir, 'empty.csv');

    const records = [{ Title: 'A' }, { Title: 'B' }];
    assert.strictEqual(writeOutput(csvPath, records), csvPath);
    assert.strictEqual(writeOutput(jsonPath, records), jsonPath);
    assert.strictEqual(writeOutput(emptyPath, []), null, 'nothing tagged -> nothing written');
    assert.strictEqual(fs.existsSync(emptyPath), false);

    assert.match(fs.readFileSync(csvPath, 'utf8'), /^Title\r\nA\r\nB\r\n$/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), records);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end: a real recording session tags fields via the overlay -----------

const SITE_ID = '_test_extract_e2e';

test.after(() => fs.rmSync(sitePaths(SITE_ID).dir, { recursive: true, force: true }));

test('a driven recording that tags two fields replays into a CSV with matching columns and one row per item', async () => {
  const drive = async (page) => {
    await page.getByRole('button', { name: 'playright:F:arm' }).click();

    const list = await page.locator('#results').boundingBox();
    await page.mouse.click(list.x + 6, list.y + 6);

    const card = await page.locator('#results li.card').first().boundingBox();
    await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);

    // Field pills only appear once the F body is open.
    await page.getByRole('button', { name: 'playright:field:pick:Title' }).click();
    const title = await page.locator('#results li.card').first().locator('a.card-link').boundingBox();
    await page.mouse.click(title.x + title.width / 2, title.y + title.height / 2);

    await page.getByRole('button', { name: 'playright:field:pick:Location' }).click();
    const loc = await page.locator('#results li.card').first().locator('span.loc').boundingBox();
    await page.mouse.click(loc.x + loc.width / 2, loc.y + loc.height / 2);

    await page.getByRole('button', { name: 'playright:F:close' }).click();
  };

  const { flow } = await recordSite({
    siteId: SITE_ID,
    url: fixture('paged', 'page1.html'),
    headless: true,
    viewport: { width: 1280, height: 900 },
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playright-extract-test-')),
    drive,
  });

  const foreach = flow.steps.find((s) => s.kind === 'foreach');
  assert.ok(foreach, 'expected a foreach');
  assert.deepStrictEqual(foreach.body.map((s) => [s.kind, s.key]), [
    ['extract', 'Title'],
    ['extract', 'Location'],
  ]);
  assert.ok(!JSON.stringify(flow).includes(MARKER_PREFIX), 'no marker noise should survive into the flow');

  const { ok, stats, reasons } = await verifyFlow(flow, { headless: true, ...FAST });
  assert.ok(ok, `expected a clean verify; reasons: ${reasons.join('; ')}`);
  assert.strictEqual(stats.records.length, 5, 'one row per card on the fixture page');
  assert.deepStrictEqual(stats.records[0], { Title: 'Frontend Engineer', Location: 'Bangalore' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playright-extract-out-'));
  try {
    const outPath = writeOutput(path.join(dir, 'output.csv'), stats.records);
    const csv = fs.readFileSync(outPath, 'utf8');
    assert.match(csv, /^Title,Location\r\n/, 'CSV columns should match the tagged fields, in tagged order');
    assert.strictEqual(csv.trim().split('\r\n').length, 6, 'header + 5 rows');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
