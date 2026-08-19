// record.js
//
// Records a flow. Three channels, each carrying only what it is structurally good at -
// which is what removes the correlation races the previous implementation had:
//
//  1. The ACTION STREAM, from Playwright's recorder running in `recorderMode: 'api'`.
//     It yields, per action, a structured object AND the generated code line, with the
//     selector produced by Playwright's own generator. So we never parse JavaScript and
//     never write a CSS path generator.
//
//  2. R/F PRESSES, in-band. The press is itself a recorded action (the buttons live in
//     the page), so its position in the stream is exact by construction. Its meaning is
//     encoded in the button's aria-label at click time, which Playwright turns into the
//     accessible name inside the recorded selector.
//
//  3. PICK PAYLOADS, out-of-band over exposeBinding. Ordering is not load-bearing here:
//     the overlay allows at most one F in flight, and per-step pairings are
//     cross-checked against the action's own accessible name (see ir.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');

const { buildOverlayScript } = require('./ui-bundle');
const { buildFlow } = require('./ir');
const { isOverlayAction, parseMarker } = require('./generalize');
const { MARKER_PREFIX, CHROMIUM_ARGS } = require('./constants');
const { logInfo, logWarn, logError } = require('./log');
const { clearTrackingData } = require('./profile');
const { ensureDisplay } = require('./display');

const REPO_ROOT = path.resolve(__dirname, '..');

function sitePaths(siteId) {
  const dir = path.join(REPO_ROOT, 'sites', siteId);
  return {
    dir,
    flow: path.join(dir, 'flow.json'),
    actions: path.join(dir, 'last-recording.actions.json'),
    failures: path.join(dir, 'failures'),
  };
}

// Best-effort extra selector candidates for one action, computed from the live element
// right after it was acted on. Purely opportunistic: if the click navigated and the
// element is already gone, we record no fallback. A short timeout keeps this from ever
// slowing the person doing the recording.
async function enrichCandidates(page, action) {
  if (!action?.selector) return [];
  try {
    return await page.locator(action.selector).first().evaluate((node) => {
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
      const HASH_LIKE = /(^sc-[a-z0-9]+$)|(__[a-z0-9]{4,}$)|(^[a-z]{0,2}\d[a-z0-9]*$)/i;
      const out = [];
      const push = (sel) => {
        if (!sel || out.includes(sel)) return;
        try { if (document.querySelectorAll(sel).length === 1) out.push(sel); } catch { /* invalid selector */ }
      };

      const tag = node.tagName.toLowerCase();
      if (node.id) push(tag + '#' + esc(node.id));
      for (const attr of ['data-testid', 'data-test-id', 'data-test', 'name']) {
        const value = node.getAttribute?.(attr);
        if (value) push(`${tag}[${attr}="${value}"]`);
      }
      const classes = Array.from(node.classList || []).filter((c) => !HASH_LIKE.test(c));
      if (classes.length) push(tag + classes.map((c) => '.' + esc(c)).join(''));

      // Positional path last: the most brittle option, but as a third candidate behind
      // two robust ones it is strictly better than having nothing to fall back to.
      const parts = [];
      let cur = node;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 8) {
        if (cur.id) { parts.unshift(cur.tagName.toLowerCase() + '#' + esc(cur.id)); break; }
        let part = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(part);
        cur = parent;
        depth += 1;
      }
      push(parts.join(' > '));
      return out;
    }, undefined, { timeout: 700 });
  } catch {
    return [];
  }
}

function countSteps(steps) {
  let total = 0;
  for (const step of steps || []) {
    total += 1;
    if (step.body) total += countSteps(step.body);
  }
  return total;
}

