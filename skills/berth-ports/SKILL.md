---
name: berth-ports
description: Use before starting any dev server, database or Compose stack, when a port is "already in use", when asked which port a service is on, or when a server must be reachable at a predictable URL. Gives this checkout its berth ports, checks who holds a port, and records claims. Never kills processes.
---

# berth: ports for this checkout

berth gives every project a permanent block of ports and records who holds what. It is advisory: it tells you the truth and never blocks or kills. Your job is to use the ports it assigns and to report what you actually bound.

`berth` is on this session's PATH when the plugin is installed; the MCP tools `berth_env`, `berth_who`, `berth_check`, `berth_ls`, `berth_claim` and `berth_release` do the same jobs if you prefer tools to a shell.

## Before you bind anything

1. If the session started with a "## Ports (berth)" section, the numbers are already in the environment: `PORT`, `WEB_PORT`, `API_PORT`, `DB_PORT`, `CACHE_PORT`, `SMTP_PORT`, `MAIL_UI_PORT`, `DOCS_PORT`, `WORKER_PORT`, `OTLP_GRPC_PORT`, `OTLP_HTTP_PORT`, plus `BERTH_BLOCK`. Otherwise run:
   ```bash
   eval "$(berth env --shell)"
   ```
   If that says the directory is not a project, use the `berth-onboard` skill (registers the repo) or take a scratch port: `berth claim --dynamic 1`.
2. Pass the port explicitly and make the framework fail loudly instead of sliding to the next number:
   - Vite: `vite --port "$PORT" --strictPort` (or `server: { port: Number(process.env.PORT), strictPort: true }`)
   - Next: `next dev -p "$PORT"`
   - uvicorn / FastAPI: `uvicorn app:main --port "$API_PORT"`
   - Node http servers: read `process.env.PORT`; never fall back to a hardcoded number
   - Docker Compose with hardcoded host ports: `eval "$(berth env --compose-override)"` then `docker compose up`; it writes an `!override` file and sets `COMPOSE_FILE`, no repo edits
3. Record the claim so other sessions and the dashboard see it: `berth claim --role api` (or `web`, `db`, `cache`, `smtp`, `mail-ui`, `docs`, `worker`, or `--extra <name>` for a service with no canonical role).
4. Tell the human the exact URL you bound, for example `http://localhost:14001`.

## "Address already in use"

Do not increment the port and do not kill anything. Ask berth:

```bash
berth who <port>
```

It prints the lease, the live holder (process, container or session), the evidence, and one advisory command. The states:

| State | Meaning | What to do |
|---|---|---|
| `ok` | expected owner is bound | use a different role port; this one is taken legitimately |
| `idle` / `stale` | leased, nothing bound | `berth release --port N` only if the lease is yours; otherwise report it |
| `orphan` | lease cwd is gone | report it; a human releases it |
| `unmanaged` | bound, no lease, in a managed range | if you started it, `berth adopt N --owner session`; otherwise report |
| `squatter` / `conflict` | someone else is in this block | report the holder; do not kill |
| `drift` | config and allocation disagree | report; `berth scan --write` is the human's fix |

`berth check` lists everything that needs attention; it always exits 0.

## Releasing

When a scratch server is done: `berth release --port <port>`. Ports claimed by role stay leased for the checkout; releasing them is optional.

## Never

- Never kill or signal a process that holds a port, never override an ownership refusal, never edit `~/.claude/settings.json` or an existing project number in the policy. Those are human decisions; the CLI refuses the corresponding commands inside an agent session, and the right move is to report and ask.
- Never let a framework choose a port; never guess a port from memory when `berth env` can tell you.
