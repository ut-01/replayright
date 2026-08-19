# replaywright

*Bind a working once. Press two sigils into its seams. Let it wake and walk alone, every
dawn, needing no further counsel from you.*

Wrought first for the harvesting of listings behind gates such as paginated
product-search pages — set the wards you desire, press the Sigil of Recurrence across the
turning pages, press the Sigil of the Legion across each card in the crowd, and the
working congeals into a `flow.json`: a bound grimoire fit to be summoned on a schedule.
What it does at the appointed hour is fixed and mute — no spirit deliberates, no oracle is
consulted; it walks the same steps it was shown.

```
npm run record -- --id=example --url="https://example.com/search?category=electronics"
npm run verify -- --id=example    # replay headed, per-step report
npm run play   -- --id=example    # headless; what a schedule runs
npm run list
```

The rite of first binding, and the reference for what the grimoire's pages may contain,
live at [sites/_template/README.md](sites/_template/README.md). **R** is the Sigil of
Recurrence — press to open the loop, press again to seal it. **F** is the Sigil of the
Legion — press once, then point at the vessel that holds the many, then point at one of
the many itself. Neither pointing touches the living page; both are shadow-gestures upon
its skin, so no false step during the binding can strand you mid-working.

## The shape of the working

Playwright's own familiar, summoned with `recorderMode: 'api'`, streams each gesture as
both a structured omen and the line of code it would become, its true-names (selectors)
drawn from Playwright's own naming-craft. Nothing here reads raw script back into meaning,
and nothing here invents its own path through the page's bones by position alone — which
is precisely why one working walks unaltered across `shop-a.example.com` and its
counterpart `shop-b.example.com`, where a path drawn by position would not survive the
crossing.

Three currents carry the working, and each is trusted only with what it is suited to
carry:

| Current | What it bears | Why it can be trusted |
|---|---|---|
| The familiar's own stream (`recorderMode: 'api'`) | every gesture, in true order, with its true-name | the order is the familiar's own, not reconstructed |
| The two sigils, pressed **within** the stream | where each loop opens and where it seals | the press is itself a recorded gesture, so its place in the stream is exact by nature, not inferred |
| The pointing-rites, bound **outside** the stream | which vessel, which one-of-many, which gestures belong to each | at most one Legion-working is ever open at a time; each pairing is cross-checked against the gesture's own spoken name |

The grimoire proper is `flow.json` — it alone is authoritative. `flow.js` is a mirror cast
for mortal eyes, remade fresh at every binding and never itself invoked.

The search for a true-name does not glance once and trust what it sees — it watches every
candidate against one shared hourglass, because counting (`locator.count()`) does not wait
the way an action does; a list that grows its rows before it fills them would otherwise
fail in the instant between. A target must also stand **visible** and **unmistaken** — a
thing present but hidden is what curdles into a thirty-second stillness at the end.

Every gesture keeps **several candidate true-names, ranked**, never just one — ranked by
how well they endure, not by how precisely they describe (`li.card` outlives
`li.card.sc-9f8a1b`, whose tail is remade at every deploy). The working takes the first
name that still answers, and murmurs a warning when it must fall past the first choice —
the earliest word that the page beyond has changed its shape.

## The bones of the house

| Path | What dwells there |
|---|---|
| `src/record.js` | the hand that drives the familiar; the three currents above |
| `src/ui/` + `src/ui-bundle.js` | the two sigils and the picker that swallows the click before the page ever feels it (lives inside the page itself, mounted in a shadow root) |
| `src/ir.js` | gesture-stream and sigil-marks, folded through a stack of open blocks, into `flow.json` |
| `src/interpret.js` | the one that walks `flow.json` back to life (`action` / `repeat` / `foreach`) |
| `src/candidates.js` | the ranked search for true-names, with its warnings when it must fall back |
| `src/generalize.js` | strips away `[name="..."i]` so one card's name answers for all its kin |
| `src/verify.js` | walks a working once and judges whether it is fit to be trusted unattended |
| `src/drift.js` | keeps the fingerprint of each walking; exits with a curse (non-zero) when a true-name has died |
| `src/emit.js` | turns `flow.json` back into a readable `.js` — for mortal eyes only |

## What the working cannot yet do

- **`times: 5` is a ceiling, not a reason to stop.** `untilGone` ends the loop cleanly
  once the turning-page control vanishes or falls dormant. The truer law — halt once a
  page yields nothing *new* — asks for memory of what has already been seen, and that
  memory is not yet kept.
- **Descending into one item's own page can unmake the list behind it.** After the
  working steps into item *i*'s own chamber, whatever was gathered by "load more" may be
  gone on return. This is a fault of the house being visited, not of the working, and
  cannot be mended in general; the working notices the shrinking and says so, rather than
  walking indexes that no longer exist.
- **No familiar Inspector watches while the binding happens.** `recorderMode: 'api'`
  cannot share the stage with Playwright's own Inspector and its hovering glow, so the
  two sigils' own overlay must carry every word of feedback alone.
- **A per-item chamber opened in its own sundered space is expected and kept alive** —
  that is precisely what keeps the list from being lost — but a page that tears open such
  a space *of its own will* during the binding (`target="_blank"`, `window.open`) is only
  noted and warned of, never re-walked at replay.
- `context._enableRecorder` is a thing Playwright keeps but does not name in its own
  `types.d.ts` — a borrowed key, not a granted one. Proven true against
  `playwright-core@1.62.1`; should that familiar be replaced with a newer one, the trials
  in `test/` must be run again before anything else is trusted.

## Deployment in containers

A `Dockerfile` is provided for running flows in headless container environments (Docker,
Kubernetes, cron on cloud runners). It ships the Chromium browser and system dependencies,
so no additional setup is needed beyond `docker build`.

### Building

```bash
docker build -t replayright:latest .
```

### Running a scheduled flow

The image runs as a non-root user (`pwuser`) for security. A typical cron entry on a
cloud runner would be:

```bash
# Replay flow 'example' every day at 3 AM UTC, exit non-zero if the flow is broken.
0 3 * * * docker run --rm replayright:latest play --id=example
```

The image already has `/dev/shm` and GPU disabled by default where needed for most
container platforms. If you encounter Chromium crashes due to small `/dev/shm` or need
GPU support:

```bash
# Disable /dev/shm usage (useful in Docker with --shm-size=1g or similar tight limits)
docker run --rm replayright:latest play --id=example --disable-dev-shm-usage

# Enable GPU if available (remove the default --disable-gpu equivalent)
docker run --rm replayright:latest play --id=example --disable-gpu=false
```

### Exit codes

Scheduled jobs rely on the exit code contract. The `play` command (and `verify`) exit
non-zero on any of:

- **`BROKEN` drift check**: the flow's selectors or structure have changed significantly
  enough that the run is no longer trustworthy. The previous fingerprint is held (not
  updated), so the job remains in a broken state until fixed.
- **`SELECTOR_UNRESOLVED`**: a step could not resolve any of its selector candidates —
  the site changed structurally, and the flow cannot proceed.
- **`aborted`**: the run stopped early due to consecutive failures exceeding the error
  budget (`MAX_CONSECUTIVE_ERRORS`, default 3).
- **Zero actions ran**: the flow executed no steps at all (usually a startup failure).

On success, the exit code is 0 and the fingerprint is updated with the new counts.
