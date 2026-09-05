# 04 — UI goodies

Everything [`../03-payloads/`](../03-payloads/) does. This stage adds no request, no
permission and no destination 03 does not already have — see the root README's
[stage ladder](../README.md#stage-04-planned--the-conveniences) for the one authoritative
copy of what belongs here and why. This file will carry the finished feature list, the
"read these files" path and the security card once every phase below is built and
verified; right now, in progress, it has already forked its Input/Output payload
controls and added a lossless JSON viewer over 03's — see `scripts/lineage.json` for the
current, exact list of what has forked from 03 so far and what is still shared.

## Status

In progress. `npm run lineage` and `npm run surface` treat this project the same as any
other — every file duplicated from 03 is registered there, and the manifest budget is
03's, unchanged.

## Run it

```bash
npm install          # from the repository root, once
npm run build        # from this directory
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`04-ui-goodies/dist/`.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle `src/` into `dist/`, copy `public/` over it |
| `npm run watch` | Rebuild on change (does **not** re-copy `public/`) |
| `npm test` | Unit + jsdom specs |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |

From the repository root, `npm run preflight` runs all of that for every project at once,
plus the gates.
