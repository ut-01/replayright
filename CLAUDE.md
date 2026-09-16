# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Record a browser flow once in a real Chromium window, mark its loops with two on-page
buttons, and get a `flow.json` that replays unattended (e.g. from cron) with no LLM in the
loop. Built for paginated listing pages: repeat over pages, foreach over the cards on each
page, optionally open each card's detail.

Plain CommonJS Node, zero dev tooling. The only dependency is `playwright`.

## Commands

```
npm install                                    # no node_modules checked in; also needs `npx playwright install chromium`
replayright record --id=<id> --url="<url>"     # headed; writes sites/<id>/, then self-verifies
replayright verify --id=<id>                   # replay headed + per-step report; does NOT touch fingerprint.json
replayright play   --id=<id>                   # headless; what a schedule runs; updates the drift fingerprint
replayright emit   --id=<id>                   # regenerate the read-only flow.js view
replayright list                               # recorded sites, tags, last-run status; --porcelain for the old plain format
replayright validate --id=<id>                 # static flow.json shape check - no browser, no network
replayright tag --id=<id> --add=<name>         # add/remove a name from flow.json's tags array (--remove=<name> too)
replayright init [--force]                     # scaffold replayright.config.json (+ a commented .jsonc reference)
replayright config --id=<id>                   # print the fully-resolved config for <id>, with which layers set what

# not installed (npm link / global install) yet? record/verify/play/emit/list/run have
# npm script aliases too (package.json's "scripts"); init/config/tag/validate don't, so
# without the bin installed those four are `node src/cli.js <command> ...` instead:
npm run record -- --id=<id> --url="<url>"
node src/cli.js init [--force]
```

Flags (all commands): `--headless[=true|false]` (default: false for record/verify, true for
play), `--times <n>` overrides *every* `repeat` block's iteration count — the fast way to
smoke-test a flow without editing `flow.json`. `--times` also seeds `config.repeat.defaultTimes`
(so a block with no `times` of its own agrees with the flag too), which means a value above
`config.repeat.maxTimes` (default 50) is rejected at config-load time with a "raise
repeat.maxTimes" error, before the run even starts — raise the cap via `replayright.config.json`
or `--times` stays capped at 50 regardless of what's passed.

There **is** a test suite now (`npm test`, `node --test`; no linter, no build).
`recordSite()`'s `drive` parameter is the seam that made it possible — it replaces "wait
for a human to close the browser" with a callback, so a recording session can be driven
headlessly against a local fixture. Verification of a real site is still done by running
`verify` against it; the test suite covers the pipeline's own logic.

Exit codes matter — they are the scheduled-job contract. `play` exits non-zero with a
distinct code per cause (`src/constants.js#EXIT_CODE`, checked in this priority order):
`10` drift `BROKEN`, `11` any `SELECTOR_UNRESOLVED`, `14` any `ASSERT_FAILED` (an `assert`
step's check failed — the page rendered fine but its state/data didn't match), `13`
aborted mid-run, `12` zero actions ran. `verify` stays plain 0/1 — it never touches the
fingerprint and is meant for a human reading the per-step report, not an automated branch.

## Architecture

The pipeline is `record.js → ir.js → flow.json → interpret.js`, with `flow.json` as the
single authoritative artifact. `flow.js` is a **debug view only** — never parsed, never
executed, regenerated on every record.

### Recording: three channels, deliberately separated

`src/record.js` drives Playwright's recorder itself via the undocumented
`context._enableRecorder(params, eventSink)` with **`recorderMode: 'api'`**. That mode is
load-bearing: without it Playwright builds the Inspector UI and never emits the
`actionAdded` events this whole system consumes. `npx playwright codegen` cannot be used
because it can neither inject the overlay nor run in api mode.

1. **Action stream** (`actionAdded`/`actionUpdated`) — every gesture in true order, with
   the selector produced by Playwright's own generator (`internal:role=link[name="…"i]`).
   Nothing here parses generated JavaScript, and nothing generates CSS paths from scratch;
   that is why one flow works across two different sites with the same shape.
