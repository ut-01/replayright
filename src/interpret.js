// interpret.js
//
// Executes a flow.json. This is the authoritative player - the emitted .js is a
// read-only debug artifact, never the thing that runs.
//
// Three step kinds, nested arbitrarily:
//   { kind: 'action', scope, selectors|relativeSelectors, action }
//   { kind: 'repeat', times, untilGone?, settle?, body: [...] }
//   { kind: 'foreach', parentSelectors, itemSelectors, expectedCount?, body: [...] }
//
// Nesting is the whole point: the real-world shape is a `repeat` over pages wrapping
// a `foreach` over the cards on each page. The previous implementation flattened
// blocks and silently dropped the inner one.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const candidates = require('./candidates');
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
  };
}

// Applies one action to an already-resolved locator. Field names come straight from
// Playwright's api-mode action objects, confirmed by dumping them in the Phase 1
// spike: click{clickCount,button}, fill{text}, press{key}, select{options}.
async function applyAction(locator, action) {
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
      return locator.fill(action.text ?? '');
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
async function waitForTextChange(page, selector, previousText, timeoutMs, ctx) {
  if (previousText === null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await safeText(page, selector);
    if (now !== previousText) return;
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

  await applyAction(locator, action);
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
    const iterCtx = { ...ctx, path: `${ctx.path}repeat[${i}]/`, repeatExit, foreachProgress };
    const before = settleSelector ? await safeText(ctx.page, settleSelector) : null;

    try {
      await runSteps(step.body, iterCtx);
    } catch (err) {
      if (err.fatal) throw err;
      recordStepError(iterCtx, err);
      await handleError(iterCtx, err, `repeat-${i}`);
    }
    ctx.stats.repeatIterations += 1;

    if (repeatExit?.done) {
      logInfo(`${ctx.path}repeat: stopping after ${i + 1} iteration(s) - nothing left to advance to`, { path: ctx.path });
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

  const first = await resolveItems(ctx);
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
  if (progress) {
    const prev = progress.get(step);
    if (prev && total >= prev.count && firstItemText !== null && firstItemText === prev.firstItemText) {
      startIndex = prev.count;
    }
  }

  if (startIndex >= total) {
    logInfo(`${ctx.path}foreach: no new items since last time (still ${total}) - nothing to do this round`, { path: ctx.path });
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
      // caller than a silently missing row.
      if (iterCtx.record) ctx.stats.records.push(iterCtx.record);
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
  };

  const stats = newStats();
  stats.consecutiveErrors = 0;
  stats._fallbackKeys = new Set();

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
    delete stats._fallbackKeys;
    if (browser) await browser.close().catch(() => {});
  }

  return stats;
}

module.exports = { runFlow, applyAction, runSteps };
