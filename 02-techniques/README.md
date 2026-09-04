# 02 — techniques

Everything [`../01-family-tree/`](../01-family-tree/) does, plus the things teams ask for
within a day of installing it:

- **deep links to your own tools** — per-row buttons built from URL templates you type,
  with the workflow id, run id, type, status and a *widenable* time window;
- **the same links on a single workflow's own page**, and one set per activity the page
  mentioned, from the same templates;
- **a settings pane**, so all of the above is configuration rather than a fork;
- **two facts the workflow list does not carry** — what each running workflow did most
  recently, and whether one of its activities is stuck in a retry loop.

```
Workflow ID                                Last event ⟳                   Status
order-2601011200-01           Logs         3m 00s · ActivityTaskStarted   Running
 ├─ …-01-payment      ↻ 47    Logs         12s · ActivityTaskFailed       Running
 └─ …-01-fulfilment           Logs                                        Completed
```

The last two are the interesting ones, and not because they are hard: **they are the
first thing in this repository that makes a request of its own.** Everything in 01, and
the deep links here, read responses the page had already fetched. The column and the
badge ask Temporal questions the page never asked. That is a different trust argument,
and most of this file is about it.

Every feature has its own toggle, and there is a master switch that removes every node
this extension put on the page **and puts the row order back** — so "off" is verifiable,
not merely claimed.

**It still decodes no payload.** Nothing here reads a workflow's input, its result or a
failure message; everything on screen is derived from event *metadata* — event types,
ids, timestamps, attempt counts, activity type names. That boundary is what makes this
stage self-contained: no codec server, no egress, and no setting that could add one.
Payloads belong to the next rung, [`../03-payloads/`](../03-payloads/) — whose manifest
is identical to this one, which is the whole reason that rung is worth reading.

## Run it

