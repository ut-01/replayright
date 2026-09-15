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
      + '.pr-pick-box{position:fixed;pointer-events:none;box-sizing:border-box;display:none;'
        + 'border:2px solid #ff3366;background:rgba(255,51,102,.1);border-radius:2px;}'
      + '.pr-level-panel{position:fixed;box-sizing:border-box;max-width:min(460px,calc(100vw - 16px));'
        + 'padding:10px 12px;border-radius:8px;background:rgba(17,17,17,.96);color:#fff;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:auto;cursor:default;text-align:left;'
        + 'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
      + '.pr-level-panel[hidden]{display:none;}'
      + '.pr-level-panel button{all:unset;box-sizing:border-box;cursor:pointer;border-radius:4px;'
        + 'font:inherit;color:#fff;}'
      + '.pr-level-panel button:focus-visible{outline:2px solid #0a84ff;outline-offset:1px;}'
      + '.pr-level-panel button:disabled{opacity:.35;cursor:default;}'
      // `all:unset` above cancels the `[hidden]` UA rule's display:none (author
      // specificity wins over the UA stylesheet) - restore it explicitly so a hidden
      // button (e.g. Preview, on stages with no previewDetails()) actually disappears.
      + '.pr-level-panel button[hidden]{display:none;}'
      + '.pr-level-reason{color:rgba(255,255,255,.75);margin-bottom:6px;}'
      + '.pr-level-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;margin-bottom:8px;'
        + 'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;}'
      + '.pr-level-crumb{padding:1px 5px;background:rgba(255,255,255,.08);}'
      + '.pr-level-crumb:hover{background:rgba(255,255,255,.18);}'
      + '.pr-level-crumb.is-current{background:#ff3366;font-weight:600;}'
      + '.pr-level-sep{color:rgba(255,255,255,.4);}'
      + '.pr-level-actions{display:flex;align-items:center;gap:6px;}'
      + '.pr-level-actions button{padding:4px 9px;background:rgba(255,255,255,.12);}'
      + '.pr-level-actions button:not(:disabled):hover{background:rgba(255,255,255,.22);}'
      + '.pr-level-actions .pr-level-use{background:#34c759;color:#000;font-weight:600;}'
      + '.pr-level-actions .pr-level-use:not(:disabled):hover{background:#5ad67d;}'
      + '.pr-level-spacer{flex:1;}'
      + '.pr-level-info{margin-top:8px;word-break:break-word;}'
      + '.pr-level-info--good{color:#8ef0a8;}'
      + '.pr-level-info--warn{color:#ffd60a;}'
      + '.pr-level-info--bad{color:#ff8a80;}'
      + '.pr-level-preview-detail{margin-top:8px;padding:8px;border-radius:6px;'
        + 'background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);white-space:pre-wrap;'
        + 'word-break:break-word;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;}'
      + '.pr-level-preview-detail[hidden]{display:none;}'
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
  // from. Its children - the cursor-following instruction label, the tag/count hover
  // badge and the highlight box - ride along on the picker's lifecycle
  // (openPicker/closePicker), so there is nothing extra to leak on cancel.
  //
  // The highlight is a separate positioned box, not an outline painted onto the site's
  // own element: an outline/background on a <tr> is routinely invisible (the <td>s paint
  // over it), and rows are exactly the case the level stepper below exists for. It also
  // means picking never mutates the recorded page's inline styles.
  let picker = null;
  let cursorLabel = null;
  let hoverBadge = null;
  let hoverBox = null;
  let pickStage = null;
  let lastPointer = null;
  let hoverRaw = null;
  let hoverShown = null;
  let hoverHint = '';

  // --- level stepper: reaching elements that cannot be clicked directly ----------
  //
  // elementFromPoint() only ever returns the INNERMOST element under the cursor, so an
  // element completely tiled by its children - a <tr> under its <td>s, a gapless <ul>
  // under its <li>s - has no pixel of its own to click. Container, item and field picks
  // all share this picker, and all three can hit that.
  //
  // So a click normally commits exactly as it always has, but FREEZES instead - opening
  // a stepper panel over the frozen element - when help is actually needed:
  //   - the clicked element's parent (within the stage's bounds) cannot be hit directly
  //     (selectors.js#isHitReachable), i.e. there is a level the user physically cannot
  //     click; or
  //   - the stage's own validation would reject/doubt the pick (stage.needsHelp); or
  //   - the user Shift-clicked, which always opens it.
  // Padded, well-formed markup therefore still commits on one click, byte-for-byte as
  // before. In the stepper the user walks the linear ancestor chain (selectors.js#
  // levelChain): down stops at the element actually clicked, up at the stage's bound
  // (<body> for a container, the child of the container for an item, the item itself
  // for a field), with a live validation line for the level currently selected.
  //
  // Every stepper control is a real in-page button whose aria-label is a
  // `playright:ui:level:*` marker, so the click Playwright records against it is dropped
  // by ir.js's existing `marker.kind === 'ui'` no-op - and the panel carries
  // data-playright-chrome so observe() never mistakes it for a per-item body event.
  // Keyboard (Arrow keys / Enter / Escape) is handled on a WINDOW capture listener that
  // stops the event there: Playwright's recorder listens on `document` (capture), which
  // comes later on the propagation path, so it never sees the key and never records a
  // stray `press` step.
  let levelPanel = null;
  let frozen = null; // { raw, chain, idx, suggested, reason }

  // Every stage: { top(raw) -> bound element or null, preview(raw) -> element a click
  // would select, suggest(chain, raw) -> starting index, needsHelp(raw) -> bool,
  // hiddenMatters(raw, chain) -> whether an unclickable parent is worth stopping for
  // (a flush page wrapper above a perfectly good list is not),
  // describe(el, ctx) -> { tone, text, canUse }, commit(el, ctx) }. `ctx` is
  // { raw, suggested }; a commit with el === ctx.suggested means "exactly what a plain
  // single click would have picked".

  function hitTestThroughPicker(fn) {
    if (!picker) return fn();
    picker.style.pointerEvents = 'none';
    try { return fn(); } finally { picker.style.pointerEvents = 'auto'; }
  }

  function under(x, y) {
    return hitTestThroughPicker(() => document.elementFromPoint(x, y));
  }

  function parentHidden(chain) {
    if (!chain || chain.length < 2) return false;
    return !hitTestThroughPicker(() => isHitReachable(chain[1], (x, y) => document.elementFromPoint(x, y)));
  }

  function placeBox(el) {
    if (!hoverBox) return null;
    const rect = el ? el.getBoundingClientRect() : null;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hoverBox.style.display = 'none';
      return rect;
    }
    hoverBox.style.display = 'block';
    hoverBox.style.left = rect.left + 'px';
    hoverBox.style.top = rect.top + 'px';
    hoverBox.style.width = rect.width + 'px';
    hoverBox.style.height = rect.height + 'px';
    return rect;
  }

  function highlight(el, hint) {
    const rect = placeBox(el);
    if (!hoverBadge) return;
    if (!el) { hoverBadge.style.display = 'none'; return; }
    const info = siblingMatchInfo(el);
    const noBox = !rect || (rect.width === 0 && rect.height === 0);
    hoverBadge.textContent = info.tag.toUpperCase() + ' (' + info.matched + ' of ' + info.total + ')'
      + (noBox ? ' · no box' : '') + (hint ? ' · ' + hint : '');
    hoverBadge.style.display = 'block';
    const left = rect && !noBox ? rect.left : (lastPointer ? lastPointer.x : 4);
    const top = rect && !noBox ? rect.top : (lastPointer ? lastPointer.y : 26);
    hoverBadge.style.left = Math.max(4, left) + 'px';
    hoverBadge.style.top = Math.max(4, top - 22) + 'px';
  }

  function hoverAt(x, y) {
    if (!picker || frozen || !pickStage) return;
    const raw = under(x, y);
    if (!raw || isOurs(raw)) { hoverRaw = null; hoverShown = null; highlight(null); return; }
    // The preview (chooseItem for an item pick) and the hidden-parent probe are only
    // worth recomputing when the cursor reaches a different element.
    if (raw !== hoverRaw) {
      hoverRaw = raw;
      hoverShown = pickStage.preview(raw) || raw;
      const top = pickStage.top(raw);
      const chain = top ? levelChain(raw, top) : null;
      hoverHint = chain && pickStage.hiddenMatters(raw, chain) && parentHidden(chain) ? '⇡ ' + levelLabel(chain[1]) + ' hidden, click to choose level' : '';
    }
    highlight(hoverShown, hoverHint);
  }

  function ensureLevelPanel() {
    ensureChromeStyle();
    if (levelPanel) return;
    levelPanel = document.createElement('div');
    levelPanel.className = 'pr-level-panel';
    levelPanel.setAttribute('data-pr', 'level-panel');
    levelPanel.setAttribute('data-playright-chrome', '');
    levelPanel.hidden = true;
    levelPanel.innerHTML = '<div class="pr-level-reason" data-pr="level-reason"></div>'
      + '<div class="pr-level-crumbs" data-pr="level-crumbs"></div>'
      + '<div class="pr-level-actions">'
      + '<button type="button" data-pr="level-up" aria-label="' + PREFIX + 'ui:level:up" title="Select the parent (Arrow Up)"><span aria-hidden="true">▲ Parent</span></button>'
      + '<button type="button" data-pr="level-down" aria-label="' + PREFIX + 'ui:level:down" title="Select the child, back towards what you clicked (Arrow Down)"><span aria-hidden="true">▼ Child</span></button>'
      + '<button type="button" data-pr="level-preview" aria-label="' + PREFIX + 'ui:level:preview" title="Show the full ranked candidate breakdown (same as window.__playright.pickPreview)"><span aria-hidden="true">🔍 Preview</span></button>'
      + '<span class="pr-level-spacer"></span>'
      + '<button type="button" data-pr="level-use" class="pr-level-use" aria-label="' + PREFIX + 'ui:level:use" title="Use this element (Enter)"><span aria-hidden="true">✓ Use</span></button>'
      + '<button type="button" data-pr="level-cancel" aria-label="' + PREFIX + 'ui:level:cancel" title="Back to picking (Escape)"><span aria-hidden="true">✕</span></button>'
      + '</div>'
      + '<div class="pr-level-info" data-pr="level-info"></div>'
      + '<div class="pr-level-preview-detail" data-pr="level-preview-detail" hidden></div>';
    applyPanelZ(levelPanel);
    document.documentElement.appendChild(levelPanel);

    levelPanel.querySelector('[data-pr="level-up"]').addEventListener('click', () => stepLevel(1));
    levelPanel.querySelector('[data-pr="level-down"]').addEventListener('click', () => stepLevel(-1));
    levelPanel.querySelector('[data-pr="level-use"]').addEventListener('click', () => useLevel());
    levelPanel.querySelector('[data-pr="level-cancel"]').addEventListener('click', () => unfreeze());
    levelPanel.querySelector('[data-pr="level-preview"]').addEventListener('click', () => togglePreviewDetail());
    levelPanel.querySelector('[data-pr="level-crumbs"]').addEventListener('click', (e) => {
      const crumb = e.target.closest && e.target.closest('[data-level-idx]');
      if (!crumb || !frozen) return;
      frozen.idx = Number(crumb.getAttribute('data-level-idx'));
      renderLevel();
    });
  }

  // Expands/collapses the full ranked-candidate breakdown for the level currently
  // selected in the stepper - the same data window.__playright.pickPreview() computes
  // (ranked item-selector candidates, occurrence count, item tag), surfaced here as a
  // visible button instead of requiring a devtools console round-trip. Only stages that
  // define previewDetails() show the button at all (currently: the item-pick stage,
  // since that is the one chooseItem() decision worth double-checking before committing).
  function togglePreviewDetail() {
    if (!frozen || !pickStage?.previewDetails) return;
    const detailEl = levelPanel.querySelector('[data-pr="level-preview-detail"]');
    if (!detailEl.hidden) { detailEl.hidden = true; return; }

    const el = frozen.chain[frozen.idx];
    const details = el.isConnected
      ? pickStage.previewDetails(el, { raw: frozen.raw, suggested: frozen.suggested })
      : null;
    if (!details) {
      detailEl.textContent = 'No preview available for this level.';
    } else {
      detailEl.textContent = 'Ranked candidates: ' + details.candidates.join('  >  ')
        + '\nOccurrence count (raw click): ' + details.occurrenceCount
        + '\nItem tag: <' + details.itemTag + '>';
    }
    detailEl.hidden = false;
    positionLevelPanel(el.isConnected ? el : frozen.raw);
  }

  function applyPanelZ(el) {
    el.style.zIndex = zTier('--pr-z-pause', '2147483646');
  }

  function currentLevelInfo() {
    const el = frozen.chain[frozen.idx];
    if (!el.isConnected || !frozen.raw.isConnected) {
      return { tone: 'bad', text: 'The page changed under this selection. Click the element again.', canUse: false };
    }
    return pickStage.describe(el, { raw: frozen.raw, suggested: frozen.suggested });
  }

  function renderLevel() {
    if (!frozen || !levelPanel) return;
    const { chain, idx } = frozen;
    const el = chain[idx];

    levelPanel.querySelector('[data-pr="level-reason"]').textContent = frozen.reason;

    // Outermost on the left, like a path: body › table › tbody › [tr] › td. Long chains
    // show a window around the current level so the panel stays one line.
    const crumbs = levelPanel.querySelector('[data-pr="level-crumbs"]');
    crumbs.textContent = '';
    const hi = Math.min(chain.length - 1, Math.max(idx + 3, 6));
    const lo = Math.max(0, Math.min(idx - 3, chain.length - 7));
    const addSep = (text) => {
      const sep = document.createElement('span');
      sep.className = 'pr-level-sep';
      sep.textContent = text;
      crumbs.appendChild(sep);
    };
    if (hi < chain.length - 1) addSep('… ›');
    for (let i = hi; i >= lo; i -= 1) {
      const crumb = document.createElement('button');
      crumb.type = 'button';
      crumb.className = 'pr-level-crumb' + (i === idx ? ' is-current' : '');
      crumb.setAttribute('data-level-idx', String(i));
      crumb.setAttribute('aria-label', PREFIX + 'ui:level:at:' + i);
      crumb.title = i === 0 ? 'What you clicked' : i + ' level(s) above what you clicked';
      const text = document.createElement('span');
      text.setAttribute('aria-hidden', 'true');
      text.textContent = levelLabel(chain[i]);
      crumb.appendChild(text);
      crumbs.appendChild(crumb);
      if (i > lo) addSep('›');
    }
    if (lo > 0) addSep('› …');

    const info = currentLevelInfo();
    const infoEl = levelPanel.querySelector('[data-pr="level-info"]');
    infoEl.textContent = (info.tone === 'good' ? '✓ ' : info.tone === 'bad' ? '✕ ' : info.tone === 'warn' ? '⚠ ' : '• ') + info.text;
    infoEl.className = 'pr-level-info pr-level-info--' + info.tone;

    levelPanel.querySelector('[data-pr="level-up"]').disabled = idx >= chain.length - 1;
    levelPanel.querySelector('[data-pr="level-down"]').disabled = idx <= 0;
    levelPanel.querySelector('[data-pr="level-use"]').disabled = !info.canUse;

    // Only stages that can compute the ranked-candidate breakdown (currently the
    // item-pick stage) show the button at all - hidden, not just disabled, so it
    // doesn't imply a feature the container/field stages don't have.
    const previewBtn = levelPanel.querySelector('[data-pr="level-preview"]');
    previewBtn.hidden = !pickStage?.previewDetails;
    // Stale from a level the user has since moved away from - collapse it rather than
    // showing detail for the wrong element.
    levelPanel.querySelector('[data-pr="level-preview-detail"]').hidden = true;

    highlight(el.isConnected ? el : null, idx === 0 ? 'clicked' : '▲' + idx);
    levelPanel.hidden = false;
    positionLevelPanel(el);
  }

  // Below the selection when there is room, else above it, clamped into the viewport.
  function positionLevelPanel(el) {
    const margin = 8;
    const panelRect = levelPanel.getBoundingClientRect();
    const rect = el.isConnected ? el.getBoundingClientRect() : null;
    let left = rect ? rect.left : margin;
    let top = rect ? rect.bottom + margin : margin;
    if (rect && top + panelRect.height > window.innerHeight - margin) top = rect.top - panelRect.height - margin;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - panelRect.width - margin));
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - panelRect.height - margin));
    levelPanel.style.left = left + 'px';
    levelPanel.style.top = top + 'px';
  }

  function freeze(raw, chain, idx, reason) {
    ensureLevelPanel();
    frozen = { raw, chain, idx, suggested: chain[idx], reason };
    if (cursorLabel) cursorLabel.style.display = 'none';
    renderLevel();
  }

  function unfreeze() {
    frozen = null;
    if (levelPanel) levelPanel.hidden = true;
    hoverRaw = null;
    highlight(null);
    if (lastPointer) hoverAt(lastPointer.x, lastPointer.y);
  }

  function stepLevel(delta) {
    if (!frozen) return;
    const next = frozen.idx + delta;
    if (next < 0 || next >= frozen.chain.length) return;
    frozen.idx = next;
    renderLevel();
  }

  function useLevel() {
    if (!frozen || !pickStage) return;
    const info = currentLevelInfo();
    if (!info.canUse) { renderLevel(); return; }
    const stage = pickStage;
    const el = frozen.chain[frozen.idx];
    const ctx = { raw: frozen.raw, suggested: frozen.suggested };
    closePicker();
    stage.commit(el, ctx);
  }

  const swallowedKeys = new Set();
  window.addEventListener('keydown', (e) => {
    if (!frozen) return;
    const actions = { ArrowUp: () => stepLevel(1), ArrowDown: () => stepLevel(-1), Enter: useLevel, Escape: unfreeze };
    const act = actions[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowedKeys.add(e.key);
    act();
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!swallowedKeys.delete(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  function onPickerClick(raw, force) {
    const stage = pickStage;
    const top = stage.top(raw);
    const chain = top ? levelChain(raw, top) : null;
    // Outside the stage's bounds: the stage's own commit path owns the error message.
    if (!chain) { closePicker(); stage.commit(raw, { raw, suggested: raw }); return; }

    const hidden = stage.hiddenMatters(raw, chain) && parentHidden(chain);
    const doubtful = stage.needsHelp(raw);
    if (!force && !hidden && !doubtful) {
      closePicker();
      stage.commit(raw, { raw, suggested: raw });
      return;
    }

    const reason = hidden
      ? levelLabel(chain[1]) + ' sits under what you clicked and cannot be clicked directly. Step up to reach it.'
      : doubtful
        ? 'That pick needs a closer look. Step up or down, then Use.'
        : 'Choose the level to use.';
    freeze(raw, chain, Math.min(chain.length - 1, Math.max(0, stage.suggest(chain, raw))), reason);
  }

  let viewportRaf = 0;
  function onViewportChange() {
    if (viewportRaf) return;
    viewportRaf = requestAnimationFrame(() => {
      viewportRaf = 0;
      if (frozen) renderLevel();
      else if (lastPointer) { hoverRaw = null; hoverAt(lastPointer.x, lastPointer.y); }
    });
  }

  function closePicker() {
    frozen = null;
    if (levelPanel) levelPanel.hidden = true;
    if (picker) { picker.remove(); picker = null; }
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    cursorLabel = null;
    hoverBadge = null;
    hoverBox = null;
    hoverRaw = null;
    hoverShown = null;
    pickStage = null;
  }

  // `instruction` is short, imperative cursor-label copy ("Click the CONTAINER") -
  // always supplied by the F state machine below (pickParent/pickItem), never
  // hardcoded here, so it always names the actual next step rather than a generic
  // "pick something". `stage` is the per-pick policy described above.
  function openPicker(instruction, stage) {
    closePicker();
    ensureChromeStyle();
    pickStage = stage;

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

    hoverBox = document.createElement('div');
    hoverBox.className = 'pr-pick-box';
    picker.appendChild(hoverBox);

    cursorLabel = document.createElement('div');
    cursorLabel.className = 'pr-cursor-label';
    cursorLabel.textContent = instruction;
    picker.appendChild(cursorLabel);

    hoverBadge = document.createElement('div');
    hoverBadge.className = 'pr-hover-badge';
    picker.appendChild(hoverBadge);

    picker.addEventListener('mousemove', (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      if (frozen) return;
      cursorLabel.style.display = 'block';
      cursorLabel.style.left = e.clientX + 'px';
      cursorLabel.style.top = e.clientY + 'px';
      hoverAt(e.clientX, e.clientY);
    });

    picker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastPointer = { x: e.clientX, y: e.clientY };
      const raw = under(e.clientX, e.clientY);
      if (!raw || isOurs(raw)) return;
      // A click while frozen is a fresh pick at the new point, under the normal rules.
      if (frozen) { frozen = null; levelPanel.hidden = true; }
      onPickerClick(raw, e.shiftKey);
    }, true);

    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
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
    const onParent = (parentEl) => {
      const parents = parentCandidates(parentEl);
      if (!parents.length) {
        say('Could not build a stable selector for that container.\nTry clicking a slightly different element (often the <ul> or the grid wrapper).', 'bad');
        pickParent();
        return;
      }
      pickItem(parentEl, parents);
    };
    openPicker('Click the CONTAINER', {
      top: () => document.body,
      preview: (raw) => raw,
      // The level with the most same-tag children is the likeliest list (ties: the
      // innermost), e.g. <tbody> rather than the <tr> when a <td> was clicked.
      suggest: (chain) => {
        let best = 0;
        let bestCount = 1;
        chain.forEach((el, i) => {
          const { count } = repeatingChildren(el);
          if (count > bestCount) { best = i; bestCount = count; }
        });
        return best;
      },
      needsHelp: (raw) => !hasRepeatingDescendant(raw),
      // A flush parent only matters when it is a better list than what was clicked:
      // the <tr> behind a <td>, the gapless <ul> behind an <li> - not the layout
      // wrapper around a list that was clicked correctly.
      hiddenMatters: (raw, chain) => repeatingChildren(chain[1]).count > repeatingChildren(raw).count,
      describe: (el) => {
        const direct = repeatingChildren(el);
        if (direct.count >= 2) return { tone: 'good', text: direct.count + ' repeating <' + direct.tag + '> children', canUse: true };
        if (hasRepeatingDescendant(el)) return { tone: 'neutral', text: 'Repeating items are nested deeper inside this', canUse: true };
        return { tone: 'warn', text: 'Nothing repeats inside this. Step up to the list or grid.', canUse: true };
      },
      commit: (el) => onParent(el),
    });
  }

  function pickItem(parentEl, parents) {
    fState = 'item';
    fBtn.title = TITLE_F.item;
    updateOpenStrip();
    say('F, step 2 of 2:\nNow click ONE of the repeating items inside it (one card/row).\n\nThis click will not affect the site either.');
    // `opts.pinned` only comes from the level stepper, when the user chose a level other
    // than the one chooseItem() would have picked on its own.
    const onItem = (clicked, opts) => {
      if (!parentEl.contains(clicked)) {
        say('That element is not inside the container you picked.\nStarting over - click the container again.', 'bad');
        pickParent();
        return;
      }

      const chosen = chooseItem(clicked, parentEl, opts);
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
    };

    // What a level resolves to: the plain single-click result at the suggested level,
    // a pinned evaluation of exactly that element anywhere else.
    const resolveAt = (el, ctx) => (el === ctx.suggested
      ? chooseItem(ctx.raw, parentEl)
      : chooseItem(el, parentEl, { pinned: true }));

    let previewRaw = null;
    let previewChosen = null;
    const autoChoice = (raw) => {
      if (raw !== previewRaw) { previewRaw = raw; previewChosen = chooseItem(raw, parentEl); }
      return previewChosen;
    };

    openPicker('Click the ITEM', {
      // Up stops at the container's direct child on the clicked path - the container
      // itself can never be its own repeating item.
      top: (raw) => {
        if (raw === parentEl || !parentEl.contains(raw)) return null;
        let node = raw;
        while (node.parentElement !== parentEl) node = node.parentElement;
        return node;
      },
      // Outline what will ACTUALLY be picked (often an ancestor), not the raw hit.
      preview: (raw) => {
        if (!parentEl.contains(raw) || raw === parentEl) return raw;
        const chosen = autoChoice(raw);
        return chosen ? chosen.level : raw;
      },
      suggest: (chain, raw) => {
        const chosen = autoChoice(raw);
        const i = chosen ? chain.indexOf(chosen.level) : -1;
        return i >= 0 ? i : 0;
      },
      needsHelp: (raw) => {
        const chosen = autoChoice(raw);
        return !chosen || !chosen.exact;
      },
      // When chooseItem() already climbed above the clicked element, a flush parent of
      // that element is beside the point; only a pick stuck AT the clicked level (a
      // <td> standing in for its <tr>) needs the stepper.
      hiddenMatters: (raw, chain) => {
        const chosen = autoChoice(raw);
        return !chosen || chain.indexOf(chosen.level) <= 0;
      },
      describe: (el, ctx) => {
        const chosen = resolveAt(el, ctx);
        if (!chosen) return { tone: 'bad', text: 'This does not repeat inside the container in a way that can be addressed.', canUse: false };
        const via = chosen.count + ' items via ' + chosen.cands[0].selector;
        if (chosen.exact) return { tone: 'good', text: via, canUse: true };
        return { tone: 'warn', text: via + ', but what you clicked appears ' + chosen.occurrence.count + ' time(s)', canUse: true };
      },
      // The full breakdown behind describe()'s one-line summary - same fields
      // window.__playright.pickPreview() returns, computed from the live selection
      // instead of via querySelector'd strings against a saved snapshot. Backs the
      // level panel's "Preview" button (togglePreviewDetail above).
      previewDetails: (el, ctx) => {
        const chosen = resolveAt(el, ctx);
        if (!chosen) return null;
        return {
          candidates: chosen.cands.map((c) => c.selector),
          occurrenceCount: chosen.occurrence.count,
          itemTag: chosen.level.tagName.toLowerCase(),
        };
      },
      commit: (el, ctx) => (el === ctx.suggested ? onItem(ctx.raw) : onItem(el, { pinned: true })),
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

  // --- field extraction (Phase 3.2) --------------------------------------------
  //
  // No preset field names - this overlay has no idea whether the page it's recording
  // against is a job board, a product listing, or something else entirely, so "+ Field"
  // is the only entry point and the user always types the label that fits their own
  // page. One-shot arm -> pick -> capture, not a toggle: typing a label and confirming
  // arms picking for that field, the very next picker click captures it (out-of-band,
  // same as F's scope pick), and the toolbar falls straight back to idle - ready for the
  // next field - with no separate "close" gesture the way F needs one. That is also why
  // the marker only has a `pick` phase (`playright:field:pick:<key>`, see
  // generalize.js#parseMarker): there is nothing else to name.
  //
  // Only meaningful, and only shown, while an F body is open (fState === 'body') - a
  // field selector is relative to fItem, which does not exist otherwise.
  const fieldsRow = shadow.querySelector('[data-pr="fields"]');
  const fieldAddBtn = shadow.querySelector('[data-pr="field-add-btn"]');
  const fieldCustomWrap = shadow.querySelector('[data-pr="field-custom"]');
  const fieldInput = shadow.querySelector('[data-pr="field-input"]');
  const fieldConfirmBtn = shadow.querySelector('[data-pr="field-confirm-btn"]');

  // No-op markers (kind "field", phase anything but "pick" - see ir.js's field
  // handling) so these are recognized as overlay chrome and dropped, the same way
  // stepper/settings buttons are. Never change, so set once here rather than per-click.
  // The input needs one too, not just the buttons around it: typing into it commits a
  // real `fill` action (Playwright records the text box being filled, same as any real
  // form field), and isOverlayAction() keys off the marker prefix regardless of action
  // type - a plain `placeholder` is not an accessible NAME, so without this the fill
  // would leak into the recorded flow as a stray step.
  fieldAddBtn.setAttribute('aria-label', PREFIX + 'field:add');
  fieldInput.setAttribute('aria-label', PREFIX + 'field:input');

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
  // SAME field.
  function armField(key) {
    fieldArmedKey = key;
    say('Field "' + key + '": click the value for this item.\n\nThis click will not affect the site.', null);
    openPicker('Click the ' + key.toUpperCase() + ' value', {
      // Up stops at the item root itself (relative selector '').
      top: (raw) => (fItem && (raw === fItem || fItem.contains(raw)) ? fItem : null),
      preview: (raw) => raw,
      suggest: () => 0,
      needsHelp: (raw) => !relativeCandidates(raw, fItem).length,
      hiddenMatters: () => true,
      describe: (el) => {
        const rel = relativeCandidates(el, fItem);
        if (!rel.length) return { tone: 'bad', text: 'Not uniquely addressable inside the item. Step up.', canUse: false };
        const text = textOf(el);
        return { tone: 'good', text: (rel[0] || '(the item itself)') + (text ? '  →  ' + JSON.stringify(text) : ''), canUse: true };
      },
      commit: (el) => onFieldPick(el),
    });
  }

  function onFieldPick(el) {
    if (!fItem) {
      say('Lost track of the current item - press F and re-pick it.', 'bad');
      fieldArmedKey = null;
      return;
    }
    if (el !== fItem && !fItem.contains(el)) {
      say('That is not inside the current item.\nClick something inside the highlighted row.', 'bad');
      armField(fieldArmedKey);
      return;
    }
    const rel = relativeCandidates(el, fItem);
    if (!rel.length) {
      say('Could not build a stable selector for that.\nTry a slightly different element, or Shift-click to choose a parent level.', 'bad');
      armField(fieldArmedKey);
      return;
    }
    const key = fieldArmedKey;
    send({ type: 'field', key, rel, tag: el.tagName.toLowerCase(), text: textOf(el) });
    say('Captured "' + key + '": ' + JSON.stringify(textOf(el) || '').slice(0, 80), 'good');
    fieldArmedKey = null;
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

    // Diagnostic: the level stepper's current state, or null when it is not open. Read
    // by test/picker-level.test.js; tests still DRIVE the stepper through its real
    // buttons and keys, never through this.
    __debugLevelState() {
      if (!frozen) return null;
      return {
        labels: frozen.chain.map((el) => levelLabel(el)),
        idx: frozen.idx,
        current: levelLabel(frozen.chain[frozen.idx]),
        info: currentLevelInfo(),
      };
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
