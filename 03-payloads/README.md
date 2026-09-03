# 03 — payloads

Everything [`../02-techniques/`](../02-techniques/) does, plus the one thing most
teams actually came for:

- **a workflow's input and result, on the row it belongs to** — a `{ }` button on
  every row, hovered to read what the workflow was started with and what it
  returned or why it failed;
- **decoded through your own codec server** when the payload is encrypted, with
  the host that decoded it named on screen, every time;
- **and nothing else.** The conveniences that were once bundled with this — column
  reorder, a bigger page size, a cross-workflow activity finder — are stage 04's
  problem. None of them changes what the extension can reach; this does.

```
Workflow ID                                  Last event ⟳                   Status
order-2601011200-01      { }  Logs           3m 00s · ActivityTaskStarted   Running
 ├─ …-01-payment    ↻ 47 { }  Logs           12s · ActivityTaskFailed       Running
 └─ …-01-fulfilment      { }  Logs                                          Completed
                          └───────────────────────────────────────────┐
                          │ order-2601011200-01 · OrderWorkflow · Running
                          │ INPUT · DECODED BY CODEC.EXAMPLE.COM
                          │ {
                          │   "orderId": "2601011200-01",
                          │   "amount": { "currency": "EUR", "minor": 4999 }
                          │ }
                          │ RESULT
                          │ Still running.
                          └───────────────────────────────────────────┘
```

**This is the rung where three things arrive at once**, which is why it is a stage
of its own: the extension decodes payloads for the first time, sends data out of the
browser for the first time, and for the first time puts a panel on screen that can
hold somebody's personal or financial data. 01 and 02 could not do any of the three.

**And the manifest asks for exactly what 02's does** — one permission, `storage`, no
`host_permissions`, no service worker, the same three content-script matches. Every
capability-bearing key is the same; a `diff` of the two files shows the name, the
description, the version and the button's tooltip. That is the sentence this project
exists to make concrete: **a permission diff is not a capability diff**, and the
largest capability step in this repository is the one the manifest does not record.

## Run it

```bash
npm install          # from the repository root, once
npm run build        # from this directory
```

The Node range `npm install` needs is stated once, in
[the root README](../README.md#start-with-01), rather than copied into each
project where three copies would go stale one at a time.

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`03-payloads/dist/`. Open a workflow list, reload the tab, and hover a `{ }`.

With no codec server configured — the default — an encrypted payload reads
*"(binary/encrypted — &lt;n&gt; bytes, not decoded here. Set a codec server in the popup
to read it.)"*, and **nothing has left your machine**. Plain payloads are already
readable at that point; most self-hosted setups never encrypt them at all.

Three projects loaded at once are distinguishable by their icons — each carries its
own number and hue.

## Read these files in order

This project is the largest in the repository, and reading it front to back is not
the way in. To answer **"what can this thing send, and who decides?"** — the only
question that changes between 02 and 03 — read four files in this order:

| # | File | The question it answers |
|---|---|---|
| 1 | [`src/apiInject.ts`](src/apiInject.ts) | Which messages this extension accepts from the page at all. Two, and the list is the file. |
| 2 | [`src/payloads/payloadServe.ts`](src/payloads/payloadServe.ts) | Whether a request happens: the ledger gate, one history event, and the decision that a payload needs a server. |
| 3 | [`src/payloads/codec.ts`](src/payloads/codec.ts) | What the request *is* — destination, headers, body — and what is deliberately not in it. Pure, so the tests are cheap, and short on purpose: it is the whole answer to "what can this send, and where?". |
| 4 | [`src/page/pageApi.ts`](src/page/pageApi.ts) | Where authority is enforced: two exported fetches, one spending the page's bearer on an origin it picks, one carrying no credential to an origin the caller picks. |

Then the panel, which is two files: [`src/payloads/tooltip.ts`](src/payloads/tooltip.ts) for the
element, the pointer and the five rules about *when* to ask, and
[`src/payloads/payloadClient.ts`](src/payloads/payloadClient.ts) for the four invariants about *which
answer may be believed*. Then two spec files, in this order:
[`tests/unit/codec.spec.ts`](tests/unit/codec.spec.ts) for the endpoint policy and the
request as pure values, and
[`tests/unit/apiInjectCodec.spec.ts`](tests/unit/apiInjectCodec.spec.ts) for every egress
claim asserted from the attacker's side — a hostile page trying to make the extension
send somewhere it should not.

**`src/payloads/` is not the whole diff from 02, and skipping the rest is how the
interesting part gets missed.** The files below are ones 02 already had, *changed* to
accommodate this stage, and each change is a decision worth reading:

| Changed file | What this stage did to it |
|---|---|
| [`src/apiInject.ts`](src/apiInject.ts) | Installs a second server, so the enumerable list of accepted messages goes from one to two. This is the trust-boundary diff. |
| [`src/page/pageApi.ts`](src/page/pageApi.ts) | Gains `fetchFromPageWorld()` — a second exported fetch that carries **no** credential to an origin the caller names, beside the one that spends the bearer on an origin it picks itself. Keeping those two from converging is the security argument of the stage. |
| [`src/rowInfo/rowInfoServe.ts`](src/rowInfo/rowInfoServe.ts) | Stops building its own pacer and imports the shared instance instead. One line; see `src/page/requestPacing.ts` for why a second `makePacer()` would have looked correct in both places. |
| [`src/render.ts`](src/render.ts) | Ranks the `{ }` button into the control order 02 already states for the workflow-id cell — a third control appended into a cell whose order must not depend on which feature a given user switched on first. The button itself is [`src/payloads/payloadButton.ts`](src/payloads/payloadButton.ts) — nine lines of DOM that deliberately carry no row identity on any attribute, which is what makes them correct under `<tr>` recycling. |
| [`src/decoration.ts`](src/decoration.ts) | Two more class names — one for the button in the cell, one for the panel, which is not in a row at all. The master switch sweeps the table; the panel is the node it can only remove because this file names it, which is why the class list and the removal live one import apart. |
| [`src/content.ts`](src/content.ts) | Drops the decoded-payload cache when the master switch goes off or the codec setting changes. |
| [`src/settings.ts`](src/settings.ts) | One new field, and it is the one that names a host. |
| [`src/popup.ts`](src/popup.ts) | The endpoint input and the codec verdict line — the only place an endpoint can be set. |

