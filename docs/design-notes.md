# Design notes

Why some of this code is shaped the way it is.

Source comments in this repository state a file's **responsibility** and the
**invariants** it holds. That is what someone editing the code needs. This file holds
the other half: the **incidents**. Most invariants exist because something went wrong
first, and a rule with no failure attached to it reads like taste and gets refactored
away — but the story does not belong in the file it is about.

Nothing here is required reading to use the extensions. It is required reading before
deleting a rule.

**The shape to write, from here on.** A rule earns two lines in the source — the
invariant, and the consequence of breaking it — and a link to its section here if
there is a story:

```
// INVARIANT: <what is true after this returns>.
// Breaking it: <what the reader would see>. See docs/design-notes.md#anchor.
```

Dates, the reproduction, and what was tried first belong in the section. Existing
headers are longer than that because they were written before there was anywhere else
to put the argument, and `npm run doc:paths` checks that the `#anchor` half of such a
link names a heading that exists.

## Contents

- [The payload panel](#the-payload-panel)
  - [Hover intent has to remember which button](#hover-intent-has-to-remember-which-button)
  - [Two ways to close a panel under the pointer](#two-ways-to-close-a-panel-under-the-pointer)
  - [A late answer, and the four places one can hide](#a-late-answer-and-the-four-places-one-can-hide)
  - [One question, three entry points](#one-question-three-entry-points)
  - [Switching it off has to take the node and the text](#switching-it-off-has-to-take-the-node-and-the-text)
- [Payloads and the codec server](#payloads-and-the-codec-server)
  - [The endpoint used to come from the page](#the-endpoint-used-to-come-from-the-page)
  - [Sending the whole array sent data that had no reason to leave](#sending-the-whole-array-sent-data-that-had-no-reason-to-leave)
  - [Pretty-printing silently corrupted long integers](#pretty-printing-silently-corrupted-long-integers)
  - [A query string is not a base URL](#a-query-string-is-not-a-base-url)
  - [The credential switches that were deleted rather than defaulted off](#the-credential-switches-that-were-deleted-rather-than-defaulted-off)
- [Deep links on the detail page](#deep-links-on-the-detail-page)
  - [The floating card was the wrong answer](#the-floating-card-was-the-wrong-answer)
  - [Where the links are allowed to sit](#where-the-links-are-allowed-to-sit)
  - [A stored setting that shadowed a new default](#a-stored-setting-that-shadowed-a-new-default)
- [The master switch](#the-master-switch)
  - [Off left the table sorted](#off-left-the-table-sorted)
  - [A restored order that outlived its welcome](#a-restored-order-that-outlived-its-welcome)
- [Splitting render.ts](#splitting-renderts)
  - [Why each of the four files exists](#why-each-of-the-four-files-exists)
  - [The age that climbed while the fact stood still](#the-age-that-climbed-while-the-fact-stood-still)
  - [The button that knows nothing](#the-button-that-knows-nothing)
  - [The press that was stamped an hour early](#the-press-that-was-stamped-an-hour-early)
- [Dependencies](#dependencies)
  - [Two schema libraries, measured](#two-schema-libraries-measured)
  - [Two queue libraries, measured](#two-queue-libraries-measured)
  - [The cache a TTL made look bounded](#the-cache-a-ttl-made-look-bounded)
  - [The formatter that was fine and the applier that was not](#the-formatter-that-was-fine-and-the-applier-that-was-not)
  - [The guard that checked the envelope and cast the rest](#the-guard-that-checked-the-envelope-and-cast-the-rest)
  - [Every JSON viewer wanted a parsed value](#every-json-viewer-wanted-a-parsed-value)
- [The gates](#the-gates)
  - [A Node range the dependencies never promised](#a-node-range-the-dependencies-never-promised)
  - [Two algorithms the gates had no business owning](#two-algorithms-the-gates-had-no-business-owning)
  - [A card nobody was checking](#a-card-nobody-was-checking)
  - [A hostname with no letters in it](#a-hostname-with-no-letters-in-it)

## The payload panel

The panel is `03-payloads/src/payloads/tooltip.ts` (the element and the pointer) and
`03-payloads/src/payloads/payloadClient.ts` (the questions and the answers). The rules
are stated at the top of those two files — numbered *rules* in the first, *invariants*
in the second, so a citation says which file it means. All but one are a bug that
happened.

### Hover intent has to remember which button

**Rule 2.** A delay before asking means moving the pointer across a table costs no
requests. The first version armed one timer for the first button entered and ignored
every button entered while it was pending — so pointing at row A and moving to row B
inside the delay opened the panel anchored to **B** and filled it with **A's** payload.
Traversing a table is exactly the gesture the delay exists to make cheap, so the rule's
own implementation broke invariant 1.

The fix is one field: the timer remembers which button it is for, and a different button
cancels and re-arms rather than being dropped.

### Two ways to close a panel under the pointer

**Rule 3.** A panel that vanishes when the pointer leaves the button cannot be read,
scrolled, or selected out of — and selecting a value out of it is most of why anyone
opens it. Both attempts to uphold this shipped broken, and both read as "the tooltip
is impossible to use".

1. **`pointerout` between two elements inside the panel closed it.** `pointerout`
   fires on every element-to-element move, including heading → body inside the panel,
   and `pointerenter` does not fire again between descendants, so nothing cancelled
   the close: the panel disappeared the instant the pointer entered it. The fix
   inverts the listener — `pointerover` bubbles and fires for every element entered,
   so one delegated listener answers "over the button / inside the panel / somewhere
   else". `pointerout` is kept for the one case `pointerover` cannot report, the
   pointer leaving the document and entering no element at all
   (`relatedTarget === null`).
2. **A capture-phase scroll listener closed it when the panel's own scrollbar was
   used.** The panel is a scroller too, so reading a long payload dismissed the thing
   being read. Capture is necessary — scroll does not bubble — so the listener has to
   ask whether the scroller *is* the panel.

A third case is the same rule, not a bug: a text selection dragged past the panel's edge
must not close it, so the grace period is suspended while a mouse button is held down
inside the panel. The release is listened for on the **window**, because a pointer
pressed inside the panel is routinely released outside it, and a `pointerup` never seen
would leave the panel open for good.

### A late answer, and the four places one can hide

**Rule 4, and invariants 1 and 3.** Two hovers are two requests in flight and they can
answer in either order, so every fill is stamped with the generation of the hover that
asked. Separately, an answer has to name the question it answers: the request id is a
small integer starting at 1 in every tab, so "it carries id 3" is something a forged
message gets right by accident. All four parts — namespace, workflow id, run id, kind —
are checked, and the same four are the cache key, so the two cannot drift apart.

That check does more work here than for the per-row questions. The worst a wrong
last-event answer does is print the wrong event type in a cell. The worst a wrong
payload answer does is put one workflow's decrypted input under another workflow's
name: somebody else's personal data, on screen, labelled as this customer's.

**The invalidation is the part that took two reviews.** When the codec setting changes,
four things can be holding an answer from before the change, and the first version
emptied two of them:

| Holder | Emptied by |
|---|---|
| The cache | `cache.clear()` |
| A request in flight | `inFlight.clear()` |
| A late answer still allowed to paint | `cacheEpoch++` stops it being cached and nothing more; being *rendered* is gated on the generation counter, so the step that stops that is `close()` |
| The text **already painted** | `erasePanelText()` |

The third meant the setting a user had just removed could still paint its decode into
the open panel, one hover later. The fourth was found by a later review: `close()` sets
`hidden`, which stops the text being **shown** and does nothing about it being
**there**. The panel lives on `document.body`, in the DOM the page shares with us — an
ISOLATED world does not get its own — so decoded payload text left in a hidden node is
still text any script in the page can read out of it. Hiding personal data is not
erasing it.

### One question, three entry points

**Invariant 2.** Three entry points reach the same row: a hover opens it, Tab focuses
it, and a click fires `focusin` **and** `click`. Every one found an empty cache and
posted its own message, because the cache only answers "have we asked this before?" once
the answer has **arrived**. Two requests for one panel — and on the one rung that
forwards payloads to a codec server, two copies of somebody's data leaving the machine
for one glance. So a question already in flight is **joined**, not asked again.

The cleanup on that join has a sharp edge: the in-flight entry must be removed only if
it is still *this* attempt's. Resetting empties the map while requests are still out, so
the same key can legitimately hold a newer attempt by the time an older one settles. An
unconditional delete removes the new attempt's entry, and the next hover — which should
have joined it for free — posts a third request instead.

### Switching it off has to take the node and the text

**Rule 5.** The `{ }` buttons live in the table, so the render pass removes them. The
panel lives on `<body>`, so nothing in a render pass touches it. Turning the payload
switch off while a panel was open left it on screen — a decoded payload sitting there,
under a switch that said the feature was off.

Off has to mean three things, and leaving out any one leaves personal data where a user
who just switched the feature off would not expect it: the node, the *reference* to the
node (or the "is the pointer inside the panel?" test keeps answering yes for a detached
element, and a click outside stops closing anything), and the decoded text behind it.

What switching off cannot do is recall a request already sent. A payload already POSTed
to a codec server is already there. Off stops the next question; it is not a
revocation, and the popup does not claim otherwise.

## Payloads and the codec server

### The endpoint used to come from the page

A version of this extension read the codec endpoint out of the Temporal UI's own
settings, so a page already decoding these payloads did not have to be told where its
codec server is. It is a nicer first run, and it is not what a starter kit is for: it
added a second trust question — page state chose a host, so the access token had to be
excluded from that path and the panel had to say which endpoint it used and why — plus a
resolution order to keep in step with the UI's own,
`(override && localStorage.endpoint) || settings.codec.endpoint`, which is not guessable
and did change between releases.

Deleted on that basis; the popup is now the only source. To put it back in a fork, read
the UI's own `getCodecEndpoint` helper — in Temporal's own UI repository, temporalio/ui,
under src/lib/utilities — and mirror it rather than guessing key names: guessing produced
a feature that was silently off, on a page whose codec server was configured and working.

### Sending the whole array sent data that had no reason to leave

The first version sent the whole `payloads` array whenever **any** member of it needed
a codec, because that keeps the answer aligned with the request by index and costs one
line less.

The cost of that line is data. A workflow started with two arguments — a plaintext
`json/plain` customer record and one encrypted blob — would have had **both** posted to
the codec server, and the plaintext one had no reason to leave the browser at all. So
the positions are carried instead: `positions` is what makes the answer re-attachable,
and sending a subset without it is what would mislabel data.

### Pretty-printing silently corrupted long integers

`JSON.parse` turns every number into an IEEE double, so an id of `12345678901234567890`
comes back as `12345678901234567000`, and `JSON.stringify` writes that back out. The
value on screen is then simply wrong, in a way that looks exactly like real data — and
account numbers and transaction ids are precisely the fields long enough for it to
happen to.

It is not only the very long integers. `-0.0` serialises as `0`, so a reversal becomes
nothing; `9007199254740993` becomes `…92`; `0.1000` becomes `0.1` and `2.0e+10` becomes
`20000000000`, either of which can be the difference between a value that pastes back
into a request and one that does not. Each is asserted, with the damaged output written
out, in `03-payloads/tests/unit/payloads.spec.ts`.

**The fix is not to format.** `decodePayload()` in
`03-payloads/src/payloads/payloads.ts` does base64, then UTF-8, then stops. A
single-line JSON payload is displayed as a single line, in a `<pre>`, exactly as the
server wrote it. There is no `prettyJson` and nothing in this rung that could rewrite a
value. That is a real cost — the panel is harder to read than it could be — and three
attempts at making it easier all failed a test this rung cares about:

1. **`JSON.parse`/`JSON.stringify`.** Corrupts long integers. Non-negotiable.
2. **A regular-expression heuristic** — skip formatting when a 16-digit-or-longer number
   is present. Never *wrong*, and it shipped for a while. But it gives up on the whole
   payload, so the financial payloads are exactly the unformatted ones, and it protects
   only what the regex knows about: `-0.0` and `0.1000` were still quietly rewritten.
3. **A lossless formatter over jsonc-parser**, every edit replacing whitespace *between*
   tokens so no token can change. It worked; a 20-digit id came out pretty-printed and
   byte-identical. It went back out anyway, because it is a **dependency bought for
   comfort**, and comfort is stage 04's department.

The measurements from (3) survive in [The formatter that was fine and the applier that
was not](#the-formatter-that-was-fine-and-the-applier-that-was-not), and the library
survey in [Every JSON viewer wanted a parsed
value](#every-json-viewer-wanted-a-parsed-value). Ugly beats wrong, taken all the way:
what the server sent is what you see.

### A query string is not a base URL

The endpoint validator accepted any HTTPS URL, and the request builder appends `/decode`
to it by string concatenation. So `https://codec.example.com/base?tenant=a` became
`https://codec.example.com/base?tenant=a/decode` — a POST to `/base` whose query is now
"tenant=a/decode". That is a URL a server will answer, and answer **wrongly**: a
plausible response from the wrong endpoint, not an error anyone would notice. A
`#fragment` does the same thing and is not even sent to the server. Userinfo
(`user:pass@`) is refused on the same path for a different reason — it is a credential
the browser would apply on our behalf. All three are rejected rather than stripped: a
user who typed a query meant something by it.

The guard then got the boundary wrong, and a code review caught it. Reading `.search`
and `.hash` and refusing anything truthy is correct for `?tenant=a` and wrong for a
**bare** delimiter, because the URL API spells an empty query and an empty fragment as
the empty string, exactly as it spells having neither. So an endpoint ending in `?` or
`#` was accepted and `/decode` was appended into the query: the original bug, reachable
by the most ordinary route there is, pasting a URL out of an address bar. The guard now
saves `href`, clears both, and refuses the endpoint if `href` changed.

The regression spec should have caught it twice over and did not. First it was a
tautology — a property test asserting "every accepted endpoint is safe to append
`/decode` to", fed three endpoints that are accepted anyway, so deleting the guard left
it green. Then, no longer a tautology, it still had no boundary value in it: **a property
test's candidate list IS the test.** The four bare-delimiter endpoints are now in that
list, along with an encoded `?` inside a path — which must be *accepted*, so the same
list also guards against a fix that over-rejects.

### The credential switches that were deleted rather than defaulted off

Temporal's own UI offers to pass your access token to the codec server, and to send
cookies with the call. This extension had both. They were removed once the request path
was read as a trust boundary rather than a feature list, and the argument is one
sentence: **the config arrives over `postMessage`.**

Anything on the page can name the endpoint. A credential flag sitting beside a
caller-chosen host is a credential a forged message can aim, and it would be aimed from
the page world, which is exactly where the live bearer and the session cookies are.

Note what this is **not**: it is not "the flag defaults to off, so we are fine". A
default protects the honest path through the popup and does nothing about a message that
sets the field to `true` on its way past, because the value that reaches the fetch is the
one in the message. Ambient authority plus a forgeable bus means the only safe number of
credential switches is zero.

The enforcement is deliberately not in the file that builds the request. That file only
**describes** it, and its return type has no `credentials` field to set;
`fetchFromPageWorld()` in `src/page/pageApi.ts` is what **spends** it, writing
`credentials: 'omit'` as a literal and refusing an `Authorization`, `Cookie` or
`Proxy-Authorization` header outright. Enforcing it at the boundary is what makes it
hold for the next caller too.

If a fork needs an authenticated codec server, the honest fix is not to add the flag
back. It is to stop taking the endpoint from a message at all: read it in the
extension's own world and pass it in with `chrome.scripting.executeScript`, which needs
`host_permissions` — a real permission for a real capability, which is the trade this
whole repository is about.

## Deep links on the detail page

### The floating card was the wrong answer

The first version of `src/detail/detailLinks.ts` drew one fixed box in the bottom-right
corner listing every activity it knew about, and its own header argued for it: rule 1 at
the top of `render.ts` is ANCHOR TO MEANING, NOT POSITION, and a workflow's page — so the
argument went — has no equivalent for "activity N", because the timeline is SVG and the
event list is virtualised.

**The premise was false, and the way it was false is the part worth keeping.** When the
UI opens an activity's panel it renders a labelled row whose label is the words "Activity
Id" and whose value is the id. That is meaning, not position — the label is the UI's own
name for the field and it survives a restyle. Reasoning from "I cannot see an anchor" to
"there is no anchor" produced an overlay that covered the page it was annotating and
listed activities the reader had not asked about.

It was worse than clutter. Because nothing on the page could be attached to, the card
could not put a link **on** an activity either, so it listed them and told the reader to
add `{activityType}` to a template for per-activity links. A feature that explains how to
configure itself, on the page where it could simply have worked, has given up — and the
type it suggested keying on is not an identity, so following the instruction produced
links that quietly matched the wrong activity.

### Where the links are allowed to sit

The links on a single workflow's page sit in the UI's own layout, which the extension
does not control and does not fork. Two anchors are used, and the second exists because
the first is not always there.

The consequence worth knowing: an anchor found by structure rots when the UI changes
its markup, and it rots **invisibly** — the links simply do not appear, which reads as
"the feature is off" rather than "the selector missed". So the resolution is asserted in
`03-payloads/tests/unit/detailLinks.spec.ts` for both anchors, together with the
idempotency of a second pass and the fact that an id that cannot be resolved to one
activity gets no link at all.

The internal extension paid for the other half. When its selectors went stale the node
was not missing — it was attached to `<body>` at the top-left, invisible behind the app's
own chrome, which reads as "the feature only appears after you toggle it" and was
diagnosed twice before anybody found the cause. Hence `LINK_BAR_ADRIFT_CLASS`: a bar that
cannot find its anchor is parked somewhere it can be **seen**, the popup counts that
state, and every pass looks for the real anchor again.

### A stored setting that shadowed a new default

Per-activity link templates were added after the settings shape already existed in
users' browsers. Anyone with saved settings had a stored links array that predated the
activity template, and a stored array wins over a new default — so the new per-activity
links were silently unreachable for exactly the users who had used the extension before.

The fix defaults the **scope**, not the array, one time. `withActivityScope` in
`src/settings.ts` is that migration, and it is the one part of `settings.ts` that is
byte-identical across the projects that have it, which is why its spec is registered as
shared while the rest of `settings.ts` is a declared fork.

## The master switch

`removeAllDecoration` in `02-techniques/src/render.ts` and `03-payloads/src/render.ts`.
One production caller each: the `if (off)` early return in `content.ts`.

### Off left the table sorted

The switch was written as "remove the nodes", because for a long time every trace this
extension left *was* a node. It grew two exceptions quietly — an inline `margin-left` and
a `data-tuis-workflow-id` marker — and both were caught. The third was not a trace at all
in the sense the function was looking for.

Reordering the `<tbody>` is the whole point of the extension, and it is the one edit that
leaves **nothing behind to find**: the rows are the page's own, and moving them writes no
class, no attribute and no style. So a sweep built from a list of class names could be
provably complete and still leave the table grouped into families with every connector
stripped off it. Off did not look off. It looked broken: a sort no Temporal UI control
explains, and no visible cause.

The fix is one call — `restoreOriginalOrder(tbody, rowsOf(tbody))` — which was already
idempotent because the render path runs under a `MutationObserver` and rule 2 applies to
it too: a table already in its original order is not written to, so switching off does not
wake the observer.

How this was found matters. It was **not** found by the cleanup spec, which existed and
passed: its fixture started in `parent, child-a` order, which is already the family
order, so "put the rows back" and "never moved them" produced the same green. The fixture
is now deliberately out of family order, and the spec asserts the order twice. The sweep
list is now a value, `REMOVABLE_ROOT_CLASSES` in `decoration.ts`, which keeps the code
and the documentation from disagreeing about the nodes — but note what it cannot do: it
could not have caught this, because the missing piece was never a class.

### A restored order that outlived its welcome

The fix above introduced this one, which is the more interesting of the two.

`originalPosition` is a `WeakMap` from `<tr>` to the index it had on the first pass, and
the first version kept that index for as long as the row existed. Every disabled pass
sorted by it. That reads as obviously correct — restore what we recorded — and it is
wrong after the second event:

1. The extension records order A and groups the rows into families.
2. The user switches the tree off; the first disabled pass restores order A. Correct, and
   this is what the tests asserted.
3. The user clicks a column header. Temporal sorts its own table into order B, reusing the
   same `<tr>` elements.
4. That mutation wakes the `MutationObserver`, and the pass it schedules sorts by the
   recorded positions and puts order A back.

So a switched-off extension quietly undoes the sort controls of the page it is off in,
every time, for as long as the tab is open. Worse where the tree starts disabled: the
first pass records whatever order it finds and there is no grouping to undo, so the
extension does nothing visible at all except overrule the column headers.

The fix is a delete. `restoreOriginalOrder` now removes the entries it just used, so a
recorded position is a **one-shot**: the next pass records the order the page is in *now*
as the new baseline. It is forgotten even when nothing moved, because "already in the
recorded order" is still a restore.

What made this survive review twice is the shape of the test. The specs asserted the
restore, then stopped — one enabled pass, one disabled pass, assert — and nothing followed
the *second* disabled pass, where the whole failure lives. `hostResorts` in
`tests/renderHarness.ts` is that missing actor: it reorders the existing rows the way a
column click does. Both new cases assert against it twice, and the first of those is not
decoration — written the obvious way, comparing the helper's own return value to the table
it just reordered, it compares a value to itself and passes even when the helper does
nothing. The assertion has to name the order the bug would produce.

## Splitting render.ts

`render.ts` grew until it was the file every feature had to be edited in, and the header
had to apologise for three things it held that were not about the table it described. It
is now four files plus the pass itself.

### Why each of the four files exists

Each one earns its own file for a reason that is not "render.ts was long":

- **`src/decoration.ts`** — the vocabulary two files both name, and the master switch's
  contract as a value (`REMOVABLE_ROOT_CLASSES`). It gives a reviewer one file to read
  for "what can the master switch fail to remove?".
- **`src/links/linkRender.ts`** — the one render job used from **two** pages: the
  workflow list, and a single workflow's own page through `src/detail/detailLinks.ts`.
  While it lived in `render.ts`, "everything that writes to the table" had an export that
  wrote somewhere else. Two copies of it agreed for exactly as long as it took to add one
  field to one of them.
- **`src/rowInfo/rowInfoRender.ts`** — the largest render job, and the only one that
  writes **outside** the workflow-id cell: the column touches the `<thead>` and every
  body row. Its specs were already a file of their own
  (`tests/unit/renderRowInfo.spec.ts`) before the source was.
- **`src/payloads/payloadButton.ts`** — the only thing in a render pass that belongs to
  stage 03. Keeping it beside the rest of `src/payloads/` is what makes "what did 03
  add?" answerable from a directory listing.

### The age that climbed while the fact stood still

The "Last event" column was briefly written the obvious way: an age computed against
`Date.now()`, redrawn by a once-a-second ticker. It advanced every second while the fact
underneath it was re-read every 35, so a workflow that had already moved on displayed a
stall climbing in real time — the most convincing possible way to be wrong, because the
seconds ticking make it look live.

Second-resolution is worth having; a second-resolution measurement of something read half
a minute ago is not. So the ages are frozen at the reading, which has a second consequence
worth more than the first: `syncLastEventColumn()` becomes a pure function of the answers
it was handed, and feeding it the same answers twice writes nothing the second time,
however much wall-clock time has passed.

The column was also appended to the end of each row once, and appending really is simpler
— the end of a row has to agree with nothing. Inserting has to agree with a column order
the Temporal UI lets the user change, which is why the position is computed on every pass.

### The button that knows nothing

The `{ }` button carries no workflow id, no run id, and not even a title that names one.
That looks like an omission and is the whole design: the Temporal UI recycles `<tr>`
elements as the list updates, so anything stamped onto a row-scoped node can outlive the
row it described. A button holding a stale run id opens a panel of somebody else's
payloads — on the one rung of this ladder where the panel contains decoded data.

Nothing on it can go stale because nothing on it is a fact.
`src/payloads/tooltip.ts` resolves the row from the cell's own `href` at the moment of
the hover. It also makes the button the cheapest write in a render pass: once created,
every later pass leaves it alone.

### The press that was stamped an hour early

The refresh button in the column header disables itself for `FRESH_FLOOR_MS` after a
press, because the receiver would refuse to re-fetch inside that window and a button
that accepts a press which does nothing is worse than one that says so.

It recorded the press with `options.nowMs` — the timestamp of the render pass that
installed the handler. That is the same clock `Date.now()` reads; what was wrong was
*when* it had been read. A handler outlives the pass that installed it, and on a quiet
page the table renders once and nothing touches it again, so a press an hour later was
stamped an hour early: the next pass measured a floor that had already elapsed and
re-enabled the button immediately.

The general shape is not specific to a clock. A value captured in a render pass and read
from an event handler is a value read at the wrong time; anything in a handler that
describes *now* has to ask now.

## Dependencies

The policy is one sentence, and `scripts/surface.json` keeps it under `dependencies`:
**browser APIs and code in this repository for anything specific to this extension;
mature, maintained libraries for generic algorithms, where using one makes the example
easier to read and harder to get wrong.** Each project's README lists what it bundles
and why, by hand; `npm run measure` prints what those packages cost the bundles a user
actually loads.

Nothing checks a table against its bundle — the same `dependencies` note in `surface.json`
says what removing that enforcement gave up. One rule survived it, because a lockfile diff
cannot answer it: a third-party package that enters a bundle through a project's own source
must be declared in *that* project's `dependencies`, since the three projects share one
hoisted install and an import of a sibling's package would otherwise resolve, bundle, and
appear in no diff anywhere. For
everything else the review point is the `package-lock.json` diff, and the reason the bundles
ship unminified is that `dist/*.js` should be readable by whoever wants to check.

This section holds what neither the table nor the command can say: which alternatives were
measured, and why the one that lost, lost. Every measurement below is a recorded experiment
with a date on it, not a live claim — a library's next release can change any of these
numbers, and the command that prints today's is named above.

### Two schema libraries, measured

Cited from `src/types.ts` in all three projects. The first implementation used **zod**,
which is the obvious choice and a genuinely excellent library; the API difference is
small enough that the port between them was mechanical.

The bundles were not. Measured 2026-09-03, the same three schemas — the workflow entry,
the list envelope, the `postMessage` envelope — compiled with exactly the options in
`02-techniques/esbuild.config.mjs` (`bundle`, `format: 'iife'`, `target: 'chrome110'`,
**not** minified):

| Library | Version | Third-party bytes in the bundle | Third-party files |
|---|---|---|---|
| valibot | 1.4.2 | 13,291 | 1 |
| zod/mini | 4.5.4 | 36,179 | 12 |
| arktype | 2.2.3 | 311,628 | 105 |
| zod | 4.5.4 | 753,678 | 94 |

**Why the numbers are so far apart, and why that is not a criticism of zod.** zod's
classic API hangs every method off every schema object, so a bundler cannot tree-shake a
schema's unused methods away; the mini export exists precisely to fix that and does.
arktype compiles its own type syntax at runtime, which means shipping the compiler. None
of that is waste in an application that uses more of the library than this one does —
three envelopes and a handful of field checks is close to the smallest possible ask.

**Why valibot stays now that the table no longer decides anything.** Size was a gate when
this was measured and is not one any more (see [A card nobody was
checking](#a-card-nobody-was-checking)). What carries the choice instead is that a
migration is a simplification only if it removes concepts or code, and porting to zod would
remove neither — the schemas are the same schemas, across three stages that all validate
with the same library. The bytes are now an argument rather than a check: a reader is asked
to open `dist/content.js` and look at it, and three quarters of a megabyte of validator
inlined four times over makes that a thing nobody will do.

**What the measurement did not decide.** Every semantic this code relies on was checked
against the library empirically first, because two are surprising: `v.number()` accepts
`Infinity` (so every numeric field here is `v.pipe(v.number(), v.finite())`), and
`v.nullable(x)` accepts `null` but still requires the key to be **present**. A library
chosen on bytes and adopted on assumption would have shipped a hole.

### Two queue libraries, measured

Cited from `src/page/pacer.ts` in 02 and 03. The pacer's slot accounting — four at a
time, queue the rest, start the next when one finishes — was hand-written, had no tests,
and was **wrong**: it checked the slot count, then slept out the backoff, then took a
slot, so during a backoff every caller passed the check and woke together. The full story
is at the top of `pacer.ts`; the point here is that this is a generic algorithm with no
Temporal in it, which is exactly the case the policy says to hand to a library.

**p-queue** was evaluated first, being the name people reach for. It works, and the tests
in `tests/unit/pacer.spec.ts` pass against it unchanged. It also carries priorities,
per-task timeouts, task ids, an event emitter, pause/resume and an `intervalCap`, none of
which this file uses. Measured 2026-09-03 in `dist/apiInject.js`, the only bundle either
of them enters:

| Library | Version | Packages bundled | Third-party weight added, in the units `npm run measure` prints |
|---|---|---|---|
| p-limit | 7.3.2 | 2 (p-limit, yocto-queue) | 2.6kb + 1.2kb |
| p-queue | 9.3.3 | 3 (p-queue, eventemitter3, p-timeout) | 27.2kb + 6.4kb + 2.2kb |

An order of magnitude, for capability that is not called. `p-limit` is also the closer fit
on the API: its `activeCount` and `pendingCount` are precisely the two numbers the pacer
exposes, where p-queue's `pending`/`size` needed a mapping and a paragraph explaining which
was which.

`intervalCap` is the feature that looks made for this and is not. It is a rate limit **we**
choose in advance; Retry-After is a wait the **server** asked for, and wiring the second
through the first would have made the Temporal-specific half of this file — the part a
reader forks — read like configuration of a library instead of a decision about a server.

**What this cost, honestly.** The change removed about fifteen lines of slot accounting and
added rather more comment than that explaining the split and the rejected alternative. The
trade is deliberate: the code that had a concurrency bug in it is no longer code this
repository maintains, and what is left in the file is Temporal policy and nothing else.

### The cache a TTL made look bounded

Cited from `src/rowInfo/rowInfoServe.ts` in 02 and 03. The evaluation that ended in **no
dependency** — recorded because it is the same policy applied to a case where it points the
other way, and because looking for the library found a real bug.

**`lru-cache` was evaluated for the bounded maps and not adopted.** There are four of them
across 02 and 03: the per-field answer stores here, the paired `results`/`askedAt` maps in
`rowInfoClient.ts`, the decoded payloads in `payloadClient.ts`, and — not a cache at all,
but bounded for the same reason — the run ledger in `pageApi.ts`. It is mature, does all of
this, and would replace some counting. Three things decided against it:

1. **Per-key eviction is the wrong semantics for the paired maps.** `evictIfHuge()`
   clears `results` and `askedAt` **both or neither**, because dropping the answers while
   every row still counts as recently asked is precisely the combination that leaves the
   user staring at an empty column until the ask interval expires. That coupling is the
   bug fixed in that function; independent per-key eviction across two caches is what
   would reintroduce it, and it is what an LRU does by design.
2. **Its TTL runs on a different clock.** `lru-cache`'s internal timestamps come from
   `performance.now()` where it exists (`defaultPerf`, checked against 11.5.2 on
   2026-09-03), while every date in this module has to be `Date.now()`. A documented `perf`
   option fixes it — which is the point rather than a defence: that is library-specific
   knowledge a reader has to hold, forgetting it leaves the module on two clocks whose
   *origins* differ, and nothing fails loudly, because the TTL test drives expiry with a
   single `vi.spyOn(Date, 'now')` and would simply stop controlling it.
3. **`fetchMethod` brings more than coalescing.** In-flight deduplication here is one
   `Map<string, Promise>`; the library's also carries abort signals, two stale-on-rejection
   options and background refresh. The failure policy at this boundary is one sentence — a
   failure is cached, with the same TTL, so one 403 does not become a thousand — and reads
   better as that sentence than as the options that reproduce it.

For the same reason there is no `p-memoize` plus a TTL package here: two dependencies to
describe two `Map`s, whose interaction a reader would then have to work out, is more
explanation surface than the maps.

**What the evaluation found.** Reading the four side by side to price the port showed that
three had an entry-count bound and this one had only `TTL_MS`. A TTL looks self-limiting and
is not: an expired entry is overwritten when the same run is asked about again, and a run
the user has scrolled past is never asked about again — so a tab left open on a busy
namespace held an answer for every run it had ever displayed, for the life of the page. The
fix is the same crude whole-map clear as its siblings, because the next render pass re-asks
for the rows that are actually on screen, so being crude costs one extra round.

The bound's test counts requests rather than entries: removing the eviction line turns it
red because the observable consequence of the bug is a question the extension no longer
needs to ask.

### The formatter that was fine and the applier that was not

**This evaluation is history: 03 no longer depends on `jsonc-parser`, and there is no
`jsonText.ts`.** It is kept because the measurement below was the expensive part to get, and
it is the first input stage 04 will want the day it builds a payload viewer. Why the
dependency went back out is in [Every JSON viewer wanted a parsed
value](#every-json-viewer-wanted-a-parsed-value). It was the only evaluation where a library
was adopted **in part** — its scanner and formatter yes, its edit applier no.

**Why the dependency, given that the file is 190 lines either way.** What is borrowed is not
effort but correctness in the places a hand-written JSON scanner is wrong without looking
wrong: string escapes and surrogate pairs, the exact number grammar (a leading zero, a lone
`-`, `1e`, `.5`), and the offset at which a document stops being valid. This module's output
is a *value the reader will copy into a request*, so a scanner bug shows a wrong account
number rather than a wrong colour. jsonc-parser is Microsoft's, MIT-licensed, has no
dependencies of its own, and is the scanner underneath VS Code's JSON support.

**Why not `applyEdits()`.** `format()` returns a list of edits, and applying them is one
line of library API. That line rebuilds the whole string once per edit —
`text.substring(0, offset) + content + text.substring(offset + length)`, in a loop — and
`format()` emits roughly one edit per token, so the cost is quadratic in the size of the
payload. Measured against jsonc-parser 3.3.1 on 2026-09-03, on arrays of records with
19-digit ids:

| bytes | edits | `applyEdits()` | one pass | identical output |
|---|---|---|---|---|
| 1 KB | 191 | 0.8 ms | 0.0 ms | true |
| 13 KB | 1,901 | 10.4 ms | 0.2 ms | true |
| 131 KB | 19,001 | 2,431.6 ms | 2.2 ms | true |
| 526 KB | 76,001 | 18,606.7 ms | 5.2 ms | true |

The last row is measured, not extrapolated, and two things make it worse than it looks:
this runs on the **page's** own main thread — 03 formatted before the text crossed
`postMessage`, so an eighteen-second applier freezes Temporal's UI, not ours — and
half-megabyte payloads are what a workflow carrying a batch looks like, not an exotic case.

So `applyFormattingEdits()` walked the sorted edits once and joined the pieces: the same
algorithm, expressed the way that does not re-copy, with the `identical output` column as
the claim that mattered. The one thing the single pass has to handle that the library's does
not is an **overlapping edit**, because `slice(from, to)` with `to < from` returns `''` and
would silently drop characters — precisely the failure that file existed to prevent.
`format()` emits none across the ten shapes it was checked against; the guard was there
anyway, refusing to format rather than dropping anything, and exported so the spec could
reach it. A guard that cannot be tested is a comment.

**What 03 does instead, now.** Nothing: `decodePayload()` stops after UTF-8 and the panel
shows what came back — no formatter, and therefore no formatter that can be wrong. That gap
is the feature stage 04 buys back, at which point the table above says what the applier
costs and the survey below says what the scanner options are.

### The guard that checked the envelope and cast the rest

Cited from `src/rowInfo/rowInfo.ts` and `src/detail/detail.ts` in 02 and 03. Before the
schemas, both boundaries were guarded by a hand-written predicate, and both had the same
hole — worth recording once, because it is the hole a hand-written guard tends to have.

The guard checked the **envelope** and cast the **contents**. `rowInfoResult` verified four
fields of the message and declared the payload `LastEvent | null`, so a message carrying
`lastEvent: 42` satisfied the guard and reached a renderer that reads `event.eventType`
straight into a template. `detail-facts` verified four envelope fields plus
`scheduledEventId` on each activity, then cast the rest, so a forged `outcome: 'exploded'`
arrived typed as something it was not.

Neither broke visibly, which is the whole problem with a cast: it is an assertion with no
code behind it, so the failure is a wrong value rendered confidently rather than an error
anyone sees. The schemas are total — every field, to the leaves — for that reason.

What has to be said in the same breath, and is said at both boundaries in the source:
**shape validation is not provenance.** `postMessage` carries no authenticated sender, so
a well-formed forged message is still well-formed. What narrows forged traffic is the
correlation check — an answer is kept only if this side asked that exact question — and
what bounds the damage is that neither of these messages can reach a credential or start
a fetch. A validator mistaken for authentication would be a worse position than the cast,
because it would look like a control.

### Every JSON viewer wanted a parsed value

03 briefly coloured the payload panel — a `scanJsonSpans()` in a since-deleted
`jsonText.ts` that cut formatted text into `(kind, text)` spans, plus a wrapper `<span>`
per token in `tooltip.ts`. It has been removed, because the ladder's own table puts
conveniences at stage 04 and this was one. What outlives the feature is *why the lexing
under it was ours to begin with*.

The obvious way to colour or view a payload is a JSON viewer package. Surveyed, and the
reason each was rejected:

```
payload as it arrives : {"accountId":12345678901234567890,"name":"Aé","rate":1.0,"big":1e2}
after JSON.parse+strfy: {"accountId":12345678901234567000,"name":"Aé","rate":1,"big":100}
```

Four values changed, and one of them is an account number wrong by 890. Every viewer
package surveyed takes a JavaScript **value** rather than text, so using one puts that
`JSON.parse` in our code — on the rung whose entire subject is showing a reader what a
payload actually says.

| Package | Input | Why not |
|---|---|---|
| `renderjson` | a parsed value | renders leaves through `JSON.stringify(value)`, so escapes are normalised: not byte-faithful even before the numbers |
| `json-formatter-js` | a parsed value | its ESM build uses `innerHTML`, which `npm run surface` fails the build on |
| `@andypf/json-viewer` | text or value, parses internally | `innerHTML` and `JSON.parse` both in its dist, plus a custom element registered in the page |
| `react-json-view`, `@textea/json-viewer`, `react-json-tree` | a parsed value | peer-depend on React and react-dom (and MUI and emotion, for one of them). The Temporal UI is Svelte |

`lossless-json` is the one library that could parse a payload without rewriting it —
numbers stay string-backed — and it composes with none of the viewers above: `renderjson`
decides what a leaf is by testing `constructor` against `Number`, `String`, `Boolean` and
`Date`, so a `LosslessNumber` falls into the *object* branch and renders as a wrapper.
Gluing them means writing the renderer anyway, on top of a second dependency, having
swapped a token stream for a whole value tree in a page that may be holding half a
megabyte of payload.

**So the lexing was never ours — only the labelling was.** jsonc-parser's scanner does
string escapes, surrogate pairs, the number grammar and the offset at which a document
stops being valid, returning each token as an offset and a length, so every character on
screen was `text.substr()` of the original. What `scanJsonSpans()` added was the one fact
the scanner does not expose — a key is a string with a colon after it — plus a merge of
adjacent unstyled runs to cut the DOM node count, and a zero-width-token guard whose
consequence would have been an endless loop in someone's page rather than a wrong colour.

**And then the formatting went too.** Removing the colouring left `jsonc-parser` in the
bundle for one job: pretty-printing a payload whose long integers `JSON.parse` would
rewrite — a real improvement in *coverage* over the regex heuristic it replaced, but both
are comfort rather than correctness. So the dependency went out, `jsonText.ts` with it, and
the heuristic too. Displaying JSON *as JSON* belongs to the rung that has time to do it
properly, not to the one whose subject is getting a payload in front of you with nothing in
between.

Stage 04 is where the payload **viewer** belongs — collapsible values, copy-per-value,
colour per value, lossless formatting for the ids — built on `lossless-json` or
jsonc-parser's own `parseTree`. Every choice above has to be made again there, which is why
the survey is here rather than only in the commit that deleted the code.

## The gates

`npm run preflight`. There is no CI for this repository, so this is the only thing
standing between a mistake and the default branch.

### A Node range the dependencies never promised

`package.json` said `engines.node: ">=22"` and the README said "Node 22 or newer". Both were
true when written. Then jsdom raised its own floor, and nothing noticed: npm enforces
`engines` only under `--engine-strict`, and only against the Node that happens to be
running, so on a machine inside the range every check passes and the declaration is never
read.

Measured rather than assumed, `>=22` was wider than what many locked packages declare — the
two a reader would guess (`@asamuzakjp/css-color`, `@asamuzakjp/dom-selector`, both via
jsdom) want `^22.13.0 || >=24.0.0`, and jsdom itself is stricter still. So the honest range
is jsdom's own, `^22.22.2 || ^24.15.0 || >=26.0.0`, declared in five places a parity check
keeps together: the root, all three projects, and `package-lock.json`.

Who this hurt is the point: everyone already working here is on a Node inside the range, so
the declaration is dead text to them. It is live only for the person cloning the repository
for the first time, on Node 22.4 or 23, whose install fails before any check of ours gets to
explain itself — the reader with the least context, at the moment they cannot tell a stale
promise from a broken repository.

`checkEngineRange()` in `scripts/preflight.mjs` compares the declared range against every
`engines.node` in the lockfile, and a range it cannot read is reported as **unchecked**
rather than folded into either verdict. That direction is deliberate: a containment check
that guesses wide reports "fits" where it does not.

Fixing the declaration left the sentences about it wrong, which is the more interesting
half. The range was correct in five machine-readable places and still false in four pieces
of prose — preflight's own advice to an incompatible runtime, and each project's install
block — each a bare major the declared range no longer admits, read by exactly the person
the range exists for, telling them to install a version that would fail again. A version
restated in prose is a copy, and a copy goes stale with nobody editing it. So the advice is
interpolated from `engines.node`, and the project READMEs link to the one statement in the
root README instead — a link `npm run doc:paths` checks, which a sentence about a version is
not.

There is deliberately no gate asserting "every Node range in the documentation matches
`engines.node`", because this very section quotes `^22.13.0 || >=24.0.0` as the range that
was *not* adopted. A check like that would need an exemption list, and an exemption list
is where a gate quietly stops checking the thing it is named after.

### Two algorithms the gates had no business owning

The dependency policy applies to the tooling too, and it pointed at two places where a gate
had reimplemented a standard, published algorithm well enough to pass its own tests. Neither
package reaches a bundle — they are root `devDependencies`. A broken gate cannot ship to a
user, but a gate that is wrong in the accepting direction is worse than no gate.

**Semver range containment**, in `scripts/preflight.mjs`. The check above was doing interval
arithmetic by hand over the grammar it happened to find in the lockfile — honest, and also a
standing bet that the tree never grows a shape it had not met. `semver.subset(ours, theirs)`
asks the reference implementation instead, with `semver.validRange` in front of it so an
unreadable range still lands on **unchecked** rather than on a guess. Four functions went.

The interesting part is what the swap *fixed*. `declaredNodeMajor()` read the lowest
supported major with `/(\d+)/` — the first number in the string. For
`^22.22.2 || ^24.15.0 || >=26.0.0` that is 22, and it is right only because the branches
happen to be written in ascending order. Written `>=26.0.0 || ^22.22.2` the same range
reports 26, and the DOM-test capability probe compares against a floor the range does not
have. `semver.minVersion(range).major` answers it for the range rather than for the way it
was typed, and the self-test drives exactly that reordered string.

**GitHub's heading-slug algorithm**, in `scripts/doc-paths.mjs`. Anchor checking needs the
anchor GitHub will actually mint, and the copied version got a run of spaces and non-ASCII
wrong in the direction that *rejects a link which works*. Both are `github-slugger`'s job,
and it is the package GitHub's own toolchain uses.

The heading *text* was the larger of the two. The old loop matched `^#{1,6}` per line and
slugged the raw remainder, so a heading holding inline markup produced an anchor GitHub
never mints — its own comment recorded this as a KNOWN LIMIT, having already cost a correct
link a rejection. Once headings come from `mdast-util-from-markdown` and their text from
`mdast-util-to-string`, three shapes the regex had been silently missing come free: setext
headings, which have no leading `#`; headings reached through a blockquote or list; and a
`#` inside a fenced code block, which is code. `marked` lost on the one thing that mattered
— its lexer gives a heading token raw inline markdown, so extracting what a reader sees
would mean hand-writing the inline walker this replacement exists to delete.

Both changes were mutation-audited, and the audit earned its keep by deleting a test.
Reusing one slugger across documents, joining raw child `.value`s instead of rendered text,
and walking only top-level children were each caught — but the second mutation failed only
one of the two markup cases, which proved the other could not discriminate: a heading
holding inline code slugs the same either way. A test no wrong answer can fail is
decoration, so that case is a comment now.

`scripts/preflight.mjs` also acquired the self-test it never had, which is the real finding
of this exercise: it runs four other gates' self-tests and had none of its own, so the one
gate trusted purely on the strength of looking correct was the one deciding whether anything
else ran. Its cases cover the range decision and the minimum-major reading, and two of them
exist only to pin the direction of the doubt — an unreadable range reports unchecked and
never satisfied, and a provably too-wide range is still FAILED even when some *other*
dependency's range could not be read. A fact is not less of a fact because the tool was
uncertain elsewhere.

### A card nobody was checking

The history of a gate that no longer exists, kept because two of its findings outlived it.
`scripts/surface.mjs` used to carry two dependency rules: one deciding whether a package was
allowed inside a bundle at all, and one reading each project's `## Dependencies` section and
comparing every card in it — version, licence, transitives — against the bundles esbuild had
just produced, resolved out of the metafile rather than from `package.json` so the gate and
`npm run measure` could not describe different installed copies of the same package.

Both rules were removed in the readability pass, and the honest summary is that they
worked and cost more to read than they caught: a reader arriving at stage 02 met two
per-package cards before reaching the two questions the stage asks Temporal. A hand-written
table per project replaced them.

**One rule went back in: rule 9.** Every third-party package that enters a bundle through a
project's own source must be declared in that project's `dependencies` — kept because
hoisting makes a sibling's package resolve with no `package.json` edit and no lockfile line,
which is the one case a lockfile diff cannot show. The version, licence and transitive
machinery stayed deleted, and the `dependencies` note in `scripts/surface.json` states that
loss plainly: nothing mechanical announces a new *transitive* package.

**Not checked is not clean.** When a card's installed `package.json` could not be read, the
rule reported that rather than passing the card — not a hypothetical direction, because
while it was being written *every* card reported "could not be read", the metafile's package
roots being relative to the project built rather than to the repository. A rule that
shrugged would have printed a count of documented packages and verified none of them.

**A mutation audit finds the case nobody thought to write.** Nine of ten mutations — the
rule never firing, the section reader running past the next heading, a missing section, a
missing card, a dropped version or licence comparison, an unmentioned transitive, one named
without its version, a card for a package no bundle contains — were each caught by the case
written for them. The tenth, silently skipping a package whose metadata could not be read,
survived, because there was no case for it. That is the direction to check first in any gate
written here since.

### A hostname with no letters in it

The leak gate reads every URL it can find and asks whether the host is one this
repository is allowed to name — `cloud.temporal.io`, `localhost`, `example.com`. Anything
else is a finding, because an unrecognised hostname is exactly how a private deployment
leaks into a public example.

Run over the commit messages rather than the working tree, that rule failed on prose. The
commit recording the base-URL decision quotes the endpoint with its middle taken out,
`https://…/base?`, so the whole host is a single ellipsis character — a hostname the gate
could not vouch for: right to be suspicious in general, wrong here in particular.

The narrowing is one line: a host with no ASCII letter and no digit in it cannot name a
machine, so it names nothing and is allowed. That is deliberately not a rule about ellipses
— an elision *inside* a host keeps its alphanumerics and stays checked, which is the case
that matters. `api…a-real-internal-hostname` is still a leak, and the self-test pins both
directions so the accepting half cannot grow into the flagging half by accident.

Where this was found matters. `npm run leak:history` had been red since that commit was
written, and it only runs deliberately; the tree scan every preflight runs was green
throughout, because the sentence lives in a commit message and not in a file. A gate only
correct over the inputs somebody looks at every day has a blind spot on a schedule.

## The ceiling nobody had to drag to reach

Stage 04's payload panel (`src/payloads/tooltip.ts`, forked from 03's — see the lineage
registry) shipped `public/content.css` with a comment claiming `.tuis-panel` and
`.tuis-panel-body` "size to their content" by default, and that their viewport-relative
`max-width`/`max-height` only became relevant once a reader dragged the body's native
resize handle wide. Nothing tested that claim against real content — the unit tests run
under jsdom, which does no layout at all, so an assertion on `style.width`/`style.height`
proves an inline size got set or cleared and says nothing about how big the box actually
rendered.

A reader reported the panel as too big on a real page. The first fix was real and stayed:
the body is one DOM node reused across every hover, `resize: both` sets `width`/`height`
directly on it, and nothing had ever cleared that after a drag — so one drag anywhere, on
either button, on any row, sized every later hover for the rest of the page's life.
`openNow()` now clears both properties before every hover. The report did not go away,
because it was never the whole story.

Measured for real this time — a headless Chromium, the actual `tooltip.ts` bundled with
esbuild, and a synthetic ~20-field payload shaped like a financial one but with none of a
real reporter's data in it — no drag was involved at all. `jsonViewer.ts` is deliberately
flat, with no collapsing (see "Every JSON viewer wanted a parsed value" above): every leaf
gets its own line, so twenty short fields came out as 47 lines, and 47 lines at the panel's
own 11px/1.5 is taller than 80% of an ordinary laptop screen. The ceiling was not an edge
case reached by dragging — it was the panel's *usual* size, on the very first hover, for
any payload past a couple of fields.

The fix was to lower the ceiling itself rather than change what fills it: `.tuis-panel` from
90vw/85vh to 65vw/58vh, `.tuis-panel-body` from 88vw/80vh to 62vw/52vh. Teaching the JSON
viewer to collapse, or tracking drag state in script to give the panel a smaller default
than its drag ceiling, would both have worked and both were rejected as more machinery than
the bug needed. The tradeoff this accepts openly: a payload that used to fit on screen
without scrolling at 80vh now scrolls sooner, at 52vh. A tiny payload — the case the old
comment actually described correctly — still opens compact; that much of the original claim
was true, just not the part that mattered.

That lower ceiling created a second bug within the same day: a reader on a real workflow, with
a long id that wrapped `.tuis-panel-title` onto multiple lines, reported the resize handle
itself as unreachable. The outer `.tuis-panel`'s headroom over `.tuis-panel-body`'s own cap had
been left at `58vh - 52vh`, a viewport-relative 6vh — but what fills that headroom, the title
and the heading row above the body, costs a roughly fixed number of *pixels*, set by font size
and how many lines the title wraps to, not by the viewport's height. A vh-relative headroom
shrinks in real pixels on a shorter screen and shrinks fastest under a wrapped title on any
screen, so on some combination of the two it runs out — the outer panel then needs its own
scrollbar to show everything, which clips `.tuis-panel-body` at the panel's visible edge and
carries the body's own native resize handle below it, out of reach. Reproduced the same way as
the first bug: a synthetic payload, but this time also a synthetic workflow id long enough to
wrap the title onto three lines, measured against `panel.scrollHeight` vs `panel.clientHeight`.

The fix keeps the viewport-relative part — so the two ceilings still shrink together on a small
screen — but adds a fixed buffer on top: `.tuis-panel`'s `max-height` is `calc(52vh + 110px)`,
not `58vh`. 110px comfortably covers a heading row plus a title wrapped onto several lines,
on any screen size, because that cost does not scale with the screen. Verified against both a
realistic id length and an artificially long one forced to wrap three lines; both now report
the body's bottom edge inside the panel's own visible bounds.

A third pass, on request rather than a report: the width ceiling — untouched by either bug
above — was still `.tuis-panel` 65vw / `.tuis-panel-body` 62vw, and that read as too wide on
its own, independent of height. Halved to 32.5vw / 31vw. Nothing here interacts with the
height fix: the two axes are independent ceilings on the same box, and the panel still grows to
whichever of width or height its content needs, up to its own axis's ceiling.

A fourth pass, also on request: let a reader drag the panel bigger than that 32.5vw/31vw
ceiling, without changing what a fresh hover opens at. That is two different numbers pretending
to be the same CSS property — `max-width`/`max-height` on `.tuis-panel-body` had been serving
both as "how big does this open by default" and "how far can a human resize it", and there is no
second CSS property for the other one. Raising the number moves both at once; there is nothing
in CSS to raise only the drag ceiling.

So the CSS max-width/max-height on `.tuis-panel`/`.tuis-panel-body` stopped meaning "the default
size" and started meaning only the drag ceiling — raised to 93vw/`calc(85vh + 110px)` and
90vw/85vh, comfortably past anything a real screen needs, for the same reason `content.css`'s
own comment gives elsewhere: a ceiling a reader can still bump into is a regression to catch,
not a cosmetic gap. The old default — 31vw/52vh, the exact numbers the second pass above landed
on — moved into `tooltip.ts` as `DEFAULT_BODY_MAX_WIDTH_VW`/`DEFAULT_BODY_MAX_HEIGHT_VH`, enforced
by a new `clampBodyToDefaultSize()` called from `fill()` right after real content replaces the
body's children. It measures the body's own natural, unclamped `getBoundingClientRect()` and,
only if that exceeds the old default on an axis, pins that axis down with an inline
`style.width`/`style.height` — the same mechanism `resize: both` itself uses for a manual drag,
just applied once in script instead of by a reader's pointer. A payload under the default is
left alone, with no inline size at all, so it keeps shrinking to fit small content exactly as it
always has. Placeholders (`Loading…`, `Still running.`) never reach this call — both are always
far under either default, and the point is to size to what the reader is actually about to read,
not to a state nobody drags from.

Verified together, not separately, because the risk was one fix quietly undoing the other: a
synthetic 50-item payload big enough to need clamping opened with its body pinned to exactly
446×468px — 31vw/52vh at the test's 1440×900 viewport — and a simulated drag past that, to
1200×700px, was honored rather than snapped back, with the outer panel still reporting the
resize handle inside its own visible bounds at that larger size. The third pass's fix and this
one are independent in the same way width and height were: this changes how big the box can get,
not whether it still fits inside `.tuis-panel` once it does.

The fourth pass immediately produced a fifth bug, and a real screenshot this time, not just a
report: a real workflow with a long, unbroken composite id — business key, sub-status, and a
timestamp joined with no whitespace — opened with the payload crammed into a narrow column on
the left and several hundred pixels of blank white space beside it. `.tuis-panel` has no width of
its own; it shrink-to-fits whichever child asks for the most. Before the fourth pass, that never
mattered, because `.tuis-panel`'s own max-width (32.5vw) capped the shrink-to-fit result directly,
title included. The fourth pass repurposed that same property into the drag ceiling — 93vw — which
uncapped it for every child, not just `.tuis-panel-body`. A title with no whitespace to wrap on
does not care that a *sibling* is clamped to a sane default; asked for up to 93vw of room, it took
it, and the panel's shrink-to-fit width followed the title, not the body sitting right below it.

Reproduced with a synthetic composite id of the same shape (a placeholder key, a fake
sub-status, an all-zero timestamp — the real report's id was never reused anywhere in the repro
or this fix): `.tuis-panel` measured 795.9px wide against `.tuis-panel-body`'s 464px, a blank
gutter of the same few-hundred-pixel size the screenshot showed. The fix gives `.tuis-panel-title`
and `.tuis-panel-heading-row` — the two children with no width ceiling of their own below the
panel's new, deliberately loose one — a `max-width: 32.5vw`, the exact number `.tuis-panel` itself
used to be hard-limited to. Past that width the title wraps onto another line instead of
stretching the panel, exactly as it did when 32.5vw was still the panel's own ceiling; a long codec
hostname in the heading row is the same risk and gets the same cap. `.tuis-panel-body` is
deliberately left out of this — it is the one child a manual drag is supposed to grow past 32.5vw,
and it already has its own clamp (`clampBodyToDefaultSize()`) doing the "small by default, large on
request" job for that axis. Reproduced fixed at 490px against the body's 464px — a padding-width
gap, not a few hundred pixels — and reproduced again with the body dragged to 900px afterward, to
confirm the panel still grows to 940px to follow it: the title's cap stops it from independently
driving the panel wide, not from the panel *becoming* wide when the one child meant to do that
asks for more room.

The very next report, with a real screenshot again, was the same gutter, from the opposite
direction: a reader shrank the body — dragged it narrower, on purpose — and the panel stayed at
its old wide size, leaving the payload cramped in a narrow column with the same blank space
beside it the fourth pass was supposed to have eliminated. `32.5vw` was never a promise that the
title could not out-width a body a reader chooses to shrink; it only promised the title would not
out-width the body's *default*. A body dragged down to, say, 300px on an ordinary laptop screen is
well below 32.5vw, and on a wide external monitor 32.5vw is easily 800px or more regardless of
screen size — comfortably wider than almost anything a reader would deliberately shrink the body
to. Reproduced on a synthetic 2560px-wide viewport with the same fake long id as the fourth-pass
repro: default open put title and body at the same 773.875px (the title's own natural width,
comfortably under 32.5vw of a screen that size, so it never even needed to wrap) — then
`.tuis-panel-body` shrunk to 318px left `.tuis-panel-title` and the panel itself sitting at their
old 773.875px, the gutter back in a form no static number could have ruled out in advance, because
the report before it was about a title too WIDE for the default and this one is about a body too
NARROW for whatever the title happens to be.

No single static max-width is right for every screen and every drag in both directions — the
actual invariant is narrower and simpler than "pick a better number": the title (and the heading
row) must never be wider than the body sitting right below them, whatever the body's width
happens to be at that instant. `content.css`'s `32.5vw` stays as a first-paint ceiling — before a
just-built panel's very first layout, nothing has measured the body yet — but the number doing the
real work now lives in `tooltip.ts`: a `ResizeObserver` on `.tuis-panel-body`, set up once when
`ensurePanel()` first builds the panel, that copies the body's current rendered width onto both
`.tuis-panel-title` and `.tuis-panel-heading-row` as an inline `max-width` every time the body's
box changes — on the first layout, after `clampBodyToDefaultSize()` pins it, and after every
native drag in either direction, because `ResizeObserver` is the one API that reports a size
change regardless of what caused it, and a `resize: both` drag fires no DOM event of its own for
anything else to listen for. Re-verified all three shapes together: the original long-title
default-open case (still fixed, 464px on both), the new shrink-then-gutter case (318px on both,
where it had been 773.875/318 mismatched before this pass), and a grow past the observer's own
default (2560px viewport, body dragged to 1400px, title un-wrapping back onto one line at
1418px to follow it) — confirming the live match tracks a body getting smaller exactly as
readily as it tracks one getting bigger.

`ResizeObserver` does not exist in jsdom, and jsdom has no layout engine for it to usefully drive
even if it did — every one of this section's bugs was verified against a real headless Chromium,
never against the unit suite, for exactly that reason (`getBoundingClientRect()` returns all
zeros under jsdom regardless). The call is guarded behind `typeof ResizeObserver !== 'undefined'`
rather than polyfilled, so the browser's own real implementation is what an actual hover uses, and
the unit suite — which never asserts anything this API would report anyway — no longer needs one
constructed at all. Guarding it silently was intentional: the 68 tests that started throwing
`ResizeObserver is not defined` before this guard was added went through `openNow()`, three or
four calls deep from whatever they were actually testing, on paths with no interest in this
feature at all.

## A cap tuned for a payload nobody had seen yet

`jsonViewer.ts`'s bound against adversarial input — described above under "Every JSON viewer
wanted a parsed value" — was `maxNodes: 5,000`, chosen with no real payload to measure against.
A reader reported the opposite failure mode from the one that bound exists to prevent: a real
payload, an array of a few dozen pricing proposals each carrying nested amount/period/interest
objects, rendered as one unformatted line instead of the coloured, indented view every smaller
payload gets. Bounded-and-falls-back is the intended behaviour for something adversarial; a
catalog of a few dozen ordinary records is not that.

The count that matters is not a DOM count. A first look measured `querySelectorAll('*').length`
against the rendered output and got a number that didn't line up with `nodeCount` inside the
parser — because a leaf becomes one `<span>`, but a container becomes a `DocumentFragment` with
no wrapping element of its own, and an object key gets its own `<span>` without `countNode()`
ever counting it (`countNode()` runs once per `parseValue()` call — every object, array, and
leaf, but keys are consumed inside `parseContainer()` and never call `parseValue()` for
themselves). Getting the real number meant writing a small function that walks a JSON value the
same way the parser does — one increment per object/array/leaf, none for a key — rather than
trusting anything measured from the DOM after the fact.

By that measure the reported payload was in the low tens of thousands of nodes, several times
past the 5,000 cap. The question was not "raise it" but "raise it to what" — the failure mode on
the other side of a too-generous cap is a real freeze on a genuinely adversarial payload, and
that number needed evidence, not a guess in the other direction. Measured in a real headless
Chromium against this file, unmodified, with synthetic fixtures built to the same shape (nested
amount/period/interest objects, never the reporter's real data — see the fixture-generator
pattern used throughout this file's other repros): render time scales linearly at roughly 2.5ms
per 1,000 nodes, and the abort itself is cheap regardless of how far past the cap a payload is,
because `countNode()` throws the instant it's exceeded rather than finishing the walk.

`maxNodes` moved from 5,000 to 100,000 — about ten times the reported payload's size, costing on
the order of 250ms on a fresh hover-open, a one-time render cost rather than a freeze. That
factor of ten was picked deliberately: enough headroom that a somewhat bigger real catalog does
not repeat this same report, without being "as large as the render budget allows," which would
have re-created the original mistake of picking a number with nothing real to weigh it against.
No test pinned the old default — every existing case in `tests/unit/jsonViewer.spec.ts` passes
its own small explicit override (`{ maxNodes: 2 }`, `{ maxNodes: 5_000, maxDepth: 1 }`) rather
than relying on `DEFAULT_JSON_VIEWER_LIMITS` — so raising it changed no test's meaning, only
what a real hover renders. Verified end to end with a synthetic 50-proposal, ~165KB fixture of
the reported shape: previously past any cap this file had, now rendered fully formatted, colour
and indentation intact, through the real message-passing path a hover actually uses.
