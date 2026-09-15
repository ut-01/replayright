# Adding a target

```
npm run record -- --id=<target-id> --url="https://example.com/records"
```

A browser opens with two buttons on the right-hand side. **Do not hand-write selectors** —
everything comes from what you click.

## The two buttons

**R — repeat.** Press once to open a repeat block, again to close it. Everything in
between runs up to 5 times. If the last thing in the block is a click (a "Next" control),
that control is remembered as the loop's exit condition: replay stops as soon as it is
missing or disabled, rather than burning the remaining iterations.

**F — foreach.** Press once, then:

1. Click the **container** holding the repeating entries — the list or grid, not one entry.
2. Click **one of the entries** inside it.

Neither click reaches the site, so picking a repeating entry cannot navigate you away. The
overlay then tells you how many entries matched. **If it says 0 or 1, re-pick immediately** —
that number is the whole ballgame, and it is knowable now rather than three days into a
broken schedule.

The container you pick only *bounds* the search; the repeating row is usually nested well
below it, so picking a roomy outer container is fine. The entry unit is chosen by matching
how often the thing you clicked appears — on a typical listing that rules out both the
enclosing `<section>` (2 of them) and the label column (one per row but too narrow),
landing on the entry row itself. If the count found does not line up, the overlay says so
in red and names both numbers; press **F** to cancel and pick a tighter container.

Use the **buttons**, not the keyboard. Playwright records keystrokes, so tapping the `f`
key adds a meaningless `press` step to the flow (verification flags it as an advisory so
you can delete it).

Everything you do after that is recorded as the per-entry body and repeats for each match.
Steps you perform on the entry (or inside it) are stored as per-entry steps; once you
navigate into a detail page, steps are stored as page-level. Press **F** again to close
the block.

`F` inside `R` is the normal shape: repeat over pages, foreach over the entries on each page.

### Field extraction: turning the loop into rows

While an `F` body is open, a row of pill buttons appears — **Title**, **Location**,
**Posted date**, **Description**, and **+ Field** for a custom label. Each is one-shot:
press it, click the value **inside the current entry**, and it is captured — no toggle,
no separate "close" press. Press a different pill to capture another field on the same
entry; nothing is captured until you press one.

If the pick lands outside the entry, it tells you and re-arms the same field
automatically. If the overlay cannot build a selector unique to that spot, the **level
stepper** opens instead (see below) so you can step up to a wrapper that can be addressed.

### Picking an element you cannot click: the level stepper

Every pick (container, item, field) hit-tests the innermost element under the cursor, so
an element completely covered by its children — a table row under its cells, a gapless
list under its items — has no pixel of its own to click. When that is the case, or when
the pick would be rejected or looks doubtful, the click **freezes** on the element and a
panel opens:

```
tr.job sits under what you clicked and cannot be clicked directly. Step up to reach it.
body › div#table-wrap › table#jobs › [tbody] › tr.job › td.title
▲ Parent   ▼ Child                                  ✓ Use   ✕
✓ 5 repeating <tr> children
```

- **▲ / ▼** (or Arrow Up / Arrow Down) walk the ancestor chain; any breadcrumb jumps
  straight to that level. Down stops at the element you clicked; up stops at `<body>` for a
  container, just below the container for an item, and at the entry itself for a field.
- The last line validates the selected level live: repeating children for a container,
  the item count for an item, the selector and sample text for a field. **✓ Use** is
  disabled on a level that cannot be used.
- **✓ Use** (or Enter) commits; **✕** (or Escape) goes back to picking; clicking elsewhere
  on the page starts a fresh pick there; pressing F cancels the whole F as usual.
- **Shift-click** opens the stepper on any pick, even one that did not need it.

A pick that needs none of this still commits on a single click. The hover badge tells you
ahead of time: `TD (1 of 3) · ⇡ tr.job hidden, click to choose level`.

None of the stepper's clicks or keys end up in `flow.json`: the buttons are
`playright:ui:level:*` markers (dropped like the settings panel), and the keys are stopped
before Playwright's recorder sees them.