Everything else is 02 byte-for-byte, which `npm run lineage` enforces rather than
claims; to see the set yourself, `cmp` the two `src/` trees.

## What one hover costs

| Rule | Why |
|---|---|
| **Nothing is fetched on render** | A hundred-row list costs zero requests. The only entry points are `pointerover`, `focusin` and `click`; there is no code path from a render pass to a request. Rule 1 in `src/payloads/tooltip.ts`. This matters more here than the wording suggests: the Temporal UI re-renders its own list on its own schedule, and every one of those passes runs this extension's render again, so anything a render pass fetched would be fetched by the tableful, all day, with nobody touching the keyboard. |
| **The header's `⟳` does not refresh payloads** | It re-asks the two per-row questions the `Last event` column and the retry badge need — event metadata, no payloads, no codec server. A refresh that also re-decoded every row on screen would push a table's worth of decoded personal data through the codec host for one click. The thing that refreshes a payload is hovering the row again, one row at a time, which is the shape the rest of this table describes. |
| **A traverse costs nothing** | `HOVER_DELAY_MS` in `src/payloads/tooltip.ts`: moving the pointer across the table passes over many rows, and a short delay before asking means only the row you stopped on is asked about. |
| **One history event per question** | `maximumPageSize=1`, so a hover on a workflow with a hundred thousand events costs what a three-event one costs. Input is the **first** event (`direction: 'forward'`); the outcome is the **last** (`'reverse'` — the same route the `Last event` column uses). A hover on a **closed** row asks two questions and therefore fetches two events. |
| **A running row costs one, not two** | It has no close event to fetch, so the result section says *"Still running."* without asking anything. |
| **One question is one request** | Invariant 2 in `src/payloads/payloadClient.ts`. A click on the button fires `focusin` **and** `click`, and both open the panel; the cache cannot help, because it still says "no" while the first request is in flight. So a question already in flight is *joined* rather than asked again — otherwise one click is two history events and, with a codec server configured, two copies of the same payload leaving the machine. |
| **Answers are cached** per `(namespace, workflowId, runId, kind)` | A pointer moving back and forth between two rows is very common. Errors are **not** cached — they are usually a setting the user is about to fix. |
| **The cache is bounded and evictable** | `MAX_CACHED_PAYLOADS` in `src/payloads/payloadClient.ts`. This one is not a memory rule: its values are decoded payloads, so an unbounded cache is a tab quietly retaining every customer record its owner glanced at all afternoon. |
| **It shares ONE pacer with the per-row questions** | `src/page/requestPacing.ts` — four **Temporal** requests in flight for the whole extension, 429/503 backoff honouring `Retry-After`. The codec POST is deliberately *outside* that slot: it happens after the history fetch has released it, so a slow decoder cannot occupy the cap that exists to be polite to Temporal. See below; this file is the most quietly important change between 02 and 03. |
| **A question that is never answered gives up** | `REQUEST_TIMEOUT_MS`, with a message saying to reload the tab, so a missing MAIN-world script cannot leave a section reading `Loading…` for the life of the page. |

### The pacer moved, and that is not a feature

In 02 exactly one feature issues requests, so the pacer **instance** lives in the
file that issues them and "four at a time" is checkable by reading that one file.

03 has a second one. Writing `makePacer(…)` in the payload path is the obvious
thing to do and it type-checks — and it would have given the extension **two
independent limits of four**, so hovering rows while a hundred-row list filled its
`Last event` column would have put eight requests in the air against a cap this
README calls four. Neither file would have looked wrong on its own.

So the instance is a module-level `const` in `src/page/requestPacing.ts`, imported by
both servers: four at a time is a property of the **extension**, not of a feature.
The cap covers requests to **Temporal** — every history, list and describe call, and
there is no way to reach the API without going through it. The codec POST is
deliberately outside it: a decoder's 429 is its own business, and a slow codec server
holding one of four Temporal slots would make the page's own columns wait on someone's
laptop.
The generic machinery is still the shared, clock-injected `src/page/pacer.ts`, which is
why it can stay byte-identical with 02 while its instance does not
([`../scripts/lineage.json`](../scripts/lineage.json) records that as a declared
fork, with this as the reason).

## What is readable without any server

`json/plain`, `binary/plain`, `text/plain` and `binary/null` are decoded in the
browser and **never sent anywhere**. Everything else — `binary/encrypted` above all
— is what a codec server is for.

`json/protobuf` is deliberately *not* in that set even though it is not encrypted:
decoding it needs the message descriptor, which this extension does not have and a
codec server usually does.

Two details in `src/payloads/payloads.ts` are worth stealing:

- **Match on the attributes key, not on `eventType`.** The same event comes back as
  `WorkflowExecutionStarted` from one Temporal version and
  `EVENT_TYPE_WORKFLOW_EXECUTION_STARTED` from another, so a `switch` over the type
  needs both spellings for every case and silently matches neither when a third
  appears. `workflowExecutionStartedEventAttributes` is one string in both — and it
  is also the only place the payloads can be.
- **Pretty-printing is not free, and the cost is silent.** `JSON.parse` turns every
  number into an IEEE double, so an id of `12345678901234567890` comes back as
  `12345678901234567000` and `JSON.stringify` writes that back out. The value on
  screen is then simply *wrong*, in a way that looks exactly like real data — and
  account numbers and transaction ids are precisely the fields long enough for it to
  happen to. When the text contains a long integer literal, the server's own
  formatting is shown untouched. Ugly beats wrong.

A failure is a linked list, so `describeFailure` walks `cause` and joins the chain —
the useful message is usually the innermost one, and the outermost is "activity task
failed". The depth cap is not defensive dressing: `cause` is server-provided data,
and a cycle in it would hang the panel.