```bash
npm install          # from the repository root, once
npm run build        # from this directory
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`02-techniques/dist/`. Open a workflow list, reload the tab, and click the toolbar icon:
the popup reports rows *seen* and rows *matched* separately, because "the extension is
not running" and "it ran and matched nothing" are different problems that look identical
on the page. It also reports how many runs this tab has asked Temporal about, because a
feature whose cost is invisible is a feature nobody can review. Two projects loaded at
once are distinguishable by their icons — each carries its own number and hue. The Node
range `npm install` needs is stated once, in
[the root README](../README.md#start-with-01).

## Read these files in order

Nearly all the growth over 01 serves one idea: **it asks Temporal questions of its own.**
To answer *"what does it ask, and who decides?"* — the only question that changes between
01 and 02 — read four files in this order.

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
render job used from two different pages. Then two specs:
[`tests/unit/apiInject.spec.ts`](tests/unit/apiInject.spec.ts), which asserts the gate
from the attacker's side — a page script trying to borrow the credential for a run it was
never handed, *without spending the bearer to find out* — and
[`tests/unit/render.spec.ts`](tests/unit/render.spec.ts), which asserts that a repeated
pass writes nothing new and that the master switch really does remove everything,
including the row order, which is the one edit that leaves nothing behind to find.

**The diff from 01 is smaller than the file count suggests, and that is the point.** Most
of 01's source is here byte-for-byte — the tree fold, the row index, the fetch hook and the
shared types — which `npm run lineage` enforces rather than claims. Two files changed.
`src/render.ts` was split: it kept the table plumbing and the three rules, handed the
drawing to the two modules above, moved the class names and render types to
[`src/decoration.ts`](src/decoration.ts) — which is what the master switch's completeness
now rests on — and states the left-to-right order of the controls sharing the workflow-id
cell, so that order cannot come out of which feature a given user switched on first. And
`src/content.ts` grew into the wiring for the settings, the request client and the
single-workflow page, while writing only the off-class on `<html>` and still calling no
`fetch`. Everything else is *new* here, in a directory named after the thing it does — see
**Layout** below.

## The two questions it asks Temporal

### "Last event" — a column beside the workflow id

For every **running** row: the newest history event, as an age and a type —
`3m 00s · ActivityTaskStarted`. One `GetWorkflowExecutionHistoryReverse` with
`maximumPageSize=1` per run, so a workflow with a hundred thousand events costs exactly
what a three-event one does. The reverse direction is the whole of it: asking the
*forward* route for one event returns the workflow's **first** event instead — the same
shape, a completely different fact, and no error anywhere to tell you.

The column sits immediately after the workflow id, which means its position is recomputed
on every pass from each row's own id cell. Two invariants make that safe, and
`syncLastEventColumn` in
[`src/rowInfo/rowInfoRender.ts`](src/rowInfo/rowInfoRender.ts) states them at the code: the
table has to stay rectangular, because a missing cell puts every header one column out from
its data, and the placement has to be idempotent, because moving a cell already in the
right place is a DOM write and a DOM write wakes the `MutationObserver` that triggered the
pass. The cell distinguishes `…` not asked yet, `!` asked and failed (reason in the title)
and `—` no events from the answer itself; all three otherwise look like an empty cell and
read as a broken extension.

**The age is exact to the second, and frozen at the reading.** Exact, because `4m 12s` and
`12s` say different things about the same `Running` status where `4m` and `now` do not.
Frozen, because the cell makes two claims and only the first is exact — *"event #42
happened 3m 00s ago"* and *"#42 is the newest event"* — so animating the subtraction over a
fact re-read every 35s renders a workflow that moved on two seconds ago as a stall
climbing convincingly to the second. Ages are measured against `observedAtMs`, the instant
Temporal was actually read, so the column changes when the data changes and at no other
time; the cost is that a stall reads up to one ask interval younger than it is. The format
is two units, floored, zero-padded — `47s`, `3m 07s`, `5h 12m`, `3d 04h` — because a third
unit pushes the UI's own columns off-screen, and `3m 9s` → `3m 10s` changes the cell's
*width* where tabular figures only fix the width of a digit.

The **`⟳` in the column header** re-asks Temporal now for every running row on screen,
as one flag (`fresh`) on the message the table world already sends rather than a new
message type — the number of message kinds the page world accepts is a thing a reviewer
counts. **The floor is on the receiving side**: `FRESH_FLOOR_MS` lives in
[`src/rowInfo/rowInfoServe.ts`](src/rowInfo/rowInfoServe.ts), not in the button, because
the button is one `postMessage` away from anything else in the page and a bound applied by
the caller is a bound only an honest caller keeps. A held-down refresh, or a script forging
the message in a loop, collapses into the same cache the automatic path uses; the button
greying itself out is the visible half of that rule, not the enforcement.

### "↻ 47" — the retrying-activity badge

A workflow whose activity has failed forty-seven times is still `Running`, and in the list
it looks exactly like one that is making progress. The badge is that number.

It needs `DescribeWorkflowExecution`, and **that is the justification for the whole
request path**: `pendingActivities` is returned by that call and by nothing else. It is
not in the list response, and it cannot be reconstructed from the history tail — an
activity on attempt 900 had its `ActivityTaskScheduled` event written ~900 events ago, so
a tail of any sane size misses exactly the workflows this badge exists to find. Attempt 1
never badges: it is the first, still-hopeful run of an activity, and badging it would put
a retry marker on every healthy workflow in the list. A workflow with several retrying
activities gets one badge, for the worst of them.

**The badge does not read the failure message, and will not.**
`pendingActivities[].lastFailure.message` sits directly beside `attempt`, and the internal
extension this starter reimplements does show it. Here it is declined: a failure message
is application data — it routinely carries account numbers, customer ids, upstream
response bodies — and it would be the one thing on screen a bystander must not read. The
attempt count, the activity **type** (a symbol from the workflow's own source) and the
next-retry time are enough to find a stuck workflow, and none of the three is anybody's
data. `activityId` is skipped for the same reason: unlike the type, it is chosen by the
caller, and it is regularly built out of a business identifier. The hover text says so in
place, so the omission is visible rather than merely intended.

### What the requests cost, and what bounds them

| Rule | Why |
|---|---|
| **Running rows only** | A closed workflow's last event and pending activities cannot change, so the request could never tell anyone anything. A list filtered to `Completed` makes no requests at all — this one filter is usually most of the saving. |
| **Rows the table is showing**, not the whole response | The page fetches more rows than it draws. |
| **One field, one call** | The two toggles are separate, so a user who wants only the column pays one request per running row and not two. |
| **Answers cached 30s** in the page world | `TTL_MS`, `src/rowInfo/rowInfoServe.ts`. |
| **Asked at most every 35s** per run in the table world | `ASK_INTERVAL_MS`, `src/rowInfo/rowInfoClient.ts`. The cache alone is not enough: a request answered *from* cache is still a `postMessage` per row per render pass, and there are a great many render passes. |
| **Four requests at a time** | `maxConcurrent`, `src/page/pacer.ts`. A hundred-row list becomes a queue, not a burst. |
| **429/503 backs off**, honouring `Retry-After` | 2s doubling to a 60s ceiling, or the server's own `Retry-After`. A rate limiter answered with a retry storm is how one tab degrades the API for a whole team. |
| **No polling timer, and no heartbeat at all** | Refresh comes from the Temporal UI polling its own list, which re-renders the table, which asks again — and the TTLs decide whether asking turns into fetching. The two timers left are one-shots that make no request: the pass scheduled after a `⟳` press to re-enable the button, and the backoff sleep, which exists to make *fewer* requests. |
| **A manual refresh is floored at 5s** per run | `FRESH_FLOOR_MS`. The `⟳` bypasses the 30s cache; this is the bound on how far, checked in the page world because the message asking for it can be posted by anything in the page. |

Every bound above is asserted rather than only described — which rows are asked about and
how often in `tests/unit/rowInfoClient.spec.ts`, the cache and cap and `Retry-After` wiring
in `tests/unit/apiInjectRowInfo.spec.ts` against a fake network that counts requests, the
pacer's time invariants in `tests/unit/pacer.spec.ts` with the clock injected, and the
freeze in `tests/unit/renderRowInfo.spec.ts`, which renders the same answers ninety seconds
apart and requires the cell to still read `3m 00s` with the pass writing nothing at all. A
comment claiming a bound and a test counting requests are not the same artefact.

**It reads; it never writes.** There is no signal, no terminate, no reset, no update
anywhere in this project.

## Deep links, including per-activity ones

A link is a label and a URL template. Tokens are filled from the row:

`{workflowId}` `{runId}` `{workflowType}` `{namespace}` `{taskQueue}` `{status}`
`{startTimeIso}` `{startTimeMs}` `{startTimeSec}` `{endTimeIso}` `{endTimeMs}`
`{endTimeSec}` — and, on an activity, `{activityId}` `{activityType}`
`{activityAttempt}` `{activityScheduledIso}` `{activityScheduledMs}`
`{activityScheduledSec}`.

Time tokens take an offset — `{startTimeIso-10m}`, `{endTimeIso+1h}` — because the window
you want in a log tool is almost never exactly the workflow's own.

**A template's scope is derived from the tokens it uses, not configured.** A template
mentioning any activity token is an activity link and appears once per activity on a
workflow's page; everything else is a workflow link. So there is no second list to
maintain, no scope dropdown, and no way for the two to disagree — and a misspelled
`{activityTyp}` stays a *visible* unknown token on a workflow-scoped link instead of
silently moving the whole template to a page you were not editing. `templateScope` in
`src/links/deepLink.ts` is the whole of that rule. A template that expands to something
that is not `http(s)` does not become a link; it is rendered inert, with the reason in its
title.

## The links on a single workflow's page

Two sites, both **inside the UI's own layout**: the workflow-scoped links in a bar beside
the page's own tabs, and the activity-scoped links appended to the value of the row the UI
labels **"Activity Id"**, in each activity panel the reader has opened.

**It fetches nothing.** Everything comes from the history and describe responses the page
fetched for itself, folded in the page's world by `src/detail/detailWatch.ts` and posted
across. No request, no cache, no pacing — and no ledger check, because a ledger entry is
authority to spend the page's bearer and this feature never spends it. The consequence is
visible on screen, and it is the trade this stage is demonstrating: on a tab that was
already sitting on a workflow when the extension loaded, the bar says it has observed
nothing and asks for a reload. It does not go and fetch the history to fill itself in.

Three decisions here are worth stealing:

- **An activity is identified by its id, never by its type.** A run that calls `ChargeCard`
  three times has three activities of that type, so a link keyed on the type opens a search
  matching all three — and looks right while doing it. `activityByPanelId` in
  `src/detail/detail.ts` resolves the id the panel is showing to one activity: `activityId`
  first, `scheduledEventId` (which Temporal assigns, so it cannot repeat) as the fallback.
  An id resolving to nothing gets **no link** rather than one built from whichever activity
  is newest, and an id that turns out not to be unique says so in its title, because that
  is the fact deciding whether the search results can be trusted.
- **Anchor to meaning, then make the failure visible.** The tab bar is found as "the list
  containing a link to this workflow's history", and the activity row as "the row the UI
  labelled Activity Id" — the UI's own name for the field, not a class name or a position.
  This *is* the fragile kind of anchoring, and the extension behind this starter paid for
  it: when the selectors went stale the node was not missing, it was attached to `<body>`
  behind the app's own chrome, and it read as "the feature only appears after you toggle
  it". So a bar that cannot find the layout is parked in a corner where it can be **seen**,
  the popup reports that state in words, and every pass looks for the real anchor again.
- **Fold before posting, never after.** A raw history event carries `input`, `result` and
  `failure`; posting the events across for the extension's side to reduce would put all of
  that on the page's message bus. `src/detail/detail.ts` keeps ids, type names, timestamps
  and attempt counts, and nothing else. Reduce at the boundary.

## Security card

Every project here carries one, in a fixed shape so the projects compare line by line.

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
| **Third-party code in the bundle** | three packages — `valibot`, `p-limit`, and `yocto-queue` behind it. See [Dependencies](#dependencies) |

### The row that matters: it originates requests

**A permission diff is not a capability diff.** Going from 01 to 02 changed no manifest
key beyond `storage` — no `host_permissions`, no service worker, no new match — and yet 02
crossed a line 01 does not: it makes requests of its own. If you are reviewing this, that
is the sentence to review. The argument that it is nonetheless a small step:

- **It cannot reach anything the user could not.** The request goes to the same API the
  page is already driving, over the page's own session, and returns what the UI itself shows
  when you open that workflow. The column saves a hundred clicks; it does not widen access.
- **A host permission would not help, so none is asked for.** Chrome's documentation,
  verbatim: *"Cross-origin requests are always treated as such in content scripts, even if
  the extension has host permissions."* On Cloud the API is not even on `cloud.temporal.io`
  — it is on the per-tenant host — so the call is cross-origin for the page too, and
  succeeds only because that host names the page's origin. From the extension's world it
  would fail with any manifest, so the fetch lives in the page's world, where it is
  indistinguishable from one the UI would have made. The API prefix is derived from a URL
  the page was observed to fetch, never assumed: Cloud and self-hosted differ, and a
  hardcoded convention for either breaks silently on the other.
- **The token never leaves the page world, and reaches only Temporal.** It is remembered in
  one closure in `pageApi.ts` and attached to those two requests — never put in a
  `postMessage`, never written to storage, never logged, with no parameter, setting or
  message field that could send it anywhere else.
- **There is one gate, not one per feature.** `fetchForListedRun()` is the only route in
  this build to the page's `Authorization` header, and it performs the ledger check itself.
  A feature added later cannot forget to.

### The weakness, and what closing most of it took

**The message bus is not authenticated.** `window.postMessage` carries no sender identity
that cannot be forged: `event.source === window` means "somebody in this page", and that
includes the Temporal UI, any npm dependency of it, and **any other installed extension's
content script**, which shares this page's DOM and message bus with ours. `MESSAGE_SOURCE`
and every field of the request are published in this repository, so a shape check is not a
gate — it says the message is well-formed and nothing whatever about who sent it.

That matters because `pageApi.ts` holds authority its caller does not: the page's origin
and the page's own `Authorization` header. **The first version of this file answered any
`(namespace, workflowId, runId)` it was given** — a textbook confused deputy. A forged
message could spend your bearer on any workflow in any namespace you happen to have access
to, including ones you never opened, and receive the answer on a channel the sender is
listening to. What closes it is not a shape check:

- **The ledger.** A question is answered only for a run the **page itself was handed**, in
  the namespace it was handed it under — learned by parsing the workflow-list *response*, in
  the same closure. Not from `inject.ts`'s `workflows` message, which is forgeable by the
  same script; the extra clone and parse per list load is the price of that distinction. The
  bound is "what this page already fetched", which is the bound the piggyback claims
  everywhere else in this repository.
- **Nothing else holds the token.** `fetchForListedRun` picks the origin itself and takes a
  *route builder*, not a URL, and there is deliberately no second exported fetch in this
  build — nothing that posts to an address its caller chose. (03 adds that kind, for a codec
  server, and keeps it a separate function for exactly this reason.)
- **And in the other direction: an answer is kept only for a question this side asked.** The
  reply crosses the same unauthenticated bus into the half that *renders*, so the same
  reasoning applies mirrored. `isRowInfoResult` validates every field to the leaves — before
  a review found it, it checked four of them, and `{lastEvent: 42}` type-checked its way to
  a property read in a template — and then `rowInfoClient.ts` drops anything whose
  `(namespace, workflowId, runId)` it did not ask about. Not authentication, which
  `postMessage` cannot provide; a narrowing that removes another extension's traffic, a
  reply replayed from a different namespace, and a forgery about a run you are not looking
  at.

**What is left, stated rather than omitted.** A script already in your page can still make
this extension spend requests it did not need — naming runs that *are* on your screen, up
to `MAX_RUNS_PER_REQUEST` at a time — and can read the answers off the bus. Both halves are
bounded to metadata about rows the page already fetched, and any script that can send the
message can read the same header out of the page's fetch layer and ask Temporal itself, so
this is quota noise rather than an escalation. That is a genuinely weaker residual than the
payload case in 03, and the reason is worth naming: **this build never decodes anything, so
there is no decoded value for a forged message to be handed.**

Closing even the noise needs the request to arrive by a channel a page script cannot write,
which means `chrome.scripting.executeScript({world: 'MAIN'})` from a service worker, and
therefore `host_permissions` — the exact grant this repository is about not asking for.
That is a real trade, and the residual is written down here rather than papered over: **a
project that shows how to avoid permissions owes you the case where the permission would
have bought something.** The tests worth reading first are the
`answering only for runs the page itself listed` block of
`tests/unit/apiInject.spec.ts`, written from the sender's side; each asserts that **no
request reached the network**, because being refused after the bearer has been spent is not
being refused.

### Enforced, not just claimed

```bash
npm run surface        # from the repository root
```

`scripts/surface.mjs` compares this project's manifest against the budget in
[`../scripts/surface.json`](../scripts/surface.json) and fails on a second permission, any
`host_permissions` entry, a service worker, `web_accessible_resources`,
`externally_connectable`, a content-script match outside the three allowed hosts, and any
of the markup/code sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write`, `eval`, `new Function`, string `setTimeout`/`setInterval`). Those are
found by **parsing** each file, so `cell['innerHTML'] = x` and an assignment wrapped over
two lines are caught, and the sentence you are reading is not mistaken for one.

