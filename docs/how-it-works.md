# How it works

No backend of ours, no credentials to configure or store, and — in
[`01-family-tree/`](../01-family-tree/) — no permissions at all. This document is the map: what runs where, why the design is
shaped like this, and which parts are the traps that cost real time to find.

There is exactly one server in this repository that is not the one the page is
already talking to: the codec server [`03-payloads/`](../03-payloads/) can send an
unreadable payload to, which you name yourself and which is empty by default. Every
other outbound byte in every project goes to the page's own Temporal.

Paths below are relative to a project directory. The mechanism is identical in
all of them, so read it against `01-family-tree/`, which has the least around it.

## The idea

The Temporal UI already asks the server for the data we want to draw. So instead
of authenticating and asking for it again, we watch the page make its own call
and read the answer over its shoulder.

**`01-family-tree` — one direction, and nothing goes back:**

```
                  ┌─────────────────────── the page's own world (MAIN) ───────┐
  Temporal UI ───▶│ window.fetch  ──▶ /api/v1/namespaces/{ns}/workflows       │
                  │      ▲                                                    │
                  │      │ wrapped by src/inject.ts at document_start          │
                  │      └── response.clone() ──▶ postMessage(location.origin) │
                  └──────────────────────────────┬───────────────────────────┬─┘
                                                 │                           │
                  ┌──────────────────────────────▼─── extension world ──────┐│
                  │ src/content.ts   receives rows                          ││
                  │   src/family/rows.ts    API shape → row shape                  ││
                  │   src/family/tree.ts    buildTree: order + connectors  (pure)   ││
                  │   src/render.ts  the only code that writes to the DOM    ││
                  └─────────────────────────────────────────────────────────┘│
                                                                             │
                  the page never sees anything from us ──────────────────────┘
```

**That last line, and "the only code that writes to the DOM", are true of `01`
only.** Both were once written as properties of the repository, which is the sort of
error this document exists to prevent: worlds, messages and DOM ownership are the
lesson here, so a diagram that overstates them teaches the wrong model. In `02` and
`03` the extension world *asks*, and the answers come back:

```
                  ┌─────────────────────── the page's own world (MAIN) ───────┐
  Temporal UI ───▶│ window.fetch ─▶ the API            src/inject.ts wraps it │
                  │                                                           │
                  │ src/apiInject.ts  installs the servers, and IS the list of │
                  │                   message types accepted from the page     │
                  │   src/page/pageApi.ts     the bearer, the ledger, both fetches  │
                  │   src/rowInfo/rowInfoServe.ts   one history page + one describe    │
                  │   src/payloads/payloadServe.ts   one history event  (03 only)       │
                  │                          └──▶ your codec server (03, opt-in)│
                  └──▲──────────────────────────────────────┬─────────────────┘
       'row-info-request'                        'row-info-result'
       'payload-request'  (03)                   'payload-result'  (03)
                     │                                      ▼
                  ┌──┴───────────────────────── extension world (ISOLATED) ──┐
                  │ src/content.ts   wiring                                   │
                  │   src/render.ts       the table: rows, order, cleanup     │
                  │     rowInfo/rowInfoRender.ts  the column and the badge    │
                  │     links/linkRender.ts       the deep-link anchors       │
                  │     payloads/payloadButton.ts the { } button   (03 only)  │
                  │   src/detail/detailLinks.ts  writes the workflow page's links     │
                  │   src/payloads/tooltip.ts      writes the hover panel   (03 only)   │
                  └──────────────────────────────────────────────────────────┘
```

Two things the `01` diagram does not have to say, and these two rungs do:

- **The page sees our messages, and can send them.** `postMessage` has no
  unforgeable sender, so every request arriving in MAIN world is treated as
  attacker-controlled — see the ledger, below, and the weakness section of each
  project's README.
- **More than one file writes to the DOM.** Three *surfaces*: `render.ts` and the
  `*Render.ts` modules it calls own the workflow table, `detailLinks.ts` owns the links
  on a single workflow's page, and `03`'s `tooltip.ts` owns the hover panel. They are
  separated by *what* they draw, not by whether they are allowed to draw — and every one
  writes into the DOM the page shares with us, which is why `03`'s panel has to erase
  its text rather than merely hide it. `cd 03-payloads && grep -rlnE 'createElement|classList' src/`
  prints the real list — the same command in any project, from that project's directory.
  Run it rather than trusting a count in prose.

Why the injected script has to be in the page's **own** world is the crux, and it
is easy to get backwards. An API call made from page JavaScript needs no
permission from us, because it *is* the page's call. The identical call made from
an extension content script is cross-origin as far as Chrome is concerned — and,
the part that surprises people, **a host permission does not change that**:
*"Cross-origin requests are always treated as such in content scripts, even if the
extension has host permissions."* Running in `"world": "MAIN"` is not a shortcut
around a permission; it is the only place the call works at all.

What that buys:

