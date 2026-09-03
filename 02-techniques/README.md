# 02 — techniques

Everything [`../01-family-tree/`](../01-family-tree/) does, plus the things teams
ask for within a day of installing it:

- **deep links to your own tools** — per-row buttons built from URL templates you
  type, with the workflow id, run id, type, status and a *widenable* time window;
- **the same links on a single workflow's own page**, and one set per activity the
  page mentioned, from the same templates;
- **a settings pane**, so all of the above is configuration rather than a fork;
- **two facts the workflow list does not carry** — what each running workflow did
  most recently, and whether one of its activities is stuck in a retry loop.

```
Workflow ID                                Last event ⟳                   Status
order-2601011200-01           Logs         3m 00s · ActivityTaskStarted   Running
 ├─ …-01-payment      ↻ 47    Logs         12s · ActivityTaskFailed       Running
 └─ …-01-fulfilment           Logs                                        Completed
```

The last two are the interesting ones, and not because they are hard: **they are
the first thing in this repository that makes a request of its own.** Everything
in 01, and the deep links here, read responses the page had already fetched. The
column and the badge ask Temporal questions the page never asked. That is a
different trust argument, and most of this file is about it.

Every feature has its own toggle, and there is a master switch that removes every
node this extension put on the page **and puts the row order back** — so "off" is
verifiable, not merely claimed.

**It still decodes no payload.** Nothing here reads a workflow's input, its result
or a failure message; everything on screen is derived from event *metadata* — event
types, ids, timestamps, attempt counts, activity type names. That boundary is what
makes this stage self-contained: no codec server, no egress, and no setting that
could add one. Payloads belong to the next rung,
[`../03-payloads/`](../03-payloads/) — whose manifest is identical to this one, which
is the whole reason that rung is worth reading.

## Run it

```bash
npm install          # from the repository root, once
npm run build        # from this directory
```

