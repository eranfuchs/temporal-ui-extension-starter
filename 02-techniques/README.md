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
Workflow ID                                Status     Last event
order-2601011200-01           Logs         Running    3m · ActivityTaskStarted
 ├─ …-01-payment      ↻ 47    Logs         Running    12s · ActivityTaskFailed
 └─ …-01-fulfilment           Logs         Completed
```

The last two are the interesting ones, and not because they are hard: **they are
the first thing in this repository that makes a request of its own.** Everything
in 01, and the deep links here, read responses the page had already fetched. The
column and the badge ask Temporal questions the page never asked. That is a
different trust argument, and most of this file is about it.

Every feature has its own toggle, and there is a master switch that removes every
node this extension put on the page — so "off" is verifiable, not merely claimed.

**It still decodes no payload.** Nothing here reads a workflow's input, its result
or a failure message; everything on screen is derived from event *metadata* — event
types, ids, timestamps, attempt counts, activity type names. That boundary is what
makes this stage self-contained: no codec server, no egress, and no setting that
could add one. Payloads belong to the next rung, `03-goodies`, which is not in this
repository yet.

## Run it

```bash
npm install          # from the repository root, once — needs Node >= 22
npm run build        # from this directory
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`02-techniques/dist/`. Open a workflow list, reload the tab, and click the toolbar
icon: the popup reports rows *seen* and rows *matched* separately, because "the
extension is not running" and "it ran and matched nothing" are different problems
that look identical on the page. It also reports how many runs this tab has asked
Temporal about, because a feature whose cost is invisible is a feature nobody can
review.

Two projects loaded at once are distinguishable by their icons — each carries its
own number and hue.

## The two questions it asks Temporal

### "Last event" — a column appended to the list

For every **running** row: the newest history event, as an age and a type —
`3m · ActivityTaskStarted`. One
`GetWorkflowExecutionHistoryReverse` with `maximumPageSize=1` per run, so a
workflow with a hundred thousand events costs exactly what a three-event one does.

The reverse direction is the whole of it. Asking the *forward* route for one event
returns the workflow's **first** event instead — the same shape, a completely
different fact, and no error anywhere to tell you.

The column is **appended**, never inserted. A column pushed into the middle would
have to agree with the header's own column order, and the Temporal UI lets the user
reorder and hide columns; appending needs to agree with nothing.

The cell has to distinguish four states, and all four look like an empty cell if
you let them: `…` not asked yet, `!` asked and it failed (with the reason in the
title), `—` answered with no events, and the answer itself. The first three are the
ones that get mistaken for a broken extension.

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
internal extension this starter was extracted from does show it. Here it is
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
| **Answers cached 30s** in the page world | Set in `TTL_MS`, `src/rowInfoServe.ts`. |
| **Asked at most every 35s** per run in the table world | `ASK_INTERVAL_MS`, `src/rowInfoClient.ts`. The cache alone is not enough: a request answered *from* cache is still a `postMessage` per row per render pass, and there are a great many render passes. |
| **Four requests at a time** | `MAX_CONCURRENT`. A hundred-row list becomes a queue, not a burst. |
| **429/503 backs off**, honouring `Retry-After` | 2s doubling to a 60s ceiling. A rate limiter answered with a retry storm is how one tab degrades the API for a whole team. |
| **No timer anywhere** | Refresh comes from the Temporal UI polling its own list, which re-renders the table, which asks again — and the TTLs decide whether asking turns into fetching. Nothing here polls on its own. |

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
were not editing. `templateScope` in `src/deepLink.ts` is the whole of that rule.

A template that expands to something that is not `http(s)` does not become a link;
it is rendered inert, with the reason in its title.

## The card on a single workflow's page

Bottom-right, collapsible: the workflow-scoped links once, then the activity-scoped
links for each activity the page's own history mentioned, newest first.

**It fetches nothing.** Everything in it comes from the history and describe
responses the page fetched for itself, folded in the page's world by
`src/detailWatch.ts` and posted across. No request, no cache, no pacing — and no
ledger check, because a ledger entry is authority to spend the page's bearer and
this feature never spends it.

