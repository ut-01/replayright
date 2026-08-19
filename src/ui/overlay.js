// overlay.js
//
// Everything that runs INSIDE the recorded page: overlay chrome, the click-swallowing
// picker, and R/F marker wiring. Concatenated after selectors.js (whose pure
// cssPath/chooseItem/etc. functions this file calls) into the one script string
// src/ui-bundle.js hands to `context.addInitScript({ content })`, which - unlike a
// Chrome content script - runs in the page's MAIN world, so it can call the
// exposeBinding'd window.__pwEvent directly. It also re-runs on every navigation,
// which is exactly what the overlay needs when a flow dives into a job detail and
// comes back.
//
// `{ content }` mode has no second `arg` the way `addInitScript(fn, arg)` did, so the
// config that used to arrive as installOverlay's parameter is baked into the bundle as
// the __CFG__ literal ui-bundle.js appends after this file, alongside __HTML__ and
// __CSS__ - the markup and stylesheet this file mounts. This function's source (like
// selectors.js) is serialized as raw text and evaluated in the browser, so it must be
// entirely self-contained: no requires, no closing over Node scope.
function installOverlay(config, html, css) {
  if (window.__playright) return;

  const PREFIX = config.markerPrefix;
  const OVERLAY_ID = 'playright-overlay';

  const send = (payload) => {
    // The binding may not be installed yet on a very early event; dropping it is
    // correct, since nothing meaningful can have happened that early.
    if (typeof window.__pwEvent === 'function') window.__pwEvent(payload);
  };

  // Any full-viewport (or otherwise click-swallowing) layer we mount - the toolbar
  // itself (#playright-overlay) plus the picker, toast layer, and any future layer
  // like it - is tagged with data-playright-chrome (see openPicker/ensureToast below).
  // observe() below is registered on `document` with capture: true, which fires BEFORE
  // a layer's own capture handler; without recognising the layer here, a click on it
  // (e.g. the picker armed while an F body is open) would be reported as a genuine
  // per-item body event instead of being swallowed as chrome noise.
  const isOurs = (el) => !!(el && el.closest && el.closest('#' + OVERLAY_ID + ', [data-playright-chrome]'));

  // Reads a --pr-z-* tier off the toolbar's :host custom properties (see overlay.css)
  // so light-DOM layers like the picker share one source of truth instead of a second
  // hardcoded number that can silently drift out of tier order. Only meaningful once
  // `host` is attached to the document (mount() runs before any layer that calls this).
  function zTier(name, fallback) {
    if (!host.isConnected) return fallback;
    const value = getComputedStyle(host).getPropertyValue(name).trim();
    return value || fallback;
  }

  const textOf = (el) => {
    const raw = (el.value !== undefined && el.value !== null && el.value !== '')
      ? String(el.value)
      : (el.innerText || el.textContent || '');
    return raw.trim().replace(/\s+/g, ' ').slice(0, 60);
  };

  // --- overlay chrome ---------------------------------------------------------
  //
  // An OPEN shadow root, confirmed safe for the marker mechanism by the Phase 2.0
  // spike (test/shadow-marker.test.js): Playwright's role locator still finds and
  // clicks a button inside one, and the recorder still keys the generated selector off
  // its accessible name. That is what lets overlay.css be a real stylesheet - none of
  // the recorded page's own CSS can bleed in, and none of ours can bleed out.
  const host = document.createElement('div');
  host.id = OVERLAY_ID;

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);

  const template = document.createElement('template');
  template.innerHTML = html;
  shadow.appendChild(template.content.cloneNode(true));

  const openStrip = shadow.querySelector('[data-pr="open-strip"]');
  const rBtn = shadow.querySelector('[data-pr="r-btn"]');
  const fBtn = shadow.querySelector('[data-pr="f-btn"]');
  const settingsBtn = shadow.querySelector('[data-pr="settings-btn"]');

  // The aria-label IS the accessible name, which is what Playwright's own selector
  // generator keys a role-based locator off - so a press of this button is recorded
  // as internal:role=button[name="playright:R:start"i]. That is what lets the marker
  // ride in-band, at an exact stream position, with no cross-channel correlation. Set
  // here at mount time (mirroring the old makeButton()'s initial label) and again on
  // every state change below, so the press just recorded always carries the meaning it
  // actually had.
  rBtn.setAttribute('aria-label', PREFIX + 'R:start');
  fBtn.setAttribute('aria-label', PREFIX + 'F:arm');
  settingsBtn.setAttribute('aria-label', PREFIX + 'ui:settings');

  // `title` is plain human-readable hover copy - independent of aria-label, which
  // must stay byte-identical to the playright:*  marker strings the recorder keys
  // off. Safe to word however's clearest, and updated alongside every state change
  // below so the tooltip never lags behind what the button will actually do next.
  const TITLE_R = { closed: 'Start a repeat block (R)', open: 'End the repeat block (R)' };
  const TITLE_F = {
    idle: 'Arm: pick the repeating container (F)',
    parent: 'Click the container that holds the repeating items',
    item: 'Click one repeating item inside the container',
    body: 'Close the per-item block (F)',
    bodyDetached: 'Still inside the per-item block - close it (F)',
  };
  rBtn.title = TITLE_R.closed;
  fBtn.title = TITLE_F.idle;
  settingsBtn.title = 'Settings (position and orientation)';

  function paint(btn, active) {
    btn.classList.toggle('is-active', active);
  }

  // "R open · F open" - a persistent at-a-glance answer to "what's still open",
  // recomputed after every rOpen/fState change below instead of tracked separately,
  // so it can never drift from the state that actually drives the buttons.
  function updateOpenStrip() {
    const parts = [];
    if (rOpen) parts.push('R open');
    if (fState !== 'idle') parts.push('F open');
    if (parts.length) {
      openStrip.textContent = parts.join(' · ');
      openStrip.hidden = false;
    } else {
      openStrip.hidden = true;
    }
  }

  // --- toast: floating status, mounted in the page's light DOM -----------------
  //
  // Deliberately NOT inside the overlay's shadow root. The :host rule in
  // overlay.css sets `transform: translateY(-50%)` on the toolbar's shadow host so
  // it can hug the vertical centre of the viewport edge - and a transformed
  // ancestor becomes the containing block for any `position: fixed` descendant, so
  // a toast rendered inside that shadow tree would end up positioned relative to
  // the toolbar's own little box instead of the viewport (the same hazard the
  // Phase 3.4 settings-panel note in CLAUDE.md warns about). Mounting it as a
  // sibling of the toolbar host, directly under <html>, sidesteps that - which is
  // also why it needs its own tiny stylesheet instead of reusing overlay.css:
  // :host custom properties only inherit into that host's OWN shadow tree, not
  // into unrelated light-DOM siblings, so the handful of colours below are plain
  // literals rather than var(--pr-*).
  const CHROME_STYLE_ID = 'playright-chrome-style';

  function ensureChromeStyle() {
    if (document.getElementById(CHROME_STYLE_ID)) return;
    const chromeStyle = document.createElement('style');
    chromeStyle.id = CHROME_STYLE_ID;
    chromeStyle.textContent =
      '.pr-toast-layer{position:fixed;top:16px;right:16px;z-index:2147483646;'
        + 'display:flex;flex-direction:column;gap:8px;pointer-events:none;'
        + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
      + '.pr-toast{display:flex;gap:8px;max-width:320px;padding:10px 12px 10px 10px;'
        + 'border-radius:8px;background:rgba(17,17,17,.94);color:#fff;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.35);white-space:pre-line;'
        + 'border-left:4px solid #8e8e93;opacity:0;transform:translateX(12px);'
        + 'transition:opacity 160ms ease,transform 160ms ease;}'
      + '.pr-toast.is-visible{opacity:1;transform:translateX(0);}'
      + '.pr-toast--good{border-left-color:#34c759;}'
      + '.pr-toast--bad{border-left-color:#ff3b30;}'
      + '.pr-toast--neutral{border-left-color:#8e8e93;}'
      + '.pr-toast-icon{flex:none;font-size:13px;line-height:1.5;}'
      + '.pr-toast-text{flex:1;}'
      + '.pr-cursor-label{position:fixed;z-index:2147483645;pointer-events:none;'
        + 'transform:translate(14px,18px);background:rgba(17,17,17,.92);color:#fff;'
        + 'font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'padding:5px 8px;border-radius:6px;white-space:nowrap;display:none;}'
      + '.pr-hover-badge{position:fixed;z-index:2147483645;pointer-events:none;'
        + 'background:rgba(255,51,102,.92);color:#fff;'
        + 'font:11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'font-weight:600;padding:3px 6px;border-radius:4px;white-space:nowrap;display:none;}'
      + '.pr-settings-panel{position:fixed;z-index:2147483646;background:rgba(17,17,17,.96);'
        + 'color:#fff;border-radius:8px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,.35);'
        + 'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'min-width:160px;right:80px;top:12px;}'
      + '.pr-settings-panel[hidden]{display:none;}'
      + '.pr-settings-header{margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.2);}'
      + '.pr-settings-title{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;'
        + 'color:rgba(255,255,255,.7);}'
      + '.pr-settings-group{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}'
      + '.pr-settings-group:last-child{margin-bottom:0;}'
      + '.pr-settings-radio{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;'
        + 'padding:4px 6px;border-radius:4px;transition:background-color 120ms ease;}'
      + '.pr-settings-radio:hover{background-color:rgba(255,255,255,.1);}'
      + '.pr-settings-radio input[type="radio"]{cursor:pointer;}'
      + '.pr-settings-radio span{font-size:12px;}';
    document.documentElement.appendChild(chromeStyle);
  }

  let toastLayer = null;
  let toastEl = null;

  function ensureToast() {
    ensureChromeStyle();
    if (!toastLayer) {
      toastLayer = document.createElement('div');
      toastLayer.className = 'pr-toast-layer';
      toastLayer.setAttribute('data-playright-chrome', '');
      document.documentElement.appendChild(toastLayer);
    }
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.innerHTML = '<span class="pr-toast-icon" data-pr="toast-icon"></span>'
        + '<span class="pr-toast-text" data-pr="toast-text"></span>';
      toastLayer.appendChild(toastEl);
    }
  }

  // Three tones, an icon apiece, plus the left accent stripe - not just a
  // background-colour change. `say('', ...)` (or any falsy text) plays the exit
  // animation and leaves the toast hidden, mirroring the old status box's
  // `display:none` default.
  function say(text, tone) {
    ensureToast();
    if (!text) {
      toastEl.classList.remove('is-visible');
      return;
    }
    const toneKey = tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : 'neutral';
    const icon = toneKey === 'good' ? '✓' : toneKey === 'bad' ? '⊘' : '•';
    toastEl.className = 'pr-toast pr-toast--' + toneKey;
    toastEl.querySelector('[data-pr="toast-icon"]').textContent = icon;
    toastEl.querySelector('[data-pr="toast-text"]').textContent = text;
    // Re-trigger the enter transition even when a toast is already showing, so
    // replacing one instruction with the next ("step 1 of 2" -> "step 2 of 2") is
    // visibly an update, not a silent text swap the user might not notice.
    toastEl.classList.remove('is-visible');
    void toastEl.offsetHeight; // force a reflow so the class removal above lands first
    toastEl.classList.add('is-visible');
  }

  // --- picker: swallows the click so picking never fires the site's handlers ---
  //
  // A transparent full-viewport layer sits above everything at the browser's
  // hit-testing level, so the click never reaches the page underneath. A plain
  // document listener is not enough: a site can stopPropagation() before ours runs,
  // and more importantly the click would still activate the element - which is how
  // picking a job card used to navigate away in the middle of defining the loop.
  //
  // The picker is mounted in the light DOM (document.documentElement), not the
  // overlay's shadow root: it has to sit above the recorded page's own content at the
  // browser's hit-testing level regardless of which shadow tree that content lives in,
  // and it is transient chrome rather than part of the overlay's own visual design, so
  // it keeps the same inline-styled construction the rest of the chrome moved away
  // from. Its two children - the cursor-following instruction label and the
  // tag/count hover badge - are Phase 2.2's "armed state" and "hover outline"
  // affordances; both ride along for free on the picker's existing lifecycle
  // (openPicker/closePicker), so there is nothing extra to leak on cancel.
  let picker = null;
  let outlined = null;
  let cursorLabel = null;
  let hoverBadge = null;

  // --- parent-climb: manual override on top of the picker, not inside it ------
  //
  // Container picks, item picks and field picks all share this one picker mechanism,
  // and all three can hit the same problem: elementFromPoint() only ever returns the
  // INNERMOST element under the cursor, so when a child and its parent occupy nearly
  // the same screen space there is no way to click the parent directly - every click
  // at that spot keeps landing on the child.
  //
  // The fix: clicking the SAME already-selected element again climbs one level up the
  // ancestor chain (via selectors.js#ancestorAt) instead of re-selecting the same
  // element. `climbAnchor` is the raw (unclimbed) elementFromPoint() result from the
  // most recent click; `climbDepth` is how many levels have been climbed FROM that
  // anchor so far. A click at a genuinely different position never matches the anchor,
  // so it always resets to a fresh, un-climbed pick - existing single-click flows (every
  // test recorded before this feature existed) are unaffected byte-for-byte.
  //
  // Deliberately NOT reset by openPicker()/closePicker() - those run on every single
  // pick stage (container, then item, then each field), and resetting there would
  // erase the climb the moment an error handler re-opens the picker to retry the SAME
  // stage, which is exactly when the climb matters. It resets only at a genuinely NEW
  // arm (pressing F from idle, or pressing a field pill) - see resetClimb() call sites
  // below - and implicitly on navigation, since the whole script (and this closure)
  // re-runs from scratch on every page load.
  let climbAnchor = null;
  let climbDepth = 0;

  function resetClimb() {
    climbAnchor = null;
    climbDepth = 0;
  }

  // Non-mutating preview for the hover badge: "what WOULD a click select right now".
  // Hovering the anchor position shows the CURRENT climb level (not yet incremented);
  // hovering anywhere else previews a fresh, un-climbed pick of whatever is there.
  function climbPeek(rawEl) {
    if (rawEl === climbAnchor) return ancestorAt(rawEl, climbDepth);
    return rawEl;
  }

  // Mutating: called only from the picker's click handler. Advances the climb when the
  // click lands on the same raw element as last time, else starts a fresh climb at 0.
  function climbFrom(rawEl) {
    if (rawEl === climbAnchor) climbDepth += 1;
    else { climbAnchor = rawEl; climbDepth = 0; }
    return ancestorAt(rawEl, climbDepth);
  }

  function updateHoverBadge(el) {
    if (!hoverBadge) return;
    if (!el) { hoverBadge.style.display = 'none'; return; }
    const info = siblingMatchInfo(el);
    hoverBadge.textContent = info.tag.toUpperCase() + ' (' + info.matched + ' of ' + info.total + ')';
    const rect = el.getBoundingClientRect();
    hoverBadge.style.display = 'block';
    hoverBadge.style.left = Math.max(4, rect.left) + 'px';
    hoverBadge.style.top = Math.max(4, rect.top - 22) + 'px';
  }

  function outline(el) {
    if (outlined && outlined !== el) {
      outlined.style.outline = outlined.__pwPrevOutline || '';
      outlined.style.backgroundColor = outlined.__pwPrevBg || '';
    }
    if (el && el !== outlined) {
      el.__pwPrevOutline = el.style.outline;
      el.__pwPrevBg = el.style.backgroundColor;
      el.style.outline = '2px solid #ff3366';
      // Translucent fill on top of the outline, plus the tag/count badge below -
      // the count is the single most useful thing at pick time, and previously only
      // showed up after committing to an item.
      el.style.backgroundColor = 'rgba(255, 51, 102, 0.1)';
    }
    outlined = el;
    updateHoverBadge(el);
  }

  function closePicker() {
    outline(null);
    if (picker) { picker.remove(); picker = null; }
    cursorLabel = null;
    hoverBadge = null;
  }

  // `instruction` is short, imperative cursor-label copy ("Click the CONTAINER") -
  // always supplied by the F state machine below (pickParent/pickItem), never
  // hardcoded here, so it always names the actual next step rather than a generic
  // "pick something".
  function openPicker(instruction, onPick) {
    closePicker();
    ensureChromeStyle();

    picker = document.createElement('div');
    picker.setAttribute('role', 'button');
    picker.setAttribute('aria-label', PREFIX + 'pick');
    picker.setAttribute('data-playright-chrome', '');
    // The radial gradient is the "armed state" vignette: everything dims except a
    // soft spotlight near the centre, a signal (on top of the crosshair cursor)
    // that this whole viewport is live for picking - and it swallows the click via
    // the listener below regardless of where in that gradient it lands.
    picker.style.cssText = 'position:fixed;inset:0;z-index:' + zTier('--pr-z-picker', '2147483645') + ';cursor:crosshair;'
      + 'background:radial-gradient(circle at 50% 40%, rgba(0,0,0,.05) 0%, rgba(0,0,0,.35) 85%);';

    cursorLabel = document.createElement('div');
    cursorLabel.className = 'pr-cursor-label';
    cursorLabel.textContent = instruction;
    picker.appendChild(cursorLabel);

    hoverBadge = document.createElement('div');
    hoverBadge.className = 'pr-hover-badge';
    picker.appendChild(hoverBadge);

    const under = (x, y) => {
      picker.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      picker.style.pointerEvents = 'auto';
      return el;
    };

    picker.addEventListener('mousemove', (e) => {
      cursorLabel.style.display = 'block';
      cursorLabel.style.left = e.clientX + 'px';
      cursorLabel.style.top = e.clientY + 'px';
      const el = under(e.clientX, e.clientY);
      // Preview only - never mutates climb state. Shows the CLIMBED level when
      // hovering back over the anchor position, so the badge is what tells the user
      // they've climbed high enough, without needing to click to find out.
      if (!isOurs(el)) outline(el ? climbPeek(el) : null);
    });

    picker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = under(e.clientX, e.clientY);
      closePicker();
      if (el && !isOurs(el)) onPick(climbFrom(el));
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
    rBtn.title = rOpen ? TITLE_R.open : TITLE_R.closed;
    paint(rBtn, rOpen);
    updateOpenStrip();
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
    fBtn.title = TITLE_F.idle;
    paint(fBtn, false);
    updateOpenStrip();
    closePicker();
    updateFieldsVisibility();
  }

  function pickParent() {
    fState = 'parent';
    fBtn.title = TITLE_F.parent;
    updateOpenStrip();
    say('F, step 1 of 2:\nClick the CONTAINER that holds the repeating items (the list or grid, not one card).\n\nThis click will not affect the site.');
    openPicker('Click the CONTAINER', (parentEl) => {
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
    fBtn.title = TITLE_F.item;
    updateOpenStrip();
    say('F, step 2 of 2:\nNow click ONE of the repeating items inside it (one card/row).\n\nThis click will not affect the site either.');
    openPicker('Click the ITEM', (clicked) => {
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
      fBtn.title = TITLE_F.body;
      paint(fBtn, true);
      updateOpenStrip();
      // Only now does a field selector have anything to be relative to.
      updateFieldsVisibility();

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
    // A fresh arm from idle - not the internal retries pickParent()/pickItem() make on
    // their own error paths - is what starts a new climb chain from scratch.
    if (fState === 'idle') { resetClimb(); pickParent(); return; }
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

  // --- field extraction (Phase 3.2) --------------------------------------------
  //
  // One-shot arm -> pick -> capture, not a toggle: pressing a pill arms picking for
  // that field, the very next picker click captures it (out-of-band, same as F's
  // scope pick), and the toolbar falls straight back to idle - ready for the next
  // field - with no separate "close" gesture the way F needs one. That is also why
  // the marker only has a `pick` phase (`playright:field:pick:<key>`, see
  // generalize.js#parseMarker): there is nothing else to name.
  //
  // Only meaningful, and only shown, while an F body is open (fState === 'body') - a
  // field selector is relative to fItem, which does not exist otherwise.
  const fieldsRow = shadow.querySelector('[data-pr="fields"]');
  const fieldButtons = Array.from(shadow.querySelectorAll('[data-pr="field-btn"]'));
  const fieldAddBtn = shadow.querySelector('[data-pr="field-add-btn"]');
  const fieldCustomWrap = shadow.querySelector('[data-pr="field-custom"]');
  const fieldInput = shadow.querySelector('[data-pr="field-input"]');
  const fieldConfirmBtn = shadow.querySelector('[data-pr="field-confirm-btn"]');

  // Fixed pills' aria-labels never change, so - unlike R/F, whose meaning flips on
  // every press - these are set once, here, rather than in every handler.
  for (const btn of fieldButtons) {
    btn.setAttribute('aria-label', PREFIX + 'field:pick:' + btn.dataset.fieldKey);
  }

  let fieldArmedKey = null;

  function updateFieldsVisibility() {
    const show = fState === 'body';
    fieldsRow.hidden = !show;
    if (!show) {
      fieldCustomWrap.hidden = true;
      fieldInput.value = '';
    }
  }

  // `instruction` mirrors pickParent/pickItem's cursor-label style. Re-entrant: called
  // both for a fresh pill press AND by onFieldPick's own error branches to retry the
  // SAME field - which is deliberate, since a retry at the same screen position is
  // exactly when parent-climb (see above) needs its state to survive.
  function armField(key) {
    fieldArmedKey = key;
    say('Field "' + key + '": click the value for this item.\n\nThis click will not affect the site.', null);
    openPicker('Click the ' + key.toUpperCase() + ' value', onFieldPick);
  }

  function onFieldPick(el) {
    if (!fItem) {
      say('Lost track of the current item - press F and re-pick it.', 'bad');
      fieldArmedKey = null;
      return;
    }
    if (el !== fItem && !fItem.contains(el)) {
      say('That is not inside the current item.\nClick something inside the highlighted row.\n\n(Clicking the very same spot again climbs to its parent, if you meant the wrapper around it.)', 'bad');
      armField(fieldArmedKey);
      return;
    }
    const rel = relativeCandidates(el, fItem);
    if (!rel.length) {
      say('Could not build a stable selector for that.\nTry a slightly different element, or click the same spot again to climb to its parent.', 'bad');
      armField(fieldArmedKey);
      return;
    }
    const key = fieldArmedKey;
    send({ type: 'field', key, rel, tag: el.tagName.toLowerCase(), text: textOf(el) });
    say('Captured "' + key + '": ' + JSON.stringify(textOf(el) || '').slice(0, 80), 'good');
    fieldArmedKey = null;
  }

  for (const btn of fieldButtons) {
    btn.addEventListener('click', () => {
      // A pill press is always a NEW arm (never a retry - retries call armField()
      // directly from onFieldPick), so this is where the climb chain starts fresh.
      resetClimb();
      armField(btn.dataset.fieldKey);
    });
  }

  fieldAddBtn.addEventListener('click', () => {
    fieldCustomWrap.hidden = false;
    fieldInput.value = '';
    fieldConfirmBtn.setAttribute('aria-label', PREFIX + 'field:pick:');
    fieldConfirmBtn.disabled = true;
    fieldInput.focus();
  });

  // Sets the confirm button's aria-label as the user TYPES, not inside its own click
  // handler - the marker IS the accessible name Playwright reads off the button at the
  // moment it is clicked, so it has to already be correct before that click happens,
  // not mutated by the same event that fires it.
  fieldInput.addEventListener('input', () => {
    const label = fieldInput.value.trim();
    fieldConfirmBtn.setAttribute('aria-label', PREFIX + 'field:pick:' + label);
    fieldConfirmBtn.disabled = !label;
  });

  fieldConfirmBtn.addEventListener('click', () => {
    const label = fieldInput.value.trim();
    if (!label) return;
    fieldCustomWrap.hidden = true;
    resetClimb(); // a custom field's first pick is a new arm too
    armField(label);
  });

  // --- settings panel (Phase 3.4) -----------------------------------------------
  //
  // Mounted in the page's light DOM (document.documentElement), not the overlay's
  // shadow root - a transformed ancestor (the toolbar host uses `transform` for its
  // positioning) becomes the containing block for `position:fixed` descendants, which
  // would land the panel off-screen. Same reasoning as the toast layer above.
  //
  // Built and appended EAGERLY (right here, not lazily on first gear-button click):
  // unlike the toast layer, which only needs to exist when there is something to say,
  // this panel's presence-but-hidden state is itself observable (tests, and any real
  // user peeking at devtools) from the moment the page loads. Lazily creating it left
  // a window where `[data-pr="settings-panel"]` simply did not exist yet.
  //
  // Each radio's aria-label IS its marker (`playright:ui:position:<value>` /
  // `playright:ui:orientation:<value>`), exactly like the R/F buttons and field pills
  // above - not the human-readable "Top-Left" text, which stays in the <span> as the
  // visible (but not accessible-name) label. That is what lets ir.js recognise and
  // drop the click via the existing `marker.kind === 'ui'` no-op - the actual element
  // the user (or Playwright) clicks carries the marker directly, so there is no need
  // for - and no leaked duplicate from - a second synthetic marker click.
  let settingsPanel = null;

  function initSettingsPanel() {
    ensureChromeStyle();
    if (settingsPanel) return;

    settingsPanel = document.createElement('div');
    settingsPanel.className = 'pr-settings-panel';
    settingsPanel.setAttribute('data-pr', 'settings-panel');
    settingsPanel.setAttribute('data-playright-chrome', '');
    settingsPanel.hidden = true;

    settingsPanel.innerHTML = `
      <div class="pr-settings-header">
        <div class="pr-settings-title">Position</div>
      </div>
      <div class="pr-settings-group">
        <label class="pr-settings-radio">
          <input type="radio" name="position" value="top-right" data-pr="pos-top-right" aria-label="${PREFIX}ui:position:top-right" />
          <span>Top-Right</span>
        </label>
        <label class="pr-settings-radio">
          <input type="radio" name="position" value="top-left" data-pr="pos-top-left" aria-label="${PREFIX}ui:position:top-left" />
          <span>Top-Left</span>
        </label>
        <label class="pr-settings-radio">
          <input type="radio" name="position" value="bottom-right" data-pr="pos-bottom-right" aria-label="${PREFIX}ui:position:bottom-right" />
          <span>Bottom-Right</span>
        </label>
        <label class="pr-settings-radio">
          <input type="radio" name="position" value="bottom-left" data-pr="pos-bottom-left" aria-label="${PREFIX}ui:position:bottom-left" />
          <span>Bottom-Left</span>
        </label>
      </div>
      <div class="pr-settings-header">
        <div class="pr-settings-title">Orientation</div>
      </div>
      <div class="pr-settings-group">
        <label class="pr-settings-radio">
          <input type="radio" name="orientation" value="vertical" data-pr="orient-vertical" aria-label="${PREFIX}ui:orientation:vertical" />
          <span>Vertical</span>
        </label>
        <label class="pr-settings-radio">
          <input type="radio" name="orientation" value="horizontal" data-pr="orient-horizontal" aria-label="${PREFIX}ui:orientation:horizontal" />
          <span>Horizontal</span>
        </label>
      </div>
    `;
    document.documentElement.appendChild(settingsPanel);

    // Set default values
    settingsPanel.querySelector('[data-pr="pos-top-right"]').checked = true;
    settingsPanel.querySelector('[data-pr="orient-vertical"]').checked = true;

    // Wire up position and orientation change handlers. The `change` event fires on
    // the SAME element whose aria-label is the marker, so Playwright's recorder
    // already captured the right accessible name before this handler even runs.
    for (const radio of settingsPanel.querySelectorAll('input[name="position"]')) {
      radio.addEventListener('change', (e) => applyPosition(e.target.value));
    }

    for (const radio of settingsPanel.querySelectorAll('input[name="orientation"]')) {
      radio.addEventListener('change', (e) => applyOrientation(e.target.value));
    }
  }

  function toggleSettingsPanel() {
    if (!settingsPanel) initSettingsPanel();
    settingsPanel.hidden = !settingsPanel.hidden;
  }

  function applyPosition(position) {
    const positions = {
      'top-right': { top: '12px', right: '12px', bottom: 'auto', left: 'auto', transform: 'none' },
      'top-left': { top: '12px', left: '12px', bottom: 'auto', right: 'auto', transform: 'none' },
      'bottom-right': { bottom: '12px', right: '12px', top: 'auto', left: 'auto', transform: 'none' },
      'bottom-left': { bottom: '12px', left: '12px', top: 'auto', right: 'auto', transform: 'none' },
    };

    if (positions[position]) {
      const styles = positions[position];
      host.style.top = styles.top;
      host.style.right = styles.right;
      host.style.bottom = styles.bottom;
      host.style.left = styles.left;
      host.style.transform = styles.transform;
    }
  }

  function applyOrientation(orientation) {
    if (orientation === 'horizontal') {
      host.style.flexDirection = 'row';
    } else {
      host.style.flexDirection = 'column';
    }
  }

  settingsBtn.addEventListener('click', () => {
    toggleSettingsPanel();
  });

  // --- mount ------------------------------------------------------------------

  const mount = () => {
    if (!document.body) return;
    if (!document.getElementById(OVERLAY_ID)) document.body.appendChild(host);
    // Built (hidden) here rather than deferred to the first gear-button click.
    // installOverlay() itself runs via addInitScript BEFORE document.documentElement
    // exists (confirmed: appendChild there throws "Cannot read properties of null"),
    // which is exactly why mount() itself is deferred to DOMContentLoaded below - so
    // this piggybacks on that same readiness gate rather than adding a second one.
    // `[data-pr="settings-panel"]` must be findable-but-hidden as soon as
    // window.__playright exists, not only after the gear button is first clicked.
    initSettingsPanel();
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
      if (state.rOpen) {
        rOpen = true;
        rBtn.setAttribute('aria-label', PREFIX + 'R:end');
        rBtn.title = TITLE_R.open;
        paint(rBtn, true);
      }
      if (state.fOpen) {
        // The item element is gone with the old document, so per-item scope detection
        // cannot continue across a navigation; Node is told and falls back to page scope.
        fBtn.setAttribute('aria-label', PREFIX + 'F:close');
        fBtn.title = TITLE_F.bodyDetached;
        paint(fBtn, true);
        fState = 'bodyDetached';
        say('Still inside the per-item block.\nSteps here apply to the page (not to one item).\nPress F when done.', null);
      }
      updateOpenStrip();
      // fItem does not survive a navigation even when fOpen does (see above) - fields
      // stay hidden in bodyDetached the same as any other non-'body' state.
      updateFieldsVisibility();
    },

    // Diagnostic exposed purely for testing the parent-climb mechanism (see
    // climbFrom/climbPeek above) without needing to drive a full F or field pick
    // session end to end. Mirrors exactly what the picker's own click handler does at
    // a given viewport point, using the SAME climb state - so this exercises the real
    // production code path, not a parallel copy of it.
    __debugClimbClick(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const effective = climbFrom(el);
      return {
        tag: effective.tagName.toLowerCase(),
        id: effective.id || null,
        depth: climbDepth,
      };
    },
    __debugClimbReset() {
      resetClimb();
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
