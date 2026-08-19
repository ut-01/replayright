// ir.js
//
// Turns the raw recording into flow.json.
//
// Structure comes entirely from IN-BAND markers: pressing R or F is itself a recorded
// action, so its position in the stream is exact by construction. A stack turns those
// markers into nested blocks, which is what makes `F` inside `R` - the shape every real
// paginated careers site has - work at all. The previous implementation walked a flat
// list and silently swallowed the inner block.
//
// Payloads (which container, which item, which steps were per-item) come out-of-band
// from the overlay. That is safe here because the overlay enforces at most one F in
// flight, so payload streams cannot interleave; and each per-step pairing is
// cross-checked against the action's own accessible name before being trusted.
const { MARKER_PREFIX, REPEAT_DEFAULT_TIMES } = require('./constants');
const { isOverlayAction, parseMarker, nameFilterValue, rankItemCandidates } = require('./generalize');

// Actions describing the recording session's own tab management rather than anything
// to replay. `navigate` IS kept - it is how a flow gets to its start page and how any
// mid-flow navigation is reproduced.
const SESSION_ACTIONS = new Set(['openPage', 'closePage']);

function splitOverlayEvents(events) {
  const blocks = [];
  let current = null;
  for (const event of events) {
    if (event.type !== 'F') continue;
    if (event.phase === 'scope') {
      current = { scope: event, bodyEvents: [] };
      blocks.push(current);
    } else if (event.phase === 'bodyEvent') {
      if (current) current.bodyEvents.push(event);
    } else if (event.phase === 'cancel') {
      current = null;
    }
  }
  return blocks;
}

// Field picks (Phase 3.2) resolve to one outcome in one instant - the picker swallows
// the click, computes a relative selector against the current item, and sends it
// out-of-band right then. There is no arm/close pairing to reconstruct (unlike F's
// scope/bodyEvent split above), so a plain in-order queue is enough: each `field:pick:*`
// marker seen in the action stream claims the next entry here.
function splitFieldEvents(events) {
  return events
    .filter((event) => event.type === 'field')
    .map((event) => ({ rel: event.rel || [], tag: event.tag || null, text: event.text || null }));
}

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Does this overlay-observed event plausibly describe the same interaction as this
// recorded action? Compared on the accessible name / typed text, which both sides see.
function looksLikeSameTarget(event, action) {
  const eventText = norm(event.text);
  const actionText = norm(nameFilterValue(action.selector) || action.text || '');
  if (!eventText || !actionText) return true; // nothing to disagree about
  return eventText.includes(actionText) || actionText.includes(eventText);
}

// Order-based pairing WITH a consistency gate, plus a small lookahead so one missed or
// extra observation self-heals instead of misaligning everything after it. This is the
// part the old blind FIFO got wrong: it would happily hand an unrelated action the
// scope info belonging to a different one.
function takeBodyEvent(queue, action, warnings) {
  for (let offset = 0; offset < Math.min(3, queue.length); offset += 1) {
    if (looksLikeSameTarget(queue[offset], action)) {
      const skipped = queue.splice(0, offset);
      if (skipped.length) {
        warnings.push({
          type: 'scope-realigned',
          message: `dropped ${skipped.length} unmatched in-page observation(s) before "${nameFilterValue(action.selector) || action.name}"`,
        });
      }
      return queue.shift();
    }
  }
  if (queue.length) {
    warnings.push({
      type: 'scope-uncertain',
      message: `could not match "${nameFilterValue(action.selector) || action.name}" to an in-page observation; treating it as a page-level step`,
    });
  }
  return null;
}

function actionSelectors(action) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  push(action.selector);
  for (const fallback of action.__fallbacks || []) push(fallback);
  return out;
}

function buildActionStep(action) {
  return {
    kind: 'action',
    scope: 'page',
    selectors: actionSelectors(action),
    action: cleanAction(action),
  };
}

// Keep only what replay needs, plus the aria snapshot for failure reports. Dropping
// `ariaSnapshot` from the action itself (it is ~1KB per action) keeps flow.json
// readable; it is preserved once per step instead.
function cleanAction(action) {
  const out = { name: action.name };
  for (const key of ['url', 'text', 'key', 'clickCount', 'button', 'options', 'modifiers']) {
    if (action[key] !== undefined) out[key] = action[key];
  }
  return out;
}

