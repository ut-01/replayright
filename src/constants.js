// constants.js

// Every overlay control's aria-label starts with this. Playwright's own selector
// generator keys a role-based locator off an element's accessible name, and for a
// native <button> the aria-label IS that accessible name - verified in the Phase 1
// spike, where clicking `<button aria-label="playright:R:start">` was recorded as
// `internal:role=button[name="playright:R:start"i]`.
//
// That is what lets R/F presses ride IN-BAND: the press is itself a recorded action,
// so its position in the action stream is exact by construction - no cross-channel
// correlation, no timing assumption. The same prefix identifies those actions for
// removal from the replayable body.
const MARKER_PREFIX = 'playright:';

module.exports = {
  MARKER_PREFIX,

  // Default iteration count for an "R" (repeat) block, and its hard cap. A repeat
  // block's real early exit is `untilGone` (stop once the control its body clicks
  // has disappeared or gone disabled); this number only bounds the worst case. The
  // genuinely correct rule - "stop once a page yields zero NEW items" - needs dedup,
  // which is out of scope.
  REPEAT_DEFAULT_TIMES: 5,

  // Backstop against a runaway loop (e.g. a "load more" that always appends one
  // differently-keyed junk item). Not a normal stop condition.
  HARD_LOOP_CEILING: 10000,

  // Consecutive step failures tolerated before a run gives up entirely.
  MAX_CONSECUTIVE_ERRORS: 3,

  // Politeness delay range, applied only around real page loads - never around
  // in-page clicks, which have no load to wait on.
  MIN_DELAY_MS: 500,
  MAX_DELAY_MS: 1500,

  // How long a step will wait for its selector to appear before giving up. locator.count()
  // does not auto-wait like an action does, so without this the resolver races the page's
  // own rendering - a list whose rows appear before their contents failed ~100ms after the
  // rows showed up.
  RESOLVE_WAIT_MS: 8000,

  // How long to wait for a `settle` condition (e.g. "the content under this selector
  // must change before the next repeat iteration") before warning and carrying on.
  SETTLE_TIMEOUT_MS: 10000,
};
