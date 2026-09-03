# Temporal UI extension starter

Small Chrome extensions that add a **parent/child family tree** to the Temporal Web
UI — and, more to the point, a worked example of how to add your own view to a UI
you do not own. **Three of them are in this repository**, as the first three rungs
of a ladder; the table below says what each rung costs, and what stage 04 is planned
to add.

No backend of ours. No credentials to configure or store. No changes to Temporal.
They work on Temporal Cloud and on a local `temporal server start-dev` without a
line of configuration, because they read the API responses the page is already
fetching. 01 never talks to Temporal at all; 02 asks the page's own API two small
questions per *running* row, using the page's own session, and still holds no
credential of its own — and still decodes no payload. 03 is where payloads arrive:
a workflow's input and result on hover, decoded in the browser when they are
readable and through **a codec server you name yourself** when they are not, which
makes it the first rung that can send anything out of the browser at all.

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
npm install                    # once, at the root: every project shares it
cd 01-family-tree && npm run build
```

**Node `^22.22.2 || ^24.15.0 || >=26.0.0`** (`node --version`). Not a preference, and
not a round number either: the jsdom specs cannot start on Node 20, and the way
they fail is to vanish from the totals while the run still reports every
collected test as passing. The odd-looking range is jsdom's own `engines.node`,
which is the narrowest in the lockfile — so an `--engine-strict` install on a
Node outside it can fail before `preflight` gets a chance to say anything.
`preflight` checks both halves: that the declared range is no wider than every
locked dependency allows, and that the Node actually running can host the specs.

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`01-family-tree/dist/`. Open a workflow list and reload the tab.

Each project's icon carries its own number and colour, so two of them loaded at
the same time are still distinguishable in a 16px toolbar.

No Temporal to point it at? [`sample/`](sample/README.md) starts workflows that
produce real parent/child families in about a minute.

## The projects

They are separate extensions, not one extension with feature flags. Each is
clonable and buildable on its own, and each rung of the ladder costs something
visible. Three rungs are here; stage 04 is planned:

| Project | Adds | Permissions | Requests it makes | Worker |
|---|---|---|---|---|
| [`01-family-tree/`](01-family-tree/) | the family tree, and nothing else | **none** | **none** | none |
| [`02-techniques/`](02-techniques/) | deep links to your own log tool (per row, and per activity on a workflow's own page), a settings pane, a "last event" column with a refresh control, a retrying-activity badge | `storage` | up to two per **running** row, to the page's own Temporal API, paced and cached — plus whatever the refresh control is pressed for, floored at one round per run per 5s. Nowhere else | none |
| [`03-payloads/`](03-payloads/), the **payload stage** | each workflow's input and result on hover, decoded through your own codec server | `storage` — **the same permission surface as 02** | the above, plus one history event per question — one for a running row, two for a closed one — and, only once you have named one, the codec server you typed into the popup | none |
| stage 04, conveniences — planned, not written | payload viewing and JSON highlighting, column reordering, a larger page size, expand-to-families, family focus, per-column copy, NOT filtering and additive filtering — [the full list](#stage-04-planned--the-conveniences) | `storage` | no new destination | none |

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
purpose, which is why the codec server, the first outbound host and the whole
personal-data question arrive together, in one project, rather than being spread
across the ladder.

03 carries what most teams actually came for — seeing a workflow's input and result
without leaving the list — which is why it is a stage of its own and not a bag of
extras. The conveniences that were once bundled with it are stage 04's problem; none
of them changes what the extension can reach.

**And 03's manifest asks for exactly what 02's does.** Same one permission, same
absent `host_permissions`, same absent service worker, same three content-script
matches — every capability-bearing key is identical, and the diff is the name, the
description, the version and the button's tooltip — while the extension gains payload
decoding, an outbound host and a panel that can hold somebody's personal data. If you
read one diff in this repository, read that one: it is the clearest statement the
ladder makes that **a permission diff is not a capability diff**.

**Stage 04 is not written yet**, and there is no empty directory standing in for it.
The list below is what it is planned to carry; every claim in the three rows above it
is about code that is in this tree.

### Stage 04, planned — the conveniences

This is the one authoritative copy of the scope. Everywhere else in the repository
that mentions stage 04 links here, because four prose copies of a roadmap is four
things to update and three that will not be.

- **Separate input and output payload affordances** — one control per direction,
  rather than one panel showing both.
- **JSON highlighting**, and the value viewer it implies: collapsible values, colour
  per value rather than per panel, and lossless formatting so a 20-digit id survives.
  03 briefly had a version of this and it was removed; the library survey that stage
  04 should start from is in
  [`docs/design-notes.md`](docs/design-notes.md#every-json-viewer-wanted-a-parsed-value).
- **Column reordering.**
- **Workflow-list page size up to 1,000.**
- **Expand to families** — pull in the relatives of the rows a filter matched.
- **One-click family focus.**
- **A copy button on each data-column header.**
- **NOT filtering** — the negation Temporal's own filter bar does not offer.
- **Ctrl/Cmd-click additive filtering**, for Temporal's own filters and for the NOT
  filter above.

None of it needs a new permission or a new destination: `storage`, and the requests
03 already makes.

That ladder is the argument this repository is making: a genuinely useful view
costs zero permissions, and every permission after that should be traceable to a
feature you can name. Read `01`, then diff it against `02`, then diff `02` against
`03` — those diffs *are* the lesson about what each capability costs, and the second
one is the lesson that a capability can cost nothing in the manifest.

## How it works

> The page already fetched the data. Read *that*, instead of asking for it again.

A `document_start` content script in the page's **own** world (`"world": "MAIN"`)
replaces `window.fetch` with a wrapper, clones any response from
`/api/v1/namespaces/{ns}/workflows`, and `postMessage`s the rows to the
extension's world, which folds them into a tree and rewrites the table.
Consequently:

- **no `host_permissions`** — 01 never issues a request at all, and 02's and 03's
  requests are made in the page's world, where a host grant changes nothing;
- **it cannot surface data the user could not already see**, because the only data
  it has is a response the page was allowed to receive — which holds for 03's
  payloads too: the same session, the same runs, the same API;
- **Cloud and self-hosted work identically**, since both drive the same API from
  the browser.

Three more properties hold for **01 only**, and the point of the ladder is that you
can see exactly where each one stops:

| | 01 | 02 | 03 |
|---|---|---|---|
| Holds no credential of any kind | yes — nothing to leak, rotate or explain | it **reads** the page's `Authorization` header in the page's world to re-issue the page's own call. Never stored, never posted to the extension's world, never sent anywhere but Temporal's own API | the same, and the outbound half is where it matters: the codec fetch carries **no** credential of any kind — `credentials: 'omit'` as a literal — and there is no option to attach one. Temporal's own UI has two (an access token, and cookies); here the token was never built and the cookie switch was deleted rather than defaulted off, because a default protects only the honest path when the endpoint arrives over `postMessage` |
| Issues no request at all | yes | up to two per running row: one `history-reverse` page of one event, one `DescribeWorkflowExecution`. Cached, paced, and never for a closed workflow | the same, plus **one history event per payload question** — one for a running row, two for a closed one, and nothing on render, so a hundred-row list still costs zero. Both features share one pacer, so "four Temporal requests at a time" is a property of the extension |
| Needs no server | yes | the same — 02 talks to exactly one server, the one the page is already talking to | **no — this is where that stops.** An encrypted payload needs a codec server you name, and that field is the only thing in the repository that can send data off the machine. Empty by default; empty means nothing leaves |
| Takes no instruction from the page | yes — the page's world only ever *tells* it things | it **serves** requests over `postMessage`, which is a trust boundary and the most interesting thing in the repository. See [`02-techniques/README.md`](02-techniques/README.md#the-weakness-and-what-closing-most-of-it-took) | the same bus, now carrying decoded payloads back and a caller-named codec host out — so the ledger is worth more here than it was there. See [`03-payloads/README.md`](03-payloads/README.md#the-weakness-and-what-closing-most-of-it-took) |

The full walkthrough — including the traps that cost hours to find, from the
`window.fetch` getter lock to why `z-index` must be exactly `0` — is in
[`docs/how-it-works.md`](docs/how-it-works.md).

## Security

Each project's README opens with a **security card** in a fixed shape:
permissions, hosts, what it reads, what it writes, what it requests, what leaves
the machine, and what third-party code is in the bundle. The cards are meant to
be compared across the projects, line by line.

The cards are not maintained by good intentions:

| Gate | Refuses |
|---|---|
| `npm run surface` | a manifest that exceeds its declared budget in [`scripts/surface.json`](scripts/surface.json) — a permission, a host permission, a service worker, `<all_urls>`, a match outside the two allowed hosts, a reference to the `chrome` namespace in a project budgeted without one, a markup/code sink (`innerHTML`, `eval`, …), or a binary file no reviewer can read. It also refuses a **third-party package inside a bundle that the budget does not name**, which esbuild's own metafile decides rather than `package.json` — see [Dependencies](#dependencies). Sinks and `chrome` references are found by **parsing** each file, not by matching lines of it: `cell['innerHTML']`, an assignment wrapped over two lines and `const { storage } = chrome` all read the same to a parser, and a sink named inside a string or a comment is not a sink |
| `npm run lineage` | a file duplicated across projects that has drifted, or that nobody has decided may drift — see [`scripts/lineage.json`](scripts/lineage.json) |
| `npm run leak:gate` | private IPs, key material, bearer tokens, JWTs, and URLs pointing at hosts that are not on a short public allowlist |
| `npm run doc:paths` | a link, a cited file path, or an `npm run …` command that does not exist — in any Markdown file **and** in the comments of any `.css`, `.html` or `.ts` file, because regrouping `src/` left dead citations in two stylesheets that a Markdown-only gate had reported clean. Plus the one kind of rot a path check cannot see: a quoted spec block — `` `sending an encrypted payload to the codec server in the popup` `` — cited beside a spec file that no longer contains it, which is what splitting a large spec produces while every old filename still resolves. And the heading a `#fragment` names, because a wrong anchor does not 404 — GitHub leaves the reader at the top of the page, which reads as "that section was deleted" |
| `npm run preflight` | an `engines.node` wider than the locked dependencies support, on top of everything below. The declaration is dead text to everyone already working here and live only for a first-time cloner, whose `--engine-strict` install then fails before any gate can explain why |