Anything longer than `MAX_DISPLAY_CHARS` is clipped, with the number of dropped
characters stated. A single workflow argument can be megabytes, and laying that into
a tooltip freezes the tab.

## The codec server

One field in the popup, empty by default. **An empty field means no payload byte
can leave this machine**, and that is the whole egress story: it is the only place
an endpoint can come from — nothing is read off the page, nothing is guessed from
the namespace.

The request is the one Temporal's own UI makes, **minus its two credential options**:
`POST {endpoint}/decode`, the namespace in `X-Namespace`, `{"payloads": […]}` in and
out. Route, header and body match exactly — **a codec server that already serves the
Temporal UI needs no change to serve this**, and the URL you typed under *Codec
Server* in the UI belongs here unchanged. The exception is the one this extension
cannot do: a codec server that authenticates its callers, because nothing here sends
a token or a cookie (see below).

What bounds it, all of it visible from outside the extension:

- **Only the payloads that cannot be read here are sent.** The first version sent
  the whole `payloads` array whenever *any* member of it needed a codec, because
  that keeps the answer aligned by index and costs one line less. The cost of that
  line is data: a workflow started with a plaintext `json/plain` customer record
  *and* one encrypted blob would have had both POSTed, and the plaintext one had no
  reason to leave the browser at all. `planCodecCall` carries the positions instead,
  and `mergeDecoded` puts the answers back — sending a subset without the positions
  is what would mislabel data.
- **https, or http on loopback. Nothing else is accepted.** The rule is about the
  payloads, not the URL: a codec server's whole job is to hand back *decrypted*
  data, so plain http to anywhere but this machine would put exactly that on the
  wire in the clear — one typo away from doing it to a host on the public internet.
  An endpoint that fails the check is treated as no endpoint at all, and the popup
  says so before anything is hovered.
- **No credential of any kind is reachable on that path, and there is no option to
  add one.** The `credentials: 'omit'` literal is in `fetchFromPageWorld()` in
  `src/page/pageApi.ts` — the function that *spends* the request — and not in the code that
  describes it, which is the point: a caller cannot opt out of something its parameter
  type has no field for. Neither an `Authorization` header nor a cookie switch exists
  to be turned on. See the next section: this is a deletion, not a default.
- **The host is named in the panel**, every hover, beside the heading — because
  "decoded" on its own reads as if the extension did it locally, and a payload that
  was sent to a server deserves to say so on screen rather than only in a README.
- **The ledger still gates it.** A payload can be asked about only for a run *this
  page itself listed* — the same single gate as the per-row questions, checked
  before any request is issued.
- **A codec server's own 429 does not pause Temporal requests.** `refuse()` is
  deliberately not used there: a busy decoder is its own business, and pausing every
  request in the tab because of it would be wrong.

### There is no "send my credentials" option, and that is a deletion

Temporal's own UI has both — pass the access token, and send cookies. This extension
had a *send cookies* checkbox too, and it was removed once the request path was read
as a trust boundary rather than as a feature list. Two options went at once, for one
reason.

The codec endpoint arrives over `postMessage`. Any script on the page can send that
message — the Temporal UI itself, any npm dependency of it, another installed
extension's content script. **A credential switch beside a caller-supplied host is
the switch that matters**, because the value that reaches the `fetch()` comes from the
message, not from the popup: a default of *off* protects only the honest path through
the popup, and a forged request naming `includeCredentials: true` and a host of its
choosing would be honoured. With the token that is the page's live bearer; with the
cookie it is whatever the browser holds for the attacker's chosen host, sent
cross-origin to it on the user's behalf.

So there is no flag to forge, and the two halves of that sentence live in two
different files on purpose. `codecDecodeCall()` in `src/payloads/codec.ts` *describes* the
request — method, headers, body — and its return type has no `credentials` field to
set; `fetchFromPageWorld()` in `src/page/pageApi.ts` *spends* it, writing
`credentials: 'omit'` as a literal and refusing an `Authorization`, `Cookie` or
`Proxy-Authorization` header outright. Enforcement sits at the boundary rather than in
the description, so a second caller added later inherits it instead of having to
remember it. `CodecConfig` then has exactly one field, so an extra key in a forged
message is not merely ignored — there is no code that can read it. **The limitation is stated
plainly rather than worked around: a codec server that requires authentication cannot
be used from this extension.** A 401 or 403 is the expected answer from one, and the
panel says so in those words.

If you need a credential in a fork, the honest way is to stop taking the endpoint from
a message at all: read it in the extension's own world and pass it in with
`chrome.scripting.executeScript`, and pay for it with `host_permissions`. That is a
bigger permission budget bought for a smaller attack surface, which is the trade this
whole repository is about.

### Why the fetch happens in the page's world

A content script cannot make either of these requests. Chrome's documentation,
verbatim: *"Cross-origin requests are always treated as such in content scripts,
even if the extension has host permissions."* On Cloud the Temporal API is not on
`cloud.temporal.io` but on the tenant host, and a codec server is configured with
`Access-Control-Allow-Origin: https://cloud.temporal.io` because that is what the
Temporal UI needs — **the page's origin in both cases, never ours.**

So both fetches are made from the MAIN world, where they are indistinguishable from
requests the Temporal UI would have made itself. The consequence is the part worth
copying: an already-working codec server needs no reconfiguration, and this project
still declares no `host_permissions`.

## The hover panel

The panel is two files, and so are its rules: **five rules** in `src/payloads/tooltip.ts` about
the element and the gesture, and **four invariants** in `src/payloads/payloadClient.ts` about
which answer may be believed. They are numbered separately, and named differently, so
that a citation says which of the two files it means.

Every one of them except invariant 1 is a bug that happened first: the earlier ones in
the internal extension this was rewritten from, and rules 2 and 5 and invariant 2 in
*this* code, found in review after the suite was green. Three of them were in the code
written to uphold another rule — two inside rule 3's own implementation and one inside
rule 2's — because a rule's implementation turns out to be a place its own violations
like to live. Invariant 1 is the exception: it was never a bug here, and was carried
across from a review of the per-row questions.