Every value this extension writes reaches the DOM through `textContent`. That matters more
here than in 01: an activity type name and a workflow id are authored by whoever started
the workflow, and this extension renders them inside a page it does not own.

## Dependencies

| Package | Version | What it is for |
|---|---|---|
| `valibot` | 1.4.2 (MIT) | Runtime schema validation at every boundary — the page's own list, history and describe responses, the `postMessage` in both directions, and each stored settings object read back out of `chrome.storage.sync`. `safeParse` before any field is read, so a shape that changed is an `issues` list handled where it arrived. In all four bundles |
| `p-limit` | 7.3.2 (MIT) | The concurrency limit under the per-row questions: at most four requests to Temporal's API in flight at once, whatever the page's row count is. In `dist/apiInject.js` only — the page-world script is the only one that fetches |
| `yocto-queue` | 1.2.2 (MIT) | `p-limit`'s queue. It is in the bundle, though nothing of ours imports it |

**What stays ours** is the part a package cannot do. For `valibot`: the schemas, and the
fact that validating a message's shape says nothing about who sent it — `src/content.ts`
still checks `event.source` itself, and `fetchForListedRun()` still decides whose data may
be fetched. For `p-limit`: every rule that is about *Temporal* rather than about counting.
`src/page/pacer.ts` wraps the limiter and owns the whole policy — both forms of
`Retry-After`, the ceiling on how long a server may ask us to wait, the exponential fallback
when it asks for nothing, the rule that the longest overlapping block wins, that a success
during a block does not reset the doubling, and that resuming is not a burst.