Every gate ships with a self-test — `npm run surface:selftest`,
`npm run lineage:selftest`, `npm run leak:selftest`, `npm run doc:selftest`,
`npm run preflight:selftest` — driving it against a case per rule it must reject
and a case it must accept. A gate that has quietly stopped detecting its own
failure case is worse than no gate: it converts an unchecked risk into a false
assurance. The last one on that list is the newest, and it was missing for the
worst possible reason: `preflight` runs the other four and was the only gate here
trusted purely on the strength of looking correct.

### Every feature ships on, except one

Every toggle in every project defaults to **on**. A feature that arrives switched
off is a feature nobody turns on, and it teaches nobody anything — so the cost of
each one is bounded and written down instead of being deferred to a checkbox: the
per-row questions ask only about *running* rows, the payload panel asks nothing
until a pointer lands on a row, and each of those bounds is asserted by a test that
counts requests.

**One setting defaults to off, and it is the one that names a host.** 03's codec
endpoint is empty out of the box, and empty is not a cautious default — it is the
reason "no payload byte leaves this machine" is checkable rather than promised,
because that field is the only place an endpoint can come from. The rule the
repository follows, and the one worth copying into a fork: default on, unless the
setting enables egress, bypasses a security control, or writes something.

If you fork this inside a company, put your own internal terms in a **gitignored**
`leakgate.local.txt` — see [`leakgate.denylist.example`](leakgate.denylist.example).
A repository that publishes the list of your internal hostnames has already
leaked it.

