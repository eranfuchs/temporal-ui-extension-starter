# Temporal UI extension starter

Three small Chrome extensions that add a **parent/child family tree** to the
Temporal Web UI — and, more to the point, a worked example of how to add your own
view to a UI you do not own.

No backend. No credentials. No changes to Temporal. They work on Temporal Cloud
and on a local `temporal server start-dev` without a line of configuration,
because they read the API responses the page is already fetching. 01 never talks
to Temporal at all; 02 asks the page's own API two small questions per *running*
row, using the page's own session, and still holds no credential of its own — and
still decodes no payload.

```
Workflow ID                                    Type                Status
order-2601011200-01                            order               Completed
 ├─ order-2601011200-01-payment                paymentWorkflow     Completed
 └─ order-2601011200-01-fulfilment             fulfilmentWorkflow  Completed
     └─ order-2601011200-01-shipment           shipmentWorkflow    Completed
order-2601011200-02                            order               Running
```

## Start with 01

[**`01-family-tree/`**](01-family-tree/) is the whole idea in the smallest form
that is still worth installing, and **it asks for no permissions at all** — no
`permissions` key in the manifest, no `host_permissions`, no service worker, no
`chrome.*` call anywhere in its source.

```bash
git clone <this repo> && cd temporal-ui-extension-starter
npm install                    # once, at the root: all three projects share it
cd 01-family-tree && npm run build
```

**Node 22 or newer** (`node --version`). Not a preference: the jsdom specs cannot
start on Node 20, and the way they fail is to vanish from the totals while the
run still reports every collected test as passing. `npm run preflight` refuses to
proceed on a Node that cannot host them, and states the reason.

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`01-family-tree/dist/`. Open a workflow list and reload the tab.

Each project's icon carries its own number and colour, so two of them loaded at
the same time are still distinguishable in a 16px toolbar.

No Temporal to point it at? [`sample/`](sample/README.md) starts workflows that
produce real parent/child families in about a minute.

## The three projects

They are separate extensions, not one extension with feature flags. Each is
clonable and buildable on its own, and each rung of the ladder costs something
visible:

