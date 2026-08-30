# Temporal UI extension starter

Three small Chrome extensions that add a **parent/child family tree** to the
Temporal Web UI — and, more to the point, a worked example of how to add your own
view to a UI you do not own.

No backend. No credentials. No changes to Temporal. They work on Temporal Cloud
and on a local `temporal server start-dev` without a line of configuration,
because they never talk to Temporal at all: they read the API responses the page
is already fetching.

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

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`01-family-tree/dist/`. Open a workflow list and reload the tab.

No Temporal to point it at? [`sample/`](sample/README.md) starts workflows that
produce real parent/child families in about a minute.

## The three projects

They are separate extensions, not one extension with feature flags. Each is
clonable and buildable on its own, and each rung of the ladder costs something
visible:

| Project | Adds | Permissions | Worker |
|---|---|---|---|
| [`01-family-tree/`](01-family-tree/) | the family tree, and nothing else | **none** | none |
| [`02-techniques/`](02-techniques/) | deep links to your own log tool, a settings pane | `storage` | none |
| [`03-goodies/`](03-goodies/) | column reorder, a larger page size, an activity finder, expand-to-families | `storage` | none |

**03 is not written yet** — the directory is a placeholder, and `npm run
preflight` says so rather than passing over it.

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

- **no `host_permissions`** — the extension never issues a request, so it needs no
  grant to issue one;
- **no credential** of any kind, so there is none to leak, rotate, or explain;
- **it cannot surface data the user could not already see**, because the only data
  it has is a response the page was allowed to receive;
- **no server**, so nothing to deploy and nothing to operate;
- **Cloud and self-hosted work identically**, since both drive the same API from
  the browser.

The full walkthrough — including the five traps that cost hours to find, from the
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
| `npm run surface` | a manifest that exceeds its declared budget in [`scripts/surface.json`](scripts/surface.json) — a permission, a host permission, a service worker, `<all_urls>`, a match outside the two allowed hosts, a `chrome.*` call in a project budgeted without one, a runtime dependency, a markup/code sink (`innerHTML`, `eval`, …), or a binary file no reviewer can read |
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
01-family-tree/     the tree, no permissions            ← start here
02-techniques/      + deep links, settings              (storage)
03-goodies/         + four more features                (placeholder)
sample/             Temporal SDK workflows that produce a hierarchy to look at
scripts/            preflight and the gates, shared by every project
docs/how-it-works.md   the mechanism, and the five traps
```

Inside each project:

```
src/                the extension — mostly comments, by volume
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
| `npm run icons` | Regenerate every project's icons from arithmetic |
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
- **Verified once on live Temporal Cloud** — `01-family-tree` only, on
  2026-08-30, in Chrome 151, against one tenant and one page of workflows: the
  fetch piggyback, the URL shape, the row match, the indentation and connectors,
  the stylesheet, and idempotency, each measured separately. One version of
  Cloud on one tenant is a data point, not a guarantee; see
  [`01-family-tree/README.md`](01-family-tree/README.md) for exactly what was
  and was not covered.
- **Proven in production, elsewhere** — the mechanism. The piggyback, the
  `window.fetch` getter lock and the render loop are extracted from an internal
  extension that has run against Temporal Cloud daily for months. This repository
  is a clean-room rewrite of them, not a copy.
- **Not verified here** — `02-techniques/` against a live tenant; either project
  against a self-hosted UI holding real workflows; `sample/` end-to-end, whose
  dependencies have not been installed on the machine it was written on; and
  everything about `03-goodies/`, which does not exist yet.

Expect a self-hosted UI on another hostname to need that hostname adding to the
project's `public/manifest.json` — and to `scripts/surface.json`, deliberately,
because widening where an extension runs should be a reviewed diff.

## Licence and affiliation

MIT — see [`LICENSE`](LICENSE).

This is a community sample. It is **not affiliated with, endorsed by, or
supported by Temporal Technologies**, and it uses no Temporal branding.
"Temporal" is used only to say which product it works with.
