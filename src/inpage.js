// inpage.js
//
// Everything that runs INSIDE the recorded page. Injected via context.addInitScript(),
// which (unlike a Chrome content script) runs in the MAIN world - so it can call the
// exposeBinding'd window.__pwEvent directly, with no CustomEvent world-bridge. It also
// re-runs on every navigation, which is exactly what the overlay needs when a flow
// dives into a job detail and comes back.
//
// This function's source is serialized and re-evaluated in the browser, so it must be
// entirely self-contained: no requires, no closing over Node scope.
function installOverlay(config) {
  if (window.__playright) return;

  const PREFIX = config.markerPrefix;
  const OVERLAY_ID = 'playright-overlay';

  // Classes that look build-generated (styled-components "sc-xxxx", CSS-modules
  // "Name__hash", bare alphanumeric soup). Heuristic, used ONLY to decide which class
  // to drop first when relaxing an over-specific selector - never to decide on its own
  // whether a selector is safe.
  const HASH_LIKE = /(^sc-[a-z0-9]+$)|(__[a-z0-9]{4,}$)|(^[a-z]{0,2}\d[a-z0-9]*$)/i;

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

  const send = (payload) => {
    // The binding may not be installed yet on a very early event; dropping it is
    // correct, since nothing meaningful can have happened that early.
    if (typeof window.__pwEvent === 'function') window.__pwEvent(payload);
  };

  const isOurs = (el) => !!(el && el.closest && el.closest('#' + OVERLAY_ID));

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
      while (node && node !== root && node.parentElement && depth < 10) {
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

  const textOf = (el) => {
    const raw = (el.value !== undefined && el.value !== null && el.value !== '')
      ? String(el.value)
      : (el.innerText || el.textContent || '');
    return raw.trim().replace(/\s+/g, ' ').slice(0, 60);
  };

  // --- overlay chrome ---------------------------------------------------------

  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.style.cssText = [
    'position:fixed', 'right:12px', 'top:50%', 'transform:translateY(-50%)',
    'z-index:2147483646', 'display:flex', 'flex-direction:column', 'align-items:flex-end',
    'gap:8px', 'font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  ].join(';');

  const status = document.createElement('div');
  status.style.cssText = [
    'max-width:320px', 'padding:10px 12px', 'border-radius:8px', 'background:rgba(17,17,17,.94)',
    'color:#fff', 'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'white-space:pre-line', 'display:none',
  ].join(';');

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;';

  function makeButton(letter, label) {
    const b = document.createElement('button');
    // The aria-label IS the accessible name, which is what Playwright's own selector
    // generator keys a role-based locator off - so a press of this button is recorded
    // as internal:role=button[name="playright:R:start"i]. That is what lets the marker
    // ride in-band, at an exact stream position, with no cross-channel correlation.
    b.setAttribute('aria-label', label);
    b.textContent = letter;
    b.style.cssText = [
      'width:36px', 'height:36px', 'border-radius:50%', 'border:2px solid #222',
      'background:#fff', 'color:#222', 'font-weight:700', 'font-size:13px', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.28)',
    ].join(';');
    return b;
  }

  const rBtn = makeButton('R', PREFIX + 'R:start');
  const fBtn = makeButton('F', PREFIX + 'F:arm');

  function paint(btn, active, colour) {
    btn.style.background = active ? colour : '#fff';
    btn.style.color = active ? '#fff' : '#222';
  }

  function say(text, tone) {
    if (!text) { status.style.display = 'none'; return; }
    status.textContent = text;
    status.style.display = 'block';
    status.style.background = tone === 'good' ? 'rgba(6,95,70,.96)'
      : tone === 'bad' ? 'rgba(127,29,29,.96)'
      : 'rgba(17,17,17,.94)';
  }

  // --- picker: swallows the click so picking never fires the site's handlers ---
  //
  // A transparent full-viewport layer sits above everything at the browser's
  // hit-testing level, so the click never reaches the page underneath. A plain
  // document listener is not enough: a site can stopPropagation() before ours runs,
  // and more importantly the click would still activate the element - which is how
  // picking a job card used to navigate away in the middle of defining the loop.
  let picker = null;
  let outlined = null;

  function outline(el) {
    if (outlined && outlined !== el) outlined.style.outline = outlined.__pwPrevOutline || '';
    if (el && el !== outlined) { el.__pwPrevOutline = el.style.outline; el.style.outline = '2px solid #ff3366'; }
    outlined = el;
  }

  function closePicker() {
    outline(null);
    if (picker) { picker.remove(); picker = null; }
  }

  function openPicker(onPick) {
    closePicker();
    picker = document.createElement('div');
    picker.setAttribute('role', 'button');
    picker.setAttribute('aria-label', PREFIX + 'pick');
    picker.style.cssText = 'position:fixed;inset:0;z-index:2147483645;cursor:crosshair;background:transparent;';

    const under = (x, y) => {
      picker.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      picker.style.pointerEvents = 'auto';
      return el;
    };

    picker.addEventListener('mousemove', (e) => {
      const el = under(e.clientX, e.clientY);
      if (!isOurs(el)) outline(el);
    });

    picker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = under(e.clientX, e.clientY);
      closePicker();
      if (el && !isOurs(el)) onPick(el);
    }, true);

    document.documentElement.appendChild(picker);
  }

  // --- R ----------------------------------------------------------------------

  let rOpen = false;
  rBtn.addEventListener('click', () => {
    rOpen = !rOpen;
    // Label the button with what the NEXT press will mean, so the press just recorded
    // carries the meaning it actually had.
    rBtn.setAttribute('aria-label', PREFIX + (rOpen ? 'R:end' : 'R:start'));
    paint(rBtn, rOpen, '#ff3b30');
    say(rOpen
      ? 'R: recording a repeat block.\nEverything from here until you press R again will be repeated.'
      : 'R: repeat block closed.', rOpen ? null : 'good');
  });

  // --- F ----------------------------------------------------------------------
  //
  // Strictly sequential, enforced here rather than trusted: arm -> pick parent ->
  // pick item -> record body -> close. At most one F is ever in flight, which is what
  // makes the out-of-band pick payloads unambiguous on the Node side.
  let fState = 'idle';
  let fItem = null;
  let bodySeq = 0;

  function resetF() {
    fState = 'idle';
    fItem = null;
    fBtn.setAttribute('aria-label', PREFIX + 'F:arm');
    paint(fBtn, false, '#007aff');
    closePicker();
  }

  function pickParent() {
    fState = 'parent';
    say('F, step 1 of 2:\nClick the CONTAINER that holds the repeating items (the list or grid, not one card).\n\nThis click will not affect the site.');
    openPicker((parentEl) => {
      const parents = parentCandidates(parentEl);
      if (!parents.length) {
        say('Could not build a stable selector for that container.\nTry clicking a slightly different element (often the <ul> or the grid wrapper).', 'bad');
        pickParent();
        return;
      }
      pickItem(parentEl, parents);
    });
  }

  function pickItem(parentEl, parents) {
    fState = 'item';
    say('F, step 2 of 2:\nNow click ONE of the repeating items inside it (one card/row).\n\nThis click will not affect the site either.');
    openPicker((clicked) => {
      if (!parentEl.contains(clicked)) {
        say('That element is not inside the container you picked.\nStarting over - click the container again.', 'bad');
        pickParent();
        return;
      }

      const chosen = chooseItem(clicked, parentEl);
      if (!chosen) {
        say('That element does not repeat inside the container in a way I can address reliably.\nPick the container again, then a genuinely repeating card/row.', 'bad');
        pickParent();
        return;
      }

      fItem = chosen.level;
      fState = 'body';
      bodySeq = 0;
      fBtn.setAttribute('aria-label', PREFIX + 'F:close');
      paint(fBtn, true, '#007aff');

      const count = chosen.count;
      // Validated live and shown immediately. A count of 0 or 1, or one that disagrees
      // with how often the clicked element actually appears, is knowable in the instant
      // it is picked - the previous implementation wrote matchCount: 0 to disk and only
      // failed days later, at replay time.
      const headline = 'Matched ' + count + ' items via  ' + chosen.cands[0].selector;
      if (chosen.exact) {
        say(headline
          + '\n\nEverything you do from now on repeats for EACH of those ' + count + ' items.'
          + '\nPress F again when the per-item steps are done.', 'good');
      } else {
        say(headline
          + '\n\nHeads up: what you clicked appears ' + chosen.occurrence.count
          + ' time(s) in that container, but this repeating unit appears ' + count + ' time(s).'
          + '\nIf that looks wrong, press F to cancel and pick a tighter container.', 'bad');
      }

      send({
        type: 'F', phase: 'scope',
        parents: parents.map((p) => p.selector),
        items: chosen.cands.map((c) => c.selector),
        count,
        occurrenceCount: chosen.occurrence.count,
        exact: chosen.exact,
        itemTag: chosen.level.tagName.toLowerCase(),
      });
    });
  }

  fBtn.addEventListener('click', () => {
    if (fState === 'idle') { pickParent(); return; }
    if (fState === 'parent' || fState === 'item') {
      say('F cancelled.', null);
      send({ type: 'F', phase: 'cancel' });
      resetF();
      return;
    }
    say('F: per-item block closed.', 'good');
    resetF();
  });

  // While an F body is being recorded, report for each observed interaction whether it
  // targeted the current item (and how to reach it from the item root). Node pairs
  // these with the recorded actions in order, cross-checking the reported text against
  // the action's own selector before trusting the pairing.
  function observe(event) {
    if (fState !== 'body' || !fItem) return;
    const target = event.target;
    if (!target || isOurs(target)) return;
    const inItem = target === fItem || fItem.contains(target);
    send({
      type: 'F', phase: 'bodyEvent', n: bodySeq++,
      inItem,
      rel: inItem ? relativeCandidates(target, fItem) : null,
      tag: target.tagName ? target.tagName.toLowerCase() : null,
      text: textOf(target),
    });
  }

  document.addEventListener('click', observe, { capture: true, passive: true });
  // Playwright merges keystrokes into a single fill action finalised around commit/blur,
  // which is what `change` tracks here too.
  document.addEventListener('change', observe, { capture: true, passive: true });

  // --- mount ------------------------------------------------------------------

  row.appendChild(rBtn);
  row.appendChild(fBtn);
  root.appendChild(status);
  root.appendChild(row);

  const mount = () => {
    if (!document.body) return;
    if (!document.getElementById(OVERLAY_ID)) document.body.appendChild(root);
  };

  window.__playright = {
    // Diagnostic: what WOULD the picker choose for this container/target pair? Any page
    // snapshot saved under sites/<id>/failures/ can be replayed through a changed picker
    // offline with this, instead of re-recording against the live site to find out.
    pickPreview(containerSelector, targetSelector) {
      const parentEl = document.querySelector(containerSelector);
      const clicked = document.querySelector(targetSelector);
      if (!parentEl || !clicked) return { error: 'container or target not found' };
      if (!parentEl.contains(clicked)) return { error: 'target is not inside the container' };
      const chosen = chooseItem(clicked, parentEl);
      if (!chosen) return { error: 'no addressable repeating unit found' };
      return {
        parents: parentCandidates(parentEl).map((p) => p.selector),
        items: chosen.cands.map((c) => c.selector),
        count: chosen.count,
        occurrenceCount: chosen.occurrence.count,
        exact: chosen.exact,
        relativeSelectors: chosen.rels,
        itemTag: chosen.level.tagName.toLowerCase(),
      };
    },

    // Re-announce state after a navigation re-runs this script: the R/F block may still
    // be logically open on the Node side even though the DOM was replaced.
    restore(state) {
      if (state.rOpen) { rOpen = true; rBtn.setAttribute('aria-label', PREFIX + 'R:end'); paint(rBtn, true, '#ff3b30'); }
      if (state.fOpen) {
        // The item element is gone with the old document, so per-item scope detection
        // cannot continue across a navigation; Node is told and falls back to page scope.
        fBtn.setAttribute('aria-label', PREFIX + 'F:close');
        paint(fBtn, true, '#007aff');
        fState = 'bodyDetached';
        say('Still inside the per-item block.\nSteps here apply to the page (not to one item).\nPress F when done.', null);
      }
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}

module.exports = { installOverlay };
