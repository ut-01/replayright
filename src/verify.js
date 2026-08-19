// verify.js
//
// Replays a flow and judges whether it is trustworthy enough to schedule.
//
// This exists because both previous versions shipped configs that were already broken
// on disk - one wrote `matchCount: 0` for its item selector and only failed days later
// at replay time. A recorder that does not immediately re-run what it just captured is
// a recorder that lies.
//
// `verified: true` is deliberately strict: every step must resolve on its PRIMARY
// selector. Surviving on a fallback is a pass for a daily run but a fail for a fresh
// recording, because it means the selector we would have chosen is already wrong.
const { runFlow } = require('./interpret');
const { logInfo, logWarn, logError } = require('./log');

// Roles whose elements a single printable keystroke plausibly belongs to.
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const roleOf = (selector) => (/internal:role=([a-z]+)/.exec(selector || '') || [])[1] || null;

// A one-character key pressed on something that cannot be typed into is almost always a
// stray keystroke - e.g. tapping the keyboard "f" instead of clicking the F button. It is
// reported, never removed: some sites really do use single-key shortcuts, and silently
// dropping a real step is worse than carrying a harmless one. But it is worth deleting by
// hand, because a meaningless step can still fail and count against the error budget.
function looksLikeStrayKeystroke(step) {
  if (step.kind !== 'action' || step.action?.name !== 'press') return false;
  if ((step.action.key || '').length !== 1) return false; // Enter/Tab/Escape/arrows are meaningful
  const role = roleOf((step.selectors || [])[0]);
  return !!role && !EDITABLE_ROLES.has(role);
}

// Static checks on the flow's shape, independent of any page.
// `problems` fail verification; `advisories` are worth a look but do not.
function auditShape(flow) {
  const problems = [];
  const advisories = [];

  const walk = (steps, where) => {
    (steps || []).forEach((step, i) => {
      const at = `${where}${i}`;
      if (step.kind === 'foreach') {
        if (!step.itemSelectors?.length) problems.push(`${at}: foreach has no item selector candidates`);
        if (!step.parentSelectors?.length) problems.push(`${at}: foreach has no parent selector candidates`);
        // A foreach whose body never touches the item would perform identical
        // page-level actions N times over. Almost always a scope-detection failure
        // during recording rather than something anyone meant - except a pure
        // "scrape this listing" body with only `extract` steps and no click/fill,
        // which is legitimate and counts as touching the item too.
        if (!(step.body || []).some((s) => s.scope === 'item' || s.kind === 'extract')) {
          problems.push(`${at}: foreach has no per-item steps - every iteration would do the same thing`);
        }
        walk(step.body, `${at}.`);
      } else if (step.kind === 'repeat') {
        if (!step.untilGone) {
          problems.push(`${at}: repeat has no advance selector, so it will always run all ${step.times} iterations`);
        }
        walk(step.body, `${at}.`);
      } else if (step.kind === 'action') {
        const list = step.scope === 'item' ? step.relativeSelectors : step.selectors;
        const pageLevelNav = step.scope !== 'item' && step.action?.name === 'navigate';
        if (!pageLevelNav && !list?.length) problems.push(`${at}: ${step.action?.name} step has no selector candidates`);
        if (looksLikeStrayKeystroke(step)) {
          advisories.push(`${at}: pressing "${step.action.key}" on a ${roleOf(step.selectors[0])} looks like a stray keystroke - consider deleting this step`);
        }
      } else if (step.kind === 'extract') {
        if (!step.relativeSelectors?.length) problems.push(`${at}: extract "${step.key}" has no selector candidates`);
      }
    });
  };

  walk(flow.steps, '');
  return { problems, advisories };
}

function printReport({ shapeProblems, advisories, stats }) {
  logInfo('--- verification report ---');

  for (const problem of shapeProblems) logWarn(`shape: ${problem}`);
  for (const advisory of advisories) logWarn(`advisory: ${advisory}`);

  logInfo(`steps executed:      ${stats.actions}`);
  logInfo(`repeat iterations:   ${stats.repeatIterations}`);
  logInfo(`foreach iterations:  ${stats.foreachIterations}`);

  if (stats.fallbacks.length) {
    logWarn(`${stats.fallbacks.length} step(s) survived only on a FALLBACK selector:`);
    for (const f of stats.fallbacks) logWarn(`  ${f.path} ${f.what} -> candidate [${f.candidateIndex}] ${JSON.stringify(f.selector)}`);
  } else if (!stats.errors.length) {
    logInfo('every step resolved on its primary selector');
  }

  for (const w of stats.warnings) logWarn(`  ${w.path} ${w.type}: ${w.message}`);
  for (const e of stats.errors) logError(`  ${e.path} ${e.type}: ${e.message}`);
  if (stats.aborted) logError(`run aborted: ${stats.aborted}`);
}

async function verifyFlow(flow, options = {}) {
  const { problems: shapeProblems, advisories } = auditShape(flow);

  const stats = await runFlow(flow, {
    headless: options.headless ?? false,
    artifactsDir: options.artifactsDir,
    minDelayMs: options.minDelayMs,
    maxDelayMs: options.maxDelayMs,
    resolveWaitMs: options.resolveWaitMs,
    chromiumArgs: options.chromiumArgs,
  });

  printReport({ shapeProblems, advisories, stats });

  const reasons = [];
  if (shapeProblems.length) reasons.push(`${shapeProblems.length} structural problem(s)`);
  if (stats.errors.length) reasons.push(`${stats.errors.length} failed step(s)`);
  if (stats.aborted) reasons.push('the run aborted');
  if (stats.fallbacks.length) reasons.push(`${stats.fallbacks.length} step(s) needed a fallback selector`);
  if (stats.actions === 0) reasons.push('no steps executed at all');

  const ok = reasons.length === 0;
  if (ok) logInfo('VERIFIED - safe to schedule.');
  else logWarn(`NOT VERIFIED: ${reasons.join('; ')}. Re-record the affected block, or edit flow.json by hand.`);

  return { ok, reasons, stats, shapeProblems, advisories };
}

module.exports = { verifyFlow, auditShape };
