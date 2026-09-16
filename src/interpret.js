// interpret.js
//
// Executes a flow.json. This is the authoritative player - the emitted .js is a
// read-only debug artifact, never the thing that runs.
//
// Step kinds, nested arbitrarily:
//   { kind: 'action', scope, selectors|relativeSelectors, action }
//   { kind: 'repeat', times, untilGone?, settle?, body: [...] }
//   { kind: 'foreach', parentSelectors, itemSelectors, expectedCount?, body: [...] }
//   { kind: 'extract', key, relativeSelectors }
//   { kind: 'assert', scope, selectors|relativeSelectors, check, message? }
//
// Nesting is the whole point: the real-world shape is a `repeat` over pages wrapping
// a `foreach` over the cards on each page. The previous implementation flattened
// blocks and silently dropped the inner one.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const candidates = require('./candidates');
const { resolveSecrets } = require('./secrets');
const { createChunkedWriter } = require('./output');
const { sleep, randomDelay, logInfo, logWarn, logError, EVENT } = require('./log');
const {
  REPEAT_DEFAULT_TIMES,
  HARD_LOOP_CEILING,
  MAX_CONSECUTIVE_ERRORS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  SETTLE_TIMEOUT_MS,
  RESOLVE_WAIT_MS,
  CHROMIUM_ARGS,
  CHUNK_BYTES_LIMIT,
} = require('./constants');

// Actions Playwright records that describe the recording session itself rather than
// something to replay against a locator.
const PAGE_LEVEL_ACTIONS = new Set(['openPage', 'closePage', 'navigate']);

function newStats() {
  return {
    actions: 0,
    repeatIterations: 0,
    foreachIterations: 0,
    fallbacks: [],
    warnings: [],
    errors: [],
    steps: [],
    // One flat object per foreach iteration that tagged at least one field (see
    // runExtract / runForeach below). Rows from every nested repeat/foreach share this
    // single list - output.js turns it into CSV/JSON.
    records: [],
    // A row where every tagged field came back null (the header/spacer rows a raw
    // "tr" item selector tends to sweep up alongside real data - see the field
    // resolution comment in runForeach) carries no information, so it is dropped
    // rather than written as a blank line. A row with SOME fields populated and
    // others null is kept as-is - only a row that is null across the board is
    // considered "empty" here.
    emptyRecordsSkipped: 0,
  };
}

// True when every value on a record is null/undefined/empty-string - i.e. nothing
// about this row resolved to anything, so it's noise (a header row, a spacer row)
// rather than a real but partially-missing item.
function isEmptyRecord(record) {
  return Object.values(record).every((v) => v === null || v === undefined || v === '');
}

// Every `extract` step's key anywhere in the flow, first-seen order, walked
// statically before any page loads. A streamed CSV/JSON file commits its column set
// with the very first chunk written to disk, so - unlike output.js's toCsv(), which
// can freely discover columns from the full in-memory record set - the chunked
// writer needs the complete key list up front, from the flow's own shape rather than
// from data it hasn't seen yet.
function collectExtractKeys(steps) {
  const keys = [];
  const seen = new Set();
  const walk = (list) => {
    for (const step of list || []) {
      if (step.kind === 'extract' && !seen.has(step.key)) {
        seen.add(step.key);
        keys.push(step.key);
      }
      if (step.body) walk(step.body);
    }
  };
  walk(steps);
  return keys;
}

// Moves whatever is pending into the chunk writer. `force` is used at a natural
// boundary (the end of a repeat iteration/"page", or the run finishing) where
// whatever has accumulated should go out regardless of size; without `force`, a
// pending chunk is only flushed once it reaches the configured byte budget - the
// fallback for a flow with no repeat block (or one page whose own row count is
// large enough to matter on its own).
function maybeFlushChunk(stats, opts, { force = false } = {}) {
  if (!opts.chunkWriter || !stats._pending.length) return;
  if (!force && stats._pendingBytes < opts.chunkBytesLimit) return;
  opts.chunkWriter.writeChunk(stats._pending);
  stats._pending = [];
  stats._pendingBytes = 0;
}

// Applies one action to an already-resolved locator. Field names come straight from
// Playwright's api-mode action objects, confirmed by dumping them in the Phase 1
// spike: click{clickCount,button}, fill{text}, press{key}, select{options}.
async function applyAction(locator, action, env = process.env) {
  switch (action.name) {
    case 'click':
      if (action.clickCount === 2) return locator.dblclick();
      if (action.button === 'right') return locator.click({ button: 'right' });
      return locator.click();
    case 'check':
      return locator.check();
    case 'uncheck':
      return locator.uncheck();
    case 'fill':
      // Resolves any `{{env:NAME}}` placeholder a recorded password was hand-edited
      // into (see secrets.js) - a literal value with no placeholder in it passes
      // through untouched.
      return locator.fill(resolveSecrets(action.text ?? '', env));
    case 'press':
      return locator.press(action.key ?? '');
    case 'select':
      return locator.selectOption(action.options ?? []);
    case 'hover':
      return locator.hover();
    default:
      throw new Error(`unsupported action "${action.name}"`);
  }
}

