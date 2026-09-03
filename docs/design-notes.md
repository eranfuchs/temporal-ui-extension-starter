# Design notes

Why some of this code is shaped the way it is.

Source comments in this repository state a file's **responsibility** and the
**invariants** it holds — what is true after the function returns, and what a
future edit must not break. That is what someone reading the code needs.

This file holds the other half: the **incidents**. Most of the invariants exist
because something went wrong first, and the story is worth keeping — a rule with
no failure attached to it reads like taste, and gets refactored away by the next
person who finds it verbose. But the story does not belong in the file it is
about. It is read once, and it made two source files longer than the feature they
implement.

So: the rule lives in the source, next to the code that upholds it, in one or two
lines. The incident lives here, under an anchor the source comment links to.

Nothing in this file is required reading to use the extensions. It is required
reading before deleting a rule.

**The shape to write, from here on.** A rule earns two lines in the source — the
invariant, and the consequence of breaking it — and a link to its section here if
there is a story:

```
// INVARIANT: <what is true after this returns>.
// Breaking it: <what the reader would see>. See docs/design-notes.md#anchor.
```

Dates, the reproduction, what was tried first and what was discarded all belong in
the section, not in the file. This is the convention for edits from now on rather
than a rewrite of what is already here: the existing headers are longer than that
because they were written before there was anywhere else to put the argument, and
churning them all would break citations that point into them — this file cites
source headers as the authority, and `npm run doc:paths` checks the ones it can see —
including, since a source comment first pointed in here, that the `#anchor` half of
such a link names a heading that exists.

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
`03-payloads/src/payloads/payloadClient.ts` (the questions and the answers). The rules are
stated at the top of those two files — numbered *rules* in the first, *invariants*
in the second, so a citation says which file it means. All but one are a bug that
happened; the sections below are those bugs.

### Hover intent has to remember which button

**Rule 2.** A delay before asking means moving the pointer across a table costs
no requests. The first implementation armed one timer for the first button
entered and ignored every button entered while it was still pending.

So: point at row A, move to row B inside the delay, and the timer fired for A —
which opened the panel anchored to **B** and filled it with **A's** payload.
Traversing a table is exactly the gesture the delay exists to make cheap, so the
rule's own implementation was the thing that broke invariant 1.

The fix is one field: the timer remembers which button it is for, and a different
button cancels and re-arms rather than being dropped. Re-arming also restarts the
delay, which is the behaviour wanted anyway — crossing five rows costs nothing
and the fifth one opens.

### Two ways to close a panel under the pointer

**Rule 3.** A panel that vanishes when the pointer leaves the button cannot be
read, scrolled, or selected out of — and selecting a value out of it is most of
why anyone opens it. Both attempts to uphold this shipped broken, and both read
as "the tooltip is impossible to use".

1. **`pointerout` between two elements inside the panel closed it.** `pointerout`
   fires on every element-to-element move, including heading → body inside the
   panel, and `pointerenter` does not fire again between descendants, so nothing
   cancelled the close. The panel disappeared the instant the pointer entered it.

   The fix inverts the listener: `pointerover` bubbles and fires for every element
   entered, so one delegated listener can answer "the pointer is now over the
   button / inside the panel / somewhere else". `pointerout` is kept for the one
   case `pointerover` cannot report — the pointer leaving the document, entering
   no element at all, which is `relatedTarget === null`.

2. **A capture-phase scroll listener closed it when the panel's own scrollbar was
   used.** The panel is a scroller too (`max-height` + `overflow: auto`), so
   reading a long payload dismissed the thing being read. Capture is necessary —
   scroll does not bubble, so it is the only way one listener hears every scroller
   on the page — which means the listener has to ask whether the scroller *is* the
   panel.

A third case is not a bug but is the same rule: a text selection dragged past the
panel's edge must not close it, so the grace period is suspended entirely while a
mouse button is held down inside the panel. The release is listened for on the
window, because a pointer pressed inside the panel is routinely released outside
it, and a `pointerup` never seen would leave the panel open for good.

### A late answer, and the four places one can hide

**Rule 4, and invariants 1 and 3.** Two hovers are two requests in flight and they
can answer in either order, so every fill is stamped with the generation of the hover
that asked for it. Separately, an answer has to name the question it answers: the
request id is a small integer starting at 1 in every tab, so "it carries id 3" is
something a forged message gets right by accident. All four parts — namespace,
workflow id, run id, kind — are checked, and the same four are the cache key, so the
two cannot drift apart.

On this rung that check does more work than it does for the per-row questions. The
worst a wrong last-event answer does is print the wrong event type in a cell. The
worst a wrong payload answer does is put one workflow's decrypted input under
another workflow's name: somebody else's personal data, on screen, labelled as
this customer's.

**The invalidation is the part that took two reviews.** When the codec setting
changes, four things can be holding an answer from before the change, and the
first version emptied two of them:

| Holder | Emptied by |
|---|---|
| The cache | `cache.clear()` |
| A request in flight | `inFlight.clear()` |
| A late answer still allowed to paint | `cacheEpoch++` stops it being cached and nothing more; being *rendered* is gated on the generation counter, so the step that stops that is `close()` |
| The text **already painted** | `erasePanelText()` |

The third one meant the setting a user had just removed could still paint its
decode into the open panel, one hover after they removed it. The fourth was found
by a later review: `close()` sets `hidden`, which stops the text being **shown**
and does nothing about it being **there**. The panel lives on `document.body`, in
the DOM the page shares with us — an ISOLATED world does not get its own — so
decoded payload text left in a hidden node is still text any script in the page
can read out of it, for as long as the node survives. Hiding personal data is not
erasing it.

"Clear the cache" is the reading that shipped the hole, which is why the function
is named for what it does to all four.

### One question, three entry points

**Invariant 2.** Three entry points reach the same row: a hover opens it, Tab focuses
it, and a click on the button fires `focusin` **and** `click`. Every one of them
found an empty cache and posted its own message, because the cache only answers
"have we asked this before?" once the answer has **arrived** — between the message
going out and the reply coming back it says no.

Two requests for one panel, and on a rung that can forward a payload to a codec
server, two copies of somebody's data leaving the machine for one glance. So a
question already in flight is **joined**, not asked again.

The cleanup on that join has a sharp edge worth keeping in mind: the in-flight
entry must be removed only if it is still *this* attempt's. Resetting empties the
map while requests are still out, so the same key can legitimately hold a newer
attempt by the time an older one settles. An unconditional delete removes the new
attempt's entry, and the next hover — which should have joined it for free — posts
a third request instead. That is invariant 2 failing in the one situation nobody hovers
twice to check.

