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

So when the text contains a long integer literal, the server's own formatting is
shown untouched. Ugly beats wrong.

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