async function safeText(page, selector) {
  try {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return null;
    return (await locator.innerText()).trim();
  } catch {
    return null;
  }
}

// Same as safeText, but against an already-resolved locator rather than a fresh
// selector lookup - used to fingerprint "is this the same first item as last round"
// without a second round of candidate resolution.
async function safeLocatorText(locator) {
  try {
    return (await locator.innerText()).trim();
  } catch {
    return null;
  }
}

// Generic, site-agnostic settle condition: "the content under this selector must
// differ from what it was before the last iteration". Locator auto-waiting handles
// most timing, but an SPA that swaps its list in place after a "Next Page" click
// gives Playwright nothing to wait on - the old items are still attached and
// clickable, so the next iteration happily re-scrapes the previous page.
//
// A single differing read is not enough to trust, the same way a single foreach
// item-count read isn't (see resolveItemsUntilStable): a live-updating page can flash
// a transient state right after the click - or, observed on a real site, silently
// revert to the PREVIOUS page a moment later (its own background refresh apparently
// resets pagination) - and accepting that flicker as "navigation complete" sends the
// next iteration right back into content it already scraped. So require the changed
// value to hold for two consecutive reads before calling it settled.
async function waitForTextChange(page, selector, previousText, timeoutMs, ctx) {
  if (previousText === null) return;
  const deadline = Date.now() + timeoutMs;
  let pendingValue = null;
  while (Date.now() < deadline) {
    const now = await safeText(page, selector);
    if (now === previousText) {
      pendingValue = null;
    } else if (now === pendingValue) {
      return;
    } else {
      pendingValue = now;
    }
    await sleep(200);
  }
  note(ctx, 'warnings', {
    type: 'settle-timeout',
    selector,
    message: `content under ${JSON.stringify(selector)} did not change within ${timeoutMs}ms; continuing anyway (the next iteration may repeat the same items)`,
  });
}

// bucket -> the vocabulary tag it's reported under in json log mode. Kept as one small
// map rather than scattering event choices across call sites, so every warning/error/
// fallback pushed onto stats gets the same tag whether it came from an action, an
// extract, a foreach, or a repeat.
const BUCKET_EVENT = {
  fallbacks: EVENT.STEP_FALLBACK,
  errors: EVENT.STEP_FAILED,
  warnings: EVENT.STEP_WARNING,
};

function note(ctx, bucket, entry) {
  ctx.stats[bucket].push({ path: ctx.path, ...entry });
  const message = entry.message || entry.reason || entry.type;
  const meta = { event: BUCKET_EVENT[bucket] || EVENT.GENERIC, path: ctx.path };
  if (bucket === 'errors') logError(`${ctx.path}: ${message}`, meta);
  else logWarn(`${ctx.path}: ${message}`, meta);
}

function onFallbackFor(ctx) {
  return (info) => {
    // Re-resolving happens once per foreach iteration, so the same fallback would
    // otherwise be logged N times for one underlying site change. Collapse the
    // iteration indexes out of the path so all iterations of one logical step share
    // a key ("0:foreach[3]/1:" and "0:foreach[4]/1:" are the same step).
    const stablePath = ctx.path.replace(/\[\d+\]/g, '[*]');
    const key = `${stablePath}|${info.what}|${info.selector}`;
    if (ctx.stats._fallbackKeys.has(key)) return;
    ctx.stats._fallbackKeys.add(key);
    note(ctx, 'fallbacks', {
      type: 'selector-fallback',
      what: info.what,
      selector: info.selector,
      candidateIndex: info.candidateIndex,
      message: `${info.what}: using fallback candidate [${info.candidateIndex}] ${JSON.stringify(info.selector)} - ${info.reason}`,
    });
  };
}

