# GoCD Lens — working notes

A Chrome extension that reads GoCD pipelines from the REST API and draws its own
dashboard, so it keeps working when the GoCD web UI does not. Built alongside
[lazygocd](https://github.com/Sahilll15/lazygocd) (a terminal UI for the same
problem) and borrowing its endpoint choices, which are verified against a real
GoCD 23.5.0 instance.

```sh
npm test            # 212 tests, no dependencies, ~300ms
npm run hooks       # point git at .githooks (pre-commit runs the suite)
npm run icons       # regenerate icons/*.png  (tools/make-icons.py)
npm run sounds      # regenerate sounds/*.wav (tools/make-sounds.py)
npm run screenshots # regenerate docs/screenshots/*.png (~85s, needs Chrome)
npm run package     # gocd-lens.zip
```

No build step. The files in `src/` are the files that run. Reload from
`chrome://extensions` after editing.

---

## The target instance

This is aimed at a **very large** GoCD server -- thousands of pipelines, with
hundreds failing at any time -- behind a corporate VPN. That number drives most of the design: anything
that is O(pipelines) per poll, or renders every pipeline at once, is wrong here.

---

## Architecture

```
src/lib/          no DOM, no chrome APIs beyond storage — this is what tests exercise
  gocd.js         REST client: endpoints, Accept versions, error classification
  status.js       status rollups, fuzzy search, material parsing, log framing
  store.js        chrome.storage.local + the redaction that keeps secrets off pages
src/background/
  service-worker.js   the ONLY place holding a credential or opening a socket
src/common/       el(), send(), stageStrip(), the sprite, design tokens
src/offscreen/    invisible page that plays chimes (a worker has no DOM)
src/dashboard/    full-tab UI      src/popup/  toolbar glance    src/setup/  settings
```

That one seam -- pages ask the worker, the worker answers with data -- is also what
makes the pages screenshottable: `tools/make-screenshots.mjs` replaces
`chrome.runtime.sendMessage` with a table of canned replies and drives every
rendering path for real, with no GoCD server anywhere.

**Pages never call GoCD.** They post a message to the service worker, which owns
the credential and makes the request; only data comes back. A bug in a rendering
path therefore cannot leak the token, and there are no content scripts at all.

---

## Invariants (tests fail if you break these)

- **`chrome.storage.local` only.** Never `storage.sync` — it uploads to Google.
- **No `innerHTML`/`eval`/`new Function`.** `el()` in `common/ui.js` is the only
  way data reaches the screen, and it assigns strings with `textContent`. Build
  logs are the least trustworthy data in the product.
- **`host_permissions: []`.** Access is requested per-origin at Connect time.
  `chrome.permissions.request` must be the **first await** in a click handler or
  Chrome refuses it — do not `permissions.contains()` first.
- **No content scripts, no remote assets, no analytics.** The user's GoCD server
  is the only host contacted.
- **Defaults must exist as `<option>` values** in `setup.html` — a mismatch
  leaves a select blank and the next change event saves that blank back.

`tests/package-integrity.test.mjs` enforces all of the above against the files.

---

## GoCD API gotchas learned the hard way

These cost real debugging. Do not "simplify" them away.

**`viewName` must use `%20`, not `+`.** `URLSearchParams` encodes spaces as `+`.
GoCD's own dashboard sends `viewName=Visual%20Builder` (confirmed in DevTools on
a live server). If a server does not decode `+`, it silently ignores the filter
and returns every pipeline on the instance — visible only as a fat payload, because local
enforcement still shows the right list.

**`allowEmpty=true`** goes alongside `viewName`, so a view matching nothing means
nothing rather than falling back to the unfiltered dashboard.
⚠️ **Spelling unconfirmed** — camelCase was chosen to match `viewName`, but it was
reported as `allow_empty`. Check DevTools against a live server and correct it.

**A stage's status is not in one field.** `/api/dashboard` sets `status`;
`/api/pipelines/:name/history` may set `result` instead; a stage mid-flight can
have neither, and only its jobs say it is alive. **The literal string `"Unknown"`
is the absence of an answer, not an answer** — it must not shadow the jobs.
See `stageStatus()`. This caused "shows running in the list, never-run when
opened".

**A stage building right now outranks a stage that failed.** `rollup` puts
`Building` first. GoCD halts a run at the stage that failed, so a later stage can
only be moving because someone re-ran the failed one -- and then the pipeline is
being worked on, not sitting broken. Ordered the other way, the product
contradicted itself: the pipeline page read the run as building off the history
endpoint while the list, the tiles and the badge read it as failed off the
dashboard payload, so the badge sat red with nothing to count on a pipeline
visibly in flight. The red segment stays in the stage strip; only the headline
changes.

