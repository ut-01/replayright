// drift.js - carried over from jscrape's src/careers/drift.js, which was already the
// right shape for an unattended daily run: fingerprint how many elements each key
// selector matches, compare against last run, exit non-zero when something that used
// to match now matches nothing.
//
// Changed from the original: the selector list is DERIVED FROM THE FLOW rather than
// curated by hand. A flow already names the selectors that matter (the foreach parent
// and items, the pagination control), so asking the user to maintain a second list of
// them was duplication waiting to drift out of sync.
const fs = require('fs');
const path = require('path');

const WARNING_DROP_RATIO = 0.5;

function siteDir(siteId, sitesDir) {
  if (sitesDir) return path.join(sitesDir, siteId);
  return path.resolve(__dirname, '..', 'sites', siteId);
}

function fingerprintPath(siteId, sitesDir) {
  return path.join(siteDir(siteId, sitesDir), 'fingerprint.json');
}

// Walks the flow and collects the selectors whose match count is worth watching.
// Only primary candidates (index 0): a fallback already being in use is reported
// separately, by the interpreter, as it happens.
function driftSelectorsFor(flow) {
  if (Array.isArray(flow.driftSelectors) && flow.driftSelectors.length) return flow.driftSelectors;

  const out = [];
  const seen = new Set();
  const add = (name, selector) => {
    if (!selector || seen.has(selector)) return;
    seen.add(selector);
    out.push({ name, selector });
  };

  const walk = (steps, prefix) => {
    (steps || []).forEach((step, i) => {
      const at = `${prefix}${i}`;
      if (step.kind === 'foreach') {
        add(`foreach[${at}].parent`, step.parentSelectors?.[0]);
        add(`foreach[${at}].items`, step.itemSelectors?.[0]);
        walk(step.body, `${at}.`);
      } else if (step.kind === 'repeat') {
        add(`repeat[${at}].advance`, step.untilGone);
        walk(step.body, `${at}.`);
      }
    });
  };

  walk(flow.steps, '');
  return out;
}

// Counts how many elements each watched selector matches on the page in its current
// state, plus the run's own loop counters. That is the whole structural snapshot.
async function captureFingerprint(page, flow, stats = {}) {
  const selectorCounts = {};
  for (const { name, selector } of driftSelectorsFor(flow)) {
    try {
      selectorCounts[name] = await page.locator(selector).count();
    } catch {
      selectorCounts[name] = 0;
    }
  }
  return {
    siteId: flow.siteId,
    capturedAt: new Date().toISOString(),
    selectorCounts,
    foreachIterations: stats.foreachIterations ?? 0,
    repeatIterations: stats.repeatIterations ?? 0,
  };
}

// A missing or unparseable fingerprint just means "no history yet", not an error.
function loadPreviousFingerprint(siteId, sitesDir) {
  try {
    return JSON.parse(fs.readFileSync(fingerprintPath(siteId, sitesDir), 'utf8'));
  } catch {
    return null;
  }
}

// The baseline is only advanced by a run that was NOT broken.
//
// The original always overwrote, reasoning that the exit code already surfaced the
// problem. It does - exactly once. Saving a broken run's zero counts as the new baseline
// poisons it: the next day `previousCount` is 0, every comparison is skipped, and the
// check cheerfully reports OK while the flow scrapes nothing. For an unattended daily job
// that is the worst possible failure mode - it screams once, then goes quiet forever.
//
// history.jsonl still records every run, broken ones included, so the forensic trail is
// complete either way.
function saveFingerprint(siteId, fingerprint, status = 'OK', sitesDir) {
  const dir = siteDir(siteId, sitesDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'history.jsonl'), `${JSON.stringify({ ...fingerprint, status })}\n`);
  if (status === 'BROKEN') return false;
  fs.writeFileSync(fingerprintPath(siteId, sitesDir), JSON.stringify(fingerprint, null, 2));
  return true;
}

// No previous fingerprint => OK (nothing to compare against yet).
// A selector that used to match something and now matches nothing => BROKEN.
// A large-but-not-total drop => WARNING. A run that used to do work and now does
// none also forces BROKEN, regardless of individual selector counts.
function classifyDrift(previous, current) {
  if (!previous) return { status: 'OK', issues: [] };

  const issues = [];

  if (previous.foreachIterations > 0 && current.foreachIterations === 0) {
    issues.push({
      name: 'foreachIterations',
      previousCount: previous.foreachIterations,
      currentCount: 0,
      severity: 'BROKEN',
      reason: 'run processed 0 items; the previous run processed more than 0',
    });
  }

  for (const [name, currentCount] of Object.entries(current.selectorCounts || {})) {
    const previousCount = previous.selectorCounts?.[name] ?? 0;
    if (previousCount <= 0) continue;

    if (currentCount === 0) {
      issues.push({
        name,
        previousCount,
        currentCount,
        severity: 'BROKEN',
        reason: `selector "${name}" matched ${previousCount} element(s) last run, 0 this run`,
      });
      continue;
    }

    const dropRatio = (previousCount - currentCount) / previousCount;
    if (dropRatio > WARNING_DROP_RATIO) {
      issues.push({
        name,
        previousCount,
        currentCount,
        severity: 'WARNING',
        reason: `selector "${name}" match count dropped ${Math.round(dropRatio * 100)}% (${previousCount} -> ${currentCount})`,
      });
    }
  }

  const status = issues.some((i) => i.severity === 'BROKEN')
    ? 'BROKEN'
    : issues.some((i) => i.severity === 'WARNING')
      ? 'WARNING'
      : 'OK';

  return { status, issues };
}

module.exports = {
  captureFingerprint,
  loadPreviousFingerprint,
  saveFingerprint,
  classifyDrift,
  driftSelectorsFor,
};
