# How it works

No backend, no credentials to configure or store, and — in
[`01-family-tree/`](../01-family-tree/) — no permissions at all. This document is the
map: what runs where, why the design is shaped like this, and where the traps are.

There is exactly one server in this repository that is not the one the page is already
talking to: the codec server [`03-payloads/`](../03-payloads/) can send an unreadable
payload to, which you name yourself and which is empty by default. Every other outbound
byte in every project goes to the page's own Temporal.

Paths below are relative to a project directory. This walkthrough covers `01`, `02` and
`03`; `04` changes nothing in the mechanism — it renders, reorders and copies answers the
earlier rungs already had — and is described in its own README. The mechanism is
identical in all of them, so read it against `01-family-tree/`, which has the least
around it.

## The idea

The Temporal UI already asks the server for the data we want to draw. So instead of
authenticating and asking for it again, we watch the page make its own call and read
the answer over its shoulder.

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

**That last line, and "the only code that writes to the DOM", are true of `01` only.**
In `02` and `03` the extension world *asks*, and the answers come back:

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

- **The page sees our messages, and can send them.** `postMessage` has no unforgeable
  sender, so every request arriving in MAIN world is treated as attacker-controlled —
  see the ledger, below, and the weakness section of each project's README.
- **More than one file writes to the DOM.** Three *surfaces*: `render.ts` and the
  `*Render.ts` modules it calls own the workflow table, `detailLinks.ts` owns the links
  on a single workflow's page, and `03`'s `tooltip.ts` owns the hover panel. Every one
  writes into the DOM the page shares with us, which is why `03`'s panel has to erase
  its text rather than merely hide it.
  `cd 03-payloads && grep -rlnE 'createElement|classList' src/` prints the list.

Why the injected script has to be in the page's **own** world is the crux. An API call
made from page JavaScript needs no permission from us, because it *is* the page's call.
The identical call made from an extension content script is cross-origin as far as
Chrome is concerned — and **a host permission does not change that**: *"Cross-origin
requests are always treated as such in content scripts, even if the extension has host
permissions."* Running in `"world": "MAIN"` is not a shortcut around a permission; it is
the only place the call works at all.

What that buys:

- **No `host_permissions`.** `01` issues no request whatsoever; `02` and `03` issue
  theirs from the page's world, where a host grant would buy nothing — including `03`'s
  call to a codec server, which is why naming one does not change the manifest.
- **No credential of our own.** No API key, no bearer token, no mTLS certificate, in
  any project. `02` and `03` *read* the page's own `Authorization` header, in the
  page's world, to re-issue the page's own call. `03` never attaches it to the codec
  host, and has no setting that could.
- **Cloud and OSS, unchanged.** All of them drive the same API from the page.
- **It cannot reach data you could not already reach.** If the page was not allowed to
  fetch it, there is nothing to observe — and every request in `02` and `03` rides the
  page's session, so it can only reach what the page could have reached by clicking.
  **Reach**, not *show*: `03` shows you more than the list page does, because it decodes
  what it fetched — a payload the page's own session was entitled to, put on screen
  without the trip through the workflow's own page.

**Where the three projects differ:**