- **No `host_permissions`.** `01` issues no request whatsoever; `02` and `03` issue
  theirs from the page's world, where a host grant would buy nothing — including
  `03`'s call to a codec server, which is why naming one does not change the
  manifest. No project asks for a grant.
- **No credential of our own.** No API key, no bearer token, no mTLS certificate, in
  any project. `02` and `03` additionally *read* the page's own `Authorization`
  header, in the page's world, to re-issue the page's own call — see the split
  below. `03` never attaches it to the codec host, and has no setting that could.
- **Cloud and OSS, unchanged.** All of them drive the same API from the page.
- **It cannot reach data you could not already reach.** If the page was not allowed
  to fetch it, there is nothing to observe — and every request in `02` and `03` rides
  the page's session, so it can only reach what the page could have reached by
  clicking. That is a much easier sentence to defend in a security review than any
  design involving a token of its own. Note the word: **reach**, not *show*. `03`
  shows you more than the list page does, because it decodes what it fetched — a
  payload the page's own session was entitled to, put on screen without the trip
  through the workflow's own page.

**Where the three projects genuinely differ.** Several of the properties above are
often quoted as if they held for the whole repository. They do not, and the ladder is
worth nothing if the rungs are not distinguished:

| | `01` | `02` | `03` |
|---|---|---|---|
| Requests issued | none, ever | up to two per **running** row: one `history-reverse` page of one event, one `DescribeWorkflowExecution`. Cached, paced, never for a closed workflow | the same two, plus **one history event per question** — the first event for the input, the last for the outcome, so a *closed* row costs two and a *running* one costs one. Nothing on render; nothing without a pointer, and a question already in flight is joined rather than asked twice |
| Backend needed | none | none. `02` talks to exactly one server — the one the page is already talking to | none, until you name a codec server in the popup. That field is the only place a second host can come from, it starts empty, and while it is empty no payload byte leaves the machine |
| Payloads decoded | none | **none.** Everything it draws comes from event metadata: types, ids, timestamps, attempt counts, activity type names. No input, result or failure message is read | **yes — this is the stage where that boundary is crossed on purpose.** Plaintext encodings are decoded in the browser; the rest are shown as a byte count until a codec server is named. What lands on screen is application data, and can be personal |
| The page's `Authorization` header | never touched | held in one closure in `pageApi.ts`, attached to Temporal's own API and to nothing else. Never stored, never in a `postMessage`, never logged | the same closure, the same one route — and explicitly **not** the codec call, which is issued by a second exported function that takes its origin from a message and carries no credential of ours. There is no setting that could change that; the option was deleted rather than defaulted off |
| Instructions taken from the page | none — the MAIN-world half only ever *tells* the extension things | it **serves** `row-info-request` messages, which is a trust boundary in both directions. `postMessage` has no unforgeable sender, so the request cannot be the authority for what gets fetched (a per-namespace ledger of runs the page was actually handed is), and the `row-info-result` coming back cannot be trusted either — it is validated to the leaves and kept only if this side asked that exact question. Read [`../02-techniques/README.md`](../02-techniques/README.md#the-weakness-and-what-closing-most-of-it-took) before copying that half | the same ledger and the same validation, over **two** message types instead of one — and the second names an outbound host. What that leaves open, and what closing most of it took, is in [`../03-payloads/README.md`](../03-payloads/README.md#the-weakness-and-what-closing-most-of-it-took) |

What it costs, stated plainly:

- **We see a list when the page asks for one.** Nothing to observe means nothing
  to draw. The first paint is whatever the page fetched.
- **We depend on a URL shape**, `/api/v1/namespaces/{ns}/workflows`. If Temporal
  changes it, the extension stops seeing rows — quietly. `src/inject.ts` logs
  every list it observes for exactly this reason, so the failure has a distinct
  signature in the console rather than looking like an empty page. In `02` the same
  shape is load-bearing for *authorisation*, not only for drawing: a list nobody
  recognises fills no ledger, and every per-row question is then refused.

## The files

The first four exist in every project, byte-identical — enforced by
[`../scripts/lineage.json`](../scripts/lineage.json).

| File | What it is |
|---|---|
| `src/inject.ts` | MAIN world, `document_start`. Wraps `window.fetch`, clones matching responses, posts rows. In `01` it is the only file that touches the page's own JavaScript; in `02` and `03` it is the only one that touches the page's **`fetch`**, and `src/apiInject.ts` + `src/page/pageApi.ts` run in that world beside it. |
| `src/types.ts` | The shapes that cross the `postMessage` boundary. |
| `src/family/rows.ts` | API shape → row shape. Pure. |
| `src/family/tree.ts` | `buildTree` — the whole feature, as one pure function. Ordering, depth, connector columns. |

These differ per project, and the difference is the lesson:

| File | What it is |
|---|---|
| `src/content.ts` | ISOLATED world. Wiring: receives messages, drives a `MutationObserver`. No DOM writes at all in `01`; in `02` and `03` exactly one — the off-class on `<html>` that the master switch hangs its CSS on. In `01` it uses no `chrome.*` API at all; in `02` and `03` it also loads settings, answers the popup, and holds no repeating timer of any kind — the only one it schedules is a single pass `FRESH_FLOOR_MS` after a `⟳` press, to re-enable that button, because the "last event" ages are frozen at the instant Temporal was read rather than animated against the clock. In `03` it additionally drops the decoded-payload cache when the master switch goes off or the codec setting changes. |
| `src/render.ts` | The workflow table. In `01` it *is* every DOM write there is — one lesson, one file, and it takes no options because there are no settings to vary. In `02` and `03` it kept the table plumbing (find the `<tbody>`, identify a row, order the families, remove everything on the master switch) and handed the drawing to modules named after the lesson that added them: `src/rowInfo/rowInfoRender.ts` (the column and the badge — the only render job that writes outside the workflow-id cell), `src/links/linkRender.ts` (the anchors, used from two pages), and `03`'s `src/payloads/payloadButton.ts` (the `{ }` button, which carries no row identity on any attribute). The dependency points one way: `render.ts` imports them and passes row identity *in* as a function, so nothing that draws can reach back for the table. |
| `src/decoration.ts` | `02` and `03` only. The root class of everything drawn, plus every class two modules share and the render types they are handed — because a selector in one module and the node it is meant to find in another is how the two drift apart. It is what the master switch's completeness rests on: `removeAllDecoration()` in `render.ts` can only sweep the classes this file names, and several of them are on nodes that are not in the table at all — the two link sites on a single workflow's page in both projects, plus `03`'s payload panel. Not *every* class in the extension: a node that only exists inside one of these roots, or a modifier written onto one, is named locally by the file that draws it, because removing the root takes it away too. The rule is in the file's own header. |

`02-techniques/` and `03-payloads/` add `src/links/deepLink.ts` (templated per-row links,
pure), `src/settings.ts` (`chrome.storage.sync`) and `src/popup.ts` (the toolbar
popup, including an honest answer to "is it working?" — rows *seen* reported
separately from rows *matched*, so the two failure modes are distinguishable).

They also add the two features that ask Temporal something — the "last event"
column and the retrying-activity badge — and they are spread over several files for
one reason: exactly one of them is allowed to touch the network, and the rest are
pure enough to test.

| File | What it is |
|---|---|
| `src/page/pageApi.ts` | MAIN world. **The only file that issues a request**, and the only code that ever sees the page's `Authorization` header, which never leaves its closure. Holds the ledger, and the seam other features use to read a response the page fetched. |
| `src/apiInject.ts` | MAIN world, the second bundle. The entry point that installs the servers — and therefore the enumerable list of message types this extension accepts from the page: one in `02`, two in `03`. |
| `src/page/temporalApi.ts` | Pure. The API prefix, and the two route builders — nothing else may name a URL. |
| `src/rowInfo/rowInfo.ts` | Pure. The two questions, how to read their answers, and what a badge is allowed to say (see the no-failure-message note at the top of it). |
| `src/rowInfo/rowInfoServe.ts` | MAIN world. Answers the questions: the TTL cache, the concurrency cap and the backoff. Four times the size of the watcher below, entirely because it asks rather than piggybacks. |
| `src/rowInfo/rowInfoClient.ts` | ISOLATED world. Which rows are worth asking about — running only, on screen only, once per interval — and what came back. |
| `src/page/pacer.ts` | Pure, with the clock and the sleep injected: the concurrency cap and the `Retry-After` backoff, testable without a network. `02` builds its one instance inside `rowInfoServe.ts`; `03` moves the instance to `src/page/requestPacing.ts` — see below. |

And the deep links on a single workflow's own page, which fetch nothing at all:

| File | What it is |
|---|---|
| `src/detail/detail.ts` | Pure. Which URLs belong to one workflow, and the folds that reduce a history or describe response to ids, type names, timestamps and attempt counts — *before* anything is posted. |
| `src/detail/detailWatch.ts` | MAIN world. Subscribes to `pageApi.ts`'s watcher seam, folds, posts. No request, no cache, no ledger entry. |
| `src/detail/detailLinks.ts` | ISOLATED world. The drawing: workflow-scoped links in a bar beside the page's own tabs, activity-scoped links inside the row the UI labels "Activity Id" — resolved to one activity by its id, never by its type. The header of that file records the floating card it replaced, and why the fallback corner is a way-station rather than a design. |

`03-payloads/` adds one directory, `src/payloads/`, and one file inside
`src/page/`; the split inside it is the same one as above — every decision that can
be made without a network is made in a pure module, and the requests still go
through `pageApi.ts`, including the one to a host `pageApi.ts` had never heard of
until a message named it. The ones below carry the stage's reasoning; for the exact
set it adds, diff the two listings:

```bash
comm -13 <(cd 02-techniques/src && find . -name '*.ts' | sort) \
         <(cd 03-payloads/src && find . -name '*.ts' | sort)
```

| File | What it is |
|---|---|
| `src/payloads/payloads.ts` | Pure: what a payload **is**, and how it is shown. Which encodings are readable without any server and which are not; the event's payloads found by its **attributes key** rather than by `eventType`, because the type comes back as `WorkflowExecutionStarted` from one Temporal version and `EVENT_TYPE_WORKFLOW_EXECUTION_STARTED` from another while the attributes key is one string in both; and the formatting, including the rule that a JSON body containing a ≥16-digit integer is shown exactly as the server wrote it, because `JSON.parse` would silently round the id. |
| `src/payloads/codec.ts` | Pure, and **the file to read for "what can this send, and where?"**. The endpoint policy — `safeCodecEndpoint`, which takes `https` or loopback `http` and refuses anything that would stop `${endpoint}/decode` from being a path join — the plan of which payloads to send and how to re-attach the answers by position, the request itself, and the length check on the reply. Split out of `payloads.ts` so that question has one short answer rather than a section of a long file. |
| `src/payloads/payloadServe.ts` | MAIN world. The second server: one history event per question — the *first* event for an input, the *last* for an outcome — and then, only if something came back unreadable and only if you named an endpoint, one POST to it. |
| `src/payloads/tooltip.ts` | ISOLATED world, and **DOM only**: the panel element, the hover/focus gesture, and the pointer/scroll guards that traps 9 and 10 below are about. It asks `payloadClient.ts` a question and draws the answer; it holds no request state. |
| `src/payloads/payloadClient.ts` | ISOLATED world, and **state only**: one hover's outstanding request, the correlation check that throws away an answer to a question this side did not ask, the bounded cache of decoded payloads, and the invalidation when the master switch or the codec setting changes. Split from `tooltip.ts` for the same reason `codec.ts` was split from `payloads.ts` — the four invariants on an answer are worth reading without the panel's CSS in the way. |
| `src/payloads/payloadMessages.ts` | The two payload messages and their guards, and nothing else: the protocol as a file, so the trust boundary can be read without either side of it. |
| `src/payloads/valueGuards.ts` | The two narrowings the payload path shares. |
| `src/page/requestPacing.ts` | The pacer **instance**, module-level, imported by both servers. `02` did not need this file; read its header for why `03` does, and why a second `makePacer()` call would have been the bug that looked correct in both places. |

The split between `content.ts` and `render.ts` is not tidiness. It is what makes
the DOM behaviour unit-testable: the render specs drive `render.ts` against a jsdom
table in milliseconds, including the idempotency property that is impossible to
eyeball and expensive to get wrong. There are several of them, split by *what is
being drawn* rather than by which source file draws it — `render.spec.ts` for the tree
and the shared invariants, then `renderLinks.spec.ts`, `renderRowInfo.spec.ts` and, in
`03`, `renderPayloadButton.spec.ts`, all sharing one harness so that one file's idea of
what a row looks like cannot drift from another's.

**The specs named those seams before the source had them, and `02` and `03` have since
been split to match:** `renderRowInfo.spec.ts` now drives `src/rowInfo/rowInfoRender.ts`,
`renderLinks.spec.ts` drives `src/links/linkRender.ts`, `renderPayloadButton.spec.ts`
drives `src/payloads/payloadButton.ts`, and `render.spec.ts` keeps the tree, the shared
invariants and the one case that asserts the master switch removes every root it drew,
puts the row order back, and leaves the table as it found it. Each
module sits in the lesson directory that introduced it, so "what did this stage add?" is
answerable from a directory listing. `01`'s `render.ts` is deliberately *not* split — one
lesson, one file, and `wc -l 01-family-tree/src/render.ts` is the argument.

## Things that will bite you

Each of these cost hours in the internal extension whose lessons this starter
reimplements. They are commented at the site in the code; this is the index.

**1. `window.fetch` must be installed behind a getter — and must give the
assignment back.**
Temporal's UI reassigns `window.fetch` *after* `document_start`. A plain
`window.fetch = wrapped` is silently evicted moments after it lands, and the
symptom is not an error — it is a small fraction of page loads mysteriously
working. `Object.defineProperty(window, 'fetch', { get: () => wrapped })`
survives it, because the framework reads `window.fetch` fresh on every call.

The tempting next step — a setter that discards what the page assigns — is
wrong. `window.fetch` is a shared page global, and a monitoring library, a test
harness, a polyfill or the next release of the UI all legitimately wrap it; an
extension that quietly prevents that has broken something it does not own, in a
way nothing reports. So the setter **adopts** the new function as the underlying
fetch and keeps our wrapper outermost. What makes that harder than it sounds is
that the ordinary way to wrap fetch is a cycle:

```js
const next = window.fetch;           // ← reads OUR wrapper
window.fetch = (input, init) => next(input, init);   // ← which we then adopt
```

`src/inject.ts` breaks it three ways, and each one covers a case the others
cannot: a synchronous `delegating` flag, a `WeakSet` of responses so one response
is posted once no matter how many levels it travels back through, and an
in-flight ceiling for the shape a synchronous flag provably cannot see — a
wrapper that `await`s something *before* calling back in. Removing that last one
does not produce a failing test; it takes the test process down.

The ceiling is **two** counters, and the per-url one does the work. A recursion
re-requests the same url, so counting per url bounds it at three re-entries; a
global-only ceiling let it run to fifty, and those forty-seven extra hops are not
free — the wrapper being re-entered is the page's own or another extension's, and
if it logs, traces, reports or refreshes a token it does all of that fifty times
for one call the page made once. The global ceiling stays for the shape the per-url
count cannot see: a wrapper that **rewrites** the url on each hop (a cache-buster,
a retry with a changed query) looks like a fresh url every time. Both bounds are
asserted **exactly** rather than as "it terminates" — `tests/unit/inject.spec.ts`
pins the hop counts at 3 and at 50, so raising either has to be a deliberate edit
to a test line. "It terminates" was the whole assertion for a while, and it was
satisfied by fifty.

The trade, stated plainly: a page with more than three *identical* requests
genuinely in flight at once has its own wrapper skipped for the fourth, because
from inside the wrapper that is indistinguishable from a recursion. That costs its
wrapper one call.

Adoption holds **one** reference, which is fine for the page and not fine for a
second script of your own that wants to watch the same global — see trap 8, which
is what that costs.

**2. Every DOM write must be idempotent.**
A `MutationObserver` drives the render. An unconditional write wakes the
observer, which schedules another pass, which writes again. That is 100% of a CPU
core, forever. The fix is not a longer debounce — it is comparing before writing,
so a pass with nothing to do touches nothing at all. Every writer compares before
every single write — `render.ts`, each `*Render.ts` module it calls, `detailLinks.ts`
and `03`'s panel — and a spec asserts that a second pass produces zero mutation
records. The rule is stated once, at the top of `render.ts`, and it governs the
modules it calls as well: a module that draws is not exempt from it for being small.

**3. The UI recycles `<tr>` elements.**
The same DOM node is reused for a different workflow, with only the link
updated. Anything that caches identity on the element is wrong from that moment
on: the cached workflow id pairs with a freshly-read run id, every lookup misses,
and the tree silently renders flat. Read the `href` first, always.

**4. Key rows by (workflowId, runId), never by workflowId alone.**
One page can show several runs of one id — a workflow that was terminated and
re-run, a cron. Collapsing them attaches every child to every run, which
duplicates rows and breaks the mapping between the tree and the table.

The corollary is about lookups, not storage. A link in the table sometimes gives
you a workflow id with **no** run id, and if that id appears twice on the page
there is no correct answer. `src/family/rows.ts` marks such an id ambiguous and
`findPlacement` returns nothing for it, deliberately — the same refusal
`buildTree` makes when it cannot identify a parent. Returning the last run that
happened to be indexed would be a coin toss reported as a fact.

**5. `z-index: 0` on the connector overlay. Not `1`, not `-1`.**
At `1` the strokes paint over the table's sticky pagination bar. At `-1` they
disappear behind the row background, which looks exactly like a broken feature.

**6. An older list response can arrive after a newer one.**
Type in the filter box, or page forward before the first answer comes back, and
two list requests are in flight at once. Nothing about the order they *return* in
says which one the user is looking at, so rendering whichever lands last rebuilds
the table around a query nobody is on any more — and a reload makes it correct
again, which is the worst kind of bug to be told about. `src/inject.ts` stamps
each observed list with a generation at the moment its request is **issued**,
which is the only ordering that reflects what the user asked for, and
`src/content.ts` drops any response older than the newest it has already applied,
along with any response whose namespace is not the namespace of the page.

**7. A content script cannot make the request, and a host permission does not
help.**
This one is only about the requests `02-techniques` makes, and it is the trap most
likely to be met while *adding* a feature rather than while debugging one. From
Chrome's documentation, verbatim: *"Cross-origin requests are always treated as
such in content scripts, even if the extension has host permissions."* So a fetch
from the extension's world carries the extension's origin, which nobody has
allowed — and on Temporal Cloud the API is not on `cloud.temporal.io` at all. It is
on the per-tenant host, so the call is cross-origin *for the page too*, and it
succeeds for the page because that host names the page's origin in its
`Access-Control-Allow-Origin`.

Asking for a host permission to fix this does nothing but widen the extension's
manifest. The fix is to make the request from the **page's** world, where it is
indistinguishable from one the UI would have made itself. The same reasoning has a
useful pay-off later: any server already configured to accept the Temporal UI's
origin — a codec server, in `03` — needs no reconfiguration either.

Two things follow that are easy to get wrong. The API prefix must be **derived
from a URL the page was seen to fetch**, never assembled from `location.origin` or
a known convention, because Cloud and self-hosted differ there. And the request
needs the page's `Authorization` header on Cloud — cookies alone give a `403` — so
`pageApi.ts` remembers the header it saw on the list call and re-sends it,
without storing it, posting it, or logging it.

**8. Adoption has room for exactly one, so the second observer must own the
property — not sit in the slot.**
Found on a live tenant, not offline, and it is the sharpest example in this
repository of a failure that looks like a working extension. `02-techniques` has
two MAIN-world observers of `window.fetch`: `inject.ts` watches for list
responses, and `pageApi.ts` watches for the API prefix, the `Authorization` header
and the ledger. The second installed itself the way trap 1 says you may — a plain
assignment, which `inject.ts` adopts.

Then the page installs a wrapper of its own, which the Temporal UI does. It goes
through the same setter, into the same single `underlyingFetch` slot, and
**replaces the second observer**. What that looks like:

- the tree draws perfectly, on every row, because `inject.ts` is still outermost
  through its own getter;
- every per-row question answers *"Nothing observed on this page yet — reload the
  workflow list and try again."* — for the life of the tab, and reloading does
  not help, because the eviction happens again on the next load;
- no error, no warning, and each half of the extension looks correct in
  isolation.

The fix is for the later observer to take the property itself and **forward the
assignment to the previous owner's setter**, which keeps everyone in the chain:
the page calls `pageApi.ts`, which calls `inject.ts`, which calls whatever
the page installed. Swallowing the assignment instead would fix the symptom and
re-break what trap 1 exists to protect.

The general rule, worth more than the specific bug: **if two of your scripts
observe the same page global, exactly one of them can rely on being adopted.**
The other needs to own the property, and nothing about the working state
distinguishes the two arrangements until a third party joins in.
`02-techniques/tests/unit/apiInject.spec.ts` pins all three participants — the
second observer still sees the list, the tree still gets its rows, and the page's
own wrapper is still called — because the version that shipped satisfied only the
middle one.

**Traps 9 and 10 belong to `03-payloads`**, whose `src/payloads/tooltip.ts` is the hover
panel that shows a workflow's input and result. They are written up here rather than
in that project's own notes because neither is a fact about payloads: they are facts
about the pointer and scroll models, and they will bite the first floating panel you
build over a page you do not own. Neither `01` nor `02` has one: `02`'s deep links are
placed in the page's own layout and stay put, so nothing there depends on knowing
where the pointer is.

**9. `pointerout` fires between two children of the same element, and
`pointerenter` does not fire again to undo it.**
A hover panel you can put the pointer *into* — to scroll it, or to select text out
of it — needs to know when the pointer has really gone. `pointerout` is the
intuitive signal and it is the wrong one: it fires on **every** element-to-element
move, including heading→body inside the panel itself. Close on it and the panel
vanishes the moment the reader moves toward the text they wanted to read, which is
before they have read a word. The usual patch — cancel the close from
`pointerenter` on the panel — does not save it, because `pointerenter` does not
re-fire while the pointer moves between the panel's own descendants: the close is
scheduled with nothing left to cancel it.

`pointerover` is the event that knows. It fires for every element entered, it
bubbles, and so **one** delegated listener on the document can answer "where is the
pointer now": on a trigger → open; inside the panel → cancel any close in flight;
anywhere else → close. That leaves `pointerout` exactly one job, the case
`pointerover` cannot report — the pointer leaving the document, which is the only
time `relatedTarget === null`.

**10. A capture-phase `scroll` listener on `window` hears the panel's own
scrollbar.**
A `position: fixed` panel must close when the page scrolls, or it ends up pointing
at a row that has moved. `scroll` events do not bubble, so the listener has to be
`{ capture: true }` on the window to hear the scroller that actually moved — and
that is precisely why it also hears the panel's own `overflow: auto`. The result is
a panel that closes when you try to scroll it: the feature is intact and unusable,
for the one payload big enough to need it. The guard is one line — ignore a scroll
whose `target` is inside the panel — plus `overscroll-behavior: contain` in the CSS,
so that reaching the end of a long payload does not chain the rest of the wheel
gesture to the page and dismiss the panel that way instead.

Both of 9 and 10 shipped, both were found by hovering a live tenant rather than by a
test, and both are the same species of bug: **the pointer and scroll models are
about elements, and a panel is a subtree.**

The way they were finally pinned is the transferable part. One test per guard — the
`the panel under the pointer` block of
[`../03-payloads/tests/unit/tooltip.spec.ts`](../03-payloads/tests/unit/tooltip.spec.ts)
— and a **mutation audit** of that block, because its first version drove the
faithful browser sequence and stayed green against the broken handler: the
`pointerover` that follows a `pointerout` cancelled the close, so the test passed on
the strength of the *other* guard. Removing any single guard has to make a named test
fail, and the only way to know that is to remove each one and watch.

## Retargeting it

The four things most teams will want to change, in the order they will want to
change them:

1. **A different view** — replace `buildTree` with your own pure function over the
   same rows and draw whatever it returns. Ordering and decoration are already
   separated from the DOM plumbing, and `tests/unit/tree.spec.ts` shows how to
   pin the result without a browser.
2. **Deep links to your own tools** — in `02-techniques/` these are settings, not
   code. `src/links/deepLink.ts` lists the tokens, and offsets like `{startTimeIso-10m}`
   exist because the useful log window is never exactly the workflow's own start
   and end. A template has to expand to an absolute `http://` or `https://` URL:
   anything else — `javascript:`, `data:`, `file:` — gets no `href` at all, and
   the popup says so as you type it. The check runs on the **expanded** URL on
   every render pass, not on the template, because a template of just
   `{workflowId}` puts a value the extension does not control in the scheme
   position, and a workflow id is authored by whoever started the workflow.
3. **A different page** — the piggyback is not specific to the workflow list. The
   pattern is: match a URL in `inject.ts`, post the response, render it in the
   extension world. Any API call the page already makes is available to you on the
   same terms.
4. **Your own codec** — in `03-payloads/` this is a setting too, and the same
   endpoint your Temporal UI is already configured with will do: the request is
   `POST {endpoint}/decode` with an `X-Namespace` header, issued from the page's
   origin, which is the origin such a server already allows (trap 7 again). If your
   codec speaks a different shape, `src/payloads/payloads.ts` is the only file that needs to
   know — `codecDecodeCall` builds the request and `readCodecResponse` reads it, both
   pure. What the endpoint is allowed to *be* is deliberately narrow: `https`, or
   `http` on loopback only, because what comes back is decrypted.

## Permissions, in full

`01-family-tree` has no `permissions` key in its manifest. Not an empty array —
no key.

`02-techniques` has exactly one — and so does `03-payloads`:

```json
"permissions": ["storage"]
```

None of the three has `host_permissions`, `scripting`, `tabs`, `webRequest`,
`web_accessible_resources`, or a service worker.

Do not read that as "none of them makes a request". `02-techniques` makes up to two
per running row, from the page's own world, and no manifest key records it —
`host_permissions` would not help it and so is not asked for (trap 7 above).

And `03-payloads`'s manifest asks for exactly what `02`'s does: same one permission,
same three match patterns, no new key of any kind — the diff is the name, the
description, the version and the button's tooltip. What it gained over
`02` is a request per question asked, decoded application data on screen, and — once you type
a codec endpoint into its popup — **an outbound host that is not Temporal's**. Every
one of those rides the page's world, so there is nothing for a manifest to declare.
**A permission diff is not a capability diff**, and `02`→`03` is the sharpest example
of it in this repository; what those requests are is in "What leaves your machine".

The content scripts are declared
against `https://cloud.temporal.io/*`, `http://localhost/*` and
`http://127.0.0.1/*`; a self-hosted UI on another hostname needs that hostname
added to the project's `public/manifest.json` **and** to the allowlist in
[`../scripts/surface.json`](../scripts/surface.json), and Chrome will ask you to
approve the change when you reload the extension.

Note that Chrome match patterns ignore the port, so the localhost entries cover
any port — including any *other* application you happen to be running on
localhost. The injected wrapper on such a page does nothing but forward calls to
the original `fetch` and test each URL against one regex, but if that footprint
is unwelcome, delete the two localhost lines and keep Cloud only.

## What leaves your machine

From `01-family-tree`: nothing. There is no outbound request, no storage, and no
link to click.

From `02-techniques`, three things, each of which you asked for:

- `chrome.storage.sync` holds your toggles and your link templates. **Chrome
  uploads that to your Google account** if you are signed in, so treat those fields
  like anything else you type into a synced browser setting — in particular, do not
  embed a key in one.
- A deep link opens the URL you configured, carrying the workflow id and time
  window you told it to carry. Those links are marked `rel="noopener noreferrer"`
  and `referrerpolicy="no-referrer"`, so the destination gets what is in the URL
  and not a handle on the Temporal tab or the namespace it came from. Nothing is
  ever sent on render — only on a click. And only `http://` and `https://` URLs
  are ever given an `href`, so a template cannot turn a per-row button into a
  `javascript:` URL running inside the Temporal page.
- **Two questions to your own Temporal, per running row.** One page of one event
  from `history-reverse`, for the "last event" column; one `DescribeWorkflowExecution`,
  for the retrying-activity badge. Both go to the same API the page is already using,
  with the page's own session, and **nowhere else** — there is no other outbound host
  in this project, and no setting that could add one. This is data you can already
  read in the UI by opening the workflow; the column saves the click, it does not
  widen the access.

  What bounds the cost: closed rows are never asked about (their answers cannot
  change), only rows the table is showing are asked about, answers are cached, four
  requests run at a time, and a `429`/`503` backs off instead of retrying. The two
  features have separate toggles, so one of them costs one request per running row
  rather than two. The popup reports the running total, because a cost you cannot see
  is a cost nobody reviews.

  The `⟳` in the column header re-asks now rather than on the cache's schedule, and
  that is the only way to make this extension fetch faster than it chose to. It is
  bounded to one round per run per five seconds, and the bound is enforced where the
  request is made rather than where the button is, because a page can post that
  message too. That button is the *only* thing that moves an age. The ages are exact
  to the second but **frozen at the instant Temporal was read** — every one is
  measured from the cache entry's own `observedAtMs`, not from the clock, and the
  hover text dates it and says so. There is no ticker: the cell is a function of its
  answers, so a pass over unchanged answers writes nothing. The trade is deliberate
  and it errs the safe way — a genuine stall reads *younger* than it is, by up to one
  ask interval, where an animated age would have shown a stall that had already ended.

  **No payload is decoded, anywhere.** Everything on screen is metadata — an event
  type, an event id, a timestamp, an attempt count, an activity type name. In
  particular the retry badge does **not** read `lastFailure.message`, which sits
  directly beside the attempt count it does read: a failure message is application
  data, and this project's claim is that it never reads any. `03-payloads` is where
  that boundary is deliberately crossed — next.

From `03-payloads`: the three above, and two more. The permission surface is the
same, so no permission marks the difference:

- **One more question to your own Temporal, per question asked.** A single history
  event each: the first one for a workflow's input, the last one for its outcome — so a
  hover on a *closed* row costs two requests and a hover on a *running* one costs one,
  because it has no outcome to ask about. Nothing on render — the `{ }` button costs
  nothing until a pointer rests on it — and a question already in flight is joined
  rather than asked again, which matters because a click on the button fires `focusin`
  and `click` and both open the panel. The same ledger authorises it, the same pacer
  paces it, and the answers are cached per `(namespace, workflowId, runId, kind)` in a
  bounded cache that the payload switch and the master switch both empty, because what
  that cache holds is decoded personal data rather than an event id.
- **The payload itself, to the codec server you named — and to nowhere else.** This is
  the only **non-navigation** request the extension initiates to a host other than the
  page's Temporal API, and the only one that carries a body. A deep link reaches another
  host too — following a link is a request like any other — but only through a URL you
  chose to click. This one exists only after you type a host into the popup:

  - **Empty by default.** With no endpoint, unreadable payloads are shown as a byte
    count and a sentence saying so. Nothing is sent, nothing is guessed from the
    namespace, and nothing is read out of the Temporal UI's own codec setting — the
    field in the popup is the only place an endpoint can come from.
  - **Only what cannot be read locally.** A plaintext payload is decoded in the
    browser and never sent, including a plaintext one sitting beside an encrypted one
    in the same request.
  - **`https`, or `http` on loopback.** Nothing else is accepted, because the response
    is decrypted data.
  - **Never with any credential.** The codec call goes out through a different
    function from the one that spends the page's bearer, and that function's own type
    has no `credentials` field and refuses an `Authorization` or cookie header outright
    — not a default, a thing it cannot express. A codec server that authenticates its
    callers simply cannot be used from here, and the panel says so when it answers
    `401`.
  - **Only on a hover, through this extension's own UI.** No egress on render, no egress
    on scroll, no background refresh. A script already running in the page can forge the
    request without any gesture; that is the weakness section's subject, not this list's.

  What that means in plain terms: **a codec server you name can see decrypted
  workflow payloads for the runs you hover.** That is the point of the feature, and it
  is the reason this one setting is off until you fill it in while every other feature
  in this repository ships on. [`../03-payloads/README.md`](../03-payloads/README.md#the-row-that-matters-data-leaves-the-browser)
  states the same thing in the security card, and its
  [weakness section](../03-payloads/README.md#the-weakness-and-what-closing-most-of-it-took)
  says what a hostile page can still do with that field.

There is no analytics and no telemetry in any project. To check rather than
believe:

```bash
grep -rniE 'fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource' \
  01-family-tree/src 02-techniques/src 03-payloads/src
```

Named in full because there is no `src/` at the repository root, and
case-insensitively, or the wrapper named `pageFetch` hides from the grep meant to
find it. In `01-family-tree` every hit is `window.fetch`, the page's own —
captured, wrapped, and called on the page's behalf so its result can be handed
straight back to it. In `02-techniques` most of the hits are comments *about* not
fetching; the ones that are code are in `src/inject.ts` (the same wrapper as `01`)
and `src/page/pageApi.ts`, which captures the page's `fetch` once as `pageFetch` and calls
it in exactly two places: to pass the page's own request through untouched, and to ask
one of the two questions in `src/rowInfo/rowInfo.ts` about a run the ledger has authorised.

`03-payloads` is the same two files — and that is the useful part of the check, since
the payload feature adds no third holder of the page's `fetch`. `pageApi.ts` there
calls `pageFetch` in three places rather than two, and the third is the whole
difference between the stages: a URL that came from a message rather than from the
ledger, sent with no `Authorization` header. Which of the two functions a caller
reaches is therefore the security question in that project, and it is why they are
separate exports with the reasoning written between them.

Nothing else in any project touches the network: there is no `XMLHttpRequest`,
`sendBeacon`, `WebSocket` or `EventSource` anywhere.
