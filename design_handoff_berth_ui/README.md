# Handoff: berth ui — dashboard and design pack

## Overview
`berth ui` is the local dashboard for berth, the advisory port registry described in `docs/DESIGN.md` §5.8. It serves one page on port 10000, polls `berth check --json` every 5 s, and shows who may use which port, who actually holds it, and the evidence for that. It never kills, blocks or reassigns.

## About the design files
The two `.dc.html` files in this bundle are **design references built in HTML**, not production code. Recreate them in berth's own stack (DESIGN.md §5.9: TypeScript on Node 20, single esbuild bundle, zero runtime deps — so a static HTML page served by `berth ui` with a small vanilla-TS or Preact client is the natural fit). The prototype's data is hard-coded; the real page reads `berth check --json`.

- `Berth Dashboard.dc.html` — the interactive prototype (all views, drawer, filters, themes).
- `Berth Design Pack.dc.html` — tokens, state system, type scale, cell specs, component inventory, terminal styling, copy rules.

Both files open directly in a browser. Ignore `support.js`-related runtime scaffolding; read the inline styles for exact values.

## Fidelity
**High-fidelity.** Colours, type, spacing and interactions are final. Recreate pixel-perfectly.

## Design tokens (CSS custom properties on `body`; light theme via `body[data-theme="light"]`)

