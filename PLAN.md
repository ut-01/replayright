# replayright: friction, UI, and cloud-readiness plan

`/Users/utkarsh/Desktop/labs/jscrape/packages/playwright-flows` (**flows** below) is a
sibling experiment, not an upstream. We take the friction-removal ideas out of it and
write them into replayright's own design. Nothing is copied wholesale except three leaf
modules that have no coupling to anything (and even those get read before they land).

## What we are explicitly NOT taking

| flows did | why we don't |
|---|---|
| Removed the **R** button; `repeat` inferred from a standalone "Next Page" tag | `repeat` and `foreach` are two different things and stay two explicit gestures. Keeping R also lets us skip `pendingPaginate`, `closeForeach`'s deferral branch, and the legacy-`R` parsing path — flows needs all three *only* because R is gone. Our `ir.js` stays smaller than theirs. |
| Wipes the browser profile on every record, unconditionally | Fatal for any flow behind a login. Adopted, but as an opt-in (Phase 5.3). |
| `pendingPaginate` / `findEnclosingRepeat` legacy shapes | With R present, a pagination tag always has an enclosing `repeat` frame on the stack. One branch, no deferral. |

## Model policy

- **Haiku 4.5** — leaf-module drops, CSS from a given token spec, Dockerfile, tests that
  mirror an existing test's shape. Nothing that decides anything.
- **Sonnet 5** — anything touching `ir.js` / `interpret.js` / `record.js` invariants, the
  block stack, the config layer, the Xvfb lifecycle, refactors that must preserve
  behavior exactly.
- **Opus 5** — worth it for exactly two steps: 2.0 (shadow-DOM spike) and 5.1 (config
  precedence), because everything downstream depends on those answers.

**Every agent prompt starts with:** "Read `CLAUDE.md` first. Do not change
`MARKER_PREFIX`. `R` (repeat) and `F` (foreach) are separate, deliberate gestures — do
not merge, infer, or remove either. Do not simplify any invariant documented in
CLAUDE.md; each one fixed a specific real failure."

---

## Phase 1 — Friction removal that touches no UI

Everything here is independent of the overlay and of each other. Land them in any order,
each as its own commit.