// Marks the steps of a foreach body that ran on a job's DETAIL page rather than on the
// list, using the URL each action was recorded at.
//
// This is what makes "open the detail in a new tab" possible. Clicking a job in the same
// tab destroys the list - the item locators, the container, and any "load more" progress
// go with it, which is exactly how a run ended up reporting "item list no longer
// resolves". If instead the detail is opened in its own tab, the list page is never
// touched at all and the loop can just keep going.
//
// The click that leads off the detail page is tagged `opensDetail`, and the step that
// navigates back to the list is tagged `returnsToList` - in new-tab mode there is nothing
// to go back from, so that step becomes "close the tab" instead of a click.
function markDetailSteps(block, listUrl, urlAfterBlock, warnings) {
  const body = block.body;
  const firstDetail = body.findIndex((s) => s.__url && listUrl && s.__url !== listUrl);
  if (firstDetail <= 0) {
    for (const step of body) delete step.__url;
    return;
  }

  const opener = body[firstDetail - 1];
  opener.opensDetail = true;

  let lastDetail = firstDetail;
  for (let i = firstDetail; i < body.length; i += 1) {
    if (body[i].__url === listUrl) break;
    body[i].scope = 'detail';
    delete body[i].relativeSelectors;
    lastDetail = i;
  }

  // If the recording came back to the list, the last detail step is what did it.
  if (urlAfterBlock === listUrl) body[lastDetail].returnsToList = true;
  else {
    warnings.push({
      type: 'foreach-does-not-return',
      message: 'the per-item steps navigate to a detail page and never come back to the list; replay will open each detail in its own tab',
    });
  }

  for (const step of body) delete step.__url;
}

function finalizeForeach(block, warnings) {
  // The most robust item selector available comes from Playwright's own generator: if
  // the first per-item step targets the item itself, its recorded selector with the
  // accessible-name filter stripped matches every sibling. The structural selectors the
  // overlay verified by counting are the fallbacks behind it.
  let recordedItemSelector = null;
  const first = block.body.find((s) => s.kind === 'action' && s.scope === 'item');
  if (first && (first.relativeSelectors || []).includes('') && first.__absoluteSelector) {
    recordedItemSelector = first.__absoluteSelector;
  }

  const itemSelectors = rankItemCandidates({ recordedItemSelector, structural: block.__structuralItems });
  for (const step of block.body) delete step.__absoluteSelector;

  // A foreach that only reads fields (no per-item click/fill) is a legitimate shape -
  // a pure "scrape this listing" flow with nothing to act on - so an `extract` step
  // counts as "does something per item" here alongside an item-scoped action.
  if (!block.body.some((s) => s.scope === 'item' || s.kind === 'extract')) {
    // With more than one item, a foreach whose body never touches the item would do the
    // same thing N times. Almost always a scope-detection failure rather than intent.
    warnings.push({
      type: 'foreach-without-item-steps',
      message: `a foreach has no per-item steps - every iteration would repeat identical page-level actions. Re-record this block.`,
    });
  }

  return {
    kind: 'foreach',
    parentSelectors: block.__parents,
    itemSelectors,
    expectedCount: block.__expectedCount,
    body: block.body,
  };
}

function finalizeRepeat(block) {
  const direct = block.body;

  // The action that advances the loop is the LAST step in the body, and it must be a
  // CLICK - pagination is always a click. Naming it lets replay exit cleanly the moment
  // there is nothing left to advance to, instead of burning the remaining iterations.
  //
  // Both constraints matter. A smoke test on a real careers page whose repeat block ended
  // in a `fill` had that textbox nominated as the advance control, which would have made
  // replay silently SKIP a genuine step the moment the field was disabled. Anything other
  // than a trailing click simply gets no early exit, and `times` remains the bound.
  const last = direct[direct.length - 1];
  const advance = last && last.kind === 'action' && last.scope === 'page' && last.action?.name === 'click'
    ? last
    : null;
  const inner = direct.find((s) => s.kind === 'foreach');

  const out = { kind: 'repeat', times: REPEAT_DEFAULT_TIMES, body: direct };
  if (advance) out.untilGone = advance.selectors[0];
  // The list content must actually change before the next iteration, or an SPA that
  // swaps its list in place would be re-scraped as if it were a new page.
  if (inner) out.settle = { selector: inner.parentSelectors[0] };
  return out;
}

