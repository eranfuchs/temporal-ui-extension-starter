# How it works

No backend, no credentials, and — in [`01-family-tree/`](../01-family-tree/) — no
permissions at all. This document is the map: what runs where, why the design is
shaped like this, and which parts are the traps that cost real time to find.

Paths below are relative to a project directory. The mechanism is identical in
all of them, so read it against `01-family-tree/`, which has the least around it.

## The idea

The Temporal UI already asks the server for the data we want to draw. So instead
of authenticating and asking for it again, we watch the page make its own call
and read the answer over its shoulder.

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
                  │   src/rows.ts    API shape → row shape                  ││
                  │   src/tree.ts    buildTree: order + connectors  (pure)   ││
                  │   src/render.ts  the only code that writes to the DOM    ││
                  └─────────────────────────────────────────────────────────┘│
                                                                             │
                  the page never sees anything from us ──────────────────────┘
```

Why the injected script has to be in the page's **own** world is the crux, and it
is easy to get backwards: a same-origin API call made from page JavaScript needs
no permission, because it *is* the page. The identical call made from an extension
content script is cross-origin as far as Chrome is concerned and needs
`host_permissions`. Running in `"world": "MAIN"` is what makes the free ride legal.

What that buys:

- **No `host_permissions`.** We never issue a request, so we need no grant to
  issue one.
- **No credentials anywhere.** No API key, no bearer token, no mTLS certificate.
- **No CORS, no proxy, no backend.** There is nothing to deploy and nothing to
  operate.
- **Cloud and OSS, unchanged.** Both drive the same API from the page.
- **It cannot show anyone data they could not already see.** If the page was not
  allowed to fetch it, there is nothing to observe. That is a much easier
  sentence to defend in a security review than any design involving a token.

What it costs, stated plainly:

- **We see a list when the page asks for one.** Nothing to observe means nothing
  to draw. The first paint is whatever the page fetched.
- **We depend on a URL shape**, `/api/v1/namespaces/{ns}/workflows`. If Temporal
  changes it, the extension stops seeing rows — quietly. `src/inject.ts` logs
  every list it observes for exactly this reason, so the failure has a distinct
  signature in the console rather than looking like an empty page.

## The files

The first four exist in every project, byte-identical — enforced by
[`../scripts/lineage.json`](../scripts/lineage.json).

| File | What it is |
|---|---|
| `src/inject.ts` | MAIN world, `document_start`. Wraps `window.fetch`, clones matching responses, posts rows. The only file that touches the page's own JavaScript. |
| `src/types.ts` | The shapes that cross the `postMessage` boundary. |
| `src/rows.ts` | API shape → row shape. Pure. |
| `src/tree.ts` | `buildTree` — the whole feature, as one pure function. Ordering, depth, connector columns. |

These two differ per project, and the difference is the lesson:

| File | What it is |
|---|---|
| `src/content.ts` | ISOLATED world. Wiring: receives messages, drives a `MutationObserver`. No DOM writes. In `01` it uses no `chrome.*` API at all; in `02` it also loads settings and answers the popup. |
| `src/render.ts` | Every DOM write in the extension. `01`'s takes no options, because it has no settings to vary. |

`02-techniques/` adds `src/deepLink.ts` (templated per-row links, pure),
`src/settings.ts` (`chrome.storage.sync`) and `src/popup.ts` (the toolbar popup,
including an honest answer to "is it working?" — rows *seen* reported separately
from rows *matched*, so the two failure modes are distinguishable).

The split between `content.ts` and `render.ts` is not tidiness. It is what makes
the DOM behaviour unit-testable: `tests/unit/render.spec.ts` drives `render.ts`
against a jsdom table in milliseconds, including the idempotency property that is
impossible to eyeball and expensive to get wrong.

## Five things that will bite you

Each of these cost hours in the internal extension this starter was extracted
from. They are commented at the site in the code; this is the index.

**1. `window.fetch` must be installed behind a getter.**
Temporal's UI reassigns `window.fetch` *after* `document_start`. A plain
`window.fetch = wrapped` is silently evicted moments after it lands, and the
symptom is not an error — it is a small fraction of page loads mysteriously
working. `Object.defineProperty(window, 'fetch', { get: () => wrapped })`
survives it, because the framework reads `window.fetch` fresh on every call.

**2. Every DOM write must be idempotent.**
A `MutationObserver` drives the render. An unconditional write wakes the
observer, which schedules another pass, which writes again. That is 100% of a CPU
core, forever. The fix is not a longer debounce — it is comparing before writing,
so a pass with nothing to do touches nothing at all. `render.ts` compares before
every single write, and a spec asserts that a second pass produces zero mutation
records.

**3. The UI recycles `<tr>` elements.**
The same DOM node is reused for a different workflow, with only the link
updated. Anything that caches identity on the element is wrong from that moment
on: the cached workflow id pairs with a freshly-read run id, every lookup misses,
and the tree silently renders flat. Read the `href` first, always.

**4. Key rows by (workflowId, runId), never by workflowId alone.**
One page can show several runs of one id — a workflow that was terminated and
re-run, a cron. Collapsing them attaches every child to every run, which
duplicates rows and breaks the mapping between the tree and the table.

**5. `z-index: 0` on the connector overlay. Not `1`, not `-1`.**
At `1` the strokes paint over the table's sticky pagination bar. At `-1` they
disappear behind the row background, which looks exactly like a broken feature.

## Retargeting it

The three things most teams will want to change, in the order they will want to
change them:

1. **A different view** — replace `buildTree` with your own pure function over the
   same rows and draw whatever it returns. Ordering and decoration are already
   separated from the DOM plumbing, and `tests/unit/tree.spec.ts` shows how to
   pin the result without a browser.
2. **Deep links to your own tools** — in `02-techniques/` these are settings, not
   code. `src/deepLink.ts` lists the tokens, and offsets like `{startTimeIso-10m}`
   exist because the useful log window is never exactly the workflow's own start
   and end.
3. **A different page** — the piggyback is not specific to the workflow list. The
   pattern is: match a URL in `inject.ts`, post the response, render it in the
   extension world. Any API call the page already makes is available to you on the
   same terms.

## Permissions, in full

`01-family-tree` has no `permissions` key in its manifest. Not an empty array —
no key.

`02-techniques` has exactly one:

```json
"permissions": ["storage"]
```

Neither has `host_permissions`, `scripting`, `tabs`, `webRequest`,
`web_accessible_resources`, or a service worker. The content scripts are declared
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

From `02-techniques`, two things, both of which you asked for:

- `chrome.storage.sync` holds your toggles and your link templates. **Chrome
  uploads that to your Google account** if you are signed in, so treat a URL
  template like anything else you type into a synced browser setting — in
  particular, do not embed a key in one.
- A deep link opens the URL you configured, carrying the workflow id and time
  window you told it to carry. Those links are marked `rel="noopener noreferrer"`
  and `referrerpolicy="no-referrer"`, so the destination gets what is in the URL
  and not a handle on the Temporal tab or the namespace it came from. Nothing is
  ever sent on render — only on a click.

There is no analytics and no telemetry in any project. To check rather than
believe:

```bash
grep -rn 'fetch\|XMLHttpRequest\|sendBeacon\|WebSocket\|EventSource' src/
```

Every hit is `window.fetch`, the page's own — captured, wrapped, and called on
the page's behalf so its result can be handed straight back to it. There is no
other network API in the source.