### 1.0 Test harness first — **Sonnet**
replayright has none, and every later phase needs one. Bring over flows' `node:test`
setup and the fixtures under `test/fixtures/` (`paged/`, `nested/`, `loadmore/`,
`shrink/`, `expand/` — plain HTML, no coupling to flows' semantics). Port only the test
files that exercise code replayright already has: `drift`, `pick`, `interpret`, and the
parts of `ir`/`record` that cover R/F blocks as they exist here.

Skip `paginate.test.js` and `extract.test.js` entirely — those test features we haven't
built yet, and they're written against the R-less UI. They come back in Phase 3, rewritten.

Add `"test": "node --test \"test/**/*.test.js\""`. Gate: green.

### 1.1 Chromium launch friction — **Haiku**
`CHROMIUM_ARGS = ['--no-default-browser-check', '--disable-session-crashed-bubble']` in
`constants.js`, applied to every launch in `record.js` and `cli.js`. The second one is the
one that matters: a persistent profile dir never gets a clean `exit_type` written, so
Chromium offers to restore pages on *every* recording session. One click of friction,
every single time.

### 1.2 Selector robustness in `relativeCandidates` — **Sonnet**
Three changes in [src/inpage.js](src/inpage.js), all in the relative-selector builder:
- Ancestor-chain depth cap 10 → 40. A description block on a framework-heavy page sits
  15–30 levels down; 10 was tuned for card titles and silently failed everything deeper.
- Stop the climb at any **ancestor** with an `id` and anchor the path there.
- Try `tag#id` as a **self**-candidate first, before class lists.

Together these are what make a portalled modal / side-panel addressable at all. Guard:
`test/pick.test.js`.

### 1.3 `requiresHeaded` auto-probe — **Haiku** (leaf module, read it before landing)
`src/headless-probe.js`: one plain `fetch` with a `curl/8.0` UA against `flow.startUrl`.
Non-2xx or thrown → `flow.requiresHeaded = true`. Run from `record` and `verify` (both
re-check every run; a site's bot posture changes like its selectors do), consumed by
`play` as its headless default. `--requires-headed[=bool]` bypasses the probe.

One ordering rule: persist `requiresHeaded` to `flow.json` **before** applying `--times`.
`--times` is a smoke-test convenience and must never reach disk.

Also add the headedness column to `list`.

### 1.4 Profile hygiene — **Haiku** to write, but see 5.3
`src/profile.js#clearTrackingData(profileDir)` — removes `Default/Network`,
`Local Storage`, `Session Storage`, `IndexedDB`, `Preferences`, `Secure Preferences`,
`TransportSecurity`, legacy `Cookies`. Each removal existence-guarded.

**Land the module now, wire it to a config flag defaulting to OFF.** flows calls it
unconditionally; that breaks logged-in flows. Phase 5.3 gives it a real switch.

### 1.5 `export-flows` / `import-flows` — **Haiku**
Zip/unzip `sites/*/flow.json` for moving recordings between machines. Trivial, useful
once a cloud agent exists. Low priority — do it last in this phase or skip to Phase 2.

### Gate 1
`npm test` green. Record + verify a real paginated listing page end to end; confirm the
recording session no longer shows the session-restore bubble, and that
`flow.requiresHeaded` was set by the probe.

---

## Phase 2 — Overlay as real HTML / CSS / JS

Do this **before** adding any new overlay control. Currently the whole overlay is
DOM-built with `cssText` strings inside one serialized function; adding four new controls
to that first and restructuring after means writing the same UI twice.

Target:
```
src/ui/
  overlay.html      markup template, data-pr-* hooks, no inline styles
  overlay.css       design tokens + all styling
  overlay.js        behavior: R/F state machines, picker, marker wiring
  selectors.js      pure selector construction (cssPath, chooseItem, ...)
  icons/*.svg       one file per icon
src/ui-bundle.js    Node-side: reads the above, returns one script string (cached)
```

**The mechanism, with zero build tooling:** `addInitScript` accepts
`{ content: "<raw js>" }`, not just a function. `ui-bundle.js` concatenates the plain JS
files, a `const __CFG__ = <JSON>` line, and the HTML/CSS/SVG as string literals into one
IIFE at record time. No bundler, no `require` in the browser, every file normally
editable. Caveat: `{ content }` takes no `arg`, so config is baked into the string rather
than passed as the second parameter.

### 2.0 Shadow-DOM spike — **Opus** — DO THIS FIRST
Real CSS files want a shadow root (site CSS otherwise bleeds into the toolbar). But the
entire marker mechanism depends on Playwright's recorder generating
`internal:role=button[name="playright:R:start"i]` for the overlay buttons. Playwright
locators are *expected* to pierce open shadow roots — prove it, don't assume.

`test/shadow-marker.test.js`, modelled on `record.test.js`'s `drive` seam: mount one
`<button aria-label="playright:R:start">` in an open shadow root, click it through a
driven session, assert the recorded selector still survives `generalize.js#parseMarker`.

- **Passes** → shadow DOM; 2.2 gets a free hand.
- **Fails** → no shadow DOM. `<style>` in `<head>`, every rule scoped under
  `#playright-overlay` / `[data-playright-chrome]`, `all: initial` on the root. Uglier
  CSS, same result for the user. **Do not fight this** — the marker mechanism outranks
  styling.

### 2.1 Structural refactor, zero visual change — **Sonnet**
Move today's overlay into the layout above, appearance identical. Switch `record.js` to
`addInitScript({ content: buildOverlayScript({ markerPrefix, ... }) })`.

Constraints to state in the prompt:
- Every `aria-label` byte-identical. `playright:R:start` / `playright:R:end` /
  `playright:F:arm` / `playright:F:close` all stay.
- `window.__playright.restore(state)` keeps handling **both** `rOpen` and `fOpen` —
  Node re-announces both across navigations and that is the only thing keeping an open R
  block alive through a page load.
- `pickPreview()` stays on the same global.
- Extract `cssPath`, `stableClasses`, `itemCandidates`, `parentCandidates`,
  `relativeCandidates`, `repeatingLevels`, `occurrenceCount`, `atMostOnePerItem`,
  `chooseItem` into `selectors.js` **byte-for-byte**. `chooseItem` is the hardest logic in
  the repo; this step relocates it, it does not touch it.
- **`npm test` green with no test file edited.** That is the entire acceptance criterion.

### 2.2 The redesign — **Sonnet** (CSS alone can be Haiku from the token spec)
- **Tokens**: `--pr-bg/-fg`, `--pr-accent-r`, `--pr-accent-f` (#007aff), radii, shadows,
  one font stack. Light + dark via `prefers-color-scheme`.
- **Buttons**: real `:hover` / `:active` / `:focus-visible` (there are none today), 120ms
  transition on the active fill, `title` on every button. Swap the bare `R`/`F` letters
  for icons **with** their letter retained as a caption — the letters are what the docs,
  the CLI hints, and your muscle memory all refer to, so icon-only would cost more than
  it gains.
- **Status box → floating toast.** It currently sits in the toolbar flow and shifts the
  layout when it appears. Float it, animate in, give the three tones (good/bad/neutral)
  an icon and a left accent rather than only a background color.
- **Armed state.** A crosshair cursor is the only signal today. Add a dimming vignette on
  the picker layer and a small label following the cursor with the current instruction
  ("click the CONTAINER"), so it isn't 400px away in the status box.
- **Hover outline.** Today `outline: 2px solid #ff3366`. Add a translucent fill and a
  badge showing the element's tag and *how many* siblings match — the count is the single
  most useful thing at pick time and currently only appears after you've committed.
- **Open-block affordance.** With R and F both able to be open at once, the toolbar should
  say so at a glance: a persistent "R open · F open" strip, so closing them in the wrong
  order is visible rather than discovered in `flow.json`.

### 2.3 UI tests — **Haiku**
Toast tones, focus-visible reachability, R-open/F-open indicator state.

### Gate 2
`npm test` green, no `aria-label` changed, a real recording session is visibly better.

---

## Phase 3 — New overlay capabilities, in the new structure

Each of these is both halves at once: an in-page control plus its Node-side handling.

### 3.0 `data-playright-chrome` — **Sonnet** — PREREQUISITE for 3.1–3.3
`isOurs()` currently only recognises `#playright-overlay`. Full-viewport layers are
appended to `<html>`, so they fall outside it. `observe` is registered on `document` with
`capture: true`, which fires **before** the layer's own capture handler — so any click on
a layer is reported as a genuine per-item body event.

Latent today (no picker can be armed while an F body is open), **guaranteed to bite the
moment 3.1 or 3.2 lands**. Tag every layer with `data-playright-chrome` and widen
`isOurs()` to `'#' + OVERLAY_ID + ', [data-playright-chrome]'`.

Also introduce the z-index tiers as CSS custom properties now:
`OVERLAY 2147483647 > PAUSE ...646 > PICKER ...645`. The gap is deliberate — pause must
sit above an in-progress pick but below the buttons.

### 3.1 Pause — **Sonnet**
A persistent version of the picker's swallow layer: every click ignored until pressed
again. Never calls a callback, so whatever was armed before pausing is still armed,
untouched, when it comes off. Deliberately does **not** survive navigation — a fresh page
is a fresh concern.

This is the single biggest friction removal in flows: today, looking around a site
mid-recording records the looking.

### 3.2 Field extraction — **Sonnet**, largest step in the plan
Turns replayright from "replays a flow" into "replays a flow and returns rows", which is
what a cloud agent actually needs.

- **In-page**: pill buttons (`Title`, `Location`, `Posted date`, `Description`) plus
  `+ Field` for a custom key. One-shot arm → pick → capture, not a toggle. Enabled only
  while an F body is open (a field selector has nothing to be relative to otherwise), and
  `display:none` rather than dimmed when disabled, so an idle toolbar stays minimal.
  Arming any one cancels whatever was armed before it.
- **Marker grammar**: `playright:field:pick:<key>`. `generalize.js#parseMarker` currently
  splits into `{kind, phase}` — add a third segment, **rejoined** rather than split
  further, so a custom label containing `:` survives.
- **`ir.js`**: a new `extract` step kind, pushed only when `top().kind === 'foreach'`.
  Field picks need no stack correlation — each resolves to one outcome in one instant, so
  a plain in-order queue (`splitFieldEvents`) is enough, unlike F's arm/close pairing.
- **`interpret.js`**: `runExtract` never throws. A field that won't resolve writes `null`
  onto the row; a missing field is not a missing run. Rows accumulate in `stats.records`,
  one flat object per foreach iteration.
- **`output.js`** (leaf, safe to lift): CSV/JSON by file extension, column order by
  first-seen field, wired to `--out` on `play`/`verify`. Default
  `sites/<id>/output.csv`, written only if something was tagged.
- **`emit.js` / `verify.js`**: render `extract` in the debug view; flag an `extract` with
  no candidates as a shape error.
- Bring back `test/extract.test.js`, rewritten for R-present recording.

### 3.3 "Next Page" tag — **Sonnet**
This is where flows' idea is genuinely good and where keeping R makes it *simpler* than
theirs.

Today `finalizeRepeat` nominates `untilGone` only when the last body step is a
page-scoped click. So you must actually click the pagination control while recording
(navigating away mid-setup), and it must come last.

Instead: an arm → pick → capture button, live only while R is open, that **swallows** the
click. Tag the control whenever it happens to be on screen — before the filter setup,
after, or mid per-item work. `ir.js` stashes it on the open `repeat` frame
(`block.__paginate`, found via a simple walk down the stack for the nearest `repeat`) and
`finalizeRepeat` synthesizes the advance click as the block's **last** body step
regardless of recording order, using the same selectors for `untilGone`.

Fallback to the existing trailing-click inference stays, unchanged, for flows recorded
without a tag. Keep the existing guard: anything other than a page-scoped click gets no
early exit and `times` remains the bound — a trailing `fill` nominated as the advance
control is the bug that guard exists for.

Because R bounds it, none of flows' deferral machinery is needed.

Bring back `test/paginate.test.js`, rewritten: tag inside R, tag before F opens, tag
during an F body — all three must produce the same flow.

### 3.4 Settings panel — **Haiku** (in the new UI structure this is mostly markup)
Toolbar position + orientation. Panel appended to `<html>`, not to the toolbar root: the
root uses `transform` for edge positioning, and a transformed ancestor becomes the
containing block for `position: fixed` descendants, which would land the panel off-screen.
Markers `playright:ui:position` / `playright:ui:orientation` — the `ui` kind must fall
through `ir.js`'s marker handling as dropped noise, never reaching a flow.

### Gate 3
Record a listing page tagging four fields and the Next Page control; `play` emits a CSV
with four columns and rows from every page.

---

## Phase 4 — Xvfb (the actual cloud gap)

flows only *warns* about a missing `DISPLAY` ([cli.js:95](../jscrape/packages/playwright-flows/src/cli.js#L95),
[record.js:262](../jscrape/packages/playwright-flows/src/record.js#L262)). Nothing to
take here — this is net-new.

### 4.1 `src/display.js` — **Sonnet**
`ensureDisplay({ mode, screen }) -> { display, dispose }`
- `mode: 'auto' | 'off' | ':N'`, default `auto`.
- No-op when `DISPLAY` is already set, when headless, or when not Linux.
- Otherwise: find a free display number (probe `/tmp/.X11-unix/X<N>`, start at 99, walk
  up), spawn `Xvfb :N -screen 0 <screen> -nolisten tcp` detached, poll for the socket with
  a ~5s timeout, set `process.env.DISPLAY`.
- `dispose()` kills the child; registered on `exit`, `SIGINT`, `SIGTERM`. An orphaned
  Xvfb per cron run is a real leak on a long-lived box.
- `Xvfb` binary missing → **throw**, naming the install command. Never silently fall back
  to headless: a `requiresHeaded` flow running headless produces plausible-looking empty
  output, the worst failure mode for an unattended job.
- `xvfb-run -a` is the fallback if self-management proves fragile, but self-managed is
  preferred — you own the lifetime and know the display number.

### 4.2 Wire it in — **Sonnet**
Replace the warning blocks in `cli.js` and `record.js`. Add `--display` and `--screen`.
`dispose()` in the same `finally` that closes the browser. `cmdPlay`'s existing
`flow.requiresHeaded` default is already the right trigger — no new per-site flag.

### 4.3 Server Chromium args — **Haiku**
Into config, not unconditionally: `--disable-dev-shm-usage` (safe, always on in
containers), `--disable-gpu`, and `--no-sandbox` **opt-in only**, with a comment naming
the tradeoff — required as root in a container, a genuine escape surface otherwise.

### 4.4 Dockerfile + docs — **Haiku**
`mcr.microsoft.com/playwright:v1.62.1-jammy` (ships the full browser and system deps),
`apt-get install -y xvfb`, non-root user, `ENTRYPOINT ["node","src/cli.js"]`. Cron line
and exit-code contract documented alongside.

### 4.5 `test/display.test.js` — **Haiku**
Skipped when `Xvfb` is absent. No-op when `DISPLAY` set; picks a free number; `dispose()`
reaps.

### Gate 4
On a display-less Linux box, `play --id=<a requiresHeaded site>` succeeds unattended and
`pgrep Xvfb` is empty afterwards.

---

## Phase 5 — Configuration

### 5.1 `src/config.js` — **Opus**
Precedence low→high: **defaults → `replayright.config.json` → env (`REPLAYRIGHT_*`) →
`flow.config` → CLI flags**.

```jsonc
{
  "sitesDir": "./sites",
  "browser": { "channel": null, "args": [], "viewport": null,
               "userAgent": null, "locale": null, "timezoneId": null, "proxy": null },
  "display": { "mode": "auto", "screen": "1920x1080x24" },
  "profile": { "persist": true, "clearTracking": false, "dir": null },
  "timeouts": { "resolveWaitMs": 8000, "settleMs": 10000, "probeMs": 10000 },
  "repeat":  { "defaultTimes": 5, "maxTimes": 50 },
  "output":  { "path": "sites/{id}/output.csv", "format": "auto" },
  "log":     { "format": "text" }
}
```
`constants.js` becomes the defaults object `config.js` layers over. Do **not** delete it
and do **not** strip its comments — those comments are why the numbers are what they are.

### 5.2 Thread it through — **Sonnet**
`interpret.js`, `candidates.js`, `record.js`, `cli.js`, `drift.js` import constants
directly today. Pass a resolved config object instead. Wide but mechanical; tests guard.

### 5.3 Profile switch — **Sonnet**
Turn Phase 1.4's flag into the real thing. `clearTracking: true` calls
`clearTrackingData` before launch and again after close; `persist: false` uses a fresh
temp dir per run. Default keeps today's behavior (persist, don't wipe), so cookie banners
still stay dismissed between sessions. Document in `sites/_template/README.md` that
persisting means the flow inherits cookies across runs — the tradeoff runs both ways.

### 5.4 Ergonomics — **Haiku**
`init` command scaffolding a fully-commented config; `"bin": { "replayright": "src/cli.js" }`
plus shebang so `npx replayright play --id=x` works outside the repo; `--sites-dir` so
flows can live elsewhere.

### Gate 5
A flow recorded in Phase 1 still plays unchanged with no config file present.

---

## Phase 6 — Cloud-agent surface

- **6.1 Structured reports — Sonnet.** `--log=json` (one object per line: level, ts,
  siteId, event, path, message) and `sites/<id>/runs/<iso>.json` per run: exit code,
  counts, fallbacks, warnings, drift status, output path, duration. This is what the agent
  reads instead of scraping stdout.
- **6.2 Batch — Sonnet.** `run --all [--concurrency=N] [--tag=daily]`. Aggregate exit
  code non-zero if any site failed; one site's failure never aborts the batch.
- **6.3 Exit codes — Haiku.** Document the existing contract (non-zero on drift `BROKEN`,
  any `SELECTOR_UNRESOLVED`, abort, or zero actions) and give each a distinct code (10
  drift / 11 unresolved / 12 empty) so the agent can branch.
- **6.4 Programmatic API — Sonnet, optional.** `index.js` exporting
  `{ record, verify, play, list, loadFlow }`. Everything already returns stats objects;
  mostly re-export plumbing.

---

## Optional, only after 1–6

- **Live step outline in the overlay.** `record.js` already receives every `actionAdded`
  and holds the `page` handle — push a compact step list back in via `page.evaluate` and
  render it in a collapsible panel, with R/F nesting shown as indentation. Turns recording
  from "hope I marked that right" into something you can watch. Sonnet.
- **Candidate reorder UI.** CLAUDE.md already calls hand-reordering selector candidates a
  supported hardening technique; a local page that loads a `flow.json` and lets you drag
  them would make it real. Sonnet.

---

## Standing hazards — include in the prompt for the phase that touches them

| Hazard | Phases |
|---|---|
| `MARKER_PREFIX = 'playright:'` is baked into every recorded selector and every `last-recording.actions.json`. Changing it invalidates existing recordings. | all |
| R and F are separate gestures. Nothing may infer one from the other. | 2, 3 |
| `restore()` must keep re-announcing **both** `rOpen` and `fOpen` across navigations. | 2, 3 |
| `context._enableRecorder(..., { recorderMode: 'api' })` is undocumented, absent from `types.d.ts`. Re-verify recording end-to-end after any Playwright bump. | 1, 4 |
| Any new overlay control needs a `playright:`-prefixed `aria-label`, or `isOverlayAction` won't recognise it and the click leaks into the flow as a real step. | 3 |
| `document`-level capture listeners fire before a layer's own capture handler — hence `data-playright-chrome`. | 3 |
| `locator.count()` does not auto-wait; candidates poll against one shared deadline. Don't "simplify" `candidates.js`. | 5 |
| A `BROKEN` drift run must not advance `fingerprint.json`. | 6 |
| `--times` must never reach `flow.json`. | 1 |
| `--no-sandbox` is a tradeoff, not a default. | 4 |
| Shadow DOM is subordinate to the marker mechanism. Spike fails → scoped CSS. | 2 |