async function saveFailureArtifacts(ctx, label) {
  const dir = ctx.opts.artifactsDir;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${stamp}-${label.replace(/[^a-zA-Z0-9_-]+/g, '_')}`);
    await ctx.page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    fs.writeFileSync(`${base}.html`, await ctx.page.content());
    return base;
  } catch {
    return null;
  }
}

// --- step kinds ---------------------------------------------------------------

async function runAction(step, ctx) {
  const action = step.action || {};

  if (PAGE_LEVEL_ACTIONS.has(action.name)) {
    if (action.name === 'navigate') {
      // Skip a navigate to where we already are - runFlow() honours flow.startUrl
      // up front, and the recorder also captures that first goto as an action.
      if (ctx.page.url() === action.url) return;
      await ctx.page.goto(action.url, { waitUntil: 'domcontentloaded' });
      ctx.stats.actions += 1;
      await sleep(randomDelay(ctx.opts.minDelayMs, ctx.opts.maxDelayMs));
      return;
    }
    // openPage/closePage describe the recording session's own tab management. Real
    // multi-tab flows (a job opening in a new tab) are not supported yet; say so
    // rather than silently doing nothing surprising.
    if (action.name === 'openPage' && ctx.stats.actions > 0) {
      note(ctx, 'warnings', { type: 'unsupported', message: 'flow opens an additional tab; multi-tab replay is not implemented, skipping' });
    }
    return;
  }

  const scopeName = step.scope || 'page';
  const isItemScoped = scopeName === 'item';
  if (isItemScoped && !ctx.item) {
    throw new Error(`step is item-scoped but is not inside a foreach (malformed flow)`);
  }

  // A `returnsToList` step exists to undo a same-tab navigation. When the detail was
  // opened in its own tab there is nothing to go back from - closing the tab IS the
  // return, and the list page was never disturbed.
  if (step.returnsToList && ctx.detailRef?.ownTab) {
    await ctx.detailRef.page.close().catch(() => {});
    ctx.detailRef.page = null;
    ctx.detailRef.ownTab = false;
    return;
  }

  const detailPage = ctx.detailRef?.page || ctx.page;
  const scope = isItemScoped ? ctx.item : (scopeName === 'detail' ? detailPage : ctx.page);
  const selectors = isItemScoped ? step.relativeSelectors : step.selectors;

  // The step that drives an enclosing repeat forward (the "Next Page" click) is the
  // one action that legitimately has nothing to do on the final iteration. Checking
  // it here rather than only between iterations matters: a site that DISABLES its
  // next-page button instead of removing it would otherwise make Playwright wait for
  // the button to become enabled until it times out - turning a clean exit into a
  // 30-second failure on every single run.
  if (!isItemScoped && ctx.repeatExit && selectors?.includes(ctx.repeatExit.selector)) {
    const { gone, reason } = await candidates.isGoneOrDisabled(ctx.page, ctx.repeatExit.selector);
    if (gone) {
      logInfo(`${ctx.path}skipping the loop-advance action - ${reason}`, { path: ctx.path });
      ctx.repeatExit.done = true;
      return;
    }
  }

  const actingPage = scopeName === 'detail' ? detailPage : ctx.page;
  const urlBefore = actingPage.url();

  const { locator, selector, candidateIndex } = await candidates.resolve(scope, selectors, {
    what: `${action.name} target`,
    ariaSnapshot: step.ariaSnapshot || action.ariaSnapshot,
    onFallback: onFallbackFor(ctx),
    // Acting on an ambiguous locator would silently hit the wrong element.
    preferUnique: true,
    // Give a still-rendering page time to catch up; count() alone does not wait.
    waitMs: ctx.opts.resolveWaitMs,
    requireVisible: true,
  });

  // The step that leads to a job's detail page. Preferred route: read the link's href and
  // open it in a NEW TAB, leaving the list page untouched so the loop can keep iterating.
  // Falls back to clicking in place when the target is not a real link (a JS-driven
  // expand or route push), which is the old same-tab behaviour.
  if (step.opensDetail && ctx.detailRef) {
    const href = await locator.evaluate((el) => el.href || null).catch(() => null);
    if (href) {
      const tab = await ctx.page.context().newPage();
      await tab.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
      ctx.detailRef.page = tab;
      ctx.detailRef.ownTab = true;
      ctx.stats.actions += 1;
      ctx.stats.steps.push({ path: ctx.path, kind: 'action', action: 'open-detail-tab', selector, candidateIndex, status: 'ok' });
      await sleep(randomDelay(ctx.opts.minDelayMs, ctx.opts.maxDelayMs));
      return;
    }
    ctx.detailRef.page = ctx.page;
    ctx.detailRef.ownTab = false;
  }

  await applyAction(locator, action, ctx.opts.env);
  ctx.stats.actions += 1;
  ctx.stats.steps.push({ path: ctx.path, kind: 'action', action: action.name, selector, candidateIndex, status: 'ok' });

  // Throttle only when a real page load actually happened. An in-place DOM update
  // has no load to be polite about, and paying a blanket delay per click makes a
  // 15-item flow needlessly slow.
  if (actingPage.url() !== urlBefore) {
    await actingPage.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(randomDelay(ctx.opts.minDelayMs, ctx.opts.maxDelayMs));
  }
}

// A field pick has nothing sensible to fail INTO - "the page changed and this field
// is gone" is routine on a listing (a card without a location, a job with no posted
// date), not a reason to abort a run that is otherwise working. So this never throws:
// an unresolved candidate list writes null onto the row and is reported as a warning,
// never as an error that counts against the consecutive-failure budget.
async function runExtract(step, ctx) {
  if (!ctx.item) {
    // Malformed flow (extract outside any foreach) - ir.js never produces this, but a
    // hand-edited flow.json could. Still don't throw; there's simply nothing to read.
    if (ctx.record) ctx.record[step.key] = null;
    note(ctx, 'warnings', { type: 'extract-outside-foreach', message: `field "${step.key}" is not inside a foreach; writing null` });
    return;
  }

  const selectors = step.relativeSelectors && step.relativeSelectors.length ? step.relativeSelectors : [''];

  try {
    const { locator, selector, candidateIndex } = await candidates.resolve(ctx.item, selectors, {
      what: `field "${step.key}"`,
      onFallback: onFallbackFor(ctx),
      // locator.count() does not auto-wait (see candidates.js); poll against the same
      // shared deadline every other resolution in this file uses.
      waitMs: ctx.opts.resolveWaitMs,
    });
    // `.first()` deliberately, not `preferUnique` - a field is read, not acted on, so an
    // ambiguous match (e.g. a wrapping label plus its child span both matching) is fine
    // to just read the first of; failing the whole row over it would be the wrong trade.
    const text = (await locator.first().innerText()).trim();
    if (ctx.record) ctx.record[step.key] = text;
    // Counted as a "step executed" the same as an action - a flow that ONLY extracts
    // fields (no click/fill) is a legitimate shape, and `actions === 0` is what both
    // verify.js and cli.js's `play` treat as "nothing happened, fail the run"; without
    // this a field-only flow would never be able to pass verification no matter how
    // many rows it correctly scraped.
    ctx.stats.actions += 1;
    ctx.stats.steps.push({ path: ctx.path, kind: 'extract', key: step.key, selector, candidateIndex, status: 'ok' });
  } catch (err) {
    if (ctx.record) ctx.record[step.key] = null;
    note(ctx, 'warnings', {
      type: 'extract-unresolved',
      message: `field "${step.key}" could not be resolved; writing null (${err.message.split('\n')[0]})`,
    });
    ctx.stats.steps.push({ path: ctx.path, kind: 'extract', key: step.key, status: 'null' });
  }
}

// Unlike runExtract, a failed assertion always fails the run - the whole point of this
// step kind is to say "the page rendered but the state/data looks wrong", distinctly
// from a vanished selector (SELECTOR_UNRESOLVED) or a watched selector drifting
// (DRIFT_BROKEN). Thrown as AssertionError (code ASSERT_FAILED) so cli.js can report it
// under its own exit code (src/constants.js#EXIT_CODE.ASSERT_FAILED) rather than lumping
// it in with either of those.
class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
    this.code = 'ASSERT_FAILED';
  }
}

function compareCount(actual, op, expected) {
  switch (op || 'eq') {
    case 'eq': return actual === expected;
    case 'gte': return actual >= expected;
    case 'lte': return actual <= expected;
    case 'gt': return actual > expected;
    case 'lt': return actual < expected;
    default: throw new Error(`unsupported count check op ${JSON.stringify(op)}`);
  }
}

async function runAssert(step, ctx) {
  const check = step.check || {};
  const label = step.message || `assert ${check.type}`;
  const scopeName = step.scope || 'page';
  const isItemScoped = scopeName === 'item';
  if (isItemScoped && !ctx.item) {
    throw new Error(`step is item-scoped but is not inside a foreach (malformed flow)`);
  }

  const detailPage = ctx.detailRef?.page || ctx.page;
  const scope = isItemScoped ? ctx.item : (scopeName === 'detail' ? detailPage : ctx.page);
  const actingPage = scopeName === 'detail' ? detailPage : ctx.page;
  const selectors = isItemScoped ? step.relativeSelectors : step.selectors;

  // Wrapped so every failure - from any check.type branch below - reaches exactly one
  // place that reports the outcome (ctx.opts.onAssert, the in-process hook a library
  // caller passes into runFlow()/play()/verify(), and a dedicated ASSERT_PASSED/
  // ASSERT_FAILED json-log line, the out-of-process channel any other consumer - a
  // shell script, a CI step, an n8n Execute Command node tailing `--log=json` - reacts
  // to instead of needing to embed JS). Both fire on a pass too, not just a failure per
  // the "run every assert" note above - a pass is exactly as reportable as a fail (e.g.
  // to extract-on-success), it just isn't fatal. `err instanceof Error &&
  // err.code === 'ASSERT_FAILED'` (not `instanceof AssertionError`) because this file's
  // AssertionError class and the one required by the checker script are different
  // objects if this module is ever loaded twice (npm dedup edge case) - the discriminant
  // that matters for reporting is the same `code` cli.js's exit-code check already keys
  // off, not identity.
  try {
    if (check.type === 'url') {
      const url = actingPage.url();
      const ok = check.op === 'equals' ? url === check.value : url.includes(check.value);
      if (!ok) {
        throw new AssertionError(`${label}: expected URL ${check.op === 'equals' ? 'to equal' : 'to contain'} ${JSON.stringify(check.value)}, got ${JSON.stringify(url)}`);
      }
    } else if (check.type === 'count') {
      // Deliberately NOT candidates.resolve() - a count check's whole point can be "expect
      // 0 matches" (e.g. a banner is gone), and resolve() treats a zero-match candidate as
      // a failure to fall back past rather than a valid answer. A count check therefore
      // always reads a single selector, not a ranked/fallback list.
      //
      // `locator.count()` itself is still an IMMEDIATE, non-waiting query (same invariant
      // as resolve()'s own comment above it), so a bare single read here fires the instant
      // the previous step's click returns - before an async render triggered by that click
      // has had a chance to land - and an `exists`/`multiple` check would then fail against
      // a page that simply hasn't caught up yet. Poll the same selector against one shared
      // deadline instead, same shape as resolve()'s loop, stopping the moment the check
      // passes; a genuine `not-exists` (count already 0) is still answered on the first,
      // fast pass with no added latency.
      const selector = (selectors && selectors[0]) ?? '';
      const locator = candidates.scopedLocator(scope, selector);
      const deadline = Date.now() + Math.max(0, ctx.opts.resolveWaitMs);
      let actual = await locator.count();
      while (!compareCount(actual, check.op, check.count) && Date.now() < deadline) {
        await sleep(150);
        actual = await locator.count();
      }
      if (!compareCount(actual, check.op, check.count)) {
        throw new AssertionError(`${label}: expected count ${check.op || 'eq'} ${check.count} for ${JSON.stringify(selector)}, got ${actual}`);
      }
    } else if (check.type === 'text-equals' || check.type === 'text-contains' || check.type === 'attribute') {
      let locator;
      try {
        ({ locator } = await candidates.resolve(scope, selectors, {
          what: label,
          onFallback: onFallbackFor(ctx),
          waitMs: ctx.opts.resolveWaitMs,
        }));
      } catch (err) {
        // Folded into ASSERT_FAILED rather than left as SELECTOR_UNRESOLVED - an assert's
        // own target not resolving IS the assertion failing ("expect this to be there"),
        // not a separate "an action's target vanished" signal.
        throw new AssertionError(`${label}: target could not be resolved (${err.message.split('\n')[0]})`);
      }
      if (check.type === 'attribute') {
        const actual = await locator.first().getAttribute(check.attribute);
        if (actual !== check.value) {
          throw new AssertionError(`${label}: expected attribute ${JSON.stringify(check.attribute)} to be ${JSON.stringify(check.value)}, got ${JSON.stringify(actual)}`);
        }
      } else {
        const text = (await locator.first().innerText()).trim();
        const ok = check.type === 'text-equals' ? text === check.value : text.includes(check.value);
        if (!ok) {
          throw new AssertionError(`${label}: expected text ${check.type === 'text-equals' ? 'to equal' : 'to contain'} ${JSON.stringify(check.value)}, got ${JSON.stringify(text)}`);
        }
      }
    } else {
      throw new Error(`unsupported assert check type ${JSON.stringify(check.type)}`);
    }
  } catch (err) {
    if (err.code === 'ASSERT_FAILED') {
      logWarn(`${ctx.path}: ${err.message}`, { event: EVENT.ASSERT_FAILED, path: ctx.path, checkType: check.type });
      ctx.opts.onAssert?.({ path: ctx.path, passed: false, checkType: check.type, scope: scopeName, message: err.message });
    }
    throw err;
  }

  // Counted as a "step executed", same reasoning as runExtract: an assert-only flow is a
  // legitimate shape and actions === 0 is what play/verify treat as "nothing happened".
  ctx.stats.actions += 1;
  ctx.stats.steps.push({ path: ctx.path, kind: 'assert', status: 'ok' });
  logInfo(`${ctx.path}: ${label} passed`, { event: EVENT.ASSERT_PASSED, path: ctx.path, checkType: check.type });
  ctx.opts.onAssert?.({ path: ctx.path, passed: true, checkType: check.type, scope: scopeName, message: label });
}

