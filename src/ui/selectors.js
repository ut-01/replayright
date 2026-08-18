// selectors.js
//
// Pure selector construction: ranking candidate CSS selectors and choosing the
// repeating item for a foreach block. Moved out of what used to be inpage.js
// byte-for-byte in Phase 2.1 - chooseItem() is the hardest logic in the repo; this
// relocates it, it does not touch it.
//
// Concatenated as raw text ahead of overlay.js into the one script string
// src/ui-bundle.js hands to `addInitScript({ content })`, so - like overlay.js - this
// file must stay entirely self-contained: no require, no closing over Node scope. It
// runs in the page's MAIN world.

// Classes that look build-generated (styled-components "sc-xxxx", CSS-modules
// "Name__hash", bare alphanumeric soup). Heuristic, used ONLY to decide which class
// to drop first when relaxing an over-specific selector - never to decide on its own
// whether a selector is safe.
const HASH_LIKE = /(^sc-[a-z0-9]+$)|(__[a-z0-9]{4,}$)|(^[a-z]{0,2}\d[a-z0-9]*$)/i;

const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

// --- selector construction --------------------------------------------------

function cssPath(el, maxDepth) {
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < (maxDepth || 10)) {
    if (node.id) { parts.unshift(node.tagName.toLowerCase() + '#' + esc(node.id)); break; }
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

// A class present on EVERY same-tag sibling is structural by direct evidence,
// whatever it happens to be named. This is the one selector heuristic in the whole
// system that generalizes reliably across sites.
function stableClasses(el) {
  const parent = el.parentElement;
  const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === el.tagName) : [el];
  let stable = Array.from(el.classList);
  for (const sib of siblings) {
    const set = new Set(sib.classList);
    stable = stable.filter((c) => set.has(c));
  }
  // Drop hash-like classes first when relaxing, so the survivors are the meaningful ones.
  stable.sort((a, b) => (HASH_LIKE.test(a) ? 1 : 0) - (HASH_LIKE.test(b) ? 1 : 0));
  return { siblings: siblings.length, stable };
}

const withClasses = (tag, classes) => tag.toLowerCase() + classes.map((c) => '.' + esc(c)).join('');

// Ranked MOST ROBUST FIRST, de-duplicated, each one actually counted against the live
// DOM - nothing is proposed that has not been verified to match here and now.
//
// Robustness, not specificity, decides the order. A build-generated class like
// "sc-9f8a1b" changes on every deploy, so `li.card` outlives `li.card.sc-9f8a1b` and
// even a bare `li` outlives both. Hash-bearing variants are kept, but only as the last
// resort for markup where nothing else distinguishes the item.
function itemCandidates(itemEl, parentEl) {
  const { stable } = stableClasses(itemEl);
  const meaningful = stable.filter((c) => !HASH_LIKE.test(c));
  const hasHashy = stable.length > meaningful.length;
  const tag = itemEl.tagName.toLowerCase();

  const out = [];
  const seen = new Set();
  const push = (sel) => {
    if (!sel || seen.has(sel)) return;
    seen.add(sel);
    let count = 0;
    try { count = parentEl.querySelectorAll(sel).length; } catch { return; }
    if (count >= 2) out.push({ selector: sel, count });
  };

  const classes = meaningful.slice();
  while (classes.length) { push(withClasses(itemEl.tagName, classes)); classes.pop(); }
  push(tag);
  if (hasHashy) push(withClasses(itemEl.tagName, stable));
  return out;
}

function parentCandidates(el) {
  const out = [];
  const seen = new Set();
  const push = (sel) => {
    if (!sel || seen.has(sel)) return;
    seen.add(sel);
    let count = 0;
    try { count = document.querySelectorAll(sel).length; } catch { return; }
    if (count === 1) out.push({ selector: sel, count });
  };

  if (el.id) push(el.tagName.toLowerCase() + '#' + esc(el.id));
  const { stable } = stableClasses(el);
  const meaningful = stable.filter((c) => !HASH_LIKE.test(c));
  if (meaningful.length) push(withClasses(el.tagName, meaningful));
  if (stable.length > meaningful.length) push(withClasses(el.tagName, stable));
  // Positional path last: the most brittle option, but better than no fallback.
  push(cssPath(el));
  return out;
}