### Five rules about the element and the gesture — `src/payloads/tooltip.ts`

1. **Nothing is fetched on render.** Above; it is a security property as much as a
   cost one, because a render-triggered fetch would decode payloads nobody asked to
   see.
2. **Hover intent.** A traverse across the table asks about nothing.

   The delay is only hover *intent* if it also remembers **which** button it is
   waiting for, and it did not. The timer was armed for the first button entered and
   any button entered while it was still pending was ignored — so pointing at row A
   and moving to row B within the delay opened B's panel and filled it with **A's
   payload**. Traversing a table is exactly how that happens, which made rule 2's own
   implementation the thing that broke invariant 1. The fix is not "cancel and re-arm
   every time" either: `pointerover` fires for every element entered and a button has
   children, so an unconditional re-arm pushes the opening one delay further away on
   every event and the panel never opens at all. Same button, leave the timer alone;
   different button, cancel and re-arm.
3. **It does not close under the pointer.** A panel that vanishes when the pointer
   leaves the button cannot be read, scrolled or selected — and selecting a value
   out of it is most of why anyone opens it. So: a grace period, cancelled by the
   pointer being anywhere over the panel, and **suspended entirely while a mouse
   button is held down inside it**, so a text selection dragged past the edge does
   not dismiss what is being selected.

   Both bugs here were in the code enforcing this rule. A `pointerout` between two
   elements *inside* the panel closed it under the pointer — `pointerenter` does not
   fire again between descendants, so nothing cancelled the close. And a
   capture-phase `scroll` listener, which exists because scroll does not bubble,
   closed the panel whenever the panel's **own** scrollbar was used: it is a
   scroller too, so reading a long payload dismissed the thing being read. Neither
   is the kind of bug a unit test is written for in advance; both are pinned by one
   now.
4. **A late answer does not paint into the panel that replaced it.** Two hovers are
   two requests in flight and they can answer in either order, so every fill is
   stamped with the generation of the hover that asked for it, and an answer whose
   hover is over is dropped rather than painted. Opening the next panel takes the next
   generation and closing one moves past it, so both of those make an answer still in
   flight undeliverable — which is what lets `close()` do double duty in the reset path
   below.
5. **Switching it off takes the node, the reference and the text.** The `{ }` buttons
   are in the table, so the render pass stops drawing them. The panel is on `<body>`,
   where no render pass looks — so turning the payload switch off while a panel was
   open left a decoded payload sitting on screen underneath a switch that said the
   feature was off, with its text still in the cache behind it. Off means the node is
   gone, the module's reference to it is gone, the painted text is erased, and the
   cache is empty.

   What it cannot mean is a revocation. A history event fetched a moment ago was
   fetched, and a payload already POSTed to a codec server is already there. Switching
   off stops the next question, and the popup does not claim otherwise.

### Four invariants about which answer may be believed — `src/payloads/payloadClient.ts`

1. **An answer has to name the question it answers.** Carried across from a review
   of the per-row questions rather than learned here. The request id is a small
   integer starting at 1 in every tab, so "it carries id 3" is something a forged
   message gets right by accident; the namespace, workflow id, run id and kind all
   have to agree, and those same four parts are the cache key so the two cannot
   drift apart.

   On this rung that check does more work than it does in 02. The worst a wrong
   last-event answer does is print the wrong event type in a cell. The worst a wrong
   payload answer does is put **one workflow's decrypted input under another
   workflow's name** — somebody else's personal data, on screen, labelled as this
   customer's.

   A mismatch is *dropped*, not deleted from the pending map: an answer that names
   the wrong run must not settle — or cancel — the question it collided with. The
   real answer, or the timeout, does that. So the worst a forged answer achieves is
   nothing at all.
2. **One question is one request.** Three entry points reach the same row — a hover
   opens the panel, Tab focuses the button, and a *click* on the button fires
   `focusin` **and** `click` — and each of them found an empty cache and posted its
   own message, because the cache only knows the answers that have already arrived.
   Two history events for one click, and with a codec server configured two copies of
   the same payload leaving the machine for one glance. A question already in flight
   is joined; the second caller is still handed the answer, because dropping it would
   leave that section reading `Loading…` for ever, which is the worse bug.
3. **An answer never outlives the setting it was decoded under.** Change the codec
   endpoint and the cache is emptied — and on its own that is not enough, because a
   request asked under the old setting settles a moment later and refills the map it
   was invalidated out of. So every request remembers the epoch it was asked under,
   and an answer from a passed epoch is still handed to its caller but never cached.

   That covers three of the four places a stale answer can hide: the cache, a request
   in flight, and a late answer still allowed to paint. The fourth is the text already
   on screen, which only the panel can reach — rule 5 above, and
   [`docs/design-notes.md`](../docs/design-notes.md) under "A late answer, and the four
   places one can hide".
4. **A request that never comes back still answers.** `REQUEST_TIMEOUT_MS`. The
   MAIN-world script can be absent entirely — an older build, a page it never ran on —
   and a section reading `Loading…` for the life of the page is not an answer. The
   timeout resolves as a well-formed result carrying `error`, saying to reload the tab,
   because rendering `error` is the panel's only way to say "this did not work".

The button carries **no row identity** — no workflow id, no run id, not even a title
that names one. That is what makes it correct under `<tr>` recycling: there is
nothing on it that can go stale, so the panel resolves the row from the row's own
`href` at the moment of the hover. It is also the cheapest possible write: once
created, every later render pass leaves it alone.

Keyboard-reachable (it is a real `<button>`, so Tab opens it and Escape closes it),
`role="tooltip"`, `aria-live="polite"` because the body arrives after a round trip.
Every value reaches the DOM through `textContent`, inside a `<pre>` — a decoded
payload is pretty-printed JSON and its indentation is the only thing making it
readable.