The consequence is visible on screen, and it is the trade this stage is
demonstrating: on a tab that was already sitting on a workflow when the extension
loaded, the card says it has observed nothing and asks for a reload. It does not go
and fetch the history to fill itself in.

Two decisions in it are worth stealing:

- **A floating card, not buttons in the event table.** Rule 1 in `src/render.ts` is
  *anchor to meaning, not position*, and the list has a perfect anchor:
  `a[href*="/workflows/"]` is what a row **is**. A workflow's own page has no
  equivalent for "the row of activity N" — the timeline is SVG, the event list is
  virtualised, and neither carries a stable hook. Anchoring there is a guess that
  breaks on the next UI release. The extension this starter came from learned it
  expensively: a button whose selectors had gone stale was not missing, it was
  attached to `<body>` behind the app's own chrome, and it read as "the feature only
  appears after you toggle it". A deliberate fixed position is the honest version of
  what that bug produced by accident.
- **Fold before posting, never after.** A raw history event carries `input`,
  `result` and `failure`. Posting the events across for the extension's side to
  reduce would put all of that on the page's message bus. `src/detail.ts` keeps ids,
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
  fetch lives in the page's world (`src/pageApi.ts`), where it is indistinguishable
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
- **The two request-backed features and the detail card have NOT been confirmed on
  live Temporal Cloud.** The tree and the deep links have; these are newer. Treat
  every claim above about how they behave on a real tenant as **unverified** —
  the unit and jsdom specs are green, which on this project's own evidence is not
  the same thing.

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
- **Rate-limit behaviour has not been observed in the wild.** The backoff is
  implemented and unit-tested against a synthetic 429; no real Temporal rate limiter
  has answered it.
- **No supply-chain attestation.** Build it yourself; the bundle is unminified on
  purpose, so `dist/*.js` is readable.

## Layout

```
src/
  inject.ts         MAIN world — wraps window.fetch, posts the list rows it sees
  pageApi.ts        MAIN world — the bearer, the ledger, the response-watcher seam,
                    and the ONLY function in this build that issues a request
  apiInject.ts      MAIN world — every message accepted from the page, in one switch
  rowInfoServe.ts   MAIN world — answers the per-row questions: cache, pacing, backoff
  detailWatch.ts    MAIN world — folds a single workflow's own responses, fetches nothing
  types.ts          the shapes crossing the postMessage boundary
  rows.ts           API response → a flat row shape
  tree.ts           the feature, as a pure function: rows → ordered rows
  rowInfo.ts        pure: the questions, the answers, and what a badge may say
  rowInfoClient.ts  which rows are worth asking about, and what came back
  detail.ts         pure: URL rules and the folds behind the detail card
  deepLink.ts       URL templates: tokens, offsets, scope, and what may become an href
  temporalApi.ts    pure: the API prefix and the two route builders
  render.ts         everything that writes to the table
  detailCard.ts     the card on a single workflow's page
  content.ts        ISOLATED world — wiring, and nothing else
  settings.ts       chrome.storage.sync
  popup.ts          the toolbar popup, including "is it working?"
public/
  manifest.json     one permission: storage
  popup.html        the settings pane (no inline script — MV3 forbids it)
  content.css       connectors, buttons, column, badge, card
  icons/            generated: this project's number and hue, not a committed image
tests/              the ordering rules, the DOM bugs that cost the most, and the
                    request gate — including the cases that fail SILENTLY
```

`wc -l src/*.ts` prints the size.

The split around the request path is deliberate, and it is what makes the security
card checkable: `rowInfo.ts` and `temporalApi.ts` are pure and therefore testable,
`pageApi.ts` is the only file that issues a request, and `render.ts` and
`detailCard.ts` are the only ones that touch the page. Reviewing "what can this
thing send" means reading one file.

## What it deliberately does not do

**No payload is decoded here** — that is the boundary of this stage, not an
omission. Input and result on hover, through a codec server, plus column reorder, a
larger page size, a cross-workflow activity finder and expand-to-families, belong to
`03-goodies`, which is not in this repository yet.

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