// Selector for `el` relative to `root`, with no positional index at the root level -
// that would defeat the point of generalizing across repeated items.
//
// Uniqueness is required, not just correctness: an earlier version accepted any
// selector whose FIRST match was the clicked element, which silently allowed a
// selector matching 20 elements as long as the clicked one happened to be first. It
// then worked on item 0 and threw a strict-mode violation on item 1.
function relativeCandidates(el, root) {
  if (el === root) return [''];
  const out = [];
  const seen = new Set();
  const push = (sel) => {
    if (sel === null || sel === undefined || seen.has(sel)) return;
    seen.add(sel);
    try {
      if (root.querySelectorAll(sel).length === 1 && root.querySelector(sel) === el) out.push(sel);
    } catch { /* invalid */ }
  };

  const chain = (useClasses) => {
    const parts = [];
    let node = el;
    let depth = 0;
    // A full-text description block is often 15-30 levels below <html> on a
    // framework-heavy careers site (layout wrappers, CSS-in-JS component divs) -
    // deeper than a job card's own title/location ever need to be. 10 was tuned for
    // the latter and silently failed the former, so this is generous on purpose.
    while (node && node !== root && node.parentElement && depth < 40) {
      // An id on an ANCESTOR (not el itself - that's the dedicated self-candidate
      // below) anchors the whole path: what is between it and el is already in
      // `parts`, so the climb can stop right here instead of needing to reach
      // `root` at all. Without this, a singleton element with an id but no
      // distinguishing classes (a modal/portal container, commonly) had no way to
      // be named other than "nth div under body", which real pages rarely make
      // unique.
      if (node !== el && node.id) { parts.unshift(node.tagName.toLowerCase() + '#' + esc(node.id)); return parts.join(' > '); }
      let part = node.tagName.toLowerCase();
      if (useClasses) {
        const cls = Array.from(node.classList).filter((c) => !HASH_LIKE.test(c));
        if (cls.length) part += cls.map((c) => '.' + esc(c)).join('');
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return node === root ? parts.join(' > ') : null;
  };

  // SELF-ONLY candidates first: a descendant selector naming just the target is far
  // more durable than a full ancestor chain. On a real careers row the chain was
  // `div.rc-accordion-button > div.w-100.d-flex > div.d-flex.flex-row.row.large-12... >
  // h3 > a.link-inline.t-intro.word-wrap-break-word.more` - six levels of responsive
  // layout utilities plus a state class, any of which changes with viewport width or
  // truncation state. `a.link-inline` says the same thing and survives all of it.
  // Ascending, so the SHORTEST selector that is still unique inside the item wins.
  // Uniqueness is enforced by `push`, so a too-loose one is rejected rather than
  // chosen - which makes "minimal unique" both safe and the most durable option.
  const tag = el.tagName.toLowerCase();
  // An id, if el has one, is tried first - more robust than any class list, and
  // exactly what a singleton element (a modal, a "show more" panel) usually has
  // instead of a distinguishing class.
  if (el.id) push(tag + '#' + esc(el.id));
  const classes = Array.from(el.classList).filter((c) => !HASH_LIKE.test(c));
  for (let i = 0; i <= classes.length; i += 1) push(withClasses(el.tagName, classes.slice(0, i)));
  for (const attr of ['data-testid', 'data-test-id', 'data-test']) {
    const value = el.getAttribute(attr);
    if (value) push(`${tag}[${attr}="${value}"]`);
  }

  // Ancestor chains as fallbacks, for targets that only a path can pin down.
  push(chain(true));
  push(chain(false));
  return out;
}

// --- choosing the repeating unit -------------------------------------------
//
// The hard part. The container the user picks only BOUNDS the search; the repeating
// unit is usually nested well below it. On a real careers page, walking up from a
// clicked job link finds several levels that all "repeat":
//
//   div.job-title-link      4 siblings   20 under the container
//   div.rc-accordion-button 2 siblings   20 under the container
//   li.rc-accordion-item   20 siblings   20 under the container   <-- the job row
//   section                 2 siblings    2 under the container
//
// So neither "outermost child of the container" (picks `section`, 2 items) nor
// "innermost repeating level" (picks the title column) is right.
//
// What settles it: the thing the user clicked occurs 20 times in the container, so the
// item unit must occur 20 times too - one per click target. Among the levels that
// satisfy that, take the OUTERMOST, which leaves the most room for other per-item
// fields to be added to the same loop later.

// Every ancestor-or-self of `el` inside `parentEl` that has same-tag siblings.
// Innermost first.
function repeatingLevels(el, parentEl) {
  const levels = [];
  let node = el;
  let depth = 0;
  while (node && node !== parentEl && parentEl.contains(node) && depth < 15) {
    const parent = node.parentElement;
    if (!parent) break;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    if (sameTag.length >= 2) levels.push(node);
    node = parent;
    depth += 1;
  }
  return levels;
}

// How many times "this kind of element" appears in the container - i.e. how many items
// the loop ought to produce. Starts from the most specific class list and relaxes until
// it matches more than one.
function occurrenceCount(el, parentEl) {
  const classes = Array.from(el.classList).filter((c) => !HASH_LIKE.test(c));
  for (let i = classes.length; i >= 0; i -= 1) {
    const sel = withClasses(el.tagName, classes.slice(0, i));
    let n = 0;
    try { n = parentEl.querySelectorAll(sel).length; } catch { continue; }
    if (n >= 2) return { selector: sel, count: n };
  }
  return { selector: el.tagName.toLowerCase(), count: 0 };
}

// Rejects an item selector that would make the recorded step ambiguous at replay: no
// item may contain more than one match for the relative selector, and enough of them
// must contain it at all for this to be the right level.
function atMostOnePerItem(parentEl, itemSelector, rel) {
  if (rel === '') return true;
  let items;
  try { items = parentEl.querySelectorAll(itemSelector); } catch { return false; }
  if (items.length < 2) return false;
  let withExactlyOne = 0;
  for (const item of items) {
    let n;
    try { n = item.querySelectorAll(rel).length; } catch { return false; }
    if (n > 1) return false;
    if (n === 1) withExactlyOne += 1;
  }
  return withExactlyOne >= Math.max(1, Math.floor(items.length / 2));
}

// Cheap, phase-agnostic signal for the picker's hover badge (Phase 2.2): how many
// of this element's immediate siblings share its tag, out of how many siblings
// there are in total. Deliberately NOT chooseItem's heavier occurrence/ancestor
// walk - this only has to answer "does this look like it repeats?" the instant
// the cursor lands on it, before anything is clicked. The real, load-bearing
// count still comes from chooseItem() once an item is actually picked.
function siblingMatchInfo(el) {
  const parent = el.parentElement;
  if (!parent) return { tag: el.tagName.toLowerCase(), matched: 1, total: 1 };
  const total = parent.children.length;
  const matched = Array.from(parent.children).filter((c) => c.tagName === el.tagName).length;
  return { tag: el.tagName.toLowerCase(), matched, total };
}

function chooseItem(clicked, parentEl) {
  const occurrence = occurrenceCount(clicked, parentEl);
  const scored = [];

  for (const level of repeatingLevels(clicked, parentEl)) {
    const rels = relativeCandidates(clicked, level);
    if (!rels.length) continue;
    const cands = itemCandidates(level, parentEl).filter((c) => atMostOnePerItem(parentEl, c.selector, rels[0]));
    if (!cands.length) continue;
    scored.push({ level, rels, cands, count: cands[0].count });
  }

  if (!scored.length) return null;

  // `scored` is innermost-first, so the last entry is the outermost.
  const exact = scored.filter((s) => s.count === occurrence.count);
  if (exact.length) return { ...exact[exact.length - 1], occurrence, exact: true };

  // Nothing lines up with how often the clicked thing appears. Take the level yielding
  // the most items (ties: outermost) and let the count shown in the overlay be the
  // user's cue that something is off.
  const best = scored.slice().sort((a, b) => a.count - b.count).pop();
  return { ...best, occurrence, exact: false };
}