## Security card

Every project in this repository carries one of these, in a fixed shape so the
projects can be compared line by line.

| | 03 — payloads |
|---|---|
| **Permissions requested** | `storage`, and nothing else — **the same permission surface as 02** |
| **Host permissions** | none |
| **Runs on** | `https://cloud.temporal.io/*`, `http://localhost/*`, `http://127.0.0.1/*` |
| **Service worker** | none |
| **Data it reads** | everything 02 reads, plus **the payloads themselves**: one history event per question — so one for a running row and two for a closed one — decoded into a workflow's input, its result, its failure message and stack trace, a termination reason |
| **Data it writes** | `chrome.storage.sync` — toggles, link templates, and the codec endpoint. No cookies, no `localStorage`, no files. **No payload is ever written to storage**; decoded text lives in one bounded in-memory cache for the life of the tab, and switching the panel off empties it |
| **Requests it makes** | up to two per *running* row for the `Last event` column and retry badge — on a schedule the page's own re-renders set, or at once when you press the header's `⟳`, floored at one round per run per 5s — plus **one history event per payload question** (one for a running row, two for a closed one), on hover only. All to the page's own Temporal API. And, when you have named one, `POST {your codec server}/decode` |
| **Data that leaves the machine** | **yes, and this is the row that changed.** Only when you have typed a codec endpoint: the *undecodable* payloads of the row you hovered, plus the namespace in `X-Namespace`, to that host and nowhere else. Never a payload this extension could read itself; never a decoded one; never row metadata; never a credential. With the field empty, nothing at all |
| **Payloads it decodes** | yes — that is the feature. `json/plain`, `binary/plain`, `text/plain`, `binary/null` in the browser; anything else through your codec server, or not at all |
| **Credentials it holds** | none. It stores no token. The page's `Authorization` header is read in the page's world and attached **only** to Temporal's own API — there is no parameter, setting or message field that can attach any credential to a codec request. The token option was never built and the cookie option was deleted; the codec `fetch` says `credentials: 'omit'` as a literal |
| **Whose data it will fetch** | only the runs the server listed to this page, tracked per namespace — the same single ledger, now also gating the hover. A request naming any other run is refused *before* the page's token is spent on it |
| **Third-party code in the bundle** | none. No runtime dependencies |

### The row that matters: data leaves the browser

If you are reviewing this project, that is the row to review, and this is the
argument that it is nonetheless a bounded step:

- **What is sent, in full:** the payloads that could not be decoded here — `metadata`
  and `data` exactly as Temporal returned them — in a `{"payloads": […]}` body, with
  the namespace in an `X-Namespace` header and `Content-Type: application/json`. That
  is the entire request. There is no other header, no query string and no body field.
- **Where it goes is a host the user typed**, in their own browser, and the panel
  names that host on screen next to the data it decoded.
- **What is not sent:** anything readable, any decoded text, the page's bearer, any
  cookie at all, row metadata, the workflow id, the run id, workflow ids of rows you
  did not hover, and anything whatever before you fill the field in.
- **It is off until it is configured.** Not off by default in the sense of a
  checkbox nobody looks at: with the endpoint empty there is no host to send to and
  the code path does not exist. That is the one setting in this repository that
  defaults to off for a reason other than cost.

Every clause above is asserted from **outside** the extension, in
`tests/unit/apiInjectCodec.spec.ts` — the `sending an encrypted payload to the codec
server in the popup` block, which is a file of its own precisely so that "what can
this send, and where?" has one spec file to read as well as one source file — against
a fake network that records the URL, the
headers and the **body** of everything that reached it. That last part is what makes
the claims non-vacuous: "only the payloads it cannot read left the browser" is a
statement about bytes, not about a destination, so the plaintext payload is searched
for in every encoding of the request body. And the assertion that no request can
attach the page's bearer sits beside a positive control proving the bearer *was*
available on that hover — a `toHaveLength(0)` that would pass on a build that made
no requests at all is not evidence of anything.

### The weakness, and what closing most of it took

**The message bus is not authenticated.** `window.postMessage` carries no sender
identity that cannot be forged: `event.source === window` means "somebody in this
page", and two quite different somebodies qualify, with two different amounts of
existing access — the distinction the rest of this section rests on:

- **MAIN-world code** — the Temporal UI itself, or any npm dependency bundled into
  it. This executes *as* the page: same JS heap, same in-memory bearer, same
  same-origin `fetch`. It could call the Temporal API directly, right now, without
  going anywhere near us.
- **Another installed extension's ISOLATED-world content script.** This shares the
  page's DOM and therefore its `window.postMessage` bus — `addEventListener` and
  `postMessage` both fire across the isolated/MAIN boundary — but it does **not**
  share the page's JS state. It cannot read the bearer sitting in the Temporal UI's
  memory, and a `fetch` it issues is cross-origin regardless of what host
  permissions its own extension holds, for the identical reason stated at the top
  of `pageApi.ts`: *"Cross-origin requests are always treated as such in content
  scripts, even if the extension has host permissions."* It is on the bus, but it
  cannot call the Temporal API itself.

`MESSAGE_SOURCE` and every field of the request are published in this repository, so
a shape check says a message is well-formed and nothing whatever about which of the
two sent it.

Three things narrow it, and none of them is a shape check:

- **The ledger, unchanged from 02 and now doing more.** A question is answered only
  for a run the **page itself was handed**, in the namespace it was handed it under,
  learned by parsing the workflow-list *response*. `fetchForListedRun()` is still
  the only route to the page's `Authorization` header and it performs that check
  itself, so the feature added on this rung could not forget to — **one gate, not
  one per feature.** In 02 the worst a forged per-row question achieved was leaking
  an event type; here it would be another customer's decoded input, which is why the
  same gate is worth more on this rung than it was on the last.
- **The second fetch carries nothing.** `fetchFromPageWorld()` posts to an origin
  its *caller* chose, so it attaches no credential of ours and there is deliberately
  no `auth: true` parameter to add. The two exported fetches must never converge,
  and the difference is one word — **who chooses the origin.** Collapsing them into
  one function with a flag would type-check.