## Dependencies

There used to be a rule here saying **no runtime dependencies**, and it read as a
security property. It was not one. It was a rule about where code was typed, and
it was paid for in hand-written schema validators, a hand-written promise queue
and very nearly a hand-written JSON scanner — code with no upstream, no test
suite but ours, and no reviewers but us. The rule now is a judgement instead:

> **Browser APIs and code in this repository for anything specific to this
> extension** — the trust boundaries, the authorization decisions, what is allowed
> to leave the machine. **Mature, maintained libraries for generic algorithms,**
> where using one makes the example easier to read and harder to get wrong.

**A dependency diff is not a manifest permission diff, but it is still an
audit-surface diff. The repository budgets and reports both.** A package cannot
grant itself a permission — the manifest is the only thing that can, and it is
budgeted separately — but it does run inside the extension's own origin with the
extension's own privileges, so "which packages, and how did they get in" is a
question with an answer here rather than an install log.

| | Enters the bundles | Arrives behind another package |
|---|---|---|
| [01](01-family-tree/README.md#dependencies) | `valibot` | — |
| [02](02-techniques/README.md#dependencies) | `valibot`, `p-limit` | `yocto-queue` |
| [03](03-payloads/README.md#dependencies) | `valibot`, `p-limit` — the same set as 02 | `yocto-queue` |

Each project's README carries a **dependency card** with the version, the licence,
what the package is for, which bundles it is in, and what stayed
application-owned. `npm run measure` prints what each one currently costs each
bundle, from the same esbuild metafile the gate reads;
[`docs/design-notes.md`](docs/design-notes.md#dependencies) records the
alternatives that were measured and lost, including the two evaluations that ended
in no dependency at all.

Three limits on that, stated rather than implied:

- **The budget covers the bundles a user loads.** Repository tooling under
  `scripts/` has its own dependencies — a semver implementation, a Markdown
  parser, GitHub's slug algorithm — which are `devDependencies` and reach no
  browser. Lower stakes, not zero: a gate that is wrong in the accepting direction
  is worse than no gate, which is why each one has a self-test.
- **This is an audit, not an attestation.** Nothing here verifies a package's
  contents against its repository, pins by integrity hash beyond what
  `package-lock.json` already does, or claims that a package that has been fine so
  far will stay fine. What it does guarantee is that a *new* package appearing in a
  bundle is a diff someone has to approve, including one that arrives as a
  dependency of a dependency.
- **Not one line of it is minified.** Every bundle ships readable with a source
  map, so what a package contributes can be read in `dist/` rather than taken on
  trust.

## Layout

```
01-family-tree/     the tree, no permissions               ← start here
02-techniques/      + deep links, settings, two questions  (storage)
03-payloads/        + input and result on hover, a codec server  (storage — the
                    same permission surface as 02, and the first rung with egress)
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
| `npm run measure` | Source, test and bundle sizes per project, and what each third-party package costs each bundle |
| `npm run lineage` | Files duplicated across projects |
| `npm run leak:gate` | Scan tracked files for anything that should not be published |
| `npm run doc:paths` | Every path, link, anchor and command the docs name still exists — in Markdown and in source comments — and every quoted spec block is cited beside the spec that holds it |
| `npm run icons` | Regenerate every project's icons from arithmetic — each carries its own number and hue, derived from its directory name |
| `npm run package` | Preflight, then zip a project's `dist/` |

`npm run preflight` is the one to run before committing. There is no CI here, so
it is the only thing between a mistake and the default branch. It reports a check
that could not run as `UNVERIFIED` rather than folding it into a green tick,
because a wrapper that turns "the tool is not installed" into a pass manufactures
confidence — which is worse than having no wrapper at all. **If you quote its
results, quote the UNVERIFIED count too.**

## Status

Three projects are built and used; stage 04 is not written. What is worth knowing
before you copy any of it:

- **The mechanism is proven elsewhere.** The piggyback, the `window.fetch` getter
  lock and the render loop come from an internal extension that has run against
  Temporal Cloud daily for months. What crossed over is the set of lessons, written
  down here and implemented again from scratch: this repository is a clean-room
  reimplementation, not a copy, and nothing in it was taken from that codebase.
- **A green suite has missed real bugs here, repeatedly**, and the two worst are
  worth knowing because they are not this repository's alone. 02 installs a
  *second* `window.fetch` observer and the page's own wrapper evicted it: the tree
  went on working while every per-row question answered "Nothing observed on this
  page yet" for the life of the tab, silently (trap 8). And a payload panel closed
  the instant the pointer entered it — unusable, and invisible to jsdom, which
  computes no layout and has no pointer. Both are fixed; neither had a failing test
  before somebody looked at the screen.
- **A UI you do not own can move under you.** Everything here reads Temporal's own
  markup and URLs. A Cloud release can change the list URL, a row's shape or a
  field's label, and the honest answer is that this code finds out the same way you
  would. Where a selector is load-bearing, the file says so and the failure is
  visible rather than silent — the deep-link bar parks itself in the corner and the
  popup reports it.
- **Not covered at all**: any project against a self-hosted UI holding real
  workflows; the rate-limit backoff against a real Temporal rate limiter; and
  `sample/` end to end, whose dependencies have never been installed.

Expect a self-hosted UI on another hostname to need that hostname adding to the
project's `public/manifest.json` — and to `scripts/surface.json`, deliberately,
because widening where an extension runs should be a reviewed diff.

## Licence and affiliation

MIT — see [`LICENSE`](LICENSE).

This is a community sample. It is **not affiliated with, endorsed by, or
supported by Temporal Technologies**, and it uses no Temporal branding.
"Temporal" is used only to say which product it works with.
