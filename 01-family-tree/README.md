# 01 — family tree

The smallest thing in this repository that is still worth installing: the
Temporal workflow list, with parent/child families grouped and drawn.

**It asks for no permissions at all.** Its `manifest.json` has no `permissions`
key, no `host_permissions` key, and no service worker. There is no `chrome.*`
call anywhere in `src/` — you can check with
`grep -rn 'chrome\.' src/`, which finds only the comment saying so.

```
Workflow ID                                    Type                Status
order-2601011200-01                            order               Completed
 ├─ order-2601011200-01-payment                paymentWorkflow     Completed
 └─ order-2601011200-01-fulfilment             fulfilmentWorkflow  Completed
     └─ order-2601011200-01-shipment           shipmentWorkflow    Completed
order-2601011200-02                            order               Running
```

There is nothing to configure, no popup, and no stored state. It draws the tree
or it does not; if you want it off, disable the extension.

## Run it

```bash
npm install          # from the repository root, once — needs Node >= 22
npm run build        # from this directory
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`01-family-tree/dist/`.

Then open a workflow list — Temporal Cloud, or a local
`temporal server start-dev` — and reload the tab. If you have no Temporal with
families in it, [`../sample/`](../sample/README.md) will give you one.

## How it works, in one paragraph

The page already fetches the workflow list. A `document_start` content script in
the page's **own** world (`"world": "MAIN"`) replaces `window.fetch` with a
wrapper, clones any response from `/api/v1/namespaces/{ns}/workflows`, and
`postMessage`s the rows to the extension's world, which folds them into a tree
and rewrites the table. No request is ever issued by the extension, which is why
it needs no permission: it only ever sees data the page was already allowed to
receive.

The non-obvious traps in that paragraph — the `window.fetch` getter lock and how
to hand a later assignment back without creating a cycle, `<tr>` recycling, the
self-feeding `MutationObserver`, an older list response arriving after a newer
one, and why `z-index` must be exactly `0` — are documented in
[`../docs/how-it-works.md`](../docs/how-it-works.md) and in comments at the top of
each file.

## Security card

Every project in this repository carries one of these. It is the answer to "what
does this thing actually do to my browser", in a fixed shape so the three
projects can be compared line by line.

| | 01 — family tree |
|---|---|
| **Permissions requested** | none. `public/manifest.json` has no `permissions` key |
| **Host permissions** | none |
| **Runs on** | `https://cloud.temporal.io/*`, `http://localhost/*`, `http://127.0.0.1/*` |
| **Service worker** | none |
| **Data it reads** | the workflow-list response the page had already fetched, and the table's own `href`s |
| **Data it writes** | nothing. No `chrome.storage`, no cookies, no `localStorage`, no files |
| **Requests it makes** | none. It never originates a request |
| **Data that leaves the machine** | none. There is no outbound anything — no analytics, no telemetry, no deep links |
| **Third-party code in the bundle** | none. No runtime dependencies |

Two of those rows are load-bearing and worth stating as arguments rather than
facts:

- **It cannot surface data you could not already see.** The only data it has is a
  response the page was allowed to receive. That is a much shorter conversation
  with a security reviewer than any design holding a token.
- **A workflow id is untrusted input.** It is authored by whoever started the
  workflow, and this extension renders it into a page it does not own. Every
  value reaches the DOM through `textContent`; there is no `innerHTML` anywhere,
  which is checked rather than remembered.

### Enforced, not just claimed

```bash
npm run surface        # from the repository root
```

`scripts/surface.mjs` compares each manifest against the budget declared in
`scripts/surface.json` and fails if a project exceeds it. For this project the
budget is empty, so the gate fails on the first `permissions` entry, the first
`host_permissions` entry, a service worker, any reference to the `chrome`
namespace under `src/`, `tests/` or `public/`, an `@types/chrome` entry in *this
project's* `package.json`, a `"chrome"` entry in its `tsconfig.json` `types`, a
runtime dependency, any of the markup/code sinks (`innerHTML`, `eval`, …), a
content-script match outside the allowed hosts, and `<all_urls>` outright.

"Any reference" is meant literally, and it is why the gate **parses** each file
rather than searching it: `const { storage } = chrome` and `cell['innerHTML'] = x`
contain neither `chrome.` nor `.innerHTML`, and a `//` inside a string used to
hide everything after it on the line. A parser also cannot mistake the sentence
above for a sink, which the patterns it replaced did.
`npm run surface:selftest` drives it against a case per rule that it must reject
*and* a case it must accept, because a gate that has quietly stopped detecting its
own failure case is worse than no gate.

### What has not been done

- **No third-party security review.** The mechanism comes from an extension used
  internally, but this code is a clean-room rewrite and nobody outside this
  repository has audited it.
- **Verified against live Temporal Cloud** — v0.2.0, on 2026-08-31, in Chrome
  151.0.7922.174, against one tenant and one page of 100 workflows. A headed
  browser-automation probe (which lives outside this repository, because it
  drives a private namespace) confirmed each link in the chain separately: the
  `window.fetch` wrapper survived Cloud's bootstrap, Cloud's list URL still
  matched the expected shape, every row on the page was annotated, `content.css`
  was in effect — checked through computed style, not by reading the stylesheet —
  and a second settled render pass wrote nothing, which is the idempotency
  property the specs assert offline.

  The tree itself was checked against the payload rather than against
  expectations: of 100 workflows, 60 carried a `parentExecution` and 49 of those
  parents were present in the same list, which is exactly how many rows were
  indented and given a prefix. That comparison is the point — the run before it
  drew nothing at all, on a page whose top 25 workflows happened to be 25
  unrelated roots, and a probe that asserts "an overlay was drawn" without asking
  whether the data held a family calls that a bug in the extension.

  That is **one** version of Cloud on **one** tenant. It does not generalise to
  the next Cloud release, and nothing equivalent has been run against a
  self-hosted UI with real data in it.
- **No supply-chain attestation.** Build it yourself from source; the bundle is
  built unminified on purpose, so `dist/content.js` is readable.

## Layout

```
src/
  inject.ts     MAIN world — wraps window.fetch, posts what it sees
  types.ts      the shapes crossing the postMessage boundary
  rows.ts       API response → a flat row shape
  tree.ts       the feature, as a pure function: rows → ordered rows
  render.ts     the only code that writes to the DOM
  content.ts    ISOLATED world — wiring, and nothing else
public/
  manifest.json no permissions
  content.css   the connectors
  icons/        generated: this project's number and hue, not a committed image
tests/          the ordering rules, and the two DOM bugs that cost the most
```

`wc -l src/*.ts` prints the size. `tsconfig.json` sets `"types": []` — this
project needs no ambient type package, not even `@types/chrome`, and the
typechecker is where that claim is enforced rather than asserted.

## What it deliberately does not do

Deep links to your log tool, a settings pane, a last-event column and a
retrying-activity badge are [`../02-techniques/`](../02-techniques/). Workflow
input and result on hover — decoded through your codec server — plus column
reorder, a bigger page size and a cross-workflow activity finder are the rung
above that, `03-goodies`, which is not in this repository yet.

Each step up the ladder costs something: 02 asks for `storage`, and — the part no
manifest key shows — it **originates requests**, because two of the facts it puts
on screen are in no response the page had already fetched. This one asks for
nothing and requests nothing, and that is the point of having it separately.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle `src/` into `dist/`, copy `public/` over it |
| `npm run watch` | Rebuild on change (does **not** re-copy `public/`) |
| `npm test` | Unit + jsdom specs |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |

From the repository root, `npm run preflight` runs all of that for every project
at once.