- **And in the other direction.** The answer crosses the same unauthenticated bus,
  into the half that *renders*, so `isPayloadResult` validates every field to the
  leaves — before that it did not, and `{text: {}}` reached `textContent` as
  `"[object Object]"` while an `error` of `0` rendered as a panel with no error and
  no body. Then the correlation check above drops anything that does not name the question this
  side asked.

**What is left, stated at its real width rather than at its most flattering.** Either
sender above can forge a `payload-request`, and what it gets is:

- **any run the ledger has retained** — every run this page has listed since it
  loaded, not only the rows on screen and not only the row under the pointer;
- **without a gesture** — no hover, focus or click is needed. It is our own UI that
  requires one; the bus does not;
- **the plaintext, back over `postMessage`** — for everything this extension can
  decode locally (`json/plain`, `binary/plain`, `text/plain`, `binary/null`), which on
  a self-hosted cluster with no codec is usually *all* of it;
- **and the ciphertext, out to a host it names**, for the payloads that needed a codec
  server — which is the egress half, and the narrower half.

An earlier draft of this section said "the ciphertext of a payload that is on the
user's screen". That was the honest description of the *feature* and a flattering
description of the *bus*, and the difference is the whole point of writing this down.

**What genuinely bounds it depends on which sender you are talking about, and
that is the mistake an earlier draft of this section made — it argued one bound and
applied it to both.**

- **For MAIN-world code, the bound is real.** A script that already runs as the
  page — the Temporal UI itself, or any dependency bundled into it — already holds
  the page's live bearer and can call the Temporal API on the page's own origin
  directly, without going anywhere near us. Everything in the list above, it can
  reach by a shorter route. For this sender, the ledger's job is only to make sure
  we are not a *wider* route than the one it already has, and no credential of ours
  being reachable on any path is what keeps that true.
- **For an installed extension's ISOLATED-world content script, the bound does not
  hold, and this is the residual risk stated directly rather than argued away.**
  Such a script is on the message bus — it can listen for our decoded answers and
  it can post a forged `payload-request` — but it is **not** running as the page,
  so it cannot read the bearer out of the Temporal UI's memory and its own `fetch`
  is cross-origin regardless of its host permissions, the identical restriction
  that keeps our own content script off the API. It has no shorter route. **For
  this sender, this extension is a wider route**: it can turn the ledger into a
  read of every listed run's plaintext input and result, and it can direct the
  ciphertext of anything this build cannot read to an HTTPS (or loopback `http`)
  host of its own choosing, through `fetchFromPageWorld()`. That function's own
  type closes the credential half of that for good — no message can attach an
  `Authorization` header or a cookie to that request, because it does not accept
  either as a parameter (see the note on `UnauthenticatedPost` in `pageApi.ts`) —
  but it does not close the read, and it does not close the directed egress of
  ciphertext. Nothing in this repository does.

Closing it needs the *request* — not only the endpoint in it — to arrive by a channel
a page script cannot write, which means `chrome.scripting.executeScript({world:
'MAIN'})` from a service worker, and therefore `host_permissions` — **a bigger
permission budget in exchange for a smaller attack surface.** Closing only the endpoint
half would leave the plaintext half open, which is the kind of partial fix that reads
as a whole one. That trade is the reason this repository writes down reasons and not
only numbers.

**This section is the one place that argument is written out in full**, and that is
deliberate: it was briefly written out three times — here, in the header of
`src/payloads/payloadServe.ts`, and in this project's entry in
[`../scripts/surface.json`](../scripts/surface.json) — which is three copies to keep
true, and reads as anxiety rather than as a bound. Both of the others now carry the
short form and point here. The budget file keeps the part only it can enforce: a
warning, beside the permission list, that the budget alone would have said 03 and 02
are the same extension.

### Personal data, deliberately

02 could not display anybody's data — the retry badge declines
`lastFailure.message` on purpose, and everything in it is event metadata. **This
project's whole purpose is to display the data**, so the handling rules are
different in kind, not in degree:

- **Nothing is persisted.** No payload reaches `chrome.storage`, no file, no
  clipboard, no log line. `console` output in this project names counts and states,
  never payload text.
- **The in-memory cache is treated as retained personal data.** Bounded by
  `MAX_CACHED_PAYLOADS`; cleared when the codec endpoint changes, so the cache cannot
  keep serving text a *narrower* setting would no longer fetch; and cleared by the
  payload switch and by the master switch alike. Turning either off drops the decoded
  text the tab was still holding, which the user cannot see, as well as taking the
  panel off the page, which they can. Clearing it also bumps an **epoch**, because
  emptying the map is not enough on its own: a request posted under the old setting is
  still in flight and would otherwise write its answer into the cache it was supposed
  to be invalidated out of.
- **A hostile payload cannot become markup.** Every value goes to the DOM through
  `textContent`, and `npm run surface` fails the build on `innerHTML` and its
  relatives by *parsing* each file rather than matching lines of it.
- **Egress through this extension's own UI is always a gesture.** There is no path
  from a render pass to a codec request; through the panel, a payload leaves only for a
  row a human pointed at. **A forged `payload-request` needs no gesture** — see the
  section above. The property holds for the code in this repository and not for the bus
  it listens on, and those are two different statements.

## Enforced, not just claimed

```bash
npm run surface        # from the repository root
```

`scripts/surface.mjs` compares this project's manifest against the budget in
[`../scripts/surface.json`](../scripts/surface.json) and fails on a second
permission, any `host_permissions` entry, a service worker,
`web_accessible_resources`, `externally_connectable`, a runtime dependency, a
content-script match outside the three allowed hosts, and any of the markup/code
sinks. The budget entry for this project is the same as 02's and says so in
capitals, because the gate can only enforce the floor: **the audit for this rung is
the security card above, not the permission list.**