async function runRepeat(step, ctx) {
  // `ctx.opts.repeatMaxTimes` is config's "you probably did not mean that many pages"
  // guard (default 50, see config.js) - distinct from HARD_LOOP_CEILING, the runaway
  // backstop (10000) that applies regardless of any config. Both cap the same number;
  // HARD_LOOP_CEILING is never configurable, so it is always the outermost Math.min.
  const times = Math.min(step.times ?? ctx.opts.repeatDefaultTimes, ctx.opts.repeatMaxTimes, HARD_LOOP_CEILING);
  const settleSelector = step.settle?.selector;
  const settleTimeout = step.settle?.timeoutMs ?? ctx.opts.settleTimeoutMs;

  // Shared with runAction so the loop-advance step can report "there was nothing
  // left to click", which is the normal way a paginated flow ends.
  const repeatExit = step.untilGone ? { selector: step.untilGone, done: false } : null;

  // Shared by reference across every iteration of THIS repeat (created once, here,
  // not per-iteration) so a nested foreach can tell "the advance control appended to
  // the same list" (a "Load More" button) from "the advance control replaced it with
  // a new page" (real pagination) - see runForeach. Keyed by the foreach step object
  // itself, so a repeat with more than one foreach in its body tracks each separately.
  const foreachProgress = new Map();

  for (let i = 0; i < times; i += 1) {
    // Reset every iteration - each page-turn is judged on its own, not cumulatively.
    // `runForeach` sets `checked` only when it's actually inside this repeat's body
    // (nothing to check for a repeat with no foreach at all), and sets `sawNew` using
    // the same same-list-vs-new-page comparison it already makes for `foreachProgress`.
    const noNewItems = { checked: false, sawNew: false };
    const iterCtx = { ...ctx, path: `${ctx.path}repeat[${i}]/`, repeatExit, foreachProgress, noNewItems };
    const before = settleSelector ? await safeText(ctx.page, settleSelector) : null;

    try {
      await runSteps(step.body, iterCtx);
    } catch (err) {
      if (err.fatal) throw err;
      recordStepError(iterCtx, err);
      await handleError(iterCtx, err, `repeat-${i}`);
    }
    ctx.stats.repeatIterations += 1;
    // A repeat iteration is a page - the chunk boundary a paginated flow's output
    // should preferably flush on (see CHUNK_BYTES_LIMIT's comment for the fallback
    // when there's no repeat block at all). Forced regardless of how small the page's
    // own byte count is, since "flush every page" is the point, not "flush once
    // pages add up to ~1MB".
    maybeFlushChunk(ctx.stats, ctx.opts, { force: true });

    if (repeatExit?.done) {
      logInfo(`${ctx.path}repeat: stopping after ${i + 1} iteration(s) - nothing left to advance to`, { path: ctx.path });
      break;
    }

    if (noNewItems.checked && !noNewItems.sawNew) {
      logInfo(`${ctx.path}repeat: stopping after ${i + 1} iteration(s) - the last page yielded no new items`, { path: ctx.path });
      break;
    }

    if (i === times - 1) break;

    // Deliberately NOT re-checking `untilGone` here. The body is what advances the
    // loop, so by this point we are already looking at the next page - and "there is
    // no page after this one" is not a reason to skip the page we just loaded. Doing
    // the check here dropped the entire last page of every site. The one correct exit
    // is `repeatExit.done` above: the advance action itself found nothing to click.
    if (settleSelector) await waitForTextChange(ctx.page, settleSelector, before, settleTimeout, iterCtx);
  }
}

