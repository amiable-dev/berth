# Day to day

## Get this checkout's ports

```bash
eval "$(berth env --shell)"
```

Exports `PORT` (the web role), one `<ROLE>_PORT` per canonical role and extra, `BERTH_PROJECT`, `BERTH_P`, `BERTH_W`, `BERTH_BLOCK`, and `BERTH_SHARED_<STACK>_<SERVICE>` for shared services. `berth env --dotenv` prints `KEY=value` lines for an `.env` file; `berth env --json` returns the same as data. In a Claude Code session all of this is already in the environment.

## Start a server on the right port

The rule that makes an advisory registry work: pass the port explicitly and make the framework fail loudly when it is taken.

::: code-group

```bash [Vite]
vite --port "$PORT" --strictPort
# or in vite.config.ts: server: { port: Number(process.env.PORT), strictPort: true }
```

```bash [Next.js]
next dev -p "$PORT"
```

```bash [FastAPI / uvicorn]
uvicorn app:main --port "$API_PORT"
```

```bash [Node http]
# read process.env.PORT; never fall back to a hardcoded number
node server.js
```

```bash [Rails / Puma]
bin/rails server -p "$PORT"
```

:::

Then record the claim so other sessions and the dashboard see it:

```bash
berth claim --role api            # or web, db, cache, smtp, mail-ui, docs, worker, otlp-grpc, otlp-http
berth claim --extra grafana       # a slot from 10–99, named in the policy or assigned on the spot
```

## Docker Compose without editing the repo

A Compose file that hardcodes host ports gets an override file:

```bash
eval "$(berth env --compose-override)"
docker compose up
```

`berth env --compose-override` reads the project's Compose services (through `docker compose config` when available, a parser otherwise), maps each published port to a role or an extras slot, writes an override file with the `!override` tag under `~/.local/state/berth/overrides/`, and prints the `COMPOSE_FILE` export that makes Compose apply it. The repo is untouched. For repositories you own, `${DB_PORT:-5432}` substitution in the Compose file is the better long-term shape; both work.

## Who has that port?

```bash
berth who 5432
```

```
5432  ok  (declared)
  decode   — (outside the block range)
  live     deploy-postgres-1 · ~/projects/skills-telemetry/deploy
  how we know
    › docker: container deploy-postgres-1, compose deploy, working_dir ~/projects/skills-telemetry/deploy
    › lsof: published through ssh pid 503 (Colima)
    › policy: declared by skills-telemetry, breach-resolve
  advisory none
```

The evidence lines are the reconciler's working: which source saw what, and how the holder was attributed.

## "Address already in use"

Do not increment the port and do not kill anything. `berth who <port>` names the holder and prints the one advisory command for its state. If the port is legitimately someone else's, use a different role port or a scratch port; if it is yours from a previous run, release it.

## Scratch ports

```bash
berth claim --dynamic 1          # 40012, from the dynamic pool, with an 8 h lease
berth release --port 40012       # give it back
```

## Is anything wrong?

```bash
berth check
```

```
33 ports · 1 need attention · 2 live sessions
  ok 19 · idle 13 · unmanaged 1

  3002  unmanaged  36-inch-platform      node pid 57886                  berth adopt 3002 --owner human
```

`berth check --json` is the full report the dashboard uses. `berth ls` is the grouped table; `--project X` narrows it, `--all` includes idle declared ports.

## Adopt a server you started by hand

```bash
berth adopt 3002 --owner human
```

Registers an unmanaged listener as a lease so it stops needing attention. `--owner session` is the agent-side form.

## Keep the policy honest

```bash
berth scan                # ports found in configs vs what the policy declares
berth scan --write        # add the missing ones to each project's declared list
```

## Worktrees and names

```bash
berth worktrees list                          # slots per project, with tombstones
berth names sync                              # portless aliases for http leases, e.g. chancery.localhost
berth launch-json --write                     # .claude/launch.json for the desktop preview pane
```