2. **R/F marker presses, in-band** — the overlay buttons live *in the page*, so pressing
   one is itself a recorded action. Its meaning is carried in the button's `aria-label`
   (`playright:R:start`, `playright:F:arm`, …), which Playwright turns into the accessible
   name inside the recorded selector. Stream position is therefore exact by construction —
   no cross-channel correlation, no timing assumptions.
3. **Pick payloads, out-of-band** via `exposeBinding('__pwEvent')` — which container, which
   item, and per-step "was this inside the current item" observations. Safe only because
   the overlay enforces at most one `F` in flight, and because `ir.js` cross-checks each
   pairing against the action's own accessible name (`looksLikeSameTarget`, plus a
   3-deep lookahead so one missed observation self-heals).

The in-page half lives under `src/ui/`: `overlay.html` (markup, `data-pr-*` hooks, no inline
styles), `overlay.css` (all styling, mounted as a real stylesheet), `overlay.js` (chrome, the
click-swallowing picker, R/F wiring), and `selectors.js` (the pure selector-construction
functions, `cssPath`…`chooseItem`, with no dependency on overlay chrome). `src/ui-bundle.js`
is the Node-side seam: it reads those files and concatenates them — the two JS files, a baked
`const __CFG__ = <JSON>` line (config can no longer arrive as a function argument once the
script is passed as raw text), then the HTML/CSS as string literals, then a bootstrap call —
into one `content` string, cached after the first read. `record.js` hands that string to
`context.addInitScript({ content })`. Because it ends up as raw text evaluated in the page,
every file under `src/ui/` must stay **entirely self-contained** — no `require`, no closing
over Node scope. It runs in the main world (so it can call `window.__pwEvent` directly) and
re-runs on every navigation, which is why Node re-announces open-block state via
`window.__playright.restore()`.

`overlay.js` mounts into an **open shadow root** (host `div#playright-overlay` in the light
DOM, so `document.getElementById('playright-overlay')` still finds — and removing it still
tears down — the whole thing). This was proven safe for the marker mechanism by the Phase 2.0
spike (`test/shadow-marker.test.js`): Playwright's role locator pierces an open shadow root
and the recorder still keys the generated selector off the button's accessible name, so
`overlay.css` can be a real stylesheet with none of the recorded page's CSS bleeding in (and
none of the overlay's leaking out). The picker layer is the one exception — it stays in the
light DOM, appended to `document.documentElement`, because it must sit above the recorded
page at the browser's hit-testing level regardless of which shadow tree that page's content
lives in.

The picker is a transparent full-viewport layer, not a document listener: the click must
never reach the site, or picking a card navigates you away mid-recording.

Hit-testing only returns the innermost element, so anything its children tile completely
(a `<tr>` under its `<td>`s, a gapless `<ul>`) cannot be clicked. The picker's **level
stepper** covers that: a click commits as before *unless* the clicked element's parent
cannot be hit directly (`isHitReachable`, and only when that parent matters for the stage
— `hiddenMatters`), the stage's validation doubts the pick (`needsHelp`), or it was a
Shift-click. Then the click freezes and a panel walks `levelChain(raw, stage.top(raw))`
with a live validation line. Each pick stage (container / item / field) is a policy object
passed to `openPicker(instruction, stage)`. Invariants:
- A single-click commit calls the stage's commit with the **raw** element, exactly as
  before; only the stepper can hand over another level. An item level other than
  `chooseItem`'s own choice is committed with `chooseItem(el, parent, { pinned: true })`.
- Stepper buttons are `playright:ui:level:*` markers (dropped by `ir.js`'s `ui` no-op) and
  the panel carries `data-playright-chrome` so `observe()` ignores it.
- Stepper keys are stopped on a **window** capture listener: Playwright's recorder listens
  on `document` capture, later on the path, so it never records a `press`.
  `test/picker-level.test.js` has a control proving the key *is* recorded otherwise.
- The highlight is a positioned box, not an outline on the site's element — outlines and
  backgrounds on a `<tr>` are invisible under its cells.
- The item stage's `describe()` already shows a one-line live count/mismatch summary at
  every level. A stage may additionally define `previewDetails(el, ctx)` (currently only
  the item stage does) returning the full ranked-candidate breakdown; when present, the
  stepper panel shows a "Preview" button (`playright:ui:level:preview`, also a `ui` no-op)
  that expands it inline — the same data `pickPreview` returns, computed live instead of
  via `querySelector`'d strings, so checking a pick no longer requires opening devtools.

`chooseItem()` in `selectors.js` is the hardest logic in the repo. Picking the repeating unit
is *not* "outermost child of the container" nor "innermost repeating level" — it walks
ancestors of the clicked element and prefers the **outermost** level whose match count
equals how often the clicked thing itself occurs in the container. When nothing lines up it
still picks something and flags the mismatch in red in the overlay, because a wrong count is
knowable at pick time. `window.__playright.pickPreview(containerSel, targetSel)` replays
this logic against a saved page snapshot for offline debugging.

### IR: `src/ir.js`

Folds the action stream + markers through a **stack** of open blocks, which is what makes
`F` inside `R` (the real-world shape) work. Detail-page steps are detected purely from the
URL each action was recorded at — no extra channel — and tagged `opensDetail` /
`returnsToList` / `scope: 'detail'`. Unbalanced or unclosed markers are closed with a
warning rather than dropping steps.

`finalizeRepeat` nominates the loop's early-exit control (`untilGone`) only when the last
body step is a page-scoped **click** — anything else (e.g. a trailing `fill`) would make
replay skip a genuine step once that element went disabled.

`ir.js` deliberately drops `action.ariaSnapshot` from steps (≈1KB each) to keep `flow.json`
hand-editable; the full snapshots survive in `last-recording.actions.json`.

### Replay: `src/interpret.js` + `src/candidates.js`

Three step kinds nest arbitrarily: `action`, `repeat`, `foreach`. The `flow.json` schema
reference lives in [sites/_template/README.md](sites/_template/README.md) and is worth
reading before touching either file.

Every step carries a **ranked list** of selectors, not one. `candidates.resolve()` returns
the first usable one and calls `onFallback` when the winner is not index 0 — that warning is
the earliest signal the site changed, well before drift reports BROKEN. Ranking is by
*robustness, not specificity*: `li.card` beats `li.card.sc-9f8a1b`. Hand-reordering
candidates in `flow.json` is a supported way to harden a flow.

Non-obvious invariants encoded in these two files (each fixed a specific real failure —
don't "simplify" them away):

- `locator.count()` does **not** auto-wait. All candidates are polled against one shared
  deadline (`RESOLVE_WAIT_MS`), so a list that renders row shells before filling them does
  not fail in the gap.
- Action targets need `requireVisible` + `preferUnique`. An attached-but-hidden match is
  what turns into a 30-second actionability timeout; an ambiguous one silently clicks the
  wrong row.
- `foreach` re-resolves parent *and* items every iteration; nothing is cached, because any
  navigation in the body detaches the handles and can even change which candidate wins.
- `foreach` breaks out with a `list-reset` warning when the list shrinks below the current
  index, instead of iterating indexes that no longer exist.
- `opensDetail` prefers reading the link's `href` and opening a **new tab**, so the list
  page is never navigated and "load more" progress is not lost. `returnsToList` then means
  "close the tab". Non-link targets (JS route pushes) fall back to same-tab clicking.
- `repeat` never re-checks `untilGone` *between* iterations — only the advance action itself
  reporting "nothing to click" ends the loop. Checking between iterations dropped the last
  page of every site.
- `repeat` also ends early when its nested `foreach` reports no genuinely new items for a
  whole iteration (reusing the same same-first-item/count comparison `foreachProgress`
  already makes for "Load More" dedup) — covers an advance control that stays present and
  enabled forever instead of vanishing/disabling, which `untilGone` cannot detect on its own.
- `settle` (content under a selector must change) exists for SPAs that swap the list in
  place, where Playwright has nothing to auto-wait on.
- Delays are applied only when a real page load happened, not around every click.
- `runAssert` reports every outcome (pass and fail, not just fail) through two channels
  kept deliberately separate from each other: the synchronous `options.onAssert(result)`
  callback threaded through `runFlow`/`play()`/`verify()` for an in-process npm consumer,
  and the `assert-passed`/`assert-failed` `EVENT`s in `src/log.js`'s existing `--log=json`
  NDJSON stream for anything out-of-process (a CI step, an n8n Execute Command node).
  Both fire from inside `runAssert`'s own try/catch, before a failing assert's error is
  thrown — deliberately not routed through `handleError`'s generic `step-failed` path,
  which only runs for a step nested under a `repeat`/`foreach` body.

### The recording overlay's third sigil: `A` (assert)

`src/ui/overlay.js`'s assert button follows the exact same one-shot arm → pick → capture
shape the "+ Field" mechanism (Phase 3.2) already uses — chosen deliberately over
inventing a new correlation mechanism: a dropdown picks the check type first (the
`aria-label`/marker only gets its final value once the type is chosen, same reason
field's confirm button sets its marker on `input`, not inside its own `click` handler),
then arming a picker sends the pick payload out-of-band over `__pwEvent`, and `ir.js`
pairs marker-click with payload FIFO-style (same queue field's `splitFieldEvents` uses)
into `{ kind: 'assert', check: {...} }` instead of `{ kind: 'extract' }`. "Found" / "not
found" / "multiple found" in the dropdown are UI sugar over `count` `gte 1` / `eq 0` /
`gt 1` — there is no separate check type for them in `flow.json` or `interpret.js`.

### Trust gates: `src/verify.js` and `src/drift.js`

`verify` is intentionally stricter than `play`: it passes only when every step resolves on
its **primary** selector and `auditShape()` finds no structural problems. Surviving on a
fallback is acceptable for a daily run but a failure for a fresh recording. The result is
persisted as `flow.verified`, and `play` warns loudly when a flow was never verified.

`drift.js` derives its watched selectors **from the flow** (foreach parent/items, repeat
advance) rather than from a hand-maintained list. A `BROKEN` run deliberately does **not**
advance `fingerprint.json` — saving a broken run's zero counts as the baseline would make
every later comparison pass and the job would go quiet forever. `history.jsonl` records
every run regardless.

## Per-site layout

`sites/<id>/`: `flow.json` (authoritative, hand-editable), `flow.js` (debug view),
`last-recording.actions.json` (raw forensics), `fingerprint.json` + `history.jsonl` (drift),
`failures/` (screenshot + HTML at the moment a step failed). `sites/_template/` is docs
only and is skipped by `list`. Recording profiles are persisted in
`os.tmpdir()/playright-profile-<id>` so cookie banners stay dismissed between sessions.

## Gotchas

- **Naming is load-bearing in one place, and nowhere else.** The package, README, and CLI
  usage text all consistently say `replayright` now — but
  `MARKER_PREFIX = 'playright:'` in [src/constants.js](src/constants.js) is baked into
  every recorded marker selector and into `sites/*/last-recording.actions.json`. This one
  spelling must NOT change; changing it invalidates existing recordings.
- `context._enableRecorder` is internal and absent from `playwright-core/types/types.d.ts`.
  It is verified against `playwright-core@1.62.1` (line references are in the comments at
  the top of [src/record.js](src/record.js)). Re-verify recording end-to-end after any
  Playwright bump.
- `record.js` passes `url` to `buildFlow()`, which destructures `startUrl` — so
  `flow.startUrl` is actually recovered from the first recorded `navigate` action. Works,
  but don't assume the parameter is wired.
- Keyboard `f`/`r` do nothing useful: Playwright records the keystroke as a real `press`
  step. `verify` flags it as an advisory but never deletes it (some sites do use single-key
  shortcuts) — delete it from `flow.json` by hand.
- Never hand-write selectors during recording; everything must come from clicks so that
  Playwright's generator remains the source.