The Node range `npm install` needs is stated once, in
[the root README](../README.md#start-with-01), rather than copied into each
project where three copies would go stale one at a time.

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`02-techniques/dist/`. Open a workflow list, reload the tab, and click the toolbar
icon: the popup reports rows *seen* and rows *matched* separately, because "the
extension is not running" and "it ran and matched nothing" are different problems
that look identical on the page. It also reports how many runs this tab has asked
Temporal about, because a feature whose cost is invisible is a feature nobody can
review.

Two projects loaded at once are distinguishable by their icons — each carries its
own number and hue.

## Read these files in order

This project is several times the size of 01, and nearly all of the growth serves one
idea: **it asks Temporal questions of its own.** To answer *"what does it ask, and who
decides?"* — the only question that changes between 01 and 02 — read four files in this
order:

| # | File | The question it answers |
|---|---|---|
| 1 | [`src/apiInject.ts`](src/apiInject.ts) | Which messages this extension accepts from the page at all. One, and the list is the file. |
| 2 | [`src/rowInfo/rowInfoServe.ts`](src/rowInfo/rowInfoServe.ts) | Whether a request happens: the things that keep a per-row feature from becoming a load generator, and why every one of them is on this side of the boundary rather than in the caller. |
| 3 | [`src/page/temporalApi.ts`](src/page/temporalApi.ts) | What the request *is* — every URL this extension builds, as pure string work. No `fetch` in the file, and one direction flag that returns a completely different fact if you get it wrong. |
| 4 | [`src/page/pageApi.ts`](src/page/pageApi.ts) | Where authority is enforced: one exported fetch, spending the page's own bearer on an origin **it** picks, and only for a run the page was itself handed. This is the confused-deputy file; the note at its top says what the first version got wrong. |

Then the drawing side, which is three files rather than one:
[`src/render.ts`](src/render.ts) finds the table, identifies rows and orders families;
[`src/rowInfo/rowInfoRender.ts`](src/rowInfo/rowInfoRender.ts) draws the column and the
badge, and is the only render job that writes *outside* the workflow-id cell;
[`src/links/linkRender.ts`](src/links/linkRender.ts) draws the anchors, and is the one
render job used from two different pages. Then two spec files, in this order:
[`tests/unit/apiInject.spec.ts`](tests/unit/apiInject.spec.ts), which asserts the gate
from the attacker's side — a page script trying to borrow the credential for a run it
was never handed, *without spending the bearer to find out* — and
[`tests/unit/render.spec.ts`](tests/unit/render.spec.ts), which asserts that a repeated
pass writes nothing new and that the master switch really does remove everything —
including the row order, which is the one edit that leaves nothing behind to find.

**The diff from 01 is smaller than the file count suggests, and that is the point.**
Most of 01's source is here byte-for-byte — the tree fold, the row index, the fetch hook
and the shared types — which `npm run lineage` enforces rather than claims. Two files
changed, and each change is a decision worth reading:

| Changed file | What this stage did to it |
|---|---|
| [`src/render.ts`](src/render.ts) | Split. It kept the table plumbing and the three rules and handed the drawing to the two modules above; the class names and the render types moved to [`src/decoration.ts`](src/decoration.ts), which is what the master switch's completeness now rests on. It also states the left-to-right order of the controls that share the workflow-id cell, so that order cannot come out of which feature a given user switched on first. 01 keeps the whole job in one file, which is the right answer for one lesson. |
| [`src/content.ts`](src/content.ts) | Grew from "fold the rows, draw the tree" into the wiring for the settings, the request client and the single-workflow page — while writing only the off-class on `<html>` and still calling no `fetch`. |

Everything else a reviewer would look for is *new* here rather than modified, and each
new file sits in a directory named after the thing it does — see **Layout** below.

## The two questions it asks Temporal

### "Last event" — a column beside the workflow id

For every **running** row: the newest history event, as an age and a type —
`3m 00s · ActivityTaskStarted`. One
`GetWorkflowExecutionHistoryReverse` with `maximumPageSize=1` per run, so a
workflow with a hundred thousand events costs exactly what a three-event one does.

The reverse direction is the whole of it. Asking the *forward* route for one event
returns the workflow's **first** event instead — the same shape, a completely
different fact, and no error anywhere to tell you.

The column sits **immediately after the workflow id**, and that placement is the
feature working rather than a cosmetic preference: the question it answers — *is this
one actually moving?* — is asked while reading the id. Appended to the end of a table
the UI already fills to the edge, the answer is off-screen behind a horizontal scroll.

It was appended once, and appending is genuinely simpler: the end of a row has to
agree with nothing, whereas a column in the middle has to agree with a header order
the Temporal UI lets the user reorder and hide. So the position is **computed on
every pass** — from each row's own id cell, and for the header, which has no
workflow link of its own to find, from the first body row that had one. Two things
that cost has to buy: the table stays rectangular (a row with no workflow link at all
still gets a cell, appended, because a missing cell puts every header one column out
from its data), and the placement is idempotent — moving a cell that is already in
the right place is a DOM write, and a DOM write wakes the `MutationObserver` that
triggered the pass. See `syncLastEventColumn` in [`src/rowInfo/rowInfoRender.ts`](src/rowInfo/rowInfoRender.ts).

The cell has to distinguish four states, and all four look like an empty cell if
you let them: `…` not asked yet, `!` asked and it failed (with the reason in the
title), `—` answered with no events, and the answer itself. The first three are the
ones that get mistaken for a broken extension.

**The age is exact to the second, which is what makes it a clock rather than a
label.** `4m 12s` and `12s` say different things about the same `Running` status;
`4m` and `now` do not. Two consequences follow, and both are the interesting part
of this small feature:

- **The age is frozen at the reading, and the tooltip says when that was.** This is
  the one design decision in the feature worth arguing about, and it was got wrong
  first. An age is a subtraction from *now*, so the obvious implementation is a
  `setInterval` at 1s that redraws the column — and this project had one. It was
  honest about cost (it fetched nothing; it recomputed from timestamps already in
  hand) and dishonest about time. The cell makes **two** claims, and only the first
  is exact: *"event #42 happened 3m 00s ago"*, and *"#42 is the newest event"*. The
  second is re-read at most every 35s (`ASK_INTERVAL_MS`, below). Animating the
  subtraction over it meant a workflow that had moved on two seconds ago displayed a
  stall climbing to the second, convincingly. So every age is now measured against
  `observedAtMs` — the instant Temporal was actually read, taken from the cache entry
  and not from the clock at reply time — and the hover text reads *"3m 00s old when
  this was read, at 12:04:31 · Frozen at that reading — press ⟳ to ask again."* The
  column changes when the data changes and at no other time. **The cost is real and
  goes in the other direction:** a stall reads up to one ask interval *younger* than
  it is. The only truthful per-second age would need a request per row per second,
  which is the load this whole feature is built to avoid. Wrong-and-visible beats
  wrong-and-animated.
- **Two units, floored, zero-padded** — `47s`, `3m 07s`, `5h 12m`, `3d 04h`.
  Three units would make the column wide enough to push the UI's own columns
  off-screen, which is the problem the placement above exists to avoid. Padding is
  not cosmetic: `3m 9s` → `3m 10s` changes the cell's *width*, and tabular figures
  fix the width of a digit, not the number of them. And it floors
  rather than rounds, because `1m 00s` printed over a 59-second-old event is a
  clock that is ahead of the truth.

The **`⟳` in the column header** re-asks Temporal now, for every running row on
screen, instead of waiting for the TTL. It is one flag on the message the table
world already sends (`fresh`), not a new message type — the number of message
kinds the page world accepts is the thing a reviewer counts, and this feature was
not worth adding one. Two details are load-bearing:

- **The floor is on the receiving side.** `FRESH_FLOOR_MS` (5s) lives in
  `src/rowInfo/rowInfoServe.ts`, not in the button, because the button is one `postMessage`
  away from anything else running in the page: a bound applied by the caller is a
  bound only an honest caller keeps. An answer younger than the floor is left in the
  cache, so a held-down refresh — or a script forging the message in a loop —
  collapses into the same cache the automatic path uses. The button greys itself out
  for the same 5s, which is the *visible* half of that rule and not the enforcement.
- **Refreshing does not clear the answers**, only the permission to ask again.
  Emptying the column and refilling it as the round drains would flash `…` across
  every row to tell the user something they already know.
- **It is 24×24, which is a rule and not a taste.** `font: inherit` on a table
  header made the glyph 11px and the target about 13px across; WCAG 2.2's *Target
  Size (Minimum)* asks for 24. `.tuis-col-refresh` in `public/content.css` gets that
  as `min-width`/`min-height` with `display: inline-flex`, and then pulls the extra
  height back out with negative vertical margins — otherwise a control this
  extension added would grow the row height of a header it does not own.

### "↻ 47" — the retrying-activity badge

A workflow whose activity has failed forty-seven times is still `Running`, and in
the list it looks exactly like one that is making progress. The badge is that
number.

It needs `DescribeWorkflowExecution`, and **that is the justification for the whole
request path**: `pendingActivities` is returned by that call and by nothing else. It
is not in the list response, and it cannot be reconstructed from the history tail —
an activity on attempt 900 had its `ActivityTaskScheduled` event written ~900 events
ago, so a tail of any sane size misses exactly the workflows this badge exists to
find. There is no cheaper question that answers it.

Attempt 1 never badges: it is the first, still-hopeful run of an activity, and
badging it would put a retry marker on every healthy workflow in the list, which is
the same as having no badge at all. A workflow with several retrying activities gets
one badge, for the worst of them.

**The badge does not read the failure message, and will not.**
`pendingActivities[].lastFailure.message` sits directly beside `attempt`, and the
internal extension this starter reimplements does show it. Here it is
declined: a failure message is application data — it routinely carries account
numbers, customer ids, upstream response bodies — and it would be the one thing on
screen that a bystander must not read. The attempt count, the activity **type** (a
symbol from the workflow's own source) and the next-retry time are enough to find a
stuck workflow, and none of the three is anybody's data. `activityId` is skipped for
the same reason: unlike the type, it is chosen by the caller, and it is regularly
built out of a business identifier. The hover text says so in place, so the omission
is visible rather than merely intended.

### What the requests cost, and what bounds them

| Rule | Why |
|---|---|
| **Running rows only** | A closed workflow's last event and pending activities cannot change, so the request could never tell anyone anything. A list filtered to `Completed` makes no requests at all — this one filter is usually most of the saving. |
| **Rows the table is showing**, not the whole response | The page fetches more rows than it draws. |
| **One field, one call** | The two toggles are separate, so a user who wants only the column pays one request per running row and not two. |
| **Answers cached 30s** in the page world | Set in `TTL_MS`, `src/rowInfo/rowInfoServe.ts`. |
| **Asked at most every 35s** per run in the table world | `ASK_INTERVAL_MS`, `src/rowInfo/rowInfoClient.ts`. The cache alone is not enough: a request answered *from* cache is still a `postMessage` per row per render pass, and there are a great many render passes. |
| **Four requests at a time** | `maxConcurrent`, in `src/page/pacer.ts`. A hundred-row list becomes a queue, not a burst. |
| **429/503 backs off**, honouring `Retry-After` | `src/page/pacer.ts` again: 2s doubling to a 60s ceiling, or the server's own `Retry-After` when it sent one. A rate limiter answered with a retry storm is how one tab degrades the API for a whole team. |
| **No polling timer, and no heartbeat at all** | Refresh comes from the Temporal UI polling its own list, which re-renders the table, which asks again — and the TTLs decide whether asking turns into fetching. Nothing here polls Temporal on its own, and nothing here holds a repeating timer: freezing the ages (above) is what removed the last one. The two timers left are both one-shots that make no request — the single pass `src/content.ts` schedules `FRESH_FLOOR_MS` after a `⟳` press, purely to re-enable the button, and the backoff sleep in `src/page/pacer.ts`, which exists to make *fewer* requests. |
| **A manual refresh is floored at 5s** per run | `FRESH_FLOOR_MS`, `src/rowInfo/rowInfoServe.ts`. The `⟳` in the header bypasses the 30s cache; this is the bound on how far. It is checked in the page world, because the message that asks for it can be posted by anything in the page. |

Each bound above is asserted somewhere rather than only described here: **which**
rows are asked about, and how often, in `tests/unit/rowInfoClient.spec.ts`; the
cache and its **expiry**, many render passes during one slow request collapsing into
one request, a refusal that is cached without pausing the rows that were not
refused, the four-at-a-time cap and the `Retry-After` wiring in the *four things
that keep the per-row questions affordable* block of
`tests/unit/apiInjectRowInfo.spec.ts`, which counts requests against a fake network
shared with the trust-boundary specs next door; the pacer's own time invariants in
`tests/unit/pacer.spec.ts`, with the clock injected; and the refresh path from both
ends — that a press asks again immediately but does not become a licence to keep
asking, and that it keeps the answers already on screen, in
`tests/unit/rowInfoClient.spec.ts`, and that the button greys itself out for exactly
as long as the receiver would refuse it, in `tests/unit/renderRowInfo.spec.ts`. **The
freeze is asserted the same way**, because "the number does not move on its own" is a
claim about a thing that did move on its own until recently:
`tests/unit/renderRowInfo.spec.ts` renders the same answers ninety seconds apart and
asserts the cell still reads `3m 00s` and that the pass wrote nothing at all, and
`tests/unit/apiInjectRowInfo.spec.ts` asserts a cache hit is dated when the *data* was
read rather than when the reply was sent. A comment claiming a bound and
a test counting requests are not the same artefact, and this feature is the one place
in the repository where the difference is billable.

**It reads; it never writes.** There is no signal, no terminate, no reset, no
update anywhere in this project.

## Deep links, including per-activity ones

A link is a label and a URL template. Tokens are filled from the row:

`{workflowId}` `{runId}` `{workflowType}` `{namespace}` `{taskQueue}` `{status}`
`{startTimeIso}` `{startTimeMs}` `{startTimeSec}` `{endTimeIso}` `{endTimeMs}`
`{endTimeSec}` — and, on an activity, `{activityId}` `{activityType}`
`{activityAttempt}` `{activityScheduledIso}` `{activityScheduledMs}`
`{activityScheduledSec}`.

Time tokens take an offset — `{startTimeIso-10m}`, `{endTimeIso+1h}` — because the
window you want in a log tool is almost never exactly the workflow's own.

**A template's scope is derived from the tokens it uses, not configured.** A
template mentioning any activity token is an activity link and appears once per
activity on a workflow's page; everything else is a workflow link. So there is no
second list to maintain, no scope dropdown, and no way for the two to disagree —
and a misspelled `{activityTyp}` stays a *visible* unknown token on a
workflow-scoped link instead of silently moving the whole template to a page you
were not editing. `templateScope` in `src/links/deepLink.ts` is the whole of that rule.

A template that expands to something that is not `http(s)` does not become a link;
it is rendered inert, with the reason in its title.

## The links on a single workflow's page

Two sites, both **inside the UI's own layout**:

- the workflow-scoped links, in a bar beside the page's own tabs;
- the activity-scoped links, appended to the value of the row the UI labels
  **"Activity Id"**, in each activity panel the reader has opened.

**It fetches nothing.** Everything comes from the history and describe responses the
page fetched for itself, folded in the page's world by `src/detail/detailWatch.ts` and
posted across. No request, no cache, no pacing — and no ledger check, because a
ledger entry is authority to spend the page's bearer and this feature never spends
it.

The consequence is visible on screen, and it is the trade this stage is
demonstrating: on a tab that was already sitting on a workflow when the extension
loaded, the bar says it has observed nothing and asks for a reload. It does not go
and fetch the history to fill itself in.

Three decisions here are worth stealing:

- **An activity is identified by its id, never by its type.** A run that calls
  `ChargeCard` three times has three activities of that type, so a link keyed on the
  type opens a search that matches all three — and looks right while doing it.
  `activityByPanelId` in `src/detail/detail.ts` resolves the id the panel is showing to one
  activity: `activityId` first, `scheduledEventId` (which Temporal assigns, so it
  cannot repeat) as the fallback. An id that resolves to nothing gets **no link**,
  rather than a link built from whichever activity happens to be newest. When the id
  turns out not to be unique — a workflow author may reuse one — the link says so in
  its title, because that is the fact that decides whether the search results can be
  trusted. Each link also carries the activity's own `scheduled → closed` window, so
  a log tool that indexes neither id can still be narrowed to one execution.
- **Anchor to meaning, then make the failure visible.** Rule 1 in `src/render.ts`
  applies here as much as in the table: the tab bar is found as "the list containing a
  link to this workflow's history", and the activity row as "the row the UI labelled
  Activity Id" — the UI's own name for the field, not a class name or a position.
  This *is* the fragile kind of anchoring, and the extension behind this starter
  paid for it: when the selectors went stale the node was not missing, it was attached
  to `<body>` behind the app's own chrome, and it read as "the feature only appears
  after you toggle it". So a bar that cannot find the layout is parked in a corner
  where it can be **seen**, the popup reports that state in words, and every pass
  looks for the real anchor again and moves the bar inline the moment it appears.
  A first version of this file drew that corner box *deliberately*, on the argument
  that a workflow page has no anchor for "activity N" — and then, having nothing to
  attach a link to, printed a line telling the reader to add `{activityType}` to a
  template if they wanted per-activity links. A feature that explains how to
  configure itself, on the page where it could simply have worked, has given up.
- **Fold before posting, never after.** A raw history event carries `input`,
  `result` and `failure`. Posting the events across for the extension's side to
  reduce would put all of that on the page's message bus. `src/detail/detail.ts` keeps ids,
  type names, timestamps and attempt counts, and nothing else. Reduce at the
  boundary.

## Security card

Every project in this repository carries one of these, in a fixed shape so the
projects can be compared line by line.

| | 02 — techniques |
|---|---|
| **Permissions requested** | `storage`, and nothing else |
| **Host permissions** | none |
| **Runs on** | `https://cloud.temporal.io/*`, `http://localhost/*`, `http://127.0.0.1/*` |
| **Service worker** | none |
| **Data it reads** | the workflow-list response the page had already fetched; the table's own `href`s; the history and describe responses a single workflow's page fetches for itself; and, per running row, one history-reverse event and one workflow description. No cookies, no `localStorage`, nothing off the page's own settings |
| **Data it writes** | `chrome.storage.sync` — your toggles and link templates. No cookies, no `localStorage`, no files |
| **Requests it makes** | **yes — see below.** Up to two per *running* row, to the page's own Temporal API, paced and cached. Nothing else, to nowhere else |
| **Data that leaves the machine** | **none.** There is no codec server, no proxy and no outbound host in this build — and no setting that can add one. (A deep link sends only what you click, when you click it.) |
| **Payloads it decodes** | none. No workflow input, result or failure message is read, decoded or displayed anywhere in this project |
| **Credentials it holds** | none. It stores no token. The page's `Authorization` header is read in the page's world and re-sent to Temporal's own API only; it is not stored, posted to the extension, or logged — and no setting can change that |
| **Whose data it will fetch** | only the runs the server listed to this page, tracked per namespace. A request naming any other run is refused *before* the page's token is spent on it — see [the weakness](#the-weakness-and-what-closing-most-of-it-took) |
| **Third-party code in the bundle** | none. No runtime dependencies |

### The row that matters: it originates requests

**A permission diff is not a capability diff.** Going from 01 to 02 changed no
manifest key beyond `storage` — no `host_permissions`, no service worker, no new
match — and yet 02 crossed a line 01 does not: it makes requests of its own.

If you are reviewing this, that is the sentence to review. The argument that it is
nonetheless a small step:

- **It cannot reach anything the user could not.** The request goes to the same API
  the page is already driving, over the page's own session, and returns what the UI
  itself shows when you open that workflow. The column saves a hundred clicks; it
  does not widen access.
- **A host permission would not help, so none is asked for.** Chrome's
  documentation, verbatim: *"Cross-origin requests are always treated as such in
  content scripts, even if the extension has host permissions."* On Cloud the API is
  not even on `cloud.temporal.io` — it is on the per-tenant host — so the call is
  cross-origin for the page too, and succeeds only because that host names the
  page's origin. From the extension's world it would fail with any manifest. So the
  fetch lives in the page's world (`src/page/pageApi.ts`), where it is indistinguishable
  from one the UI would have made.
- **The API prefix is derived, never assumed.** It is cut from a URL the page was
  observed to fetch. Cloud and self-hosted differ here, and a hardcoded convention
  for either breaks silently on the other.
- **The token never leaves the page world, and reaches only Temporal.** It is
  remembered in one closure in `pageApi.ts` and attached to those two requests. It
  is never put in a `postMessage`, never written to storage, never logged, and there
  is no parameter, setting or message field that could send it anywhere else.
- **There is one gate, not one per feature.** `fetchForListedRun()` is the only
  route in this build to the page's `Authorization` header, and it performs the
  ledger check itself. A feature added later cannot forget to.
- **It answers only for a run the page itself listed.** See the next section: this
  is the part that took a rewrite.

### The weakness, and what closing most of it took

**The message bus is not authenticated.** `window.postMessage` carries no sender
identity that cannot be forged: `event.source === window` means "somebody in this
page", and that includes the Temporal UI, any npm dependency of it, and **any other
installed extension's content script**, which shares this page's DOM and message bus
with ours. `MESSAGE_SOURCE` and every field of the request are published in this
repository, so a shape check is not a gate — it says the message is well-formed and
nothing whatever about who sent it.

That matters because `pageApi.ts` holds authority its caller does not: the page's
origin and the page's own `Authorization` header. **The first version of this file
answered any `(namespace, workflowId, runId)` it was given** — a textbook confused
deputy. A forged message could spend your bearer on any workflow in any namespace
you happen to have access to, including ones you never opened, and receive the
answer on a channel the sender is listening to.

What closes it is not a shape check:

- **The ledger.** A question is answered only for a run the **page itself was
  handed**, in the namespace it was handed it under — learned by parsing the
  workflow-list *response*, in the same closure. Not from `inject.ts`'s `workflows`
  message, which is forgeable by the same script; the extra clone and parse per list
  load is the price of that distinction. The bound is "what this page already
  fetched", which is the bound the piggyback claims everywhere else in this
  repository.
- **Nothing else holds the token.** `fetchForListedRun` picks the origin itself and
  takes a *route builder*, not a URL. There is deliberately no second exported fetch
  in this build — nothing that posts to an address its caller chose. (03 adds that
  kind, for a codec server, and keeps it a separate function for exactly this
  reason: one carries the page's bearer to an origin this module picks, the other
  goes to an origin the caller picks and must therefore carry nothing.)
- **And in the other direction: an answer is kept only for a question this side
  asked.** The reply crosses the same unauthenticated bus, into the half that
  *renders*, so the same reasoning applies mirrored. `isRowInfoResult` validates
  every field to the leaves — before a review found it, it checked four of them, and
  `{lastEvent: 42}` type-checked its way to a property read in a template — and then
  `rowInfoClient.ts` drops anything whose `(namespace, workflowId, runId)` it did not
  ask about. Not authentication, which `postMessage` cannot provide; a narrowing that
  removes another extension's traffic, a reply replayed from a different namespace,
  and a forgery about a run you are not looking at. What a forger who reads our own
  request can still do is put a wrong event type in that row's cell.

**What is left, stated rather than omitted.** A script already in your page can
still make this extension spend requests it did not need — naming runs that *are* on
your screen, up to `MAX_RUNS_PER_REQUEST` at a time — and can read the answers off
the bus. Both halves are bounded to metadata about rows the page already fetched,
and any script that can send the message can read the same header out of the page's
fetch layer and ask Temporal itself, so this is quota noise rather than an
escalation. That is a genuinely weaker residual than the payload case in 03, and the
reason is worth naming: **this build never decodes anything, so there is no decoded
value for a forged message to be handed.**

Closing even the noise needs the request to arrive by a channel a page script cannot
write, which means `chrome.scripting.executeScript({world: 'MAIN'})` from a service
worker, and therefore `host_permissions` — the exact grant this repository is about
not asking for. That is a real trade, and the residual is written down here rather
than papered over: **a project that shows how to avoid permissions owes you the case
where the permission would have bought something.**

The tests worth reading first are in `tests/unit/apiInject.spec.ts`, the
`answering only for runs the page itself listed` block, written from the sender's
side. Each asserts that **no request reached the network**: being refused after the
bearer has been spent is not being refused.

### Enforced, not just claimed

```bash
npm run surface        # from the repository root
```

`scripts/surface.mjs` compares this project's manifest against the budget in
[`../scripts/surface.json`](../scripts/surface.json) and fails on a second
permission, any `host_permissions` entry, a service worker,
`web_accessible_resources`, `externally_connectable`, a runtime dependency, a
content-script match outside the three allowed hosts, and any of the markup/code
sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`,
`new Function`, string `setTimeout`/`setInterval`). Those are found by **parsing**
each file, so `cell['innerHTML'] = x` and an assignment wrapped over two lines are
caught, and the sentence you are reading is not mistaken for one.

Every value this extension writes reaches the DOM through `textContent`. That
matters more here than in 01: an activity type name and a workflow id are authored
by whoever started the workflow, and this extension renders them inside a page it
does not own.

### What has not been done

- **No third-party security review.** The mechanism comes from an extension used
  internally, but this code is a clean-room rewrite and nobody outside this
  repository has audited it.
- **The two request-backed features have NOT been confirmed on live Temporal Cloud.**
  The tree, the deep links and the detail-page links have; the last-event column and
  the retry badge are newer. Treat every claim above about how those two behave on a
  real tenant as **unverified** — the unit and jsdom specs are green, which on this
  project's own evidence is not the same thing. Two of those claims no spec could ever
  settle: the `⟳`'s 24px hit target and the negative margins meant to keep it from
  growing the header row are **layout**, and jsdom computes none. Nobody has yet looked
  at that button in a browser.

  The detail-page links used to be the weakest claim in that set, and are now the
  best-evidenced. Both DOM anchors on a workflow's page — the tab bar, and the row
  labelled "Activity Id" — were asserted only against a **hand-written** jsdom page in
  `tests/unit/detailLinks.spec.ts`, which proves the placement logic, the idempotency
  and the id resolution but cannot prove the real page still labels that field the way
  this code expects. They have now been read off live Cloud 2.53.3, and the markup is:

  ```html
  <div class="flex items-start gap-4">
    <p class="min-w-56 text-sm text-secondary/80">Activity ID</p>
    <p class="whitespace-pre-line break-all">9</p>
  </div>
  ```

  The label is a leaf `<p>`, it matches `LABEL_CANDIDATE_SELECTOR`, and its
  `nextElementSibling` holds the id — so the anchor lands, the bar reports
  `adrift: 0`, and the link's tooltip carries the resolved activity's type, status and
  schedule time. The live page also confirmed the prediction written into
  `detailLinks.ts` about why `div` is **not** in that selector: the wrapper div's own
  `nextElementSibling` is the *next field's* wrapper, whose text reads
  `Activity Type …`. Had `div` been included, every panel would have grown a link
  keyed off the wrong field.

  If a future Cloud release does move that label, the bar parks itself in the corner
  and the popup says so — which is the whole reason that state is visible instead of
  silent.

  What the same live round found instead was two ways for the link to be missing while
  every part of the machinery works, neither of them a selector.

  **The extension arrived too late.** Installed *after* the workflow tab had finished
  loading, the page carried no extension node at all and printed no log line. Chrome
  injects content scripts at page load and never goes back for tabs that are already
  open. That is a documented platform rule rather than a defect, but it presents
  identically to a broken extension, so the popup's "no answer from this tab" message
  now leads with the reload and the reason for it.

  **A new default never reached an existing user** — the one that survives every
  reload, and the reason this section exists. An activity link is only built if one of
  the configured templates names an activity token, and `links` is stored as one array
  that the popup rewrites whole. Anyone who used this extension before the activity
  template was added has a stored array without it, so `templatesInScope(links,
  'activity')` is legitimately empty and no per-activity link can exist — for good,
  because reloading restores exactly the array that was stored. `withActivityScope` in
  `src/settings.ts` now treats the *scope* as the default rather than the array, once,
  until a human edits the list. `tests/unit/settings.spec.ts` pins both directions.

  It is not the same thing because a live round here has found something every
  single time. One found the tree drawing perfectly while every per-row question
  answered *"Nothing observed on this page yet"*: this project installs a **second**
  `window.fetch` observer, and the page's own wrapper had evicted it. The tree kept
  working, because `inject.ts` holds the property through a getter — only the second
  observer went deaf, for the life of the tab, with nothing announcing it. The fix is
  the descriptor at the foot of `pageApi.ts`: it owns the property and *forwards* a
  later assignment down to `inject.ts`'s setter, so the page calls us, we call
  `inject.ts`, and `inject.ts` calls whatever the page installed. Another round found
  the payload panel — now 03's — closing the instant the pointer entered it, unusable
  for its actual purpose, with no unit test that could have said so. Each of those had
  a green suite behind it minutes earlier.
- **Rate-limit behaviour has not been observed in the wild.** The pacer is
  unit-tested against a synthetic 429 and a synthetic `Retry-After` with an injected
  clock, so "never more than four in flight, even coming out of a backoff" is an
  assertion rather than a claim (`tests/unit/pacer.spec.ts`), and the *wiring* — the
  header reaching the pacer, the pause applying to rows the server never refused,
  and the pause lifting rather than sticking — is asserted end-to-end through the
  fake network in `tests/unit/apiInjectRowInfo.spec.ts`. **No real Temporal rate limiter
  has answered any of it**, and a synthetic 429 is exactly as considerate as the
  person who wrote it. Worth saying plainly, because the first version of that code
  was inline in `rowInfoServe.ts`, untested, and wrong: it took its slot *after*
  sleeping out the backoff, so a 429 turned the queue into a crowd that all woke at
  once and burst straight past the limit of four. A review found it; no amount of
  reading the surrounding prose would have.
- **No supply-chain attestation.** Build it yourself; the bundle is unminified on
  purpose, so `dist/*.js` is readable.

## Layout

`src/` is grouped by lesson. Its root holds the bundle entry points — the three the
manifest loads plus the popup's, which is the list in `esbuild.mjs` — and the modules
every lesson touches; each directory below them is one thing the extension does. `src/family/` is stage 01 unchanged; everything else here
is new in this stage.

```
src/
  inject.ts         MAIN world — wraps window.fetch, posts the list rows it sees
  apiInject.ts      MAIN world — every message accepted from the page, in one switch
  content.ts        ISOLATED world — wiring, and nothing else
  popup.ts          the toolbar popup, including "is it working?"
  render.ts         the table: finding it, identifying rows, ordering families
  decoration.ts     every root class and shared name the writers use
  settings.ts       chrome.storage.sync
  types.ts          the shapes crossing the postMessage boundary
  page/             the boundary with the page's own Temporal API
    pageApi.ts      the bearer, the ledger, the response-watcher seam, and the ONLY
                    function in this build that issues a request
    temporalApi.ts  pure: the API prefix and the two route builders
    pacer.ts        concurrency cap + 429/503 backoff, with the clock injected
  family/           the tree, as pure functions — stage 01, unchanged
    rows.ts         API response → a flat row shape
    tree.ts         rows → ordered rows, each with its connector
  rowInfo/          the two features that cost a request
    rowInfo.ts      pure: the questions, the answers, and what a badge may say
    rowInfoClient.ts  ISOLATED world — which rows are worth asking about, and what
                    came back
    rowInfoServe.ts MAIN world — answers them: cache, then the pacer
    rowInfoRender.ts  the column and the badge, drawn from those answers
  links/
    deepLink.ts     URL templates: tokens, offsets, scope, and what may become an href
    linkRender.ts   the anchors — the only <a> this extension writes, both pages
  detail/           one workflow's own page
    detail.ts       pure: URL rules, the folds behind the links, and which activity
                    an id on the page resolves to
    detailWatch.ts  MAIN world — folds the page's own responses, fetches nothing
    detailLinks.ts  the links themselves, in the UI's own layout
public/
  manifest.json     one permission: storage
  popup.html        the settings pane (no inline script — MV3 forbids it)
  content.css       connectors, buttons, column, badge, link bar
  icons/            generated: this project's number and hue, not a committed image
tests/              the ordering rules, the DOM bugs that cost the most, and the
                    request gate — including the cases that fail SILENTLY
```

`find src -name '*.ts' | xargs wc -l` prints the size.

The split around the request path is deliberate, and it is what makes the security
card checkable: `src/rowInfo/rowInfo.ts` and `src/page/temporalApi.ts` are pure and
therefore testable, `src/page/pageApi.ts` is the only file that issues a request, and
the only files that write to the page are `render.ts`, the two `*Render.ts` modules it
calls, and `src/detail/detailLinks.ts` — plus one line in `src/content.ts`, which
toggles the master switch's class on `<html>` and writes nothing else.
`grep -rln 'createElement\|classList' src/` is the check; the one other name it returns
is `src/popup.ts`, which writes to the popup's own document and cannot reach the page at
all. Reviewing "what can this thing send" means reading one file.

## What it deliberately does not do

**No payload is decoded here** — that is the boundary of this stage, not an
omission. Input and result on hover, through a codec server, are
[`../03-payloads/`](../03-payloads/); column reorder, a larger page size, a
cross-workflow activity finder and expand-to-families are conveniences one rung
further up, and that stage is not in this repository yet.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle `src/` into `dist/`, copy `public/` over it |
| `npm run watch` | Rebuild on change (does **not** re-copy `public/`) |
| `npm test` | Unit + jsdom specs |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |

From the repository root, `npm run preflight` runs all of that for every project
at once, plus the gates — and reports anything it could not run as **UNVERIFIED**
rather than as a pass.