**A run that stopped part-way with everything passing is `Passed`.** Stages
passed + later stages never scheduled is the shape of a pipeline held at a manual
approval gate. That is green as far as it got, which is what GoCD's own dashboard
shows; the grey segment in the stage strip is where "and no further" gets said.
This was got wrong twice from opposite directions — first reported as
"Never run", then as "In progress" — before landing on `Passed`. Only a run with
nothing known about any stage is `Unknown`. There is deliberately no third
"in progress but not building" status; a genuinely mid-flight run has a stage
that is `Building`/`Scheduled`, which `rollup` catches first.

**Remember run counters, not just statuses.** A pipeline can start *and* finish
between two polls; comparing statuses alone sees no change and says nothing.

**Mutations need `X-GoCD-Confirm: true`.** Accept versions: dashboard `v4`,
pipelines `v1`, stages `v3`. `/files/...` is a plain file server — no
`vnd.go.cd` Accept header.

**GoCD's views can break while its pipelines are fine.** Observed in production:
`?viewName=...` started failing and took the web UI down with it, while a plain
`/api/dashboard` answered perfectly. `retryUnfiltered()` handles this — it
re-asks without the filter and enforces the view from the cached definition.
Only when we hold that definition (else the payload is wrong *and* huge), and
never on network/auth errors.

**No push channel of any kind.** Everything is polling. Console logs are a file
endpoint with a `startLineNumber` cursor.

**Measured on the real server:** GoCD's own dashboard polls with **two** requests
per cycle (`/api/dashboard` + `/api/server_health_messages`), all `304`s,
~18 kB total for the window. Ours makes one.

---

## Decisions, and why

**Watching (🔔) and starring (★) are different things.** Starring pins to the top
of a list. Watching notifies on run **start** and **finish**. Wanting something
in easy reach and wanting to be interrupted by it are different wishes.

**Watching costs zero requests.** Notifications are computed from the
`/api/dashboard` payload the badge already needs. Per-pipeline polling would be
N requests per cycle — on this instance, that is how you take the server down.
⚠️ Consequence: a watched pipeline **outside the active view** is not in the
payload, so it never notifies. The badge tooltip admits this; notifications do
not. Unresolved.

**The badge counts running first, failing second.** It is on screen all day, so
it should answer "is anything happening now". A failure persists for hours, is
already plain in three other places, and a badge stuck on `9` all week trains
you to ignore it. Source is user-chosen (`view` / `watched` / `starred`) — an
earlier `auto` mode that silently changed meaning when you starred something was
removed for being invisible.

**Two controls, each meaning what it says.** *Check in the background every*
decides whether we check at all (which keeps the badge current). *Notify me even
when no dashboard tab is open* decides whether those checks may interrupt you.
Gating the alarm on the notify tick meant the interval dropdown did nothing and
the badge froze.

**Quiet defaults.** Background checking ships as *Never*; open-tab refresh is
10s. Unattended traffic deserves an explicit yes.

**Views are enforced locally as well as server-side.** `viewName` is a request,
not a guarantee. `applyView()` re-applies it so the list, sidebar, chip counts,
badge and notifications cannot disagree. Two built-in views (`local:starred`,
`local:watched`) are namespaced so they cannot collide with a real view name;
they send no `viewName` and filter locally — which is exactly why they survive a
views outage.

**Pollers share one request; a view change never joins them.** Several tabs, the
popup and the alarm each poll on their own timer, so `refreshDashboard` hands a
concurrent caller the request already in the air. Picking a view is not that same
question: answering it with the running request returns the payload for the view
being left, and skips the body, so `activeView` is never written and the badge
goes on counting what you navigated away from. It waits for the poll instead.

**Changing view keeps what you typed and drops what you picked.** `selectView`
clears the chosen group -- it may not exist in the new view -- and lands you back
on the list, since that is the only place the view you just picked is visible.
Both search boxes survive: text you typed is a filter you still want, re-run
against the new view. The one exception is a search left behind on a pipeline
page, because that box doubles as jump-to-pipeline and such a search would narrow
the new view down to the thing you were leaving. Boot passes
`resetContext: false`: adopting a default view is not a choice the user made, and
the popup and notifications deep-link straight into a pipeline before it runs.

**The popup remembers what you typed, for five minutes.** It is a fresh
document every time it opens, so a click anywhere else throws the search away
-- a bad trade in a box whose whole job is finding one pipeline among thousands.
It expires because the popup's first duty is *is anything red?*, and a filter
left over from yesterday answers that about one pipeline while looking like it
answered about all of them. Written on every keystroke rather than debounced,
since the popup is torn down the instant it loses focus and a pending timer goes
with it.