function buildFlow({ siteId, startUrl, actionLog, overlayEvents }) {
  const warnings = [];
  const scopeBlocks = splitOverlayEvents(overlayEvents);
  let nextScopeBlock = 0;
  const fieldEvents = splitFieldEvents(overlayEvents);
  let nextFieldEvent = 0;

  const rootSteps = [];
  const stack = [{ kind: 'root', body: rootSteps }];
  const top = () => stack[stack.length - 1];
  let detectedStartUrl = startUrl || null;

  for (const entry of actionLog) {
    const action = entry.action;
    if (!action) continue;

    if (isOverlayAction(action, MARKER_PREFIX)) {
      const marker = parseMarker(action, MARKER_PREFIX);
      if (!marker) continue;

      if (marker.kind === 'R') {
        if (marker.phase === 'start') {
          stack.push({ kind: 'repeat', body: [] });
        } else if (marker.phase === 'end') {
          const open = top();
          if (open.kind !== 'repeat') {
            warnings.push({ type: 'unbalanced-marker', message: 'R was closed without being open; ignored' });
          } else {
            stack.pop();
            top().body.push(finalizeRepeat(open));
          }
        }
        continue;
      }

      if (marker.kind === 'F') {
        if (marker.phase === 'arm') {
          const scopeBlock = scopeBlocks[nextScopeBlock];
          if (!scopeBlock) {
            warnings.push({ type: 'f-without-scope', message: 'F was pressed but no container/item pair was captured; those steps stay un-looped' });
            continue;
          }
          nextScopeBlock += 1;
          stack.push({
            kind: 'foreach',
            body: [],
            __parents: scopeBlock.scope.parents,
            __structuralItems: scopeBlock.scope.items,
            __expectedCount: scopeBlock.scope.count,
            __bodyEvents: scopeBlock.bodyEvents.slice(),
            // Where the list lives, so a step recorded elsewhere is recognisable as a
            // detail-page step.
            __listUrl: entry.url,
          });
        } else if (marker.phase === 'close') {
          const open = top();
          if (open.kind !== 'foreach') {
            warnings.push({ type: 'unbalanced-marker', message: 'F was closed without being open; ignored' });
          } else {
            stack.pop();
            // `entry.url` here is where the browser was when F was pressed to close -
            // i.e. whether the recording had made it back to the list.
            markDetailSteps(open, open.__listUrl, entry.url, warnings);
            top().body.push(finalizeForeach(open, warnings));
          }
        }
        continue;
      }

      if (marker.kind === 'field' && marker.phase === 'pick') {
        const open = top();
        // A field selector has nothing to be relative to outside a foreach body - the
        // in-page toolbar already hides the field buttons unless one is open, but a
        // hand-edited action log or a race during recording could still get here.
        if (open.kind !== 'foreach') {
          warnings.push({
            type: 'field-outside-foreach',
            message: `field "${marker.label}" was picked outside a foreach body; ignored`,
          });
          continue;
        }
        const payload = fieldEvents[nextFieldEvent];
        if (!payload) {
          warnings.push({
            type: 'field-without-pick',
            message: `field "${marker.label}" was armed but no pick was captured; skipped`,
          });
          continue;
        }
        nextFieldEvent += 1;
        if (!payload.rel.length) {
          warnings.push({
            type: 'field-unaddressable',
            message: `field "${marker.label}" could not be given a stable selector; skipped`,
          });
          continue;
        }
        open.body.push({ kind: 'extract', key: marker.label, relativeSelectors: payload.rel });
        continue;
      }

      if (marker.kind === 'ui') {
        // Settings panel markers (Phase 3.4) are UI configuration noise, not replayable steps.
        // Silently dropped: position, orientation, settings clicks all fall here.
        continue;
      }

      // `pick` and anything else recorded against the overlay: noise, dropped.
      continue;
    }

    if (SESSION_ACTIONS.has(action.name)) continue;

    if (action.name === 'navigate') {
      if (!detectedStartUrl) { detectedStartUrl = action.url; continue; }
      top().body.push({ kind: 'action', scope: 'page', selectors: [], action: cleanAction(action) });
      continue;
    }

    const step = buildActionStep(action);
    const open = top();

    if (open.kind === 'foreach') {
      const event = takeBodyEvent(open.__bodyEvents, action, warnings);
      if (event && event.inItem && (event.rel || []).length) {
        step.scope = 'item';
        step.relativeSelectors = event.rel;
        // Held for finalizeForeach, then removed - the generalized form of this is what
        // becomes the item selector when the step targets the item itself.
        step.__absoluteSelector = action.selector;
        delete step.selectors;
      }
    }

    // Deliberately NOT copying action.ariaSnapshot here. flow.json is meant to be read
    // and hand-edited; a ~1KB aria dump per step buries the two lines that matter (and
    // it also contains our own overlay buttons). The full snapshots are preserved in
    // last-recording.actions.json for forensics.
    if (open.kind === 'foreach') step.__url = entry.url; // consumed by markDetailSteps
    open.body.push(step);
  }

  // Anything still open when recording ended: close it so the flow is still usable,
  // and say so rather than dropping the steps.
  while (stack.length > 1) {
    const open = stack.pop();
    warnings.push({
      type: 'unclosed-block',
      message: `${open.kind === 'repeat' ? 'R' : 'F'} was never closed before the browser was shut; closing it at the end of the recording`,
    });
    top().body.push(open.kind === 'repeat' ? finalizeRepeat(open) : finalizeForeach(open, warnings));
  }

  return {
    flow: {
      siteId,
      startUrl: detectedStartUrl,
      recordedAt: new Date().toISOString(),
      verified: false,
      steps: rootSteps,
    },
    warnings,
  };
}

module.exports = { buildFlow, splitOverlayEvents, splitFieldEvents, looksLikeSameTarget };