// `drive` is a test seam: when provided it is called with the live page instead of
// waiting for a person to close the browser, so the whole record -> flow.json -> verify
// loop can be exercised headlessly against a local fixture. Recording a browser session
// is otherwise the one part of this system that cannot be tested.
// `clearTracking` is OFF by default: the stable profile dir this function already uses
// is what lets cookie banners and login state persist across recording sessions instead
// of being re-fought every time, and a flow that depends on being logged in would break
// if that state were wiped on every run. Turn it on only for a site where you deliberately
// want every recording to start logged-out and cookie-free (see profile.js).
//
// `persist` (config.js's profile.persist, default true) picks WHICH directory backs the
// profile: true keeps today's stable `os.tmpdir()/playright-profile-<siteId>` dir, so
// cookie/session state survives between recordings of the same site; false launches
// against a fresh, uniquely-named temp dir that is removed again once this run ends, so
// nothing survives to the next one. `dir` (profile.dir) overrides the stable path with a
// caller-chosen location - e.g. somewhere outside the OS temp dir that survives a reboot.
// `userDataDir` remains a separate, higher-priority override: it is the test seam every
// test file in this repo already passes its own throwaway dir through, and callers that
// pass it own that directory's lifecycle themselves (it is never auto-removed here).
async function recordSite({
  siteId, url, drive = null, headless = false, userDataDir, viewport, clearTracking = false,
  persist = true, dir = null,
  display = 'auto', screen,
  // EXTRA Chromium args, appended to constants.js's CHROMIUM_ARGS - not a replacement.
  // This is config.js's browser.args layer; cli.js is what actually resolves and passes
  // it. Defaults to none, so every existing caller (all current tests) is unaffected.
  chromiumArgs = [],
}) {
  // `npx playwright codegen` has no flag to inject our own overlay, and the eventSink we
  // need is only wired up when the recorder runs in api mode - which the CLI never does.
  // So we drive the recorder ourselves.
  //
  // context._enableRecorder(params, eventSink) is marked `internal: true` in Playwright's
  // protocol metadata and is absent from playwright-core/types/types.d.ts, so it can
  // change without notice. Verified against playwright-core 1.62.1:
  //   coreBundle.js:62205  _enableRecorder(params, eventSink)
  //   coreBundle.js:50851  recorderMode === 'api' -> ProgrammaticRecorderApp
  //   coreBundle.js:51009  ActionAdded -> emits the recorderEvent we consume
  // Omitting recorderMode:'api' is exactly the bug that left the previous version's
  // action log permanently empty: the default path builds the Inspector UI, which never
  // emits those events.
  delete process.env.PW_CODEGEN_NO_INSPECTOR; // would make RecorderApp.show() a no-op

  const paths = sitePaths(siteId);
  fs.mkdirSync(paths.dir, { recursive: true });

  // Resolve which directory backs the persistent context. Priority: an explicit
  // `userDataDir` (test seam, caller-owned lifecycle) > `dir` (profile.dir, a
  // caller-pinned stable location) > `persist: true`'s stable per-site convention >
  // `persist: false`'s fresh, unique-per-run temp dir. Only the last of these is ours to
  // clean up afterward - the other three are either explicitly caller-managed or meant to
  // survive the run by design.
  let profileDir;
  let ephemeralProfileDir = false;
  if (userDataDir) {
    profileDir = userDataDir;
  } else if (dir) {
    profileDir = dir;
  } else if (persist) {
    profileDir = path.join(os.tmpdir(), `playright-profile-${siteId}`);
  } else {
    profileDir = path.join(os.tmpdir(), `playright-profile-${siteId}-${randomUUID()}`);
    ephemeralProfileDir = true;
  }
  if (clearTracking) clearTrackingData(profileDir);

  // Recording is a real headed Chromium window by design (CLAUDE.md: "record a browser
  // flow once in a real Chromium window") - a person clicks the R/F buttons in it. On a
  // normal desktop DISPLAY is already set and this is a no-op; on a headless Linux/cloud
  // box it stands up a scoped Xvfb so the launch below can succeed at all. Skipped
  // outright when `headless` was passed true (the `drive` test seam uses this).
  const displayHandle = headless ? { dispose: () => {} } : await ensureDisplay({ mode: display, screen });

  try {
    return await recordSession({
      siteId, url, drive, headless, viewport, clearTracking, profileDir, paths, chromiumArgs,
    });
  } finally {
    // Same tier as the browser-close path below, not a separate afterthought: an
    // orphaned Xvfb process per recording session is a real leak on a long-lived box.
    displayHandle.dispose();
    // A fresh temp dir generated for `persist: false` is just as much a leak as the Xvfb
    // process above if nobody removes it - each run would otherwise accumulate its own
    // never-reused profile directory forever. Only OUR generated dir is removed; a
    // caller-supplied `userDataDir` or `dir` stays, since it is not ours to delete.
    if (ephemeralProfileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function recordSession({ siteId, url, drive, headless, viewport, clearTracking, profileDir, paths, chromiumArgs = [] }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: viewport ?? null,
    args: [...CHROMIUM_ARGS, ...chromiumArgs],
  });

  const actionLog = [];
  const overlayEvents = [];
  const pending = [];
  const markerState = { rOpen: false, fOpen: false };

  await context.exposeBinding('__pwEvent', (_source, payload) => {
    if (payload && typeof payload === 'object') overlayEvents.push(payload);
  });

  await context.addInitScript({ content: buildOverlayScript({ markerPrefix: MARKER_PREFIX }) });

  // launchPersistentContext() already opened a page before we could listen for the
  // 'page' event, so that first page's close would otherwise go unnoticed and the
  // context would never emit Close.
  const trackPage = (page) => {
    page.on('close', () => {
      if (context.pages().length === 0) context.close().catch(() => {});
    });
    // The init script re-runs on every navigation, but the overlay cannot know that a
    // block is still logically open - only Node knows that. Re-announce it.
    page.on('domcontentloaded', () => {
      if (!markerState.rOpen && !markerState.fOpen) return;
      page.evaluate((state) => window.__playright?.restore(state), { ...markerState }).catch(() => {});
    });
  };
  context.on('page', trackPage);
  context.pages().forEach(trackPage);
  const initialPage = context.pages()[0];

  const onAction = (page, data, code, isUpdate) => {
    const action = data?.action;
    if (!action) return;

    if (isUpdate && actionLog.length) {
      const last = actionLog[actionLog.length - 1];
      const fallbacks = last.action.__fallbacks;
      last.action = fallbacks ? { ...action, __fallbacks: fallbacks } : action;
      last.code = code;
      return;
    }

    // The URL the action was recorded ON. This is what lets ir.js tell "still on the
    // list" from "now on a job's detail page" without any extra channel: the click that
    // opens a detail page is still recorded at the list URL, and everything after it is
    // recorded at the detail URL.
    let url = null;
    try { url = page.url(); } catch { /* page already gone */ }

    const entry = { seq: actionLog.length, action, code, url };
    actionLog.push(entry);

    if (isOverlayAction(action, MARKER_PREFIX)) {
      const marker = parseMarker(action, MARKER_PREFIX);
      if (marker?.kind === 'R') markerState.rOpen = marker.phase === 'start';
      if (marker?.kind === 'F') {
        if (marker.phase === 'arm') markerState.fOpen = true;
        if (marker.phase === 'close') markerState.fOpen = false;
      }
      return; // no point enriching our own buttons
    }

    pending.push(
      enrichCandidates(page, action).then((fallbacks) => {
        if (fallbacks.length) entry.action.__fallbacks = fallbacks;
      })
    );
  };

  await context._enableRecorder(
    { language: 'javascript', mode: 'recording', recorderMode: 'api' },
    {
      actionAdded: (page, data, code) => onAction(page, data, code, false),
      actionUpdated: (page, data, code) => onAction(page, data, code, true),
      signalAdded: () => {},
    }
  );

  const closed = new Promise((resolve) => context.on('close', resolve));
  const onSigint = () => { context.close().catch(() => {}); };
  process.once('SIGINT', onSigint);

  // The recorder never observed the initial page's creation (it predates
  // _enableRecorder), so it emits no page-open action for it even though every generated
  // line references `page`. Opening a fresh page now, with the recorder already active,
  // makes it capture that properly; the original is closed only AFTER, so pages().length
  // never hits zero in between and does not trip the close handler above.
  const page = await context.newPage();
  if (initialPage && initialPage !== page) await initialPage.close();
  await page.goto(url);

  if (drive) {
    try {
      await drive(page, context);
    } finally {
      await context.close().catch(() => {});
    }
  } else {
    logInfo('Recording. Use the R and F buttons on the right-hand side of the browser window.');
    logInfo('  R  press once to open a repeat block, again to close it.');
    logInfo('  F  press once, then click the container, then one item. Everything after that repeats per item.');
    logInfo('Close the browser window when the flow is complete.');
  }

  await closed;
  process.removeListener('SIGINT', onSigint);
  await Promise.allSettled(pending);

  // Belt and braces: wipe again on the way out, so nothing this session accumulated
  // (a cookie set on the very first page load, before we could have cleared it) is
  // still sitting on disk waiting for the NEXT run to inherit it either.
  if (clearTracking) clearTrackingData(profileDir);

  const { flow, warnings } = buildFlow({ siteId, url, actionLog, overlayEvents });

  fs.writeFileSync(paths.actions, JSON.stringify({ actionLog, overlayEvents }, null, 2));
  fs.writeFileSync(paths.flow, JSON.stringify(flow, null, 2));

  logInfo(`Recorded ${actionLog.length} raw action(s) -> ${countSteps(flow.steps)} replayable step(s).`);
  logInfo(`Wrote ${path.relative(REPO_ROOT, paths.flow)}`);
  for (const warning of warnings) logWarn(`${warning.type}: ${warning.message}`);
  if (!flow.steps.length) logError('Nothing replayable was recorded.');

  return { flow, warnings, paths };
}

module.exports = { recordSite, sitePaths, countSteps, enrichCandidates };