**Everything counts the same set, badge included.** The badge is narrowed by
the popup's search as well as by its source, and its tooltip says so -- a badge
counting a subset without admitting it is what `auto` was removed for. It is
repainted on the keystroke rather than at the next poll, because with background
checking off there may not be a next poll, and it widens again on its own when
the search expires.

**A restored search is re-asserted, not just displayed.** The TTL runs from the
last *write*, and restoring the box was not a write -- so a search could expire
while you were looking at it, and the badge, which reads through the TTL, would
widen to the whole view while the popup stayed narrowed. Badge 3 above a popup
reading 1 running: same cache, same matcher, one of them handed an empty needle.
`restoreSearch` writes it back, which restarts the clock and repaints the badge.

**Everything in the popup counts the same set.** The tiles and the built-in view
counts follow the search box, so a picker cannot read `Starred (4)` above three
rows, or `Failing 2` above one failure. A tile therefore carries the search with
it into the dashboard -- otherwise clicking `Failing 1` under a search opens the
other 900.

**Polls that change nothing do not redraw.** `refresh()` fingerprints the payload
(ETag, else a rolling hash) and repaints only the clock when it matches. Scroll
position is preserved across redraws of the same screen.

**The pipeline page redraws on a change, not on a poll.** It rebuilds from
scratch on every render, so a tick that found nothing new is pure churn -- and
while a run is building the tick fires every few seconds. `loadHistory` compares
a fingerprint of what the screen actually shows (run counters, stage and job
statuses) rather than the response, which carries durations that move on their
own. A poll-driven reload is also silent: it must not drop a skeleton over a
page you are reading.

**Groups start collapsed**, and storage tracks which are *expanded* — so a new
group appearing on the server stays folded instead of unfolding into your list.

**Three auth modes, session first.** *Use my existing GoCD login* rides the
cookie already in the browser and stores **nothing**; token mode survives session
expiry and sidesteps CSRF on mutations; basic auth is for old servers. Setup
verifies the credential against the server **before** saving it.

**CORS is a non-issue because the worker makes every request.** Chrome exempts an
extension's own contexts from CORS for hosts in its permissions, so GoCD needs no
`Access-Control-Allow-Origin` and no `OPTIONS` preflight is sent — which is also
why `X-GoCD-Confirm` never has to survive one. Content scripts *are* subject to
CORS; this extension has none.

**Assets are generated, not shipped opaque.** `tools/make-icons.py` writes the
PNGs with stdlib zlib (Chrome will not take an SVG for a toolbar icon) and is
size-adaptive: at 16px the lens ring and the chevron collide, so that size drops
the ring. `tools/make-sounds.py` synthesises the three WAVs from arithmetic —
shipping audio nobody can inspect is a poor trade in an extension asking to be
trusted.

**Scale defences.** The popup pages 16 at a time behind *Load more*; the log
viewer renders the last 6000 lines and offers a download for the rest. Rendering
every card at once locks the tab, which is why groups start collapsed -- but an expanded
group now paints in full: opening one is a deliberate ask for what is in it, and
a 30-row cap with *Show all N* only put a second click in front of the answer.
The one path that can still ask for everything at once is a search broad enough
to match most of the instance, since a search opens every group it matches.
The sidebar has its own filter box for the same reason -- several hundred group
rows is a scrolling problem of its own -- and it is markup rather than painted,
so a poll landing mid-type cannot take the caret with it.

**Re-run picks jobs inline, not in a modal.** A stage of a dozen parallel e2e
jobs is normal, and re-running all of them to retry one flaky job wastes agents.
Each job row carries a checkbox before its terminal icon -- only where the stage
can be re-run *and* has more than one job -- with failed jobs pre-ticked, because
retrying what broke is the common case. The button reads *Re-run selected (n)*
until the selection is empty or complete, both of which mean the whole stage and
use `run` rather than `run-selected-jobs`. The checkbox sits outside the row's
button: ticking a job must not open its log, and an `<input>` cannot live inside
a `<button>`. A select-all in the stage header keeps "re-run everything" at one
click even though failures arrive ticked.

The ticks live in a module-level `Map` in `pipeline-view.js`, not in the DOM. A
poll lands every few seconds and `render()` rebuilds the whole screen, so a
selection held only in the checkboxes is wiped while you are still making it --
tick three of twelve, wait for the next refresh, and they are all clear again.
Same reason scroll position is preserved. The key includes the **stage counter**,
so the attempt created by a re-run starts from its own failures instead of
inheriting the selection that produced it, and the store is pruned to the
pipeline on screen.

---

## Deliberately absent — do not re-add without asking

Each of these existed and was removed for a reason:

