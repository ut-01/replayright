// generalize.js
//
// String surgery on Playwright's own internal selector grammar. Playwright hands us
// instance-specific selectors - `internal:role=link[name="Senior Frontend Engineer"i]`
// identifies exactly one card. Dropping the accessible-name filter turns it into
// `internal:role=link`, which matches every sibling card; scoped under the foreach
// parent that is precisely the item selector we want.
//
// Verified in the Phase 1 spike: the stripped form resolved to 5 links page-wide and 5
// under the parent, and `internal:*` engines are accepted by page.locator() because
// they are registered builtin engines.
//
// This is why the system works on Apple as well as Google: it never stores a positional
// CSS path, which is what made the previous implementation site-specific in practice.

// Matches a single [name="..."i] / [name='...'i] filter, honouring backslash escapes so
// a name containing a quote does not truncate the match.
const NAME_FILTER = /\[name=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')i?\]/g;

function stripNameFilter(selector) {
  if (typeof selector !== 'string') return null;
  const stripped = selector.replace(NAME_FILTER, '');
  return stripped === selector ? null : stripped;
}

// The accessible name inside a [name="..."i] filter, unescaped. Used to read a marker
// button's meaning back out of the selector Playwright generated for it.
function nameFilterValue(selector) {
  if (typeof selector !== 'string') return null;
  const match = selector.match(/\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')i?\]/);
  if (!match) return null;
  return (match[1] ?? match[2]).replace(/\\(.)/g, '$1');
}

// True for any action recorded against our own overlay - the R/F buttons and the
// picker layer. These are the in-band markers plus their noise; none belongs in a
// replayable body.
function isOverlayAction(action, prefix) {
  if (!action) return false;
  const name = nameFilterValue(action.selector);
  if (name && name.startsWith(prefix)) return true;
  // Belt and braces: if the generator ever produced something other than a role
  // locator for these elements, the raw selector still contains the prefix.
  return typeof action.selector === 'string' && action.selector.includes(prefix);
}

// `playright:R:start` -> { kind: 'R', phase: 'start' }
// `playright:field:pick:Job Title` -> { kind: 'field', phase: 'pick', label: 'Job Title' }
//
// Split on the first TWO ':' only, then rejoin whatever remains as one piece. A
// custom field label is free text the user typed into "+ Field" and may itself
// contain ':' - splitting unbounded would truncate "Salary: Base" down to "Salary".
//
// `label` is only ever present on the returned object for a marker that actually has a
// third segment (only `field:pick:<key>` does today) - omitted rather than `null` for
// every other marker, so `{ kind: 'R', phase: 'start' }` stays deepStrictEqual to what
// it was before this segment existed.
function parseMarker(action, prefix) {
  const name = nameFilterValue(action?.selector);
  if (!name || !name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  if (firstColon === -1) return { kind: rest, phase: null };
  const kind = rest.slice(0, firstColon);
  const afterKind = rest.slice(firstColon + 1);
  const secondColon = afterKind.indexOf(':');
  if (secondColon === -1) return { kind, phase: afterKind || null };
  const phase = afterKind.slice(0, secondColon);
  const label = afterKind.slice(secondColon + 1);
  return { kind, phase: phase || null, label: label || null };
}

// Ranked item-selector candidates: the generalized Playwright selector first (most
// robust - survives class renames and DOM reshuffles), then the structural ones the
// in-page code verified by counting.
function rankItemCandidates({ recordedItemSelector, structural }) {
  const out = [];
  const seen = new Set();
  const push = (sel) => {
    if (!sel || seen.has(sel)) return;
    seen.add(sel);
    out.push(sel);
  };
  push(stripNameFilter(recordedItemSelector));
  for (const sel of structural || []) push(sel);
  return out;
}

module.exports = { stripNameFilter, nameFilterValue, isOverlayAction, parseMarker, rankItemCandidates, NAME_FILTER };
