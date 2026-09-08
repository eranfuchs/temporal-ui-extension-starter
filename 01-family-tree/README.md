# 01 — family tree

The smallest thing in this repository that is still worth installing: the
Temporal workflow list, with parent/child families grouped and drawn.

**It asks for no permissions at all.** Its `manifest.json` has no `permissions`
key, no `host_permissions` key, and no service worker. There is no `chrome.*`
call anywhere in `src/` — you can check with
`grep -rnE 'chrome\.' src/`, which finds only the comment saying so.

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
npm install          # from the repository root, once
npm run build        # from this directory
```

The Node range `npm install` needs is stated once, in
[the root README](../README.md#start-with-01), rather than copied into each
project where three copies would go stale one at a time.

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
does this thing actually do to my browser", in a fixed shape so the projects
can be compared line by line.

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
| **Third-party code in the bundle** | one package, `valibot`, and nothing behind it — see [Dependencies](#dependencies) |

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

This project's budget in [`../scripts/surface.json`](../scripts/surface.json) is
**empty**, which is the stage-specific part: the gate fails on the first `permissions`
or `host_permissions` entry, a service worker, any reference to the `chrome` namespace
under `src/`, `tests/` or `public/`, an `@types/chrome` dependency, and a `"chrome"`
entry in `tsconfig.json`'s `types`.

What every gate refuses — sinks and `chrome` references found by **parsing** each file
rather than searching it, every loaded script traced to an audited entry point, the
one dependency rule — and why each ships with a self-test, is in the
[root README](../README.md#security).

### What has not been done

- **No independent security review.** Every change is reviewed as it is written, the
  message boundary carries specs that forge a message and assert it is refused, and
  `npm run preflight` re-runs the banned-sink, permission and secret-scan gates on
  every pass. What is missing is an outside pair of eyes: the mechanism comes from an
  extension used internally, but this code is a clean-room rewrite and nobody outside
  this repository has audited it.
- **Tested against one version of Temporal Cloud, on one tenant.** The next Cloud
  release can move the list URL, the row markup or the bootstrap order, and this code
  finds out the same way you would. Nothing here has been run against a self-hosted UI
  with real data in it.
- **No supply-chain attestation.** The bundle is built unminified on purpose, so
  `dist/content.js` is readable, including the one third-party package inside it. What
  the gate does and does not check is in the
  [root README](../README.md#dependencies); nothing verifies a package's contents
  against its repository, and the lockfile's integrity hashes are the only pinning
  there is.

## Dependencies

One package reaches the browser. The repository's dependency policy, and the
audit-surface argument behind it, are in the
[root README](../README.md#dependencies).

| | `valibot` |
|---|---|
| **Version** | 1.4.2 — MIT |
| **What it is for** | Runtime schema validation. Every boundary this extension reads across — the page's own workflow-list response, and the `postMessage` from the page world — is `safeParse`d against a schema before any field is read, so a shape that changed is an `issues` list handled at the boundary instead of an `undefined` that surfaces four calls later as something else |
| **Bundles it enters** | `dist/content.js` and `dist/inject.js`, both of them |
| **Packages it brings with it** | none. valibot has no dependencies of its own |
| **What stays ours** | the schemas, and every decision they inform. A parse result is evidence about the **shape** of a value and never about where it came from — see `src/types.ts` |

This table is hand-written; `npm run measure` prints what the package currently costs
each bundle. Why valibot and not zod, with the measurements that decided it, is in
[`docs/design-notes.md`](../docs/design-notes.md#two-schema-libraries-measured).

## Layout

`src/` is grouped by lesson: its root holds the bundle entry points — the two in
`esbuild.mjs`, both named by the manifest — plus the modules every lesson touches, and
each directory below them is one thing the extension does. The later projects add
files and directories here; they do not rearrange these.

```
src/
  inject.ts     MAIN world — wraps window.fetch, posts what it sees
  content.ts    ISOLATED world — wiring, and nothing else
  render.ts     the only code that writes to the DOM
  types.ts      the shapes crossing the postMessage boundary
  family/       the feature, as pure functions
    rows.ts     API response → a flat row shape
    tree.ts     rows → ordered rows, each with its connector
public/
  manifest.json no permissions
  content.css   the connectors
  icons/        generated: this project's number and hue, not a committed image
tests/          the ordering rules, and the two DOM bugs that cost the most
```

`find src -name '*.ts' | xargs wc -l` prints the size. `tsconfig.json` sets
`"types": []` — this project needs no ambient type package, not even `@types/chrome`,
and the typechecker is where that claim is enforced rather than asserted.

## What it deliberately does not do

Deep links to your log tool, a settings pane, a last-event column and a
retrying-activity badge are [`../02-techniques/`](../02-techniques/). Workflow input
and result on hover, decoded through your codec server, are the rung above that —
[`../03-payloads/`](../03-payloads/). The conveniences are the rung above *that* —
[`../04-ui-goodies/`](../04-ui-goodies/),
[listed in the root README](../README.md#stage-04--the-conveniences).

Each step costs something: 02 asks for `storage` and — the part no manifest key shows
— it **originates requests**, because two of the facts it puts on screen are in no
response the page had already fetched. 03 gains decoded payloads and a host of your
choosing to send the unreadable ones to, on 02's manifest exactly, which is the
sharpest thing this ladder has to say. This one asks for nothing and requests nothing.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle `src/` into `dist/`, copy `public/` over it |
| `npm run watch` | Rebuild on change (does **not** re-copy `public/`) |
| `npm test` | Unit + jsdom specs |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |

From the repository root, `npm run preflight` runs all of that for every project
at once.