The tests are also mutation-audited rather than merely green. A green test proves
nothing until it has been shown to go red, and one hole was found that way: deleting
the shape check on an incoming answer left every tooltip spec passing, because the
specs around it all correlate — right shape, wrong run — and the id lookup turns
most malformed messages away anyway. What none of them covered was a message with
the four correlation fields *right* and a rendered field of the wrong type. That
spec exists now. The harness itself is deliberately not in this repository: it edits
source files in place, and a tool that does that does not belong beside the code it
mutates.

## What a production build would add, and this one deliberately does not

This is a **teaching** repository. Where a hardening step would have cost more
explanation than it bought understanding, it was left out — and written down here
instead of quietly omitted, because an unmentioned gap reads as a gap nobody saw.
Each of these is a real limitation, small, and known.

- **`prettyJson` guards long integers only, not every number JSON cannot round-trip.**
  `LONG_INTEGER` in `src/payloads/payloads.ts` catches the case that actually happens to
  account numbers and transaction ids — a 16-digit-or-longer integer literal — and
  shows the server's own formatting untouched. It does not catch a high-precision
  decimal (`1.0000000000000000001` prints as `1`) or an exponent past double range
  (`1e400` prints as `null`, because `JSON.stringify(Infinity)` is `"null"`). A
  production build would parse with a lossless reviver, or not re-serialise at all.
  Verify any claim like this the way these three were: run it, do not reason about it.
- **`safeCodecEndpoint` returns the string you typed, rather than rebuilding the URL
  from its parts.** It rejects anything that would stop `${endpoint}/decode` from
  being a path join — userinfo, a query, a fragment, and, since the round-trip check
  replaced a truthiness test, a *bare* `?` or `#`, which the URL API reports
  identically to having none at all. What it still passes through is a relative
  segment: `https://codec.example.com/base/../other` is accepted and posts to
  `/other/decode`, because that is what the URL resolves to. Surprising, same origin,
  and not a leak. A production build would return the normalised `href`.
- **`readCodecResponse` validates the array and its length, not each payload.** A
  codec server that returns the right number of wrong-shaped objects gets them merged
  in, and the panel then renders whatever `encodingOf` makes of them. The response
  comes from a host the user typed, so this is a robustness gap rather than a trust
  one — unlike the answer arriving over `postMessage`, which **is** validated to the
  leaves, because anything on the page can send one of those.
- **The pacer caps Temporal requests, not codec requests.** Four in flight to the
  Temporal API; the codec POST happens after that slot is released, so hovering fast
  across many encrypted rows can put more than four requests on your codec server at
  once. That is deliberate — a slow decoder must not occupy the cap that exists to be
  polite to Temporal — but a second, separate cap per codec destination is what a
  production build would add.
- **Switching off is not a revocation.** Covered in rule 5 above and repeated here
  because it is the one on this list a user could be surprised by: a payload already
  POSTed to a codec server is already there.

One rule is worth stealing even though it is not enforced by a gate: **`fetchForListedRun()`
is the only function that can attach the page's `Authorization` header.** Its sibling
`fetchFromPageWorld()` posts to an origin its *caller* chose and carries no credential
of ours. The two must never converge, and the difference between them is one word — who
chooses the origin. Collapsing them into one function with an `auth: true` flag would
type-check, and is exactly the change to refuse in review.

## What has not been done

- **No third-party security review.** The mechanism comes from an extension used
  internally, but this code is a clean-room rewrite and nobody outside this
  repository has audited it.
- **NOT confirmed against a real codec server on a live tenant.** The unit and jsdom
  specs are green, including every egress claim above against a fake network — and on
  this repository's own evidence that is not the same thing. A live round here has
  found something every single time: one found every per-row question answering
  *"Nothing observed on this page yet"* because the page's own `window.fetch` wrapper
  had evicted this extension's second observer, silently, for the life of the tab.
  Another found this very panel closing the instant the pointer entered it — unusable
  for its actual purpose, with a green suite behind it minutes earlier. Treat the
  behaviour of the codec path on a real tenant as **unverified**.
- **Rate-limit behaviour has not been observed in the wild.** The pacer is
  unit-tested against a synthetic 429 with an injected clock, and the wiring is
  asserted end-to-end through the fake network. No real Temporal rate limiter has
  answered any of it, and a synthetic 429 is exactly as considerate as the person who
  wrote it.
- **No supply-chain attestation.** Build it yourself; the bundle is unminified on
  purpose, so `dist/*.js` is readable.

One thing here *is* live-verified, and it is worth stating because it was carried over
by hand. The detail-page links — the workflow bar on the tab row, and the per-activity
link inside the row labelled "Activity Id" — were confirmed on Cloud 2.53.3 from
**this stage's own `dist/`**, not only from 02's, producing an identical result. That
matters because the edits bringing them into 03 were re-applied by hand across
`render.ts` and `content.ts` rather than merged, and a hand-applied hunk that lands in
the wrong place fails by rendering nothing — the same shape as every other silent
failure listed above. See 02's README for the markup that was read off the live page.

The same round also established what an absent link means, and neither answer is a
selector. With the extension installed *after* the workflow tab had finished loading,
the page carried no extension node at all — Chrome injects content scripts at page
load and never goes back for already-open tabs, so the tab needs one reload, which the
popup's "no answer from this tab" message now leads with. And an activity link is only
built if a configured template names an activity token, so a `links` array stored
before that template existed keeps it out permanently; `withActivityScope` in
`src/settings.ts` fills the missing *scope* once, until a human edits the list.

## Layout

