# berth ui

Front-end of `berth ui`: one HTML page, one stylesheet, one ES2022 module (`// @ts-check` + JSDoc). No
framework, no npm dependencies, no build step; `berth build` inlines the three files into the HTML served by
`node:http` on 127.0.0.1:10000. Only external request: the JetBrains Mono stylesheet, with a monospace
fallback stack so the page works offline.

## Run locally

    python3 -m http.server 4999 --bind 127.0.0.1 --directory ui     # open http://127.0.0.1:4999/

Without a real `/api/state` it falls back to `fixtures/check.sample.json`, shows a `fixture` tag beside the
wordmark (the 404 logged every 5 s is expected) and keeps polling so it goes live once `berth ui` answers.

## Data contract

`app.js` fetches `GET /api/state` (the shape of `berth check --json`, typed in its JSDoc) every 5 s while
polling is on and on REFRESH; a failed fetch keeps the last good report and shows `offline`. Joins are
client-side: `sessions[].leases` links ports to sessions (fallback `lease.owner.session_id`);
`policy.projects` drives table groups, map rows, the rules view and the declared-only legacy ticks;
`advisory`, `evidence` and `decoded` render as-is. DOM is built with `createElement`/`textContent`; URLs
link only if `http(s)://`. Theme persists in `localStorage["berth.theme"]` (try/catch), default dark.

## Verified

Served on 4999, checked in Chromium at 916x540 against the seven handoff screenshots: all five views, the
17101 drawer, light theme, filters, poll toggle, Escape, focus; `tsc --checkJs --strict` passes; console clean.
Deviations: 5000/7000 (ControlCenter) are `unmanaged` per the brief, not `ok`; the term mock colours the
state word (design pack §07) and always separates holder from session; ports outside every block get an
`unassigned` group in the table view.