| Removed | Why |
|---|---|
| **Stale-deploy / GitHub check** | The only thing that ever contacted a third party. lazygocd *does* have it; dropping it makes "your GoCD server is the only host contacted" unconditional. |
| **Run with variables** | Unused. The client still accepts `environmentVariables`; only the UI went. |
| **Export settings** | Wrote a JSON with no way to import it back. |
| **Sound volume slider** | The WAVs are synthesised quiet (~−13 dBFS) and the OS already has a volume control. |
| **Failure-sound picker** | Five options collapsed to one fixed double beep. |
| **Badge source `auto`** | Silently changed what it counted the moment you starred something. |
| **`notifyScope` + `notifyOnRecovery`** | A scope dropdown and a direction tick collapsed into one *Also notify for starred pipelines*. "All pipelines" was unusable at 900 failures anyway. |
| **OS notification-settings buttons** | Chrome cannot open System Settings; the URL schemes may be refused silently. The click-path is printed as text instead. |
| **Save as a GoCD view (`+` beside the picker)** | Removed on request; the picker is a switch, not an editor. The UI went first and `saveView()` followed: it was the only **write** to `/api/internal/*`, an endpoint with no contract and no version guarantee, kept alive by nothing but optionality. A GoCD maintainer flagged that dependency on a sibling project ([gocd/gocd#14575](https://github.com/gocd/gocd/discussions/14575)) and was right. The read stays, isolated and degrading to `viewsAvailable = false`; a test now pins that `/api/internal/*` is GET-only. |
| **Per-section row cap (*Show all N*)** | Sections capped at 30 cards. Groups already start collapsed, so expanding one is a deliberate ask; the cap answered it with another button. |
| **Derived background interval** | Deriving the background cadence from the open-tab interval meant everyone polling every minute. |

---

## UI gotchas

- **`[hidden]` loses to any author `display`.** `base.css` has
  `[hidden] { display: none !important }` — without it, `.icon-btn`,
  `.view-picker`, `.btn` and `.two-up` all ignored `hidden`.
- **`.check .hint` is a `<span>`**, so it needs `display: block` or every
  checkbox description runs on beside its label. Same trap bit `.run-label` and
  `.run-sub`: `overflow`/`text-overflow` do not apply to inline elements, so a
  long label overflowed the row and shoved the status pill out instead of
  ellipsing.
- **`opacity` on a row cannot be undone by a child.** A card's actions sat at
  `opacity: 0` with the starred and watching buttons set back to `1` -- which
  never showed them, because opacity on the parent is a group the child cannot
  escape. They fade per button now, and their **width** collapses with them:
  holding the space for four buttons that were not on screen truncated every
  long pipeline name permanently. `max-width: 0` rather than `display: none`,
  since a button that is not displayed cannot be tabbed to and `:focus-within`
  is what reveals these for the keyboard.
- **Tooltips on truncated text are measured, not assumed.**
  `applyOverflowTitles()` runs after each render and compares `scrollWidth`
  against `clientWidth`, so only genuinely clipped text gets a `title`. Titles it
  adds are marked with `data-auto-title` so a deliberate one is never clobbered.
  A card name is the exception in *when*: it is only clipped once the actions
  take their space, so the card re-measures on `mouseover` -- which is also why
  those buttons' width does not transition, or the measurement would read a size
  still on its way somewhere.
- **The theme toggle flips against the *effective* theme.** Cycling
  `system → dark → light` needed two clicks on a machine set to dark, because
  the first was invisible.
- **The change-highlight is colourless** — an expanding ring, twice. Tinting with
  `--accent` competed with "building"; washing a card's background made it
  flicker, because the animation ends on `transparent`.
- **Native select carets ignore `padding-right`.** `appearance: none` plus an
  inline data-URI chevron at `right 12px center`.

---

## Style

Comments explain **why**, not what — especially where the code looks odd but is
deliberate (every gotcha above has one). Prefer deleting prose over adding it;
several rounds of this session were spent removing explanation that repeated the
label above it. User-facing text says "browser", not "Chrome" — this runs on
Edge and Brave too, and `browserIdentity()` detects which for OS instructions.

**Commits carry no AI attribution.** No `Co-Authored-By: Claude` trailer, no
"Generated with Claude Code" line, in commit messages or PR descriptions — this
is a personal profile and the history should read as one author's.

---

## Unverified

- **Never run as an installed extension.** No `chrome://extensions` load, no real
  GoCD server, so anything that depends on a real credential, a real permission
  prompt, a real notification or a real alarm is untested by hand.
  The *rendering* is no longer unseen: `tools/make-screenshots.mjs` serves the
  real pages against fixture replies and photographs them in headless Chrome, so
  layout and theming can be looked at. Use it before guessing at a visual bug.
- `allowEmpty` spelling (above).
- The OS-settings deep links were removed deliberately: Chrome cannot open
  System Settings, and a button that might do nothing is worse than none.