// candidates.resolve() returns as soon as a candidate matches ANYTHING non-zero - the
// right behavior for "has this list shell appeared yet", but wrong for a list whose
// item count is still moving: a table that fills in the rest of its rows via a
// follow-up AJAX response (too few, at first), or a page that transiently renders a
// huge duplicated/loading DOM before settling to its real content (too many, briefly -
// observed on a live site as a two-tick spike to 755 "tr" matches before dropping to
// the true 52). Either way, a single non-zero read cannot be trusted, so a raw ">="
// check against `expectedCount` is not enough - it would happily lock in the 755.
// Instead, keep re-resolving until the count holds steady across consecutive polls:
// two matching reads at exactly `expectedCount` (fast path - this is what recording
// saw), or three matching reads at any other value (the list has genuinely changed
// since recording), or the settle budget runs out, whichever comes first.
async function resolveItemsUntilStable(step, ctx, resolveItems) {
  let last = await resolveItems(ctx);
  if (!step.expectedCount) return last;

  const deadline = Date.now() + ctx.opts.settleTimeoutMs;
  let stableStreak = 1;
  while (Date.now() < deadline) {
    if (last.count === step.expectedCount && stableStreak >= 2) return last;
    if (stableStreak >= 3) return last;
    await sleep(300);
    const next = await resolveItems(ctx);
    stableStreak = next.count === last.count ? stableStreak + 1 : 1;
    last = next;
  }
  return last;
}

