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

  // The aria-label IS the accessible name, which is what Playwright's own selector
  // generator keys a role-based locator off - so a press of this button is recorded
  // as internal:role=button[name="playright:R:start"i]. That is what lets the marker
  // ride in-band, at an exact stream position, with no cross-channel correlation. Set
  // here at mount time (mirroring the old makeButton()'s initial label) and again on
  // every state change below, so the press just recorded always carries the meaning it
  // actually had.
  rBtn.setAttribute('aria-label', PREFIX + 'R:start');
  fBtn.setAttribute('aria-label', PREFIX + 'F:arm');

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
        + 'font-weight:600;padding:3px 6px;border-radius:4px;white-space:nowrap;display:none;}';
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

  const mount = () => {
    if (!document.body) return;
    if (!document.getElementById(OVERLAY_ID)) document.body.appendChild(host);
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
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
