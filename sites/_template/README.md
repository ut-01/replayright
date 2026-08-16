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

Three step kinds, nestable:

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
```

Selector candidates are ranked by **robustness, not specificity**. `li.card` is preferred
over `li.card.sc-9f8a1b`, because a build-generated hash changes on every deploy. Editing
the order by hand is a legitimate way to harden a flow.