async function runForeach(step, ctx) {
  // Resolved fresh every iteration, never cached: any navigation inside the body
  // detaches every handle from the previous document. Playwright locators are lazy,
  // but the *candidate that won* can also change once the DOM is replaced.
  const resolveItems = async (subCtx) => {
    const parent = await candidates.resolve(ctx.page, step.parentSelectors, {
      what: 'foreach parent',
      onFallback: onFallbackFor(subCtx),
      requireUnique: true,
      waitMs: ctx.opts.resolveWaitMs,
    });
    const items = await candidates.resolve(parent.locator, step.itemSelectors, {
      what: 'foreach items',
      onFallback: onFallbackFor(subCtx),
      waitMs: ctx.opts.resolveWaitMs,
    });
    return items;
  };

  const first = await resolveItemsUntilStable(step, ctx, resolveItems);
  const total = first.count;

  if (step.expectedCount && total !== step.expectedCount) {
    note(ctx, 'warnings', {
      type: 'item-count-drift',
      message: `foreach matched ${total} item(s), expected ${step.expectedCount} at record time`,
    });
  }
  if (total === 0) {
    note(ctx, 'warnings', { type: 'empty-foreach', message: 'foreach matched 0 items; body will not run' });
    return;
  }

  logInfo(`${ctx.path}foreach: ${total} item(s) via ${JSON.stringify(first.selector)}`, { path: ctx.path });

  // Pre-seed every iteration's row with the flow's own field keys, in the order they
  // were tagged. This is what keeps CSV columns consistent even when a step earlier in
  // the body fails and aborts the rest of the iteration before every extract step runs -
  // the fields that never got reached simply stay null instead of the row missing keys
  // other rows have. `null` when there are no extract steps at all in this body: nothing
  // to accumulate, so no row is pushed per iteration below.
  const fieldKeys = (step.body || []).filter((s) => s.kind === 'extract').map((s) => s.key);
  const hasFields = fieldKeys.length > 0;

  // A "Load More" advance control appends to the SAME list rather than replacing it
  // with a new page - without this, every repeat iteration would re-walk the items
  // already visited on top of whatever just got appended. Detected by comparing this
  // iteration's first item against the one recorded at the end of the previous
  // iteration: still the same item, just a longer list, means "resume after what we
  // already did"; a different (or missing) first item means a real next-page
  // navigation replaced the list, so start over from 0 exactly as before. Only
  // possible when nested inside a repeat at all - `ctx.foreachProgress` is threaded
  // in by runRepeat and absent for a bare, top-level foreach.
  const progress = ctx.foreachProgress;
  const firstItemText = progress ? await safeLocatorText(first.locator.nth(0)) : null;
  let startIndex = 0;
  let prev = null;
  if (progress) {
    prev = progress.get(step);
    if (prev && total >= prev.count && firstItemText !== null && firstItemText === prev.firstItemText) {
      startIndex = prev.count;
    }
  }

  if (startIndex >= total) {
    logInfo(`${ctx.path}foreach: no new items since last time (still ${total}) - nothing to do this round`, { path: ctx.path });
  }

  // Tell the enclosing repeat (if any) whether this page-turn actually produced
  // anything new, reusing the exact comparison above rather than a second one - a
  // first sighting (no `prev` yet) always counts as "new" so a normal loop still
  // gets to run at least once before this can end it.
  if (ctx.noNewItems) {
    ctx.noNewItems.checked = true;
    if (!prev || total - startIndex > 0) ctx.noNewItems.sawNew = true;
  }

  for (let i = startIndex; i < total; i += 1) {
    const iterCtx = { ...ctx, path: `${ctx.path}foreach[${i}]/` };

    let items;
    try {
      items = await resolveItems(iterCtx);
    } catch (err) {
      note(iterCtx, 'errors', { type: 'list-lost', message: `item list no longer resolves: ${err.message.split('\n')[0]}` });
      break;
    }

    // The classic failure: the body navigated into a detail view and coming back
    // reset the list (losing "load more" progress, or re-rendering from page 1).
    // Detect and say so, rather than iterating stale indexes in silence.
    if (items.count <= i) {
      note(iterCtx, 'warnings', {
        type: 'list-reset',
        message: `list shrank from ${total} to ${items.count} item(s) - a navigation in the body likely reset it; stopping this foreach at item ${i}`,
      });
      break;
    }

    iterCtx.item = items.locator.nth(i);
    // Shared by reference so a step can hand the detail tab to the steps after it.
    // Per-iteration, so one item's tab can never leak into the next.
    iterCtx.detailRef = { page: null, ownTab: false };
    // One row per iteration, pre-seeded with every field this foreach tags so the
    // column set stays identical across rows even when the body errors out partway
    // through (see the comment above `fieldKeys`). `null` foreach (no extract steps
    // anywhere in the body) - nothing accumulates and nothing is pushed below.
    iterCtx.record = hasFields ? Object.fromEntries(fieldKeys.map((k) => [k, null])) : null;

    try {
      await runSteps(step.body, iterCtx);
      ctx.stats.foreachIterations += 1;
    } catch (err) {
      if (err.fatal) throw err;
      recordStepError(iterCtx, err);
      await handleError(iterCtx, err, `foreach-${i}`);
    } finally {
      // Even on failure: never leave a detail tab open, or a 20-item run ends with 20
      // orphaned tabs and the memory to match.
      if (iterCtx.detailRef.ownTab) {
        await iterCtx.detailRef.page.close().catch(() => {});
      }
      // Pushed regardless of whether the iteration succeeded - a row with some fields
      // still null (because the body errored before reaching them) is more useful to a
      // caller than a silently missing row. A row that is null across every field,
      // though, carries nothing at all (see isEmptyRecord) and is dropped rather than
      // written out - only counted, so a run's report can still say how many were
      // swept aside.
      if (iterCtx.record) {
        if (isEmptyRecord(iterCtx.record)) {
          ctx.stats.emptyRecordsSkipped += 1;
        } else {
          ctx.stats.records.push(iterCtx.record);
          ctx.stats._pending.push(iterCtx.record);
          ctx.stats._pendingBytes += JSON.stringify(iterCtx.record).length;
          maybeFlushChunk(ctx.stats, ctx.opts);
        }
      }
    }
  }

  if (progress) progress.set(step, { count: total, firstItemText });
}