Tagged fields become one flat row per entry. `play`/`verify` write them to
`sites/<id>/output.csv` (or `.json`, by `--out`'s extension) — nothing is written if no
field was ever tagged. A field that fails to resolve on a given entry writes `null`
rather than failing the whole run.

### Opening a detail record inside the loop

Click straight into an entry's detail during the per-entry steps — that is the natural
thing to do, and the recorder handles it. It notices that those steps happened on a
*different URL* and marks them as detail steps.

At replay the detail is opened in **its own tab** (read from the link's `href`), so the
list page is never navigated and cannot be lost mid-loop. The step where you clicked
"back" then becomes "close the tab". If the thing you clicked is not a real link (a
JS-driven expand or route push), replay falls back to clicking in place and using the
recorded back step.

Close the browser window when the flow is done. The recording is replayed immediately and
you get a per-step report.

## Files this produces

| File | What it is |
|---|---|
| `flow.json` | **The thing that runs.** Hand-editable. |
| `flow.js` | A readable view of the same flow. Debug only — never executed, regenerated on every record. |
| `last-recording.actions.json` | Raw action stream + overlay events, for forensics. |
| `fingerprint.json` / `history.jsonl` | Selector match counts per run, for drift detection. |
| `failures/` | Screenshot + HTML captured at the moment any step failed. |

## Recording profile

Every recording launches Chromium against a persistent profile dir, controlled by
`replayright.config.json`'s `profile` block (see `src/config.js`):

| Key | Default | Effect |
|---|---|---|
| `profile.persist` | `true` | `true` reuses the stable `os.tmpdir()/playright-profile-<id>` dir across recordings of this site. `false` launches against a fresh, uniquely-named temp dir that is deleted again once the run ends — nothing survives to the next recording. |
| `profile.clearTracking` | `false` | When `true`, cookies/local storage/session storage/IndexedDB/preferences are wiped from the profile dir both *before* launch and again *after* the browser closes, so the session starts and ends logged-out. |
| `profile.dir` | `null` | Overrides the profile directory entirely — e.g. pin it somewhere outside the OS temp dir so it survives a reboot that would otherwise clear `/tmp`. |

**The tradeoff runs both ways.** Persisting the profile (the default) means a flow
inherits cookies and session state across runs: fewer cookie-banner dismissals, fewer
re-logins, and any auth state you established by hand keeps working. It also means a
stale or poisoned session — an expired login, a consent choice the site later re-prompts
for, a tracking cookie that changes what the site serves — can silently affect every
subsequent recording or replay until someone notices and clears it by hand (or sets
`clearTracking: true`, or `persist: false` for a clean slate every time).

## Batch running many sites: `run --all` and `tags`

```
npm run run -- --all                       # play every recorded site
npm run run -- --all --tag=daily            # play only sites tagged "daily"
npm run run -- --all --concurrency=3        # up to 3 sites' play() at once
```

`run --all` calls the exact same `play` every site would get from `play --id=<id>` - one
Xvfb/browser/drift/run-record cycle per site - and never lets one site's failure (even a
thrown exception, e.g. a corrupt `flow.json`) stop the others: the batch always attempts
every matching site, and the process exits non-zero only if at least one of them did.

`--tag=<name>` filters which sites run, by an optional top-level `tags` array in
`flow.json`:

```jsonc
{ "startUrl": "...", "steps": [...],
  "tags": ["daily", "jobs"] }
```

Add or remove a tag with `replayright tag --id=<id> --add=<name>` / `--remove=<name>`
(both may be given in one call), or edit the array by hand - it is still plain
hand-editable JSON, same as `flow.config` (see below). No `--tag` means "run every
recorded site", tagged or not.

`--concurrency=<n>` (default `1`, i.e. sequential) bounds how many sites' `play()` run at
once. Raising it trades wall-clock time for two things worth knowing before you do:

- Each concurrent site is a full extra Chromium (and, for a `requiresHeaded` site, its own
  Xvfb) - pick a number your machine can actually hold in memory at once.
- With more than one site genuinely in flight, the *step-level* log lines that come from
  deep inside a site's own `play()` run (`interpret.js`/`drift.js`) can be attributed to
  the wrong `siteId` in a `--log=json` stream, because those call sites rely on a
  process-wide "current site" rather than passing `siteId` explicitly. This is a known,
  documented limitation, not an oversight - fixing it means threading `siteId` through
  every log call inside `interpret.js`/`drift.js`, which is out of scope for what added
  batch running. It does **not** affect correctness: each site's own
  `sites/<id>/runs/<iso>.json` report and `run --all`'s own per-site summary line are both
  attributed correctly regardless of concurrency (both carry `siteId` explicitly). Use
  `--concurrency=1` if exact per-line attribution in a machine-read log stream matters more
  than wall-clock time.

## Then

```
npm run verify -- --id=<target-id>     # replay headed, report per step
npm run play   -- --id=<target-id>     # headless; what a schedule runs
```

`verify` is strict: it only passes when **every** step resolves on its *primary* selector.
Surviving on a fallback is fine for a daily run but a failure for a fresh recording,
because it means the selector we would have picked is already wrong.

`play` exits non-zero when the drift check reports `BROKEN` — a selector that used to
match something and now matches nothing. That is the signal to re-record.

## flow.json reference

Four step kinds, nestable:

```jsonc
{ "kind": "action",
  "scope": "page" | "item",          // "item" = relative to the current foreach entry
  "selectors": ["..."],              // page scope: ranked candidates, first that resolves wins
  "relativeSelectors": ["..."],      // item scope: "" means the entry element itself
  "action": { "name": "click" },      // click | fill | press | check | uncheck | select | hover | navigate
  "opensDetail": true,               // read this link's href and open it in a new tab
  "returnsToList": true }            // in new-tab mode: close the tab instead of clicking

// scope: "page"   the listing page
//        "item"   relative to the current foreach entry
//        "detail" the record's own page (its own tab when the click target is a real link)

{ "kind": "repeat",
  "times": 5,                        // hard cap
  "untilGone": "<selector>",         // stop once this is missing/disabled
  "settle": { "selector": "..." },   // this content must change before the next iteration
  "body": [ ... ] }

{ "kind": "foreach",
  "parentSelectors": ["..."],        // must resolve to exactly one container
  "itemSelectors": ["..."],          // ranked; candidates are verified by counting at record time
  "expectedCount": 20,               // what was seen while recording; a mismatch warns
  "body": [ ... ] }

{ "kind": "extract",                 // only ever appears directly inside a foreach's body
  "key": "Title",                    // the pill's label, or whatever you typed into "+ Field"
  "relativeSelectors": ["..."] }     // relative to the current entry; "" means the entry itself
```

### Checking a hand edit: `validate`

Since `flow.json` is meant to be hand-edited (selector reordering, adding a `tags`
array, swapping in a `{{env:...}}` secret placeholder), a typo or a moved brace is
easy to introduce. `replayright validate --id=<id>` does a pure structural check of
the shape above - unknown step kind, an `extract` outside any `foreach`, an empty
selector array, a `repeat`/`foreach` with nothing in its body - with **no browser
and no network call**, so it's a fast sanity check to run right after an edit,
before spending a full `verify` cycle against the live site.

### Secrets in `fill` steps

Recording a login flow captures whatever you actually type, **verbatim** - a
password ends up in `flow.json` (and `last-recording.actions.json`) in plain text.
Before that file is ever committed anywhere, hand-edit the `fill` step's `text` to
reference an environment variable instead:

```jsonc
{ "action": { "name": "fill", "text": "{{env:REPLAYRIGHT_SECRET_SITE_PASSWORD}}" } }
```

`play`/`verify` resolve `{{env:NAME}}` against `process.env` immediately before
typing it in; a literal value with no `{{env:...}}` in it is unaffected. A flow
whose referenced variable isn't set fails fast, before any browser is launched,
with an error naming the missing variable - rather than launching Xvfb/Chromium
and failing deep inside a login step. There is no automatic detection of "this was
a password field" at record time - swapping in the placeholder is a manual edit,
the same way reordering selector candidates by hand already is.

Selector candidates are ranked by **robustness, not specificity**. `li.card` is preferred
over `li.card.sc-9f8a1b`, because a build-generated hash changes on every deploy. Editing
the order by hand is a legitimate way to harden a flow.

An `extract` step never fails the run: if none of its candidates resolve on a given entry,
that field is written as `null` for that row rather than aborting. `play`/`verify` collect
one row per foreach iteration and write them to `sites/<id>/output.csv` by default
(`--out <path>` to choose the path/format; `.json` writes a JSON array instead) — only if
at least one field was tagged anywhere in the flow.

### Accumulating rows across runs: `output.mode`

By default (`output.mode: "overwrite"`, unchanged from before) `output.csv`/`.json` is
replaced wholesale by each run's rows — a scheduled daily run only ever shows what the
*most recent* run scraped. Set `output.mode: "append"` in `replayright.config.json` (or a
site's own `flow.config`) to accumulate instead: every run's rows are appended to
`sites/<id>/output.records.jsonl` (the durable source of truth, independent of wherever
`--out`/`output.path` points), and `output.csv`/`.json` is rewritten as the full
accumulated set on every run.

`output.dedupeKey` (an array of `extract` field names, e.g. `["Title", "URL"]`) tells
append mode which rows are "the same item" across runs — a later run's row with a
matching key **replaces** the earlier one (the freshest scrape wins), instead of piling
up near-duplicates for a listing that's simply still there. With no `dedupeKey`, dedupe
falls back to exact whole-row equality: identical rows collapse, anything that changed
is kept as an additional row.