### Switching it off has to take the node and the text

**Rule 5.** The `{ }` buttons live in the table, so the render pass removes them.
The panel lives on `<body>`, so nothing in a render pass touches it. Turning the
payload switch off while a panel was open left it on screen — a decoded payload
sitting there, under a switch that said the feature was off — with its decoded
text still in the cache behind it.

Off has to mean three things, and leaving out any one leaves personal data
somewhere a user who just switched the feature off would not expect it: the node,
the *reference* to the node (or the "is the pointer inside the panel?" test keeps
answering yes for a detached element, and a click outside stops closing anything),
and the decoded text behind it.

What switching off cannot do is recall a request already sent. A history event
fetched a moment ago was fetched; a payload already POSTed to a codec server is
already there. Off stops the next question. It is not a revocation, and the popup
does not claim otherwise.

## Payloads and the codec server

### The endpoint used to come from the page

A version of this extension read the codec endpoint out of the Temporal UI's own
settings, so that a page already decoding these payloads did not have to be told
where its codec server is. It is a genuinely nicer first run, and it is not what a
starter kit is for. It added:

- a second trust question — page state chose a host, so the access token had to be
  excluded from that path and the panel had to say which endpoint it used and why;
- a resolution order to keep in step with the UI's own,
  `(override && localStorage.endpoint) || settings.codec.endpoint`, which is not
  guessable and did change between releases;
- about a third of the codec file's code and prose, for a convenience.

Deleted on that basis. The popup is now the only source. If you want it back in
your own fork, read the UI's own `getCodecEndpoint` helper — in Temporal's own UI
repository, temporalio/ui, under src/lib/utilities — and mirror it rather than
guessing key names:
guessing produced a feature that was silently off, on a page whose codec server was
configured and working.

### Sending the whole array sent data that had no reason to leave

The first version sent the whole `payloads` array whenever **any** member of it
needed a codec, because that keeps the answer aligned with the request by index
and costs one line less.

The cost of that line is data. A workflow started with two arguments — a plaintext
`json/plain` customer record and one encrypted blob — would have had **both**
posted to the codec server, and the plaintext one had no reason to leave the
browser at all.

So the positions are carried instead. `positions` is what makes the answer
re-attachable; sending a subset without it is what would mislabel data.

### Pretty-printing silently corrupted long integers

`JSON.parse` turns every number into an IEEE double, so an id of
`12345678901234567890` comes back as `12345678901234567000`, and `JSON.stringify`
writes that back out. The value on screen is then simply wrong, in a way that
looks exactly like real data — and account numbers and transaction ids are
precisely the fields long enough for it to happen to.

It is not only the very long integers. `-0.0` serialises as `0`, so a reversal
becomes nothing; `9007199254740993` becomes `…92`; `0.1000` becomes `0.1` and
`2.0e+10` becomes `20000000000`, either of which can be the difference between a
value that pastes back into a request and one that does not. Each of those is
asserted, with the damaged output written out, in
`03-payloads/tests/unit/payloads.spec.ts`.

**The fix is not to format.** `decodePayload()` in
`03-payloads/src/payloads/payloads.ts` does base64, then UTF-8, then stops. A
single-line JSON payload is displayed as a single line, in a `<pre>`, exactly as the
server wrote it. There is no `prettyJson`, no encoding-specific display path, and
nothing in this rung that could rewrite a value.

That is a real cost and it is the point of stating it here rather than hiding it: the
panel is harder to read than it could be. Three attempts at making it easier all
failed a test this rung actually cares about.

1. **`JSON.parse`/`JSON.stringify`.** Corrupts long integers. Non-negotiable.
2. **A regular-expression heuristic** — skip formatting when a 16-digit-or-longer
   number is present. Never *wrong*, and it shipped for a while. But it gives up on
   the whole payload, so the financial payloads (the ones most worth reading) are
   exactly the unformatted ones, and it protects only what the regex knows about:
   `-0.0` and `0.1000` were still quietly rewritten.
3. **A lossless formatter over jsonc-parser** — scan, take a list of edits, apply
   them, every edit replacing whitespace *between* tokens so no token can change. It
   worked; a 20-digit id came out pretty-printed and byte-identical. It went back out
   anyway, because it is a **dependency bought for comfort**, and comfort is stage
   04's department.