`src/` is grouped by lesson. Its root holds the bundle entry points — the three the
manifest loads plus the popup's, which is the list in `esbuild.mjs` — and the modules
every lesson touches; each directory below them is one thing the extension does. `src/payloads/` is new here and `src/page/requestPacing.ts` is the
one file the next paragraph is about; the rest of the directories are 02's, though
**several individual files inside them changed** — the table in
[Read these files in order](#read-these-files-in-order) enumerates them, and
`npm run lineage` is what keeps the unchanged ones honest.

```
src/
  inject.ts         MAIN world — wraps window.fetch, posts the list rows it sees
  apiInject.ts      MAIN world — every message accepted from the page, in one switch
  content.ts        ISOLATED world — wiring, and nothing else
  popup.ts          the toolbar popup, including the codec verdict line
  render.ts         the table: finding it, identifying rows, ordering families — and
                    the master switch, which removes every node this extension added
                    and puts the row order back
  decoration.ts     every root class and shared render type the writers use, and
                    REMOVABLE_ROOT_CLASSES — the list the master switch sweeps
  settings.ts       chrome.storage.sync — including the one field that names a host
  types.ts          the shapes crossing the postMessage boundary
  page/             the boundary with the page's own Temporal API
    pageApi.ts      the bearer, the ledger, the response-watcher seam, and the two
                    exported fetches: one spends the page's credential on an origin
                    IT picks, the other carries none to an origin the caller picks.
                    They must never converge
    temporalApi.ts  pure: the API prefix and the two route builders
    pacer.ts        concurrency cap + 429/503 backoff, with the clock injected
    requestPacing.ts  the ONE pacer instance and the refusal decoder, shared by both
                    features that make requests. The one change here that is not a
                    feature — see above
  family/           the tree, as pure functions — stage 01, unchanged
    rows.ts         API response → a flat row shape
    tree.ts         rows → ordered rows, each with its connector
  rowInfo/          the two columns that cost a request
    rowInfo.ts      pure: the questions, the answers, and what a badge may say
    rowInfoClient.ts  ISOLATED world — which rows are worth asking about, and what
                    came back
    rowInfoServe.ts MAIN world — answers them: cache, then the pacer
    rowInfoRender.ts  draws the column and the badge — the only render job that
                    writes outside the workflow-id cell
  links/
    deepLink.ts     URL templates: tokens, offsets, scope, and what may become an href
    linkRender.ts   draws the anchors — the one render job used from two pages, so the
                    three hardening attributes on an outbound link live here once
  detail/           one workflow's own page
    detail.ts       pure: URL rules, the folds behind the links, and which activity
                    an id on the page resolves to
    detailWatch.ts  MAIN world — folds the page's own responses, fetches nothing
    detailLinks.ts  the links themselves, in the UI's own layout
  payloads/         this stage — the panel, and the only egress in the repository
    payloadMessages.ts  the two payload messages and their guards — the protocol alone
    payloads.ts     pure: what a payload is, what can be read in the browser, and how
                    it is formatted for the panel. Fetches nothing
    codec.ts        pure: what a codec request looks like — destination, headers, body
                    — and what is deliberately NOT in it
    valueGuards.ts  the two narrowings the payload path shares
    payloadButton.ts  draws the per-row `{ }` button, and deliberately puts no row
                    identity on it
    tooltip.ts      ISOLATED world — the hover panel: the element, the gesture, and
                    the five rules
    payloadClient.ts  ISOLATED world — one hover's question, and the four invariants
                    on its answer
    payloadServe.ts MAIN world — answers one hover: history, then the codec
public/
  manifest.json     one permission: storage — the same as 02
  popup.html        the settings pane (no inline script — MV3 forbids it)
  content.css       connectors, buttons, column, badge, link bar, panel
  icons/            generated: this project's number and hue, not a committed image
tests/              the ordering rules, the DOM bugs that cost the most, the request
                    gate, and every egress claim — from the attacker's side
```

`find src -name '*.ts' | xargs wc -l` prints the size.

The split is what makes the security card checkable: `src/payloads/payloads.ts` and
`src/payloads/codec.ts` are pure and therefore testable, `src/page/pageApi.ts` is the
only file that issues a request, and the only files that write to the page are
`src/render.ts`, the three render modules it calls (`src/rowInfo/rowInfoRender.ts`,
`src/links/linkRender.ts`, `src/payloads/payloadButton.ts`), `src/detail/detailLinks.ts` and
`src/payloads/tooltip.ts` — plus one line in `src/content.ts`, which toggles the master
switch's class on `<html>` and writes nothing else. `grep -rln 'createElement\|classList'
src/` is the check; the one other name it returns is `src/popup.ts`, which writes to the
popup's own document and cannot reach the page at all.

**Reviewing "what can this thing send" means reading four files, not one** — an
earlier draft of this line said one, which was the claim a reviewer had to disprove
by reading the other three. `pageApi.ts` *executes* the fetch and constrains it (no
credential, ever), but it does not decide that the fetch happens: `apiInject.ts` says
which messages are accepted at all, `payloadServe.ts` decides whether a payload is
unreadable enough to need a server and gates it on the ledger, and `codec.ts`
determines the destination, the headers and the body. One file is where the authority
is enforced; four is what the review actually costs. The reading order is at the top
of this README.

## What it deliberately does not do

- **It does not put payload data anywhere but the panel.** No copy button, no
  download, no export, no proxy of ours. Every one of those is a second egress path
  with its own redaction question, and the panel is the feature.
- **It does not search or filter inside payloads.** The internal extension behind
  this starter has a whole filter view for that; it is a large amount of UI and it
  teaches nothing about the trust boundary, which is what this repository is for.
- **It still writes nothing to Temporal.** No signal, no terminate, no reset, no
  update — anywhere in any project here.
- **It does not read the codec endpoint out of the Temporal UI's own settings.** An
  earlier version did, so that a page already decoding these payloads did not have
  to be told where its server is. It is a nicer first run and it is not what a
  starter kit is for: it added a second trust question, a resolution order that has
  to stay in step with the UI's own and did change between releases, and a large
  fraction of the codec path — for a convenience. `safeCodecEndpoint` in
  `src/payloads/codec.ts` carries the note, and "The endpoint used to come from the page" in
  [`docs/design-notes.md`](../docs/design-notes.md) says what to read if you want it
  in a fork.

Column reorder, a larger page size, a cross-workflow activity finder and
expand-to-families are stage 04's conveniences; none of them changes what the
extension can reach, which is why they are not here.

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