| | `01` | `02` | `03` |
|---|---|---|---|
| Requests issued | none, ever | up to two per **running** row: one `history-reverse` page of one event, one `DescribeWorkflowExecution`. Cached, paced, never for a closed workflow | the same two, plus **one history event per question** — the first event for the input, the last for the outcome, so a *closed* row costs two and a *running* one costs one. Nothing on render; nothing without a pointer; a question already in flight is joined rather than asked twice |
| Backend needed | none | none — the one server the page is already talking to | none, until you name a codec server in the popup. That field is the only place a second host can come from, it starts empty, and while it is empty no payload byte leaves the machine |
| Payloads decoded | none | **none.** Everything it draws comes from event metadata: types, ids, timestamps, attempt counts, activity type names | **yes — this is the stage where that boundary is crossed on purpose.** Plaintext encodings are decoded in the browser; the rest are shown as a byte count until a codec server is named. What lands on screen is application data, and can be personal |
| The page's `Authorization` header | never touched | held in one closure in `pageApi.ts`, attached to Temporal's own API and to nothing else. Never stored, never in a `postMessage`, never logged | the same closure, the same one route — and explicitly **not** the codec call, which is issued by a second exported function that takes its origin from a message and carries no credential of ours |
| Instructions taken from the page | none — the MAIN-world half only ever *tells* the extension things | it **serves** `row-info-request` messages, which is a trust boundary in both directions: the request cannot be the authority for what gets fetched (a per-namespace ledger of runs the page was actually handed is), and the `row-info-result` coming back is validated to the leaves and kept only if this side asked that exact question. See [`../02-techniques/README.md`](../02-techniques/README.md#the-weakness-and-what-closing-most-of-it-took) | the same ledger and the same validation, over **two** message types instead of one — and the second names an outbound host. See [`../03-payloads/README.md`](../03-payloads/README.md#the-weakness-and-what-closing-most-of-it-took) |

What it costs:

- **We see a list when the page asks for one.** Nothing to observe means nothing to
  draw. The first paint is whatever the page fetched.
- **We depend on a URL shape**, `/api/v1/namespaces/{ns}/workflows`. If Temporal
  changes it, the extension stops seeing rows — quietly. `src/inject.ts` logs every
  list it observes, so the failure has a distinct signature in the console rather than
  looking like an empty page. In `02` the same shape is load-bearing for
  *authorisation*: a list nobody recognises fills no ledger, and every per-row question
  is then refused.

## The files

The first four exist in `01`, `02` and `03` byte-identical. `04` keeps `inject.ts` and
`tree.ts` identical too, and forks `src/types.ts` and `src/family/rows.ts` to carry root identity
(`rootExecution`, `rootWorkflowId`) for its expand-to-families feature.

| File | What it is |
|---|---|
| `src/inject.ts` | MAIN world, `document_start`. Wraps `window.fetch`, clones matching responses, posts rows. In `01` it is the only file that touches the page's own JavaScript; in `02` and `03` it is the only one that touches the page's **`fetch`**, and `src/apiInject.ts` + `src/page/pageApi.ts` run in that world beside it. |
| `src/types.ts` | The shapes that cross the `postMessage` boundary. |
| `src/family/rows.ts` | API shape → row shape. Pure. |
| `src/family/tree.ts` | `buildTree` — the whole feature, as one pure function. Ordering, depth, connector columns. |

These differ per project:

| File | What it is |
|---|---|
| `src/content.ts` | ISOLATED world. Wiring: receives messages, drives a `MutationObserver`. No DOM writes at all in `01`; in `02` and `03` exactly one — the off-class on `<html>` that the master switch hangs its CSS on. In `01` it uses no `chrome.*` API; in `02` and `03` it also loads settings, answers the popup, and holds no repeating timer — the only one it schedules is a single pass `FRESH_FLOOR_MS` after a `⟳` press, to re-enable that button. In `03` it additionally drops the decoded-payload cache when the master switch goes off or the codec setting changes. |
| `src/render.ts` | The workflow table. In `01` it *is* every DOM write there is, and it takes no options because there are no settings to vary. In `02` and `03` it keeps the table plumbing (find the `<tbody>`, identify a row, order the families, remove everything on the master switch) and hands the drawing to `src/rowInfo/rowInfoRender.ts` (the column and the badge — the only render job that writes outside the workflow-id cell), `src/links/linkRender.ts` (the anchors, used from two pages), and `03`'s `src/payloads/payloadButton.ts` (the `{ }` button, which carries no row identity on any attribute). The dependency points one way: `render.ts` imports them and passes row identity *in* as a function, so nothing that draws can reach back for the table. |
| `src/decoration.ts` | `02` and `03` only. The root class of everything drawn, plus every class two modules share and the render types they are handed. It is what the master switch's completeness rests on: `removeAllDecoration()` in `render.ts` can only sweep the classes this file names, and several of them are on nodes that are not in the table at all — the two link sites on a single workflow's page, plus `03`'s payload panel. A node that only exists inside one of these roots is named locally by the file that draws it, because removing the root takes it away too. |

`02-techniques/` and `03-payloads/` add `src/links/deepLink.ts` (templated per-row links,
pure), `src/settings.ts` (`chrome.storage.sync`) and `src/popup.ts` (the toolbar popup,
which reports rows *seen* separately from rows *matched*, so the two failure modes are
distinguishable).

They also add the two features that ask Temporal something — the "last event" column
and the retrying-activity badge — spread over several files for one reason: exactly one
of them is allowed to touch the network, and the rest are pure enough to test.

| File | What it is |
|---|---|
| `src/page/pageApi.ts` | MAIN world. **The only file that issues a request**, and the only code that ever sees the page's `Authorization` header, which never leaves its closure. Holds the ledger, and the seam other features use to read a response the page fetched. |
| `src/apiInject.ts` | MAIN world, the second bundle. The entry point that installs the servers — and therefore the enumerable list of message types this extension accepts from the page: one in `02`, two in `03`. |
| `src/page/temporalApi.ts` | Pure. The API prefix, and the two route builders — nothing else may name a URL. |
| `src/rowInfo/rowInfo.ts` | Pure. The two questions, how to read their answers, and what a badge is allowed to say. |
| `src/rowInfo/rowInfoServe.ts` | MAIN world. Answers the questions: the TTL cache, the concurrency cap and the backoff. |
| `src/rowInfo/rowInfoClient.ts` | ISOLATED world. Which rows are worth asking about — running only, on screen only, once per interval — and what came back. |
| `src/page/pacer.ts` | Pure, with the clock and the sleep injected: the concurrency cap and the `Retry-After` backoff, testable without a network. `02` builds its one instance inside `rowInfoServe.ts`; `03` moves the instance to `src/page/requestPacing.ts`. |

And the deep links on a single workflow's own page, which fetch nothing at all:

| File | What it is |
|---|---|
| `src/detail/detail.ts` | Pure. Which URLs belong to one workflow, and the folds that reduce a history or describe response to ids, type names, timestamps and attempt counts — *before* anything is posted. |
| `src/detail/detailWatch.ts` | MAIN world. Subscribes to `pageApi.ts`'s watcher seam, folds, posts. No request, no cache, no ledger entry. |
| `src/detail/detailLinks.ts` | ISOLATED world. The drawing: workflow-scoped links in a bar beside the page's own tabs, activity-scoped links inside the row the UI labels "Activity Id" — resolved to one activity by its id, never by its type. |

`03-payloads/` adds one directory, `src/payloads/`, and one file inside `src/page/`;
every decision that can be made without a network is made in a pure module, and the
requests still go through `pageApi.ts`, including the one to a host `pageApi.ts` had
never heard of until a message named it. For the exact set, diff the two listings:

```bash
comm -13 <(cd 02-techniques/src && find . -name '*.ts' | sort) \
         <(cd 03-payloads/src && find . -name '*.ts' | sort)
```

| File | What it is |
|---|---|
| `src/payloads/payloads.ts` | Pure: what a payload **is**, and how it is shown. Which encodings are readable without any server and which are not; the event's payloads found by its **attributes key** rather than by `eventType`, because the type comes back as `WorkflowExecutionStarted` from one Temporal version and `EVENT_TYPE_WORKFLOW_EXECUTION_STARTED` from another while the attributes key is one string in both; and the formatting, including the rule that a JSON body containing a ≥16-digit integer is shown exactly as the server wrote it. |
| `src/payloads/codec.ts` | Pure, and **the file to read for "what can this send, and where?"**. The endpoint policy — `safeCodecEndpoint`, which takes `https` or loopback `http` and refuses anything that would stop `${endpoint}/decode` from being a path join — the plan of which payloads to send and how to re-attach the answers by position, the request itself, and the length check on the reply. |
| `src/payloads/payloadServe.ts` | MAIN world. The second server: one history event per question — the *first* event for an input, the *last* for an outcome — and then, only if something came back unreadable and only if you named an endpoint, one POST to it. |
| `src/payloads/tooltip.ts` | ISOLATED world, and **DOM only**: the panel element, the hover/focus gesture, and the pointer/scroll guards that traps 9 and 10 below are about. It asks `payloadClient.ts` a question and draws the answer; it holds no request state. |
| `src/payloads/payloadClient.ts` | ISOLATED world, and **state only**: one hover's outstanding request, the correlation check that throws away an answer to a question this side did not ask, the bounded cache of decoded payloads, and the invalidation when the master switch or the codec setting changes. |
| `src/payloads/payloadMessages.ts` | The two payload messages and their guards, and nothing else: the protocol as a file, so the trust boundary can be read without either side of it. |
| `src/payloads/valueGuards.ts` | The two narrowings the payload path shares. |
| `src/page/requestPacing.ts` | The pacer **instance**, module-level, imported by both servers, so the whole extension has one four-in-flight limit rather than two. |

The split between `content.ts` and `render.ts` is what makes the DOM behaviour
unit-testable: the render specs drive `render.ts` against a jsdom table in
milliseconds, including the idempotency property. They are split by *what is being
drawn* — `render.spec.ts` for the tree and the shared invariants (including the case
that asserts the master switch removes every root it drew, puts the row order back, and
leaves the table as it found it), then `renderLinks.spec.ts`, `renderRowInfo.spec.ts`
and, in `03`, `renderPayloadButton.spec.ts`, all sharing one harness.

## Things that will bite you

Each of these is commented at the site in the code; this is the index.

**1. `window.fetch` must be installed behind a getter — and must give the assignment
back.**
Temporal's UI reassigns `window.fetch` *after* `document_start`. A plain
`window.fetch = wrapped` is silently evicted moments after it lands, and the symptom is
not an error — it is a small fraction of page loads mysteriously working.
`Object.defineProperty(window, 'fetch', { get: () => wrapped })` survives it, because the
framework reads `window.fetch` fresh on every call.

A setter that discards what the page assigns is wrong: `window.fetch` is a shared page
global, and a monitoring library, a test harness, a polyfill or the next release of the
UI all legitimately wrap it. So the setter **adopts** the new function as the underlying
fetch and keeps our wrapper outermost. The ordinary way to wrap fetch is a cycle:

```js
const next = window.fetch;           // ← reads OUR wrapper
window.fetch = (input, init) => next(input, init);   // ← which we then adopt
```

`src/inject.ts` breaks it three ways, each covering a case the others cannot: a
synchronous `delegating` flag, a `WeakSet` of responses so one response is posted once
no matter how many levels it travels back through, and an in-flight ceiling for the
shape a synchronous flag cannot see — a wrapper that `await`s something *before* calling
back in.

The ceiling is **two** counters, and the per-url one does the work. A recursion
re-requests the same url, so counting per url bounds it at three re-entries; a
global-only ceiling would let it run to fifty, and the wrapper being re-entered is the
page's own or another extension's — if it logs, traces or refreshes a token it does all
of that fifty times for one call. The global ceiling stays for the shape the per-url
count cannot see: a wrapper that **rewrites** the url on each hop (a cache-buster, a
retry with a changed query). `tests/unit/inject.spec.ts` pins the hop counts at 3 and at
50.

The trade: a page with more than three *identical* requests genuinely in flight at once
has its own wrapper skipped for the fourth, because from inside the wrapper that is
indistinguishable from a recursion.

Adoption holds **one** reference, which is fine for the page and not fine for a second
script of your own that wants to watch the same global — see trap 8.

**2. Every DOM write must be idempotent.**
A `MutationObserver` drives the render. An unconditional write wakes the observer, which
schedules another pass, which writes again — 100% of a CPU core, forever. The fix is not
a longer debounce; it is comparing before writing, so a pass with nothing to do touches
nothing at all. Every writer compares before every write — `render.ts`, each
`*Render.ts` module it calls, `detailLinks.ts` and `03`'s panel — and a spec asserts
that a second pass produces zero mutation records.

**3. The UI recycles `<tr>` elements.**
The same DOM node is reused for a different workflow, with only the link updated.
Anything that caches identity on the element is wrong from that moment on: the cached
workflow id pairs with a freshly-read run id, every lookup misses, and the tree silently
renders flat. Read the `href` first, always.

**4. Key rows by (workflowId, runId), never by workflowId alone.**
One page can show several runs of one id — a workflow that was terminated and re-run, a
cron. Collapsing them attaches every child to every run.

The corollary is about lookups. A link in the table sometimes gives you a workflow id
with **no** run id, and if that id appears twice on the page there is no correct answer.
`src/family/rows.ts` marks such an id ambiguous and `findPlacement` returns nothing for
it — the same refusal `buildTree` makes when it cannot identify a parent.

**5. `z-index: 0` on the connector overlay. Not `1`, not `-1`.**
At `1` the strokes paint over the table's sticky pagination bar. At `-1` they disappear
behind the row background, which looks exactly like a broken feature.

**6. An older list response can arrive after a newer one.**
Type in the filter box, or page forward before the first answer comes back, and two list
requests are in flight at once. Rendering whichever lands last rebuilds the table around
a query nobody is on any more. `src/inject.ts` stamps each observed list with a
generation at the moment its request is **issued**, and `src/content.ts` drops any
response older than the newest it has already applied, along with any response whose
namespace is not the namespace of the page.

**7. A content script cannot make the request, and a host permission does not help.**
From Chrome's documentation: *"Cross-origin requests are always treated as such in
content scripts, even if the extension has host permissions."* A fetch from the
extension's world carries the extension's origin, which nobody has allowed — and on
Temporal Cloud the API is not on `cloud.temporal.io` at all but on the per-tenant host,
so the call is cross-origin *for the page too*, and succeeds for the page because that
host names the page's origin in its `Access-Control-Allow-Origin`.

The fix is to make the request from the **page's** world, where it is indistinguishable
from one the UI would have made itself. Any server already configured to accept the
Temporal UI's origin — a codec server, in `03` — then needs no reconfiguration either.

Two things follow. The API prefix must be **derived from a URL the page was seen to
fetch**, never assembled from `location.origin` or a known convention, because Cloud and
self-hosted differ. And the request needs the page's `Authorization` header on Cloud —
cookies alone give a `403` — so `pageApi.ts` remembers the header it saw on the list
call and re-sends it, without storing it, posting it, or logging it.

**8. Adoption has room for exactly one, so the second observer must own the property —
not sit in the slot.**
`02-techniques` has two MAIN-world observers of `window.fetch`: `inject.ts` watches for
list responses, and `pageApi.ts` watches for the API prefix, the `Authorization` header
and the ledger. If the second installs itself by plain assignment — which `inject.ts`
adopts — and the page then installs a wrapper of its own, the page's wrapper goes through
the same setter, into the same single `underlyingFetch` slot, and **replaces the second
observer**. What that looks like: the tree draws perfectly on every row, every per-row
question answers *"Nothing observed on this page yet"* for the life of the tab, and there
is no error and no warning.

So the later observer takes the property itself and **forwards the assignment to the
previous owner's setter**, which keeps everyone in the chain: the page calls
`pageApi.ts`, which calls `inject.ts`, which calls whatever the page installed.

The general rule: **if two of your scripts observe the same page global, exactly one of
them can rely on being adopted.** The other needs to own the property.
`02-techniques/tests/unit/apiInject.spec.ts` pins all three participants — the second
observer still sees the list, the tree still gets its rows, and the page's own wrapper
is still called.

**Traps 9 and 10 belong to `03-payloads`**, whose `src/payloads/tooltip.ts` is the hover
panel. Neither is a fact about payloads: they are facts about the pointer and scroll
models, and they will bite the first floating panel you build over a page you do not
own.

**9. `pointerout` fires between two children of the same element, and `pointerenter`
does not fire again to undo it.**
A hover panel you can put the pointer *into* — to scroll it, or to select text out of
it — needs to know when the pointer has really gone. `pointerout` fires on **every**
element-to-element move, including heading→body inside the panel itself. Close on it and
the panel vanishes the moment the reader moves toward the text. Cancelling the close
from `pointerenter` on the panel does not save it, because `pointerenter` does not
re-fire while the pointer moves between the panel's own descendants.

`pointerover` is the event that knows. It fires for every element entered, it bubbles,
and so **one** delegated listener on the document can answer "where is the pointer
now": on a trigger → open; inside the panel → cancel any close in flight; anywhere else
→ close. That leaves `pointerout` exactly one job — the pointer leaving the document,
which is the only time `relatedTarget === null`.

**10. A capture-phase `scroll` listener on `window` hears the panel's own scrollbar.**
A `position: fixed` panel must close when the page scrolls, or it ends up pointing at a
row that has moved. `scroll` events do not bubble, so the listener has to be
`{ capture: true }` on the window to hear the scroller that actually moved — and that is
precisely why it also hears the panel's own `overflow: auto`: a panel that closes when
you try to scroll it. The guard is one line — ignore a scroll whose `target` is inside
the panel — plus `overscroll-behavior: contain` in the CSS, so that reaching the end of
a long payload does not chain the rest of the wheel gesture to the page.

Both are the same species of bug: **the pointer and scroll models are about elements,
and a panel is a subtree.** One test per guard, in the `the panel under the pointer`
block of
[`../03-payloads/tests/unit/tooltip.spec.ts`](../03-payloads/tests/unit/tooltip.spec.ts):
removing any single guard makes a named test fail.

## Retargeting it

The four things most teams will want to change, in the order they will want to change
them:

1. **A different view** — replace `buildTree` with your own pure function over the same
   rows and draw whatever it returns. Ordering and decoration are already separated from
   the DOM plumbing, and `tests/unit/tree.spec.ts` shows how to pin the result without a
   browser.
2. **Deep links to your own tools** — in `02-techniques/` these are settings, not code.
   `src/links/deepLink.ts` lists the tokens, and offsets like `{startTimeIso-10m}` exist
   because the useful log window is never exactly the workflow's own start and end. A
   template has to expand to an absolute `http://` or `https://` URL: anything else —
   `javascript:`, `data:`, `file:` — gets no `href` at all, and the popup says so as you
   type it. The check runs on the **expanded** URL on every render pass, not on the
   template, because a template of just `{workflowId}` puts a value the extension does
   not control in the scheme position, and a workflow id is authored by whoever started
   the workflow.
3. **A different page** — the piggyback is not specific to the workflow list. The
   pattern is: match a URL in `inject.ts`, post the response, render it in the extension
   world. Any API call the page already makes is available to you on the same terms.
4. **Your own codec** — in `03-payloads/` this is a setting too, and the same endpoint
   your Temporal UI is already configured with will do: the request is
   `POST {endpoint}/decode` with an `X-Namespace` header, issued from the page's origin,
   which is the origin such a server already allows (trap 7). If your codec speaks a
   different shape, `src/payloads/codec.ts` is the only file that needs to know —
   `codecDecodeCall` builds the request and `readCodecResponse` reads it, both pure.
   What the endpoint is allowed to *be* is deliberately narrow: `https`, or `http` on
   loopback only, because what comes back is decrypted.

## Permissions, in full

`01-family-tree` has no `permissions` key in its manifest. Not an empty array — no key.

`02-techniques` has exactly one — and so does `03-payloads`:

```json
"permissions": ["storage"]
```

None of the three has `host_permissions`, `scripting`, `tabs`, `webRequest`,
`web_accessible_resources`, or a service worker.

Do not read that as "none of them makes a request". `02-techniques` makes up to two per
running row, from the page's own world, and no manifest key records it —
`host_permissions` would not help it and so is not asked for (trap 7).

`03-payloads`'s manifest asks for exactly what `02`'s does: same one permission, same
three match patterns, no new key of any kind. What it gained over `02` is a request per
question asked, decoded application data on screen, and — once you type a codec endpoint
into its popup — **an outbound host that is not Temporal's**. Every one of those rides
the page's world, so there is nothing for a manifest to declare. **A permission diff is
not a capability diff.**

The content scripts are declared against `https://cloud.temporal.io/*`,
`http://localhost/*` and `http://127.0.0.1/*`; a self-hosted UI on another hostname needs
that hostname added to the project's `public/manifest.json`, and Chrome will ask you to
approve the change when you reload the extension.

Chrome match patterns ignore the port, so the localhost entries cover any port —
including any *other* application you happen to be running on localhost. The injected
wrapper on such a page does nothing but forward calls to the original `fetch` and test
each URL against one regex, but if that footprint is unwelcome, delete the two localhost
lines and keep Cloud only.

## What leaves your machine

From `01-family-tree`: nothing. There is no outbound request, no storage, and no link
to click.

From `02-techniques`, three things, each of which you asked for:

- `chrome.storage.sync` holds your toggles and your link templates. **Chrome uploads that
  to your Google account** if you are signed in, so treat those fields like anything else
  you type into a synced browser setting — in particular, do not embed a key in one.
- A deep link opens the URL you configured, carrying the workflow id and time window you
  told it to carry. Those links are marked `rel="noopener noreferrer"` and
  `referrerpolicy="no-referrer"`, so the destination gets what is in the URL and not a
  handle on the Temporal tab or the namespace it came from. Nothing is ever sent on
  render — only on a click. And only `http://` and `https://` URLs are ever given an
  `href`.
- **Two questions to your own Temporal, per running row.** One page of one event from
  `history-reverse`, for the "last event" column; one `DescribeWorkflowExecution`, for
  the retrying-activity badge. Both go to the same API the page is already using, with
  the page's own session, and **nowhere else** — there is no other outbound host in this
  project, and no setting that could add one. Closed rows are never asked about, only
  rows the table is showing are asked about, answers are cached, four requests run at a
  time, and a `429`/`503` backs off instead of retrying. The `⟳` in the column header
  re-asks now, bounded to one round per run per five seconds, enforced where the request
  is made rather than where the button is. The ages are exact to the second but
  **frozen at the instant Temporal was read**, so a pass over unchanged answers writes
  nothing. **No payload is decoded, anywhere** — in particular the retry badge does not
  read `lastFailure.message`.

From `03-payloads`: the three above, and two more. The permission surface is the same,
so no permission marks the difference:

- **One more question to your own Temporal, per question asked.** A single history event
  each: the first one for a workflow's input, the last one for its outcome — so a hover
  on a *closed* row costs two requests and a hover on a *running* one costs one. Nothing
  on render, and a question already in flight is joined rather than asked again. The
  same ledger authorises it, the same pacer paces it, and the answers are cached per
  `(namespace, workflowId, runId, kind)` in a bounded cache that the payload switch and
  the master switch both empty.
- **The payload itself, to the codec server you named — and to nowhere else.** This is
  the only **non-navigation** request the extension initiates to a host other than the
  page's Temporal API, and the only one that carries a body. It exists only after you
  type a host into the popup:

  - **Empty by default.** With no endpoint, unreadable payloads are shown as a byte
    count and a sentence saying so. Nothing is sent, nothing is guessed from the
    namespace, and nothing is read out of the Temporal UI's own codec setting.
  - **Only what cannot be read locally.** A plaintext payload is decoded in the browser
    and never sent, including a plaintext one sitting beside an encrypted one in the
    same request.
  - **`https`, or `http` on loopback.** Nothing else is accepted, because the response
    is decrypted data.
  - **Never with any credential.** The codec call goes out through a different function
    from the one that spends the page's bearer, and that function's own type has no
    `credentials` field and refuses an `Authorization` or cookie header outright. A
    codec server that authenticates its callers cannot be used from here, and the panel
    says so when it answers `401`.
  - **Only on a hover, through this extension's own UI.** No egress on render, no
    egress on scroll, no background refresh. A script already running in the page can
    forge the request without any gesture; that is the weakness section's subject.

  In plain terms: **a codec server you name can see decrypted workflow payloads for the
  runs you hover.** That is the point of the feature, and it is the reason this one
  setting is off until you fill it in while every other feature ships on.
  [`../03-payloads/README.md`](../03-payloads/README.md#the-row-that-matters-data-leaves-the-browser)
  states the same thing in the security card, and its
  [weakness section](../03-payloads/README.md#the-weakness-and-what-closing-most-of-it-took)
  says what a hostile page can still do with that field.

There is no analytics and no telemetry in any project. To check rather than believe:

```bash
grep -rniE 'fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource' \
  01-family-tree/src 02-techniques/src 03-payloads/src
```

In `01-family-tree` every hit is `window.fetch`, the page's own — captured, wrapped, and
called on the page's behalf. In `02-techniques` the code hits are in `src/inject.ts` (the
same wrapper as `01`) and `src/page/pageApi.ts`, which captures the page's `fetch` once
as `pageFetch` and calls it in exactly two places: to pass the page's own request through
untouched, and to ask one of the two questions in `src/rowInfo/rowInfo.ts` about a run
the ledger has authorised. `03-payloads` is the same two files; `pageApi.ts` there calls
`pageFetch` in three places rather than two, and the third is the whole difference
between the stages: a URL that came from a message rather than from the ledger, sent
with no `Authorization` header. Nothing else in any project touches the network: there
is no `XMLHttpRequest`, `sendBeacon`, `WebSocket` or `EventSource` anywhere.
