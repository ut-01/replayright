// emit.js
//
// Renders a flow as a readable Playwright script. This is a DEBUG ARTIFACT ONLY - it is
// never executed, never parsed, and never round-tripped. flow.json is the authoritative
// thing that runs (see interpret.js).
//
// That separation is the point. The previous implementation's output was produced by
// string-surgery over Playwright's generated file - anchoring on the first and last
// action lines and deleting excluded ones with `text.split(line).join('')`, a global
// delete that could corrupt any line that happened to share a substring. Generating a
// throwaway view from a structured source has none of those failure modes.
const { REPEAT_DEFAULT_TIMES } = require('./constants');

const q = (value) => JSON.stringify(value);

// Carried over from the previous postprocess.js: Playwright's action objects use the
// same field names across every language generator, so rebuilding a call from
// name/text/key/clickCount is stable.
function callFor(target, action) {
  switch (action.name) {
    case 'click':
      return action.clickCount === 2 ? `await ${target}.dblclick();`
        : action.button === 'right' ? `await ${target}.click({ button: 'right' });`
        : `await ${target}.click();`;
    case 'check': return `await ${target}.check();`;
    case 'uncheck': return `await ${target}.uncheck();`;
    case 'fill': return `await ${target}.fill(${q(action.text ?? '')});`;
    case 'press': return `await ${target}.press(${q(action.key ?? '')});`;
    case 'select': return `await ${target}.selectOption(${q(action.options ?? [])});`;
    case 'hover': return `await ${target}.hover();`;
    default: return `// unsupported action ${q(action.name)}`;
  }
}

// `itemVar` is null until inside a foreach; `depth` names nested loops item, item2, ...
function emitSteps(steps, indent, itemVar, depth = 0) {
  const lines = [];
  const pad = ' '.repeat(indent);

  for (const step of steps || []) {
    if (step.kind === 'action') {
      if (step.action.name === 'navigate') {
        lines.push(`${pad}await page.goto(${q(step.action.url)});`);
        continue;
      }

      const isItem = step.scope === 'item';
      const list = isItem ? step.relativeSelectors : step.selectors;
      const primary = list?.[0];

      // The detail page is opened in its own tab so the list is never navigated away.
      if (step.opensDetail) {
        const link = primary === '' ? itemVar : `${itemVar}.locator(${q(primary)})`;
        lines.push(`${pad}// open this item's detail in its own tab, leaving the list untouched`);
        lines.push(`${pad}const href = await ${link}.evaluate((el) => el.href);`);
        lines.push(`${pad}const detailPage = await page.context().newPage();`);
        lines.push(`${pad}await detailPage.goto(href);`);
        continue;
      }
      if (step.returnsToList) {
        lines.push(`${pad}await detailPage.close(); // the tab IS the "back" step`);
        continue;
      }

      const target = isItem
        ? (primary === '' ? itemVar : `${itemVar}.locator(${q(primary)})`)
        : `${step.scope === 'detail' ? 'detailPage' : 'page'}.locator(${q(primary)})`;
      lines.push(`${pad}${callFor(target, step.action)}`);
      if (list && list.length > 1) {
        lines.push(`${pad}// fallback selectors: ${list.slice(1).map(q).join(', ')}`);
      }
      continue;
    }

    if (step.kind === 'repeat') {
      lines.push(`${pad}for (let page_i = 0; page_i < ${step.times ?? REPEAT_DEFAULT_TIMES}; page_i++) {`);
      if (step.untilGone) {
        lines.push(`${pad}  // exits early once ${q(step.untilGone)} is gone or disabled`);
      }
      lines.push(...emitSteps(step.body, indent + 2, itemVar, depth));
      lines.push(`${pad}}`);
      continue;
    }

    if (step.kind === 'foreach') {
      const nested = depth === 0 ? 'item' : `item${depth + 1}`;
      const hasFields = (step.body || []).some((s) => s.kind === 'extract');
      lines.push(`${pad}{`);
      lines.push(`${pad}  const parent = page.locator(${q(step.parentSelectors?.[0])});`);
      lines.push(`${pad}  const items = parent.locator(${q(step.itemSelectors?.[0])});`);
      lines.push(`${pad}  const total = await items.count(); // recorded: ${step.expectedCount ?? '?'}`);
      lines.push(`${pad}  for (let i = 0; i < total; i++) {`);
      lines.push(`${pad}    const ${nested} = items.nth(i); // re-resolved every iteration`);
      if (hasFields) lines.push(`${pad}    const row = {};`);
      lines.push(...emitSteps(step.body, indent + 4, nested, depth + 1));
      if (hasFields) lines.push(`${pad}    records.push(row);`);
      lines.push(`${pad}  }`);
      lines.push(`${pad}}`);
      continue;
    }

    if (step.kind === 'extract') {
      const list = step.relativeSelectors;
      const primary = list?.[0];
      const target = primary === '' ? itemVar : `${itemVar}.locator(${q(primary)})`;
      lines.push(`${pad}row[${q(step.key)}] = await ${target}.first().innerText().then((t) => t.trim()).catch(() => null);`);
      if (list && list.length > 1) {
        lines.push(`${pad}// fallback selectors: ${list.slice(1).map(q).join(', ')}`);
      }
      continue;
    }

    lines.push(`${pad}// unknown step kind ${q(step.kind)}`);
  }

  return lines;
}

function emitFlow(flow) {
  return [
    '// GENERATED FROM flow.json - FOR READING ONLY.',
    '// This file is not what runs. `npm run play -- --id=<id>` executes flow.json',
    '// directly via src/interpret.js; edits here are lost on the next emit.',
    `// site: ${flow.siteId}   recorded: ${flow.recordedAt || 'unknown'}   verified: ${!!flow.verified}`,
    '',
    "const { chromium } = require('playwright');",
    '',
    '(async () => {',
    '  const browser = await chromium.launch({ headless: false });',
    '  const page = await browser.newPage();',
    '  const records = []; // one row per tagged foreach iteration, if any',
    flow.startUrl ? `  await page.goto(${q(flow.startUrl)});` : '',
    '',
    ...emitSteps(flow.steps, 2, null, 0),
    '',
    '  console.log(JSON.stringify(records, null, 2));',
    '  await browser.close();',
    '})();',
    '',
  ].filter((line) => line !== '').join('\n');
}

module.exports = { emitFlow, callFor };