function recordStepError(ctx, err) {
  ctx.stats.steps.push({ path: ctx.path, kind: 'error', status: 'failed', message: err.message.split('\n')[0] });
}

async function handleError(ctx, err, label) {
  ctx.stats.consecutiveErrors += 1;
  const artifacts = await saveFailureArtifacts(ctx, label);
  note(ctx, 'errors', {
    type: err.code || 'step-failed',
    message: `${err.message.split('\n')[0]}${artifacts ? ` (artifacts: ${artifacts}.png/.html)` : ''}`,
  });
  if (ctx.stats.consecutiveErrors >= ctx.opts.maxConsecutiveErrors) {
    const fatal = new Error(`${ctx.stats.consecutiveErrors} consecutive step failures - aborting the run`);
    fatal.fatal = true;
    throw fatal;
  }
}

async function runSteps(steps, ctx) {
  for (let i = 0; i < (steps || []).length; i += 1) {
    const step = steps[i];
    const stepCtx = { ...ctx, path: `${ctx.path}${i}:` };
    switch (step.kind) {
      case 'action':
        await runAction(step, stepCtx);
        ctx.stats.consecutiveErrors = 0;
        break;
      case 'extract':
        await runExtract(step, stepCtx);
        break;
      case 'assert':
        await runAssert(step, stepCtx);
        ctx.stats.consecutiveErrors = 0;
        break;
      case 'repeat':
        await runRepeat(step, stepCtx);
        break;
      case 'foreach':
        await runForeach(step, stepCtx);
        break;
      default:
        note(stepCtx, 'warnings', { type: 'unknown-step', message: `unknown step kind ${JSON.stringify(step.kind)}, skipped` });
    }
  }
}