The repository's dependency policy is in the [root README](../README.md#dependencies), and
the comparisons that chose these — including the one evaluation that ended in **no**
dependency — are in [`docs/design-notes.md`](../docs/design-notes.md#dependencies). This
table is hand-written: what stops a package arriving unreviewed is the `package-lock.json`
diff, `npm run measure` prints what each one currently costs each bundle, and the bundle is
unminified on purpose so `dist/*.js` is readable. Nothing here is attested beyond
`package-lock.json`'s integrity hashes.

## Layout

`src/` is grouped by lesson. Its root holds the bundle entry points — the three the
manifest loads plus the popup's, which is the list in `esbuild.mjs` — and the modules every
lesson touches; each directory below them is one thing the extension does. `src/family/` is
stage 01 unchanged; everything else here is new in this stage.

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

The split around the request path is what makes the security card checkable:
`src/rowInfo/rowInfo.ts` and `src/page/temporalApi.ts` are pure and therefore testable,
`src/page/pageApi.ts` is the only file that issues a request, and the only files that write
to the page are `render.ts`, the two `*Render.ts` modules it calls,
`src/detail/detailLinks.ts` and one line in `src/content.ts`.
`grep -rln 'createElement\|classList' src/` is the check; the one other name it returns is
`src/popup.ts`, which writes to the popup's own document and cannot reach the page at all.
**Reviewing "what can this thing send" means reading one file.**

## What it deliberately does not do

**No payload is decoded here** — that is the boundary of this stage, not an omission. Input
and result on hover, through a codec server, are [`../03-payloads/`](../03-payloads/). The
conveniences are one rung further up and that stage is not in this repository yet;
[the root README lists them](../README.md#stage-04-planned--the-conveniences).

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle `src/` into `dist/`, copy `public/` over it |
| `npm run watch` | Rebuild on change (does **not** re-copy `public/`) |
| `npm test` | Unit + jsdom specs |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |

From the repository root, `npm run preflight` runs all of that for every project at once,
plus the gates — and reports anything it could not run as **UNVERIFIED** rather than as a
pass.