| Project | Adds | Permissions | Requests it makes | Worker |
|---|---|---|---|---|
| [`01-family-tree/`](01-family-tree/) | the family tree, and nothing else | **none** | **none** | none |
| [`02-techniques/`](02-techniques/) | deep links to your own log tool (per row, and per activity on a workflow's own page), a settings pane, a "last event" column, a retrying-activity badge | `storage` | up to two per **running** row, to the page's own Temporal API, paced and cached. Nowhere else | none |
| `03-goodies` — **planned, not here yet** | each workflow's input and result on hover, decoded through your codec server; column reorder; a larger page size; an activity finder; expand-to-families | `storage` | the above, plus a codec server you typed into the popup | none |

The "requests" column is there because it is the one cost the manifest does
**not** show. 02 declares no `host_permissions` and still originates requests: it
makes them from the page's own world, where a host permission would buy nothing
(Chrome treats a content-script fetch as cross-origin even with one). A permission
diff is not a capability diff.

The line between 02 and 03 is drawn at one place, and it is not a permission
either: **02 never decodes a payload.** Everything it shows is derived from event
metadata — event types, ids, timestamps, attempt counts, activity type names — so
there is no codec server, no outbound host, and no way for a workflow's input,
result or failure message to reach the screen or the wire. 03 crosses that line on
purpose, which is why the codec server, the first external dependency and the whole
personal-data question arrive together, in one project, rather than being spread
across the ladder.

**03 is not written yet**, and there is no empty directory standing in for it. The
row above says what it is planned to carry; every claim in the two rows above it is
about code that is in this tree.

That ladder is the argument this repository is making: a genuinely useful view
costs zero permissions, and every permission after that should be traceable to a
feature you can name. Read `01`, then diff it against `02` — the diff *is* the
lesson about what each capability costs.

## How it works

> The page already fetched the data. Read *that*, instead of asking for it again.

A `document_start` content script in the page's **own** world (`"world": "MAIN"`)
replaces `window.fetch` with a wrapper, clones any response from
`/api/v1/namespaces/{ns}/workflows`, and `postMessage`s the rows to the
extension's world, which folds them into a tree and rewrites the table.
Consequently:

- **no `host_permissions`** — 01 never issues a request at all, and 02's requests
  are made in the page's world, where a host grant changes nothing;
- **it cannot surface data the user could not already see**, because the only data
  it has is a response the page was allowed to receive;
- **Cloud and self-hosted work identically**, since both drive the same API from
  the browser.

Three more properties hold for **01 only**, and the point of the ladder is that you
can see exactly where each one stops:

| | 01 | 02 |
|---|---|---|
| Holds no credential of any kind | yes — nothing to leak, rotate or explain | it **reads** the page's `Authorization` header in the page's world to re-issue the page's own call. Never stored, never posted to the extension's world, never sent anywhere but Temporal's own API |
| Issues no request at all | yes | up to two per running row: one `history-reverse` page of one event, one `DescribeWorkflowExecution`. Cached, paced, and never for a closed workflow |
| Needs no server | yes | the same — 02 talks to exactly one server, the one the page is already talking to. (03 is where that stops.) |
| Takes no instruction from the page | yes — the page's world only ever *tells* it things | it **serves** requests over `postMessage`, which is a trust boundary and the most interesting thing in the repository. See [`02-techniques/README.md`](02-techniques/README.md#the-weakness-and-what-closing-most-of-it-took) |

The full walkthrough — including the traps that cost hours to find, from the
`window.fetch` getter lock to why `z-index` must be exactly `0` — is in
[`docs/how-it-works.md`](docs/how-it-works.md).

## Security

Each project's README opens with a **security card** in a fixed shape:
permissions, hosts, what it reads, what it writes, what it requests, what leaves
the machine, and what third-party code is in the bundle. The cards are meant to
be compared across the three projects.

The cards are not maintained by good intentions:

| Gate | Refuses |
|---|---|
| `npm run surface` | a manifest that exceeds its declared budget in [`scripts/surface.json`](scripts/surface.json) — a permission, a host permission, a service worker, `<all_urls>`, a match outside the two allowed hosts, a reference to the `chrome` namespace in a project budgeted without one, a runtime dependency, a markup/code sink (`innerHTML`, `eval`, …), or a binary file no reviewer can read. Sinks and `chrome` references are found by **parsing** each file, not by matching lines of it: `cell['innerHTML']`, an assignment wrapped over two lines and `const { storage } = chrome` all read the same to a parser, and a sink named inside a string or a comment is not a sink |
| `npm run lineage` | a file duplicated across projects that has drifted, or that nobody has decided may drift — see [`scripts/lineage.json`](scripts/lineage.json) |
| `npm run leak:gate` | private IPs, key material, bearer tokens, JWTs, and URLs pointing at hosts that are not on a short public allowlist |
| `npm run doc:paths` | a link, a cited file path, or an `npm run …` command in any Markdown file that does not exist |

Every gate ships with a self-test — `npm run surface:selftest`,
`npm run lineage:selftest`, `npm run leak:selftest`, `npm run doc:selftest` —
driving it against a case per rule it must reject and a case it must accept. A
gate that has quietly stopped detecting its own failure case is worse than no
gate: it converts an unchecked risk into a false assurance.

If you fork this inside a company, put your own internal terms in a **gitignored**
`leakgate.local.txt` — see [`leakgate.denylist.example`](leakgate.denylist.example).
A repository that publishes the list of your internal hostnames has already
leaked it.

## Layout

```
01-family-tree/     the tree, no permissions               ← start here
02-techniques/      + deep links, settings, two questions  (storage)
sample/             Temporal SDK workflows that produce a hierarchy to look at
scripts/            preflight and the gates, shared by every project
docs/how-it-works.md   the mechanism, and the traps that cost hours
```

Inside each project:

```
src/                the extension, with the reasoning for it in comments
public/             manifest, CSS, generated icons
tests/              unit + jsdom specs, including the idempotency property
```

## Commands

Run at the **repository root**; each one runs in every project.

| Command | What it does |
|---|---|
| `npm run preflight` | Everything below, plus the gates, reporting ok / FAILED / **UNVERIFIED** separately |
| `npm run build` | Bundle each project's `src/` into its `dist/` |
| `npm test` | Unit + jsdom specs |
| `npm run typecheck` | `tsc --noEmit`, over `src/` **and** `tests/` |
| `npm run surface` | The permission budget, sinks, dependencies, binaries |
| `npm run lineage` | Files duplicated across projects |
| `npm run leak:gate` | Scan tracked files for anything that should not be published |
| `npm run doc:paths` | Every path, link and command the docs name still exists |
| `npm run icons` | Regenerate every project's icons from arithmetic — each carries its own number and hue, derived from its directory name |
| `npm run package` | Preflight, then zip a project's `dist/` |

`npm run preflight` is the one to run before committing. There is no CI here, so
it is the only thing between a mistake and the default branch. It reports a check
that could not run as `UNVERIFIED` rather than folding it into a green tick,
because a wrapper that turns "the tool is not installed" into a pass manufactures
confidence — which is worse than having no wrapper at all. **If you quote its
results, quote the UNVERIFIED count too.**

## Status

Specific about which parts are proven:

- **Verified by specs** — the ordering and connector rules, the row shaping, and
  the DOM behaviour including idempotency. `npm run preflight` runs them.
- **Verified on live Temporal Cloud** — `01-family-tree` only, on 2026-08-31, in
  Chrome 151, against one tenant and one page of 100 workflows: the fetch
  piggyback, the URL shape, the row match, the indentation and connectors, the
  stylesheet, and idempotency, each measured separately — and the number of rows
  indented compared against the number of parent/child pairs the payload actually
  contained, rather than against an expectation. One version of Cloud on one
  tenant is a data point, not a guarantee; see
  [`01-family-tree/README.md`](01-family-tree/README.md) for exactly what was
  and was not covered.
- **Proven in production, elsewhere** — the mechanism. The piggyback, the
  `window.fetch` getter lock and the render loop are extracted from an internal
  extension that has run against Temporal Cloud daily for months. This repository
  is a clean-room rewrite of them, not a copy.
- **Partly verified on live Temporal Cloud** — `02-techniques`. What was driven on
  a tenant is the plumbing every feature here stands on: the fetch piggyback, the
  API-prefix derivation, the bearer capture, the ledger check and one real history
  request answered end to end. It took three rounds, and **each round found a bug a
  green suite had just missed** — including the one that matters most for anyone
  copying this: 02 installs a *second* `window.fetch` observer, the page's own
  wrapper evicted it, the tree went on working, and every per-row question answered
  "Nothing observed on this page yet" for the life of the tab, silently (trap 8).
- **Not verified on a tenant** — `02-techniques`' newest features: the **last-event
  column**, the **retrying-activity badge** and the **detail-page card**. They were
  built after those rounds. Their specs are green, which on this repository's own
  evidence is not the same thing; treat every claim about how they behave on a real
  tenant as unverified, and see the "What has not been done" section of
  [`02-techniques/README.md`](02-techniques/README.md).
- **Not verified here** — either project against a self-hosted UI holding real
  workflows; the rate-limit backoff against a real Temporal rate limiter;
  `sample/` end-to-end, whose dependencies have not been installed on the machine it
  was written on; and everything about `03-goodies`, which does not exist yet.

Expect a self-hosted UI on another hostname to need that hostname adding to the
project's `public/manifest.json` — and to `scripts/surface.json`, deliberately,
because widening where an extension runs should be a reviewed diff.

## Licence and affiliation

MIT — see [`LICENSE`](LICENSE).

This is a community sample. It is **not affiliated with, endorsed by, or
supported by Temporal Technologies**, and it uses no Temporal branding.
"Temporal" is used only to say which product it works with.
