// candidates.js
//
// Every step in a flow stores a RANKED LIST of selectors rather than a single one.
// Index 0 is Playwright's own generated selector (role/text based, e.g.
// `internal:role=link[name="Senior Engineer"i]`); later entries are structural
// fallbacks derived at record time.
//
// This exists because a single brittle selector is what kills an unattended daily
// job three weeks after it was recorded. Falling through to candidate 1 keeps the
// run alive AND emits a warning, which is the earliest programmatic signal that the
// site changed - well before the selector stops matching entirely and drift.js
// reports BROKEN.
//
// The empty string is a meaningful selector: it means "the scope element itself",
// used by item-scoped actions whose target IS the repeating item (the common case
// where the thing you click to open a job is the card/link the loop iterates).
const { sleep } = require('./log');

class SelectorResolutionError extends Error {
  constructor(what, attempts, ariaSnapshot) {
    const detail = attempts
      .map((a, i) => `    [${i}] ${JSON.stringify(a.selector)} -> ${a.outcome}`)
      .join('\n');
    super(`Could not resolve ${what}; every candidate failed:\n${detail}`);
    this.name = 'SelectorResolutionError';
    this.code = 'SELECTOR_UNRESOLVED';
    this.what = what;
    this.attempts = attempts;
    // Playwright records an aria snapshot of the page alongside every action. It is
    // useless for replay, but it is exactly what you want in the failure report: a
    // picture of what the page looked like when the selector still worked.
    this.ariaSnapshot = ariaSnapshot;
  }
}

function scopedLocator(scope, selector) {
  if (selector === '') {
    // Only a Locator can be "itself"; a Page has no self to return.
    if (typeof scope.count !== 'function') {
      throw new Error('the empty selector ("the scope itself") is only valid inside a foreach item scope');
    }
    return scope;
  }
  return scope.locator(selector);
}

// Tries each candidate in order and returns the first usable one. `onFallback` fires
// (once) when the winner is not candidate 0.
//
// `preferUnique` is for ACTION targets: acting on a locator that matches several elements
// is not a thing to paper over - clicking "whichever job link is first" would quietly
// scrape the wrong row. So a unique match is sought across all candidates first, and if
// none exists the step fails with the counts spelled out, instead of surfacing as
// Playwright's opaque "strict mode violation ... resolved to 20 elements".
//
// `requireUnique` is for foreach PARENTS: several matching containers is an ambiguity
// worth reporting, but taking the first still does something sensible.
async function resolve(scope, selectors, options = {}) {
  const {
    what = 'element',
    ariaSnapshot,
    onFallback,
    requireUnique = false,
    preferUnique = false,
    waitMs = 0,
    requireVisible = false,
  } = options;

  const list = Array.isArray(selectors) ? selectors : [selectors];
  if (list.length === 0) throw new Error(`no selector candidates recorded for ${what}`);

  // `locator.count()` is an IMMEDIATE query - it does not auto-wait like an action does.
  // Resolving candidates with it alone turned Playwright's patient model into an
  // impatient snapshot, and a site that renders its list shells before filling them in
  // failed ~100ms after the shells appeared. So poll every candidate against a single
  // shared deadline: the first pass is the fast path (no added latency when the page is
  // already settled), and later passes give a still-rendering page time to catch up.
  const deadline = Date.now() + Math.max(0, waitMs);
  let attempts = [];
  let matched = [];

  for (;;) {
    attempts = [];
    matched = [];

    for (let i = 0; i < list.length; i += 1) {
      const selector = list[i];
      let locator;
      let count;
      try {
        locator = scopedLocator(scope, selector);
        count = await locator.count();
      } catch (err) {
        attempts.push({ selector, outcome: `invalid selector: ${err.message.split('\n')[0]}` });
        continue;
      }

      if (count === 0) {
        attempts.push({ selector, outcome: 'matched 0 elements' });
        continue;
      }

      // count() counts ATTACHED elements, visible or not. Acting needs visible, so a
      // hidden match is not a usable answer - that mismatch is what produced a resolved
      // selector followed by a 30-second actionability timeout.
      if (requireVisible) {
        let visible = false;
        try { visible = await locator.first().isVisible(); } catch { visible = false; }
        if (!visible) {
          attempts.push({ selector, outcome: `matched ${count} element(s), none visible` });
          continue;
        }
      }

      matched.push({ selector, locator, count, index: i });

      if (count === 1) {
        if (i > 0) onFallback?.({ what, selector, candidateIndex: i, reason: `primary candidate ${JSON.stringify(list[0])} no longer matches` });
        return { locator, selector, candidateIndex: i, count };
      }

      if (preferUnique) {
        attempts.push({ selector, outcome: `matched ${count} elements - ambiguous for an action target` });
        continue; // keep looking for something unique
      }

      if (requireUnique) {
        onFallback?.({ what, selector, candidateIndex: i, reason: `matched ${count} elements, expected exactly 1; using the first` });
        return { locator: locator.first(), selector, candidateIndex: i, count };
      }

      if (i > 0) onFallback?.({ what, selector, candidateIndex: i, reason: `primary candidate ${JSON.stringify(list[0])} no longer matches` });
      return { locator, selector, candidateIndex: i, count };
    }

    if (Date.now() >= deadline) break;
    await sleep(150);
  }

  if (preferUnique && matched.length) {
    const error = new SelectorResolutionError(what, attempts, ariaSnapshot);
    error.code = 'SELECTOR_AMBIGUOUS';
    error.message = `Ambiguous ${what}: no candidate matched exactly one element, so acting on it could hit the wrong one.\n`
      + matched.map((m) => `    [${m.index}] ${JSON.stringify(m.selector)} -> ${m.count} elements`).join('\n');
    throw error;
  }

  throw new SelectorResolutionError(what, attempts, ariaSnapshot);
}

// "Gone" for the purposes of a repeat block's early exit: either no element matches,
// or the one that does is disabled. Both mean "there is no next page to ask for".
// Anything unexpected resolves to false, so a flaky check never silently truncates a
// run - the `times` cap is what bounds it instead.
async function isGoneOrDisabled(scope, selector) {
  try {
    const locator = scope.locator(selector);
    if ((await locator.count()) === 0) return { gone: true, reason: 'no element matches' };
    const first = locator.first();
    if (await first.isDisabled()) return { gone: true, reason: 'element is disabled' };
    const ariaDisabled = await first.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') return { gone: true, reason: 'element has aria-disabled="true"' };
    return { gone: false };
  } catch (err) {
    return { gone: false, reason: `check failed: ${err.message.split('\n')[0]}` };
  }
}

module.exports = { resolve, isGoneOrDisabled, SelectorResolutionError };
