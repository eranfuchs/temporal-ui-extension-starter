# Sample workflows

Workflows whose only purpose is to give the extension something to draw: a
parent with two children, one of which has a child of its own.

```
order
├─ payment
└─ fulfilment
   └─ shipment
```

Three levels is the minimum that exercises every connector the extension draws.

## Run it

Three terminals, in this order.

```bash
# 1 — the server, and its own web UI on http://localhost:8233
temporal server start-dev

# 2 — the worker
cd sample
npm install
npm run worker

# 3 — create some workflows
cd sample
npm start          # four families; pass a number for more, e.g. npm start -- 12
```

Then open <http://localhost:8233/namespaces/default/workflows> with the extension
loaded.

Every run creates one family that sleeps for ten minutes, so the list always has
something `Running` in it — which is what makes the extension's "families with a
running member sort first" rule visible. Every third family fails its fraud
check, so there is also a failure to look at.

You do not need the `temporal` CLI for the extension itself; it is only how this
sample gets a server to talk to. Install it from
<https://docs.temporal.io/cli> (`brew install temporal` on macOS).

## Why this is a separate npm project

The extension itself has **zero runtime dependencies** and a handful of dev ones.
The Temporal SDK is a large dependency tree with native binaries in it, and none
of it ships in the extension. Keeping it in `sample/` means `npm install` at the
repository root stays small, and nobody has to install a Rust core bridge to
build a Chrome extension.

## It talks to localhost and nothing else

`src/shared.ts` holds every address in one place, defaulting to
`127.0.0.1:7233` and `http://localhost:8233`. There are no credentials here and
no code path to Temporal Cloud: this sample exists so that the screenshots and
the demo can be made against data that belongs to nobody.