// --- entry point --------------------------------------------------------------

// `options.page` lets a caller (tests, and record.js's self-verify pass) drive an
// existing page instead of having a browser launched and torn down here.
async function runFlow(flow, options = {}) {
  const opts = {
    headless: options.headless ?? true,
    minDelayMs: options.minDelayMs ?? MIN_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? MAX_DELAY_MS,
    maxConsecutiveErrors: options.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS,
    artifactsDir: options.artifactsDir ?? null,
    resolveWaitMs: options.resolveWaitMs ?? RESOLVE_WAIT_MS,
    settleTimeoutMs: options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS,
    repeatDefaultTimes: options.repeatDefaultTimes ?? REPEAT_DEFAULT_TIMES,
    // Not provided by a caller that doesn't know about config.js (every existing test,
    // and any direct runFlow() call) -> HARD_LOOP_CEILING alone, exactly today's
    // behaviour. cli.js passes config.repeat.maxTimes (default 50) here once loaded.
    repeatMaxTimes: options.repeatMaxTimes ?? HARD_LOOP_CEILING,
    // Overridable in tests without mutating process.env; every real caller leaves
    // this unset and gets the real environment, which is what a fill step's
    // {{env:NAME}} placeholder (see secrets.js) resolves against.
    env: options.env ?? process.env,
    // Only set up when the caller (cli.js, for the default non-append output mode -
    // see writeConfiguredOutput) hands over where to stream rows as they're produced.
    // Left null for every other caller (tests, record.js's self-verify, append-mode
    // runs), which still get the complete row set back via stats.records exactly as
    // before - this is additive, not a replacement for that.
    chunkWriter: options.outputPath
      ? createChunkedWriter(options.outputPath, options.outputFormat || 'csv', collectExtractKeys(flow.steps))
      : null,
    chunkBytesLimit: options.chunkBytesLimit ?? CHUNK_BYTES_LIMIT,
    // Fired synchronously by runAssert for every 'assert' step, pass and fail, before
    // a failure's AssertionError is thrown - so a library caller sees the result even
    // for a bare page-scoped assert with no enclosing repeat/foreach to catch the throw
    // (see test/assert-step.test.js's note on uncaught top-level step errors). Absent
    // for every caller that doesn't pass one (every existing test, the CLI), which is
    // exactly today's behaviour - out-of-process consumers get the same result via the
    // ASSERT_PASSED/ASSERT_FAILED json-log lines instead, not through this callback.
    onAssert: options.onAssert ?? null,
  };

  const stats = newStats();
  stats.consecutiveErrors = 0;
  stats._fallbackKeys = new Set();
  stats._pending = [];
  stats._pendingBytes = 0;

  let browser = null;
  let page = options.page ?? null;

  if (!page) {
    const allArgs = [...CHROMIUM_ARGS, ...(options.chromiumArgs ?? [])];
    browser = await chromium.launch({ headless: opts.headless, args: allArgs });
    const context = await browser.newContext();
    page = await context.newPage();
  }

  try {
    if (flow.startUrl) await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded' });
    await runSteps(flow.steps, { page, item: null, stats, opts, path: '' });
  } catch (err) {
    if (!err.fatal) throw err;
    stats.aborted = err.message;
  } finally {
    // Whatever never crossed a page boundary or hit the byte threshold still needs to
    // reach disk - including on an aborted run, so a kill mid-way through loses only
    // the current in-flight chunk rather than every row scraped so far.
    maybeFlushChunk(stats, opts, { force: true });
    opts.chunkWriter?.close();
    delete stats._pending;
    delete stats._pendingBytes;
    delete stats._fallbackKeys;
    if (browser) await browser.close().catch(() => {});
  }

  return stats;
}

module.exports = { runFlow, applyAction, runSteps, collectExtractKeys, isEmptyRecord };