Font: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`, weights 400/500/600. Body 12px / line-height 1.45. Only family used.

Dark (default) / Light:
- `--bg` #0b0d10 / #f2f2ee
- `--panel` #10131a / #fafaf7
- `--panel2` #161a22 / #ebebe6 (tooltip)
- `--line` #232932 / #d5d5cf (all hairlines, 1px)
- `--fg` #d7dce3 / #1b1e22
- `--dim` #7f8994 / #646c75
- `--faint` #3b434e / #b9bdc2
- `--sel` #1a2130 / #e3e6ea (hover + selected rows)
- `--empty` #141820 / #e6e6e1 (free map cell)
- `--reserved` #5b6570 / #8b949d (declared-only ticks)

State colours dark / light:
- `--ok` #3fd68b / #137a42
- `--idle` #b08d3c / #8a6a15
- `--stale` #f2b135 / #a56d00
- `--orphan` #e0812a / #b25a0f
- `--unmanaged` #9aa5b1 / #5d6772
- `--squatter` #ff6b5d / #c9352a
- `--conflict` #ff3b3b / #c40e0e
- `--drift` #4ea6ff / #175fb8 (also link colour)

Hatched states (map cells): squatter, stale, conflict, orphan → `repeating-linear-gradient(135deg, <state> 0 2px, transparent 2px 5px)`.

Type scale: 28/600 (pack title only) · 18/600 (drawer port) · 13/600 .04em (wordmark, formula) · 12/400, ports 600 (body, cells) · 11/400 (secondary, paths, evidence) · 10/500 .08em uppercase (column heads, section labels; chips use .06em) · 9px (map W labels, strip labels).

Radii: none anywhere except the 6px poll dot (50%). Shadows: tooltip only, `0 4px 16px rgba(0,0,0,.3)`.

## Layout shell
Full-viewport column, `min-height:640px`.
1. **Header** 40px per line, `--panel` bg, hairline below, `padding:0 12px`, flex, `flex-wrap:wrap`, `gap:0 12px`. Children each 40px tall: wordmark `berth` (13/600, .04em) + `ui :10000` (11px --dim); nav tabs; `flex:1` spacer; search input (flex 0 1 220px, min 110px, 24px tall, `--bg` bg, hairline border, 11px, focus border `--dim`); controls group (poll dot 6px + "Ns ago" 11px --dim, `POLL ON|OFF` and `REFRESH` buttons 22px tall, 10px uppercase .06em, hairline border, no fill, hover border `--dim`; theme toggle 22×22 showing ☾/☼).
   - Tab: transparent, `padding:0 10px`, 12px, .02em, `white-space:nowrap`, 2px bottom border (`--fg` active / transparent), colour `--fg` active / `--dim`; count suffix 10px --dim. Tabs: sessions (count = sessions), table (count = ports), map, rules (count = projects), term.
2. **Filter bar** min 32px, `padding:5px 12px`, wraps, `gap:4px 6px`. Label `STATE` (10px uppercase .08em --dim); eight state chips: 20px tall, `padding:0 7px`, 10px .04em, 7px square swatch, hairline border; active = border in state colour + `--sel` bg + `--fg` text; when any active, inactive chips at 50% opacity. Divider 1×16 `--line`. `PROJECT` + native `<select>` (20px, `--bg`). `clear` link (10px --drift) when any filter/search set. Right-aligned summary: `N of M ports · K need attention · S live sessions` (10px --dim).
3. **Body** flex row: `main` (flex 1) + optional drawer 380px.

## Views

### Sessions (default landing)
Two-pane grid `minmax(260px,320px) minmax(0,1fr)`.
- Left rail (hairline right, scroll): sticky head `SESSION | LEASES`. Row: grid `8px 1fr auto`, gap 10px, `padding:8px 12px`, hairline below, hover/selected `--sel`. 8px square = worst state colour across the session's leases (order of severity: drift > conflict > squatter > unmanaged > orphan > stale > idle > ok). Line 1: short id (8 chars, 600) + tool (`claude code`/`human`/`macOS`, 10px --dim). Line 2: `project · W0` or cwd (11px --dim, ellipsis). Line 3: mini chips for non-ok states with counts (9px, line-height 14px, `padding:0 4px`). Right: lease count (11px) and `pid N` / `ended HH:MM` (10px).
- Detail pane: header grid `repeat(auto-fit,minmax(180px,1fr))`, gap `8px 24px`, `padding:12px 16px`, fields: session (full id, 13/600) · tool · pid · started; project · worktree · block (`17000–17099`); cwd (full row; `--orphan` colour + "(missing — worktree removed)" if gone); how we know (full row, --dim). Then lease table (columns: port · role · state · live holder · kind · age · url), rows 26px, `padding:5px`, first/last cell 16px inset, hairlines, hover `--sel`, idle rows 55% opacity, selected (drawer open) `--sel`. Empty: "No leases match the current filters." (--dim, `padding:24px 16px`).

### Table (Project → Worktree → Role)
Single table, `min-width:900px`, sticky head. Group row per project: `--panel` bg, `padding:10px 12px 4px`, name 600 + `P=n · 10000–10999` + path (11px --dim). Lease rows: `W0 main` / `W1 <worktree dir>` (--dim, indented 24px) · port (600) · role · chip · live holder · session (short id) · cwd (ellipsis, max 260px) · age · url link. Rows 24px (`padding:4px`).

### Map (range map)
`padding:12px 16px 24px`. Legend row (10px uppercase --dim) with 9 swatches (8 states + free). Grid `auto auto 1fr`, hairline top and below each 22px row, 30 rows P=00–29:
- col 1: P (10px --dim, right-aligned), col 2: project name (11px) + base port (10px --faint), col 3: worktree groups separated by 14px.
- Group: `W<n>` label 9px --faint 18px wide, then 10 cells (roles 00–09) 22×14px, 2px gap, `box-sizing:border-box`, 1px border (state colour, or `--line` when free), fill state colour / hatch / `--empty`. Extras (policy-named slots 10–99): label `+n extras` then 12×14 cells.
- Row opacity: unassigned P 35%, assigned with nothing live (only declared/shared) 60%, else 100%. Name colour `--faint` for unassigned.
- Hover: `outline:1px solid --fg` + tooltip (fixed, +12/+14px from cursor, `--panel2` bg, hairline, `padding:6px 8px`, 11px): port 600 + state 9px uppercase coloured; `project · Wn · role`; `holder · session xxxxxxxx`. Click on a leased cell opens the drawer.
- **Legacy strip** (always visible, 24px below): label, then 56px tall box, hairline, `--panel` bg, `position:relative`. `left% = (port−1024)/8975`. Hatched band (`--faint`, 135°, 1px/6px, 50% opacity) for 4000–4999. Ticks 3px wide: live listener = 32px tall from top 6px in state colour; declared-only = 16px tall from top 22px in `--reserved`. Landmark labels 9px --faint at bottom: 1024, 3000, 4000, 5000, 5432, 6379, 8000, 9090, 9999. Caption line below (10px --dim).

### Rules (policy rendered)
Grid `repeat(auto-fit,minmax(340px,1fr))`, gap 16px, `padding:16px`. Panels: hairline border, `--panel` bg, 10px uppercase header row. (1) Scheme: formula 13px with P/W/R coloured `--ok`/`--drift`/`--stale`; explanation grid; 5-column role grid (code in `--stale`, name). (2) Pools and reserved (2-col grid) + shared.observability: clickable port buttons (600 port + --dim name) opening the drawer; note text. (3) Projects table (full width): P (`--ok`) · project (600) · block · path · declared · extras.

### Term (terminal mock)
`<pre>` in `--panel`, hairline, `padding:14px 16px`, 12px/1.5. Shows `berth ls` (grouped, from the current filter), `berth who <drawer port or 17101>`, `berth check` summary. Prompt `$ ` in --dim, command 600. Column layout: 2-space indent, labels padded to 9, values at col 12. Only the state word is coloured in a real terminal; honour NO_COLOR.

### Port drawer (`berth who`)
380px aside, hairline left, `--panel` bg, scroll. Sections separated by hairlines, `padding:12px 14px`:
1. Header: port 18/600, state chip (10px uppercase .06em, 1px border, `padding:1px 6px`), × close (--dim, hover --fg).
2. Decoded: `10000 + 1000·P + 100·W + RR` with P `--ok`, W `--drift`, R `--stale`, `+` in `--faint`; then plain-English decode (11px --dim). Non-block ports show `—` and a range explanation.
3. Facts grid `auto 1fr`, gap `5px 14px`, 11px: lease · owner · live holder (coloured state colour when conflict/squatter) · cwd · created · expires · url.
4. How we know: one `›` line per evidence source, 11px --dim.
5. Advisory: state-coloured sentence + command box (`--bg`, hairline; code 11px; `COPY` button, becomes `COPIED` for 1.5s; copies to clipboard). Footer "berth never kills or reassigns. Exit code is always 0." (10px --dim). No command for ok/idle.
6. `who <port> · json`: the `berth who --json` payload, 10px --dim, pre-wrap.

Advisory copy per state (exact):
- stale: "Owner pid is gone. Suggest release; berth never auto-kills." → `berth release --port {p}`
- orphan: "Lease cwd no longer exists. Suggest release; tombstone keeps the worktree ID." → `berth release --port {p}`
- unmanaged: "Bound inside a managed range with no lease and no session marker." → `berth adopt {p} --owner human`
- squatter: "A different session bound a port inside another project's block. Name the holder and the block owner; do not kill." → `berth who {p}`
- conflict: "Lease owner differs from the live holder. Tell the owning session its belief is wrong." → `berth who {p} --json`
- drift: "Config declares a port outside its allocation, or a labelled service vanished. Never reassign." → `berth scan --write`
- ok: "none" · idle: "none — shown dimmed"

## Interactions and behaviour
- Tabs switch views; filters, search and drawer persist across views.
- Search matches port, project, role, holder, cwd, state, short session id, pid (case-insensitive substring).
- State chips multi-select; project select single; `clear` resets all three.
- Poll toggle: on = dot pulses (`@keyframes pulse` 2s ease-in-out, opacity 1→.35), label counts `0s…5s ago` and resets; off = static dot, label `manual`. Refresh resets the counter (real impl: re-fetch `berth check --json`; reconcile is cached 1s server-side).
- Theme toggle flips `body[data-theme]`; default dark. Persist choice in localStorage.
- Row/cell click → drawer for that port; × closes. Selected row gets `--sel`.
- Hover: rows `--sel`; map cells 1px `--fg` outline + tooltip following the cursor; tooltip hides on leave.
- No transitions/animations other than the poll dot.
- Responsive: header and filter bar wrap onto 40px/auto lines below ~1000px; table view scrolls horizontally (min 900px); sessions rail min 260px.

## State
`view` (sessions|table|map|rules|term), `selectedSession`, `query`, `stateFilters: Set`, `projectFilter`, `drawerPort|null`, `tooltip|null`, `polling: bool`, `lastCheckedAgo`, `copied`, `theme`. Data: `check.json` → arrays of leases `{port, project, worktree, role, kind, owner:{session_id,tool,pid,pid_start}, cwd, created, expires, note, state, live:{holder,pid}, evidence:[…]}`, sessions, policy (projects with P, path, declared, extras).

## Assets
None. Font: JetBrains Mono (Google Fonts, or bundle the woff2 for offline use — the dashboard runs on a laptop that may be offline).

## Files
- `Berth Dashboard.dc.html` — prototype
- `Berth Design Pack.dc.html` — design pack

## Screenshots
- `screenshots/01-sessions.png`
- `screenshots/02-table.png`
- `screenshots/03-range-map.png`
- `screenshots/04-rules.png`
- `screenshots/05-terminal.png`
- `screenshots/06-drawer-conflict-17101.png`
- `screenshots/07-light-theme.png`