The measurements from (3) survive in [The formatter that was fine and the applier
that was not](#the-formatter-that-was-fine-and-the-applier-that-was-not), and the
library survey in [Every JSON viewer wanted a parsed
value](#every-json-viewer-wanted-a-parsed-value). Stage 04 will want both, and will
be solving a display problem with the payload-fidelity problem already settled here.

Ugly beats wrong, taken all the way: what the server sent is what you see.

### A query string is not a base URL

The endpoint validator accepted any HTTPS URL, and the request builder appends
`/decode` to it by string concatenation. So
`https://codec.example.com/base?tenant=a` became
`https://codec.example.com/base?tenant=a/decode` — a POST to `/base` whose query
is now "tenant=a/decode". That is a URL a server will answer, and answer
**wrongly**: the failure is a plausible response from the wrong endpoint, not an
error anyone would notice.

A `#fragment` does the same thing and is not even sent to the server. Userinfo
(`user:pass@`) is refused on the same path for a different reason — it is a
credential the browser would apply on our behalf, and `fetch()` throws on it
anyway, so accepting it only bought a popup that promised an endpoint would be
used and a panel that failed at the moment of use.

All three are rejected rather than stripped: a user who typed a query meant
something by it, and a codec server that needs one is not a server this shape of
request can reach.

The regression spec for this had a second lesson in it. A property test asserting
"every accepted endpoint is safe to append `/decode` to" was fed three endpoints
that are accepted anyway, which made it a tautology — deleting the guard left it
green. A property that never sees a value which could break it is not asserting
the property; it is asserting that the examples chosen to pass, pass.

And the same lesson arrived a second time, on the fixed version, from a code
review. The first guard read `.search` and `.hash` and refused anything truthy —
which is correct for `?tenant=a` and wrong for a **bare** delimiter, because the
URL API spells an empty query and an empty fragment as the empty string, exactly
as it spells having neither. So an endpoint ending in `?` or `#` was accepted, and
`/decode` was appended into the query: the original bug, reachable by the most
ordinary route there is — pasting a URL out of an address bar. The guard now saves
`href`, clears both, and refuses the endpoint if `href` changed, which decides the
empty delimiter and the populated one with one comparison.

The property test would have caught it, and did not, for the reason the paragraph
above already gives: **a property test's candidate list IS the test.** It was no
longer a tautology and still had no boundary value in it. The four bare-delimiter
endpoints are now in that list, along with an encoded `?` inside a path — which
must be *accepted*, so the same list also guards against a fix that over-rejects.

### The credential switches that were deleted rather than defaulted off

Temporal's own UI offers to pass your access token to the codec server, and to
send cookies with the call. This extension had both. They were removed once the
request path was read as a trust boundary rather than as a feature list, and the
argument that removed them is one sentence: **the config arrives over
`postMessage`.**

Anything on the page — the app itself, another extension's content script — can
name the endpoint. A credential flag sitting beside a caller-chosen host is a
credential a forged message can aim, and it would have been aimed from the page
world, which is exactly where the live bearer and the session cookies are.

Note what this is **not**: it is not "the flag defaults to off, so we are fine". A
default protects the honest path through the popup. It does nothing about a
message that sets the field to `true` on its way past, because the value that
reaches the fetch is the one in the message. Ambient authority plus a forgeable
bus means the only safe number of credential switches is zero.

The enforcement is deliberately not in the file that builds the request. That file
only **describes** it, and its return type has no `credentials` field to set;
`fetchFromPageWorld()` in `src/page/pageApi.ts` is what **spends** it, writing
`credentials: 'omit'` as a literal and refusing an `Authorization`, `Cookie` or
`Proxy-Authorization` header outright. Enforcing it at the boundary is what makes
it hold for the next caller too, instead of holding only for the one caller that
exists today.

If a fork needs an authenticated codec server, the honest fix is not to add the
flag back. It is to stop taking the endpoint from a message at all: read it in the
extension's own world and pass it in with `chrome.scripting.executeScript`, which
needs `host_permissions` — a real permission for a real capability, which is the
trade this whole repository is about.

## Deep links on the detail page

### The floating card was the wrong answer

The first version of `src/detail/detailLinks.ts` drew one fixed box in the bottom-right
corner listing every activity it knew about, and its own header argued for it: rule 1
at the top of `render.ts` is ANCHOR TO MEANING, NOT POSITION, the workflow list has a
perfect anchor in `a[href*="/workflows/"]`, and a workflow's page — so the argument
went — has no equivalent for "activity N", because the timeline is SVG and the event
list is virtualised.

**The premise was false, and the way it was false is the part worth keeping.** There
is a meaning-anchor on that page: when the UI opens an activity's panel it renders a
labelled row whose label is the words "Activity Id" and whose value is the id. That is
meaning, not position — the label is the UI's own name for the field, it survives a
restyle, and it is how the internal extension this was rewritten from has anchored
per-activity buttons for months. Reasoning from "I cannot see an anchor" to "there is
no anchor" produced a floating overlay that covered the page it was annotating and
listed activities the reader had not asked about.

It was worse than clutter. Because nothing on the page could be attached to, the card
also could not put a link **on** an activity, so it fell back to listing them and
telling the reader to add `{activityType}` to a template if they wanted per-activity
links. A feature that explains how to configure itself, on the page where it could
simply have worked, is a feature that has given up — and the type it suggested keying
on is not an identity, so following the instruction produced links that quietly
matched the wrong activity.

### Where the links are allowed to sit

The links on a single workflow's page sit in the UI's own layout, which the
extension does not control and does not fork. Two anchors are used, and the second
exists because the first is not always there.

The consequence worth knowing: an anchor found by structure rots when the UI
changes its markup, and it rots **invisibly** — the links simply do not appear,
which reads as "the feature is off" rather than "the selector missed". So the
resolution is asserted in `03-payloads/tests/unit/detailLinks.spec.ts` for both
anchors, together with the idempotency of a second pass and the fact that an id
that cannot be resolved to one activity gets no link at all.

The internal extension paid for the other half of this. When its selectors went
stale the node was not missing — it was attached to `<body>` at the top-left,
invisible behind the app's own chrome. It reads as "the feature only appears after you
toggle it", and it was diagnosed twice before anybody found the cause. Hence
`LINK_BAR_ADRIFT_CLASS`: a bar that cannot find its anchor is parked somewhere it can
be **seen**, the popup counts that state, and every pass looks for the real anchor
again and moves the bar the moment it appears.

### A stored setting that shadowed a new default

Per-activity link templates were added after the settings shape already existed in
users' browsers. Anyone with saved settings had a stored links array that predated
the activity template, and a stored array wins over a new default — so the new
per-activity links were silently unreachable for exactly the users who had used
the extension before.

The fix defaults the **scope**, not the array, one time. `withActivityScope` in
`src/settings.ts` is that migration, and it is the one part of `settings.ts` that
is byte-identical across the projects that have it, which is why its spec is
registered as shared while the rest of `settings.ts` is a declared fork.

## The master switch

`removeAllDecoration` in `02-techniques/src/render.ts` and
`03-payloads/src/render.ts`. One production caller each: the `if (off)` early
return in `content.ts`.

### Off left the table sorted

The switch was written as "remove the nodes", because for a long time every
trace this extension left *was* a node. It grew two exceptions quietly — the
inline `margin-left` on the page's own workflow links, and the
`data-tuis-workflow-id` marker — and both were caught and swept. The third was
not a trace at all in the sense the function was looking for.

Reordering the `<tbody>` is the whole point of the extension, and it is the one
edit that leaves **nothing behind to find**. The rows are the page's own; moving
them writes no class, no attribute and no style. So a sweep built from a list of
class names could be complete, provably complete, and still leave the table
grouped into families with every connector stripped off it — which is worse than
either end state on its own. Off did not look off. It looked broken: a sort no
Temporal UI control explains, and no visible cause.

The fix is one call. `removeAllDecoration` ends by asking
`restoreOriginalOrder(tbody, rowsOf(tbody))` to put the recorded order back,
which was already idempotent because the render path runs under a
`MutationObserver` and rule 2 applies to it too — a table already in its original
order is not written to, so switching off does not wake the observer up.

Two things about how this was found are worth keeping. It was **not** found by
the cleanup spec, which existed and passed: its fixture started in `parent,
child-a` order, which is already the family order, so "put the rows back" and
"never moved them" produced the same green. The fixture is now deliberately out
of family order, and the spec asserts the order twice — after rendering and after
cleanup. And the sweep list is now a value, `REMOVABLE_ROOT_CLASSES` in
`decoration.ts`, that `removeAllDecoration` builds its selector from; that keeps
the code and the documentation from disagreeing about the nodes, but note what it
cannot do — it could not have caught this, because the missing piece was never a
class.

### A restored order that outlived its welcome

The fix above introduced this one, which is the more interesting of the two.

`originalPosition` is a `WeakMap` from `<tr>` to the index it had on the first pass,
and the first version of it kept that index for as long as the row existed. Every
disabled pass sorted by it. That reads as obviously correct — restore what we
recorded — and it is wrong after the second event:

1. The extension records order A and groups the rows into families.
2. The user switches the tree, or the whole extension, off.
3. The first disabled pass restores order A. Correct, and this is what the tests
   asserted.
4. The user clicks a column header. Temporal sorts its own table into order B,
   reusing the same `<tr>` elements.
5. That mutation wakes the `MutationObserver`, which schedules another pass.
6. The pass sorts by the recorded positions and puts order A back.

So a switched-off extension quietly undoes the sort controls of the page it is off
in — every time, for as long as the tab is open. Worse in the variant where the tree
starts disabled: the first pass records whatever order it finds and there is no
grouping to undo, so the extension does nothing visible at all except overrule the
column headers.

The fix is a delete. `restoreOriginalOrder` now removes the entries it just used, so
a recorded position is a **one-shot**: the next pass records the order the page is in
*now* as the new baseline, and re-enabling the tree takes a fresh snapshot. It is
forgotten even when nothing moved, because "already in the recorded order" is still a
restore, and the alternative leaves the snapshot alive for exactly the passes that
did not need it.

What made this survive review twice is the shape of the test. The specs asserted the
restore, then stopped — one enabled pass, one disabled pass, assert. Nothing followed
the *second* disabled pass, which is where the whole failure lives, and no fixture
had the page moving rows on its own. `hostResorts` in `tests/renderHarness.ts` is
that missing actor: it reorders the existing rows the way a column click does. Both
new cases assert against it twice — once that it moved something, once that the
extension left the result alone — and the first of those assertions is not
decoration. Written the obvious way, comparing the helper's own return value to the
table it just reordered, it compares a value to itself and passes even when the
helper does nothing; the assertion has to name the order the bug would produce.

## Splitting render.ts

`render.ts` grew until it was the file every feature had to be edited in, and the
header had to apologise for three things it held that were not about the table it
described. It is now four files plus the pass itself. This section holds the part
of that argument a reader does not need in order to change the code.

### Why each of the four files exists

Each one earns its own file for a reason that is not "render.ts was long":

- **`src/decoration.ts`** — the vocabulary two files both name, and the master switch's
  contract as a value (`REMOVABLE_ROOT_CLASSES`). Splitting it is what let
  `render.ts` stop holding class names it does not itself use, and it gives a
  reviewer one file to read for "what can the master switch fail to remove?".
- **`src/links/linkRender.ts`** — the one render job used from **two** pages: the
  workflow list, and a single workflow's own page through `src/detail/detailLinks.ts`.
  While it lived in `render.ts`, "everything that writes to the table" had an export
  that wrote somewhere else. Two copies of it agreed for exactly as long as it took
  to add one field to one of them.
- **`src/rowInfo/rowInfoRender.ts`** — the largest of the render jobs, and the only one
  that writes **outside** the workflow-id cell: the column touches the `<thead>` and
  every body row. Its specs were already a file of their own
  (`tests/unit/renderRowInfo.spec.ts`) before the source was.
- **`src/payloads/payloadButton.ts`** — the only thing in a render pass that belongs to
  stage 03. Keeping it beside the rest of `src/payloads/` is what makes "what did 03
  add?" answerable from a directory listing.

### The age that climbed while the fact stood still

The "Last event" column was briefly written the obvious way: an age computed against
`Date.now()`, redrawn by a once-a-second ticker. The number that produced was exactly
right about the event it named and quietly wrong about everything else. It advanced
every second while the fact underneath it was re-read every 35, so a workflow that
had already moved on displayed a stall climbing in real time — the most convincing
possible way to be wrong, because the seconds ticking make it look live.

Second-resolution is worth having. A second-resolution measurement of something read
half a minute ago is not. So the ages are frozen at the reading, which has a second
consequence worth more than the first: `syncLastEventColumn()` becomes a pure
function of the answers it was handed, and feeding it the same answers twice writes
nothing the second time however much wall-clock time has passed.

The column was also appended to the end of each row once, and appending really is
simpler — the end of a row has to agree with nothing. Inserting has to agree with a
column order the Temporal UI lets the user change, which is why the position is
computed on every pass rather than being a constant.

### The button that knows nothing

The `{ }` button carries no workflow id, no run id, and not even a title that names
one. That looks like an omission and is the whole design: the Temporal UI recycles
`<tr>` elements as the list updates, so anything stamped onto a row-scoped node can
outlive the row it described. A button holding a stale run id opens a panel of
somebody else's payloads — on the one rung of this ladder where the panel contains
decoded data.

Nothing on it can go stale because nothing on it is a fact. `src/payloads/tooltip.ts`
resolves the row from the cell's own `href` at the moment of the hover. It also
makes the button the cheapest write in a render pass: once created, every later pass
leaves it alone.

### The press that was stamped an hour early

The refresh button in the column header disables itself for `FRESH_FLOOR_MS` after a
press, because the receiver would refuse to re-fetch inside that window and a button
that accepts a press which does nothing is worse than one that says so.

It recorded the press with `options.nowMs` — the timestamp of the render pass that
installed the handler. That is the same clock `Date.now()` reads; `content.ts` passes
`Date.now()` in. What was wrong was *when* it had been read. A handler outlives the
pass that installed it, and on a quiet page the table renders once and nothing touches
it again, so a press an hour later was stamped an hour early. The next pass measured a
floor that had already elapsed and re-enabled the button immediately.

The general shape is worth keeping, because it is not specific to a clock: a value
captured in a render pass and read from an event handler is a value read at the wrong
time. Anything in a handler that describes *now* has to ask now.

## Dependencies

The policy is in `scripts/surface.json` under `runtime_dependencies`, and it is one
sentence: **browser APIs and code in this repository for anything specific to this
extension; mature, maintained libraries for generic algorithms, where using one makes
the example easier to read and harder to get wrong.** Read that file for what each
project is budgeted, and `npm run measure` for what each package actually costs the
bundles a user loads.

This section is the part that does not belong in either: which alternatives were
measured, and why the one that lost, lost — including the evaluation that ended in no
dependency at all, and the one that took half a library. Every measurement below is a
recorded experiment with a date on it, not a live claim: a library's next release can
change any of these numbers, and the command that prints today's is named above.

### Two schema libraries, measured

Cited from `src/types.ts` in all three projects. Runtime schema validation was
introduced across every trust boundary in this repository, and the first
implementation used **zod**, which is the obvious choice and a genuinely excellent
library. The API difference is small enough that the port between them was
mechanical.

The bundles were not. Measured 2026-09-03, the same three schemas — the workflow
entry, the list envelope, the `postMessage` envelope — compiled with exactly the
options in `02-techniques/esbuild.config.mjs` (`bundle`, `format: 'iife'`,
`target: 'chrome110'`, **not** minified):

| Library | Version | Third-party bytes in the bundle | Third-party files |
|---|---|---|---|
| valibot | 1.4.2 | 13,291 | 1 |
| zod/mini | 4.5.4 | 36,179 | 12 |
| arktype | 2.2.3 | 311,628 | 105 |
| zod | 4.5.4 | 753,678 | 94 |

Two things about that table matter more than the ordering.

The first is **why the numbers are so far apart, and why that is not a criticism of
zod.** zod's classic API hangs every method off every schema object, so a bundler
cannot tree-shake a schema's unused methods away; the mini export exists precisely
to fix that and does. arktype compiles its own type syntax at
runtime, which means shipping the compiler. None of that is waste in an application
that uses more of the library than this one does — three envelopes and a handful of
field checks is close to the smallest possible ask.

The second is **why bundle size is a first-class criterion here specifically, and
would not be everywhere.** This repository asks a reader to open `dist/content.js`
and look at it. It ships unminified for that reason (see the comment on `minify` in
the esbuild config), it prints every third-party file that enters every bundle as
part of its own audit, and its whole argument is that a reader can account for what
they loaded. Three quarters of a megabyte of validator, inlined four times over,
does not make that impossible — but it does make it a thing nobody will actually
do, which for a teaching repository is the same outcome.

valibot also happens to have no dependencies of its own, so the transitive line in
every project's budget stays empty on its account. That was not the deciding factor
and is worth stating as a fact rather than a virtue: zero transitive dependencies is
one supplier to trust rather than none.

**What the measurement did not decide.** Every semantic this code relies on was
checked against the library empirically before any schema was written, because two
of them are surprising: `v.number()` accepts `Infinity` (so every numeric field here
is `v.pipe(v.number(), v.finite())`), and `v.nullable(x)` accepts `null` but still
requires the key to be **present**. Those probes are the reason the unknown-key and
nullability policies in `types.ts` are stated as decisions rather than assumed. A
library chosen on bytes and adopted on assumption would have shipped a hole.

### Two queue libraries, measured

Cited from `src/page/pacer.ts` in 02 and 03. The pacer's slot accounting — four at a
time, queue the rest, start the next when one finishes — was hand-written, had no
tests, and was **wrong**: it checked the slot count, then slept out the backoff, then
took a slot, so during a backoff every caller passed the check and woke together. The
full story is at the top of `pacer.ts`; the point here is that this is a generic
algorithm with no Temporal in it, which is exactly the case the dependency policy
says to hand to a library.

**p-queue** was evaluated first, being the name people reach for. It works, and the
thirteen tests in `tests/unit/pacer.spec.ts` pass against it unchanged. It also
carries priorities, per-task timeouts, task ids, an event emitter, pause/resume and
an `intervalCap`, none of which this file uses. Measured 2026-09-03 in
`dist/apiInject.js`, the only bundle either of them enters:

| Library | Version | Packages bundled | Third-party weight added, in the units `npm run measure` prints |
|---|---|---|---|
| p-limit | 7.3.2 | 2 (p-limit, yocto-queue) | 2.6kb + 1.2kb |
| p-queue | 9.3.3 | 3 (p-queue, eventemitter3, p-timeout) | 27.2kb + 6.4kb + 2.2kb |

An order of magnitude, for capability that is not called. `p-limit` also happens to
be the closer fit on the API: its `activeCount` and `pendingCount` are precisely the
two numbers the pacer exposes, where p-queue's `pending`/`size` needed the same
mapping and one more paragraph to explain which was which.

`intervalCap` deserves its own sentence, because it is the feature that looks made
for this and is not. It is a rate limit **we** choose in advance; Retry-After is a
wait the **server** asked for. Wiring the second through the first would have made
the Temporal-specific half of this file — the part a reader forks — read like
configuration of a library instead of a decision about a server.

**What this cost, honestly.** The change removed about fifteen lines of slot
accounting and added rather more comment than that explaining the split and the
rejected alternative, so `npm run measure` reports the stage source getting slightly
*longer*. That is the trade taken deliberately: the code that had a concurrency bug
in it is no longer code this repository maintains, and what is left in the file is
Temporal policy and nothing else.

### The cache a TTL made look bounded

Cited from `src/rowInfo/rowInfoServe.ts` in 02 and 03. This is the third library
evaluation, and the one that ended in **no dependency** — recorded because the
reasoning is the same policy applied to a case where it points the other way, and
because looking for the library found a real bug.

**`lru-cache` was evaluated for the bounded maps and not adopted.** There are four of
them across 02 and 03: the per-field answer stores here, the paired
`results`/`askedAt` maps in `rowInfoClient.ts`, the decoded payloads in
`payloadClient.ts`, and — not a cache at all, but bounded for the same reason — the
run ledger in `pageApi.ts`. `lru-cache` is mature, does all of this, and would replace
some counting. Three things decided against it, and the first is the one that matters:

1. **Per-key eviction is the wrong semantics for the paired maps.** `evictIfHuge()`
   clears `results` and `askedAt` **both or neither**, because dropping the answers
   while every row still counts as recently asked is precisely the combination that
   leaves the user staring at an empty column until the ask interval expires. That
   coupling is the bug fixed in that function; independent per-key eviction across two
   caches is what would reintroduce it, and it is what an LRU does by design.
2. **Its TTL runs on a different clock.** `lru-cache`'s internal timestamps come from
   `performance.now()` where it exists (`defaultPerf` in the package, checked against
   11.5.2 on 2026-09-03), while every date in this module has to be `Date.now()` —
   `atMs` becomes `observedAtMs` on the reply and is compared against `FRESH_FLOOR_MS`.
   The package does expose a documented `perf` option, so `{ perf: Date }` fixes it.
   That is the point rather than a defence: the fix is a piece of library-specific
   knowledge a reader now has to hold, forgetting it leaves the module on two clocks
   whose *origins* differ, and nothing fails loudly — the existing TTL test drives
   expiry with a single `vi.spyOn(Date, 'now')`, and would simply stop controlling it.
3. **`fetchMethod` brings more than coalescing.** In-flight deduplication here is one
   `Map<string, Promise>`; the library's version of it also carries abort signals,
   `allowStaleOnFetchRejection`, `noDeleteOnFetchRejection` and background refresh.
   The failure policy at this boundary is one sentence — a failure is cached, with the
   same TTL, so one 403 does not become a thousand — and it is easier to read as that
   sentence than as the four options that reproduce it.

For the same reason there is no `p-memoize` plus a TTL package here: two dependencies
to describe two `Map`s, whose interaction a reader would then have to work out, is
more explanation surface than the maps.

**What the evaluation found.** Reading the four side by side to price the port showed
that three had an entry-count bound and this one did not: it had only `TTL_MS`. A TTL
looks self-limiting and is not. An expired entry is overwritten when the same run is
asked about again, and a run the user has scrolled past is never asked about again — so
a tab left open on a busy namespace held an answer for every run it had ever displayed,
for the life of the page. The fix is the same crude whole-map clear as its siblings,
which is why the bound is 2,000 and not a policy: the next render pass re-asks for the
rows that are actually on screen, so being crude costs one extra round for the current
table.

The bound now has an end-to-end test that counts requests, and the test earns its keep
the way the others in that file do — removing the eviction line turns it red on a
request count, not on a size assertion, because the observable consequence of the bug
is a question the extension no longer needs to ask.

### The formatter that was fine and the applier that was not

**This evaluation is history: 03 no longer depends on `jsonc-parser`, and there is no
`jsonText.ts`.** It is kept in full because the measurement below is the expensive
part, it was hard to get, and it is the first input stage 04 will want the day it
builds a payload viewer. Read it as "what we learned when we tried", not as a
description of shipped code — the reasons the dependency went back out are in
[Every JSON viewer wanted a parsed value](#every-json-viewer-wanted-a-parsed-value).

At the time it was the fourth library evaluation, and the only one where the library
was adopted **in part** — its scanner and formatter yes, its edit applier no.

**Why the dependency, given that the file is 190 lines either way.** What is borrowed
is not effort, it is correctness in the places a hand-written JSON scanner is wrong
without looking wrong: string escapes and surrogate pairs, the exact number grammar
(a leading zero, a lone `-`, `1e`, `.5`), and the offset at which a document stops
being valid. This module's output is a *value the reader will copy into a request*, so
a scanner bug here shows a wrong account number rather than a wrong colour — the same
argument as the schema library, applied to a lexer. jsonc-parser is Microsoft's,
MIT-licensed, has no dependencies of its own, and is the scanner underneath VS Code's
JSON support, which is a great deal more input than this repository can generate.

**Why not `applyEdits()`.** `format()` returns a list of edits, and applying them is
one line of library API. That line rebuilds the whole string once per edit —
`text.substring(0, offset) + content + text.substring(offset + length)`, in a loop —
and `format()` emits roughly one edit per token, so the cost is quadratic in the size
of the payload. Measured against jsonc-parser 3.3.1 on 2026-09-03, on arrays of
records with 19-digit ids:

| bytes | edits | `applyEdits()` | one pass | identical output |
|---|---|---|---|---|
| 1 KB | 191 | 0.8 ms | 0.0 ms | true |
| 13 KB | 1,901 | 10.4 ms | 0.2 ms | true |
| 131 KB | 19,001 | 2,431.6 ms | 2.2 ms | true |
| 526 KB | 76,001 | 18,606.7 ms | 5.2 ms | true |

The last row is measured, not extrapolated. Two things make it worse than the numbers
suggest: this runs in the **page's** world, on the page's own main thread — 03 formats
before the text crosses `postMessage`, so an eighteen-second applier freezes Temporal's
UI, not ours — and half-megabyte payloads are not the exotic case, they are what a
workflow that carries a batch looks like.

So `applyFormattingEdits()` walks the sorted edits once and joins the pieces. It is
the same algorithm, expressed the way that does not re-copy; the `identical output`
column is the claim that matters, and the spec pins it too.

The one thing the single pass has to handle that the library's does not is an
**overlapping edit**, because `slice(from, to)` with `to < from` returns `''` and
would silently drop characters — precisely the failure that file existed to prevent.
`format()` was checked against ten shapes and emits none; the guard was there anyway,
refusing to format rather than dropping anything, and exported so the spec could
reach it. A guard that cannot be tested is a comment.

**What 03 does instead, now.** Nothing: `decodePayload()` stops after UTF-8 and the
panel shows the bytes that arrived. No formatter of any kind, and therefore no
formatter that can be wrong. That gap is the feature stage 04 buys back, at which
point the table above says what the applier costs and the survey below says what the
scanner options are.

### The guard that checked the envelope and cast the rest

Cited from `src/rowInfo/rowInfo.ts` and `src/detail/detail.ts` in 02 and 03. Before
the schemas, both of those boundaries were guarded by a hand-written predicate, and
both had the same shape of hole — worth recording once because it is the shape a
hand-written guard tends to have.

The guard checked the **envelope** and cast the **contents**. `rowInfoResult` verified
four fields of the message and declared the payload `LastEvent | null`, so a message
carrying `lastEvent: 42` satisfied the guard and reached a renderer that reads
`event.eventType` straight into a template. `detail-facts` verified four envelope
fields plus `scheduledEventId` on each activity, then cast the rest, so a forged
`outcome: 'exploded'` or `attempt: 'lots'` arrived typed as something it was not.

Neither one broke visibly, and that is the whole problem with a cast: it is an
assertion with no code behind it, so the failure is a wrong value rendered
confidently rather than an error anyone sees. The schemas are total — every field, to
the leaves — for that reason and not for tidiness.

What has to be said in the same breath, and is said at both boundaries in the source:
**shape validation is not provenance.** `postMessage` carries no authenticated
sender, so a well-formed forged message is still well-formed. What narrows forged
traffic is the correlation check — an answer is kept only if this side asked that
exact question — and what bounds the damage is that neither of these messages can
reach a credential or start a fetch. A validator that were mistaken for
authentication would be a worse position than the cast, because it would look like a
control.

### Every JSON viewer wanted a parsed value

03 briefly coloured the payload panel — a `scanJsonSpans()` in
a since-deleted `jsonText.ts` module that cut formatted text into `(kind, text)`
spans, and a wrapper `<span>` per token in `tooltip.ts`. It has been removed, because
the ladder's own table puts conveniences at stage 04 and this was one: nothing about
correctness or the trust boundary depended on it. What is worth recording is *why the
lexing underneath it was ours to begin with*, since that question outlives the feature
and will come back the day stage 04 grows a real payload viewer.

The obvious way to colour or view a payload is to install a JSON viewer package.
Surveyed, and the reason each was rejected:

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
numbers stay string-backed — and it composes with none of the viewers above:
`renderjson` decides what a leaf is by testing `constructor` against `Number`,
`String`, `Boolean` and `Date`, so a `LosslessNumber` falls into the *object* branch
and renders as a wrapper. Gluing them means writing the renderer anyway, on top of a
second dependency, having swapped a token stream for a whole value tree in a page that
may be holding half a megabyte of payload.

**So the lexing was never ours — only the labelling was.** jsonc-parser's scanner does
string escapes, surrogate pairs, the number grammar and the offset at which a document
stops being valid; each token comes back as an offset and a length, and every
character on screen was `text.substr()` of the original. What `scanJsonSpans()` added
on top was the one fact the scanner does not expose — a key is a string with a colon
after it — plus a merge of adjacent unstyled runs to cut the DOM node count, and a
zero-width-token guard whose consequence would have been an endless loop in someone's
page rather than a wrong colour. None of that made the *parsing* ours; it only chose
which already-correct span got which class name.

**And then the formatting went too, which is the part worth being honest about.**
Removing the colouring left `jsonc-parser` in the bundle for one job: pretty-printing
a payload whose long integers `JSON.parse` would rewrite. That was a real improvement
in *coverage* over the regex heuristic it replaced — but both are comfort, not
correctness, and neither is what this rung is about. So the dependency went out,
`jsonText.ts` with it, and then the heuristic went out too: 03 does not format a
payload at all. Displaying JSON *as JSON* is one whole job, and it belongs to the rung
that has time to do it properly rather than to the one whose subject is getting the
bytes in front of you unaltered.

What that cost and saved, measured: 03's bundles went from 307.3kb to 233.1kb over the
two removals, the project's declared dependencies from three to two, and 03 now adds
**no** dependency that 02 does not already carry. What it gave up is a formatted view
of the long-integer payload.

Stage 04 is where the payload **viewer** belongs — collapsible values, copy-per-value,
colour per value, and lossless formatting for the ids — built on `lossless-json` or
jsonc-parser's own `parseTree`. Every choice above will have to be made again there,
which is why the survey is written down here rather than living only in the commit
that deleted the code.

## The gates

`npm run preflight`. There is no CI for this repository, so this is the only thing
standing between a mistake and the default branch.

### A Node range the dependencies never promised

`package.json` said `engines.node: ">=22"`, and the README said "Node 22 or newer".
Both were true when written. Then jsdom raised its own floor, and nothing anywhere
noticed: npm enforces `engines` only under `--engine-strict`, and only against the
Node that happens to be running. On a machine inside the range, every check passes
and the declaration is never read.

Measured rather than assumed, `>=22` turned out to be wider than what **27** of the
locked packages declare — `npm run preflight` prints the number. The two a reader
would guess (`@asamuzakjp/css-color`, `@asamuzakjp/dom-selector`, both pulled in by
jsdom) want `^22.13.0 || >=24.0.0`; jsdom itself is stricter still. So the honest
range is jsdom's own, `^22.22.2 || ^24.15.0 || >=26.0.0`, and it is declared in five
places that a parity check keeps together: the root, all three projects, and
`package-lock.json`.

Who this actually hurt is the point. Everyone already working here is on a Node
inside the range, so the declaration is dead text to them. It is live only for the
person cloning the repository for the first time, on Node 22.4 or 23, whose install
fails before any check of ours gets to explain itself — the one reader with the least
context, at the one moment they have no way to tell a stale promise from a broken
repository.

`checkEngineRange()` in `scripts/preflight.mjs` compares the declared range against
every `engines.node` in the lockfile, and a range it cannot read is reported as
**unchecked** rather than folded into either verdict. That direction is deliberate: a
containment check that guesses wide reports "fits" where it does not, which is the
failure this whole file exists to avoid. What the check does *not* own any more is the
range algebra itself — see below.

Fixing the declaration left the sentences about it wrong, which is the more interesting
half. The range was correct in five machine-readable places and still false in four
pieces of prose: preflight's own advice to an incompatible runtime — "use Node >=22" —
and `needs Node >= 22` in each project's install block. Each was a bare major the
declared range no longer admits, and each was read by exactly the person the range
exists for, telling them to install a version that would fail again. A version restated
in prose is a copy, and a copy goes stale with nobody editing it. So the advice is now
interpolated from `engines.node` rather than written beside it, and the three project
READMEs link to the one statement in the root README instead of repeating it — a link
`npm run doc:paths` checks, which a sentence about a version is not.

There is deliberately no gate asserting "every Node range in the documentation matches
`engines.node`", because this very section quotes `^22.13.0 || >=24.0.0` as the range
that was *not* adopted. A check like that would need an exemption list, and an exemption
list is where a gate quietly stops checking the thing it is named after. Having one
statement to keep true is the cheaper answer.

### Two algorithms the gates had no business owning

The dependency policy applies to the tooling too, and it pointed at two places where a
gate had reimplemented a standard, published algorithm well enough to pass its own
tests. Neither package reaches a bundle: `scripts/surface.mjs` budgets each project's
`dependencies`, and these are root `devDependencies`. The stakes are lower here — a
broken gate cannot ship to a user — but they are not zero, because a gate that is wrong
in the accepting direction is worse than no gate.

**Semver range containment**, in `scripts/preflight.mjs`. The check above was doing
interval arithmetic by hand over the grammar it happened to find in the lockfile, and
declaring anything else unreadable. That was honest, and it was also a standing bet that
the tree never grows a range shape it had not met. `semver.subset(ours, theirs)` is that
question, asked of the reference implementation of the specification, with
`semver.validRange` in front of it so an unreadable range still lands on **unchecked**
rather than on a guess. Four functions went with it.

The interesting part is what the swap *fixed*. `declaredNodeMajor()` read the lowest
supported major with `/(\d+)/` — the first number in the string. For
`^22.22.2 || ^24.15.0 || >=26.0.0` that is 22, which is right, and it is right only
because the branches happen to be written in ascending order. Nothing requires that.
Written `>=26.0.0 || ^22.22.2`, the same range would have reported 26, and the DOM-test
capability probe would have been comparing against a floor the range does not have.
`semver.minVersion(range).major` answers it for the range rather than for the way it was
typed, and the self-test drives exactly that reordered string.

**GitHub's heading-slug algorithm**, in `scripts/doc-paths.mjs`. Anchor checking needs
the anchor GitHub will actually mint, and the copied version got two things wrong in the
direction that *rejects a link which works* — a run of spaces, and non-ASCII. Both are
`github-slugger`'s job, and it is the package GitHub's own toolchain uses.

The heading *text* was the larger of the two. The old loop matched `^#{1,6}` per line and
slugged the raw remainder, which meant a heading holding any inline markup produced an
anchor GitHub never mints — its own comment recorded this as a KNOWN LIMIT, having
already cost a correct link a rejection. Once headings come from
`mdast-util-from-markdown` and their text from `mdast-util-to-string`, three more shapes
come free that the regex had been silently missing: setext headings, which have no
leading `#` at all; headings reached through a blockquote or list; and a `#` inside a
fenced code block, which is code and not a heading. The gate's self-test pins the first
two.

`marked` was the smaller candidate and lost on the one thing that mattered. Its lexer
gives a heading token a `.text`, but that text is raw inline markdown: a link arrives
whole, brackets and target and all, and so does a `**bold**` run. Extracting what a
reader actually sees would mean hand-writing the inline walker this replacement exists
to delete. The mdast pair is two packages instead of one and
pulls a `micromark-*` tree behind it; `npm run measure` prints the current size of the
dev tree, and none of it is loaded by a browser.

Both changes were mutation-audited, and the audit earned its keep in the usual way: it
deleted a test. Reusing one slugger across documents, joining raw child `.value`s instead
of rendered text, and walking only top-level children were each caught — but the second
mutation failed only one of the two markup cases, which proved the other could not
discriminate. A slugger that drops backticks as characters and one handed the rendered
text land on the same slug for a heading holding inline code, exactly as the old
implementation's comment had said. That case is now a comment instead of a check. A test
no wrong answer can fail is decoration.

`scripts/preflight.mjs` also acquired the self-test it never had, which is the real
finding of this exercise. It runs four other gates' self-tests and had none of its own,
so the one gate here that was trusted purely on the strength of looking correct was the
one deciding whether anything else ran. Its eight cases cover the range decision and the
minimum-major reading — not the spawned builds, and deliberately not node-semver's own
conformance. Two of them exist only to pin the direction of the doubt: an unreadable
range reports unchecked and never satisfied, and a range that is provably too wide is
still reported as FAILED even when some *other* dependency's range could not be read at
all. A fact does not become less of a fact because the tool was uncertain elsewhere.

### A card nobody was checking

Rule 7 of `scripts/surface.mjs` decides whether a package may be inside a bundle. It has
nothing to say about whether the README still describes the package that **is** inside
one, and that is the claim which rots on its own: a version bump changes what a reader
loads and touches nothing a budget looks at. Every other check here stays green while the
card goes quietly out of date — the same shape as every other entry in this file.

So rule 8 reads each project's `## Dependencies` section and compares it against the
bundles esbuild has just produced. Four decisions in it are worth recording.

**The version and the licence come from the copy that was inlined, not from
`package.json`.** The projects declare caret ranges, so their own `package.json` cannot
answer "which version does a reader load" — and in a tree with two installed copies, only
the metafile can say which one esbuild actually reached. The check resolves the package
root out of that metafile and reads *that* directory's `package.json`, using the same
resolution `scripts/measure.mjs` uses, so the gate and the size report cannot end up
describing different copies of the same package.

**A direct package gets a card; a transitive one only has to be named, with its version.**
A direct dependency is a choice somebody made and has to defend, which is what a card is
for. `yocto-queue` is not a choice: it is in the bundles because `p-limit` is. A card of
its own would read as a second decision that nobody took, so the rule asks instead that it
appear inside the card of whatever brought it in — where a reader who has just found the
name in a bundle will look for it.

**Sizes are deliberately not in the cards.** They are the one figure a reader most wants
and the one that cannot be written down honestly: `bytesInOutput` is what survived
tree-shaking, so it moves whenever our own imports move, and a number typed into prose is
a copy that goes stale with nobody editing it. Each card names `npm run measure` instead.
A gate comparing card sizes against measured ones would need a tolerance, and a tolerance
is where a gate quietly stops checking the thing it is named after — the same reason there
is no gate over the Node ranges in the prose above.

**Not checked is not clean.** When a card's installed `package.json` cannot be read, the
rule reports that as a finding rather than passing the card. This is not a hypothetical
direction: while the rule was being written, *every* card in the repository reported
"could not be read", because the path being joined was wrong — the metafile's package
roots are relative to the project being built, not to the repository. A rule that shrugged
at an unreadable package would have printed a count of documented packages and verified
none of them, which is worse than not having the rule.

That last one is also the mutation audit's contribution. Nine of ten mutations — the rule
never firing, the section reader running past the next heading, a missing section reading
as clean, a missing card, a dropped version comparison, a dropped licence comparison, an
unmentioned transitive, a transitive named without its version, and a card for a package
no bundle contains — were each caught by exactly the case written for them. The tenth,
silently skipping a package whose metadata could not be read, survived: there was no case
for it. There is now.

Writing the cards also found something no check was looking for. `jsonc-parser` reaches
`dist/popup.js`, which has no payload panel and no JSON to scan, because the popup imports
`safeCodecEndpoint` from `src/payloads/codec.ts` and the module-level declarations come
with it. Splitting that file to shed them would trade a coherent "what can this extension
send, and where?" unit for a smaller popup, so 03's card says so plainly instead. A card
that has to admit something is a card doing its job.

### A hostname with no letters in it

The leak gate reads every URL it can find and asks whether the host is one this repository
is allowed to name — `cloud.temporal.io`, `localhost`, `example.com`. Anything else is a
finding, because an unrecognised hostname is exactly how a private deployment leaks into a
public example.

Run over the commit messages rather than the working tree, that rule failed on prose. The
commit that recorded the base-URL decision quotes the endpoint with its middle taken out,
`https://…/base?`, and the whole host is a single ellipsis character. The gate had never
heard of it, so it reported a hostname it could not vouch for — and it was right to be
suspicious in general and wrong here in particular.

The narrowing is one line: a host with no ASCII letter and no digit in it cannot name a
machine, so it names nothing and is allowed. That is deliberately not a rule about
ellipses. An elision *inside* a host keeps its alphanumerics and stays checked, which is
the case that matters — `api…a-real-internal-hostname` is still a leak, and the self-test
pins both directions so the accepting half can never grow into the flagging half by
accident.

Worth noting where this was found. `npm run leak:history` had been red since that commit
was written, which is a run that only happens deliberately; the tree scan the gate runs on
every preflight was green throughout, because the sentence lives in a commit message and
not in a file. A gate that is only correct over the inputs somebody looks at every day is
a gate with a blind spot on a schedule.
