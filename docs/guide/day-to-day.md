# Day to day

## Get this checkout's ports

```bash
eval "$(berth shell-init zsh)"     # once, in ~/.zshrc (or bash, fish)
```

Installs a directory-change hook that runs `berth env --shell` whenever the project root under your cwd changes, and unsets everything again when you leave it — `cd` between two directories of the same project costs nothing, since no `berth` process runs unless the root actually changed. A one-off shell still works with the plain command it wraps:

```bash
eval "$(berth env --shell)"
```

Exports `PORT` (the web role), one `<ROLE>_PORT` per canonical role and extra, `BERTH_PROJECT`, `BERTH_P`, `BERTH_W`, `BERTH_BLOCK`, and `BERTH_SHARED_<STACK>_<SERVICE>` for shared services. Outside a registered project it quietly exports only the `BERTH_SHARED_*` variables and prints a comment naming the fix, rather than failing (`--strict` restores the old exit-1 behaviour); `--unset` prints `unset` lines for the same variable names instead. `berth env --dotenv` prints `KEY=value` lines for an `.env` file; `berth env --json` returns the same as data. In a Claude Code session all of this is already in the environment.

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
docker compose up   # or docker-compose up — berth doctor names the one this machine has
```

`berth env --compose-override` reads the project's Compose services (through `docker compose config` when available, a parser otherwise), maps each published port to a role or an extras slot, writes an override file with the `!override` tag under `~/.local/state/berth/overrides/`, and prints the `COMPOSE_FILE` export that makes Compose apply it, along with a `# then: …` line naming the Compose command it detected. The repo is untouched. For repositories you own, `${DB_PORT:-5432}` substitution in the Compose file is the better long-term shape; both work.

### Containers started by hand

The override only moves containers Compose itself manages. If a service's currently-declared port is already held by a container `docker ps` shows with no `com.docker.compose.*` labels — started by a bare `docker run` — the override cannot touch it: `docker compose up` would bring up a second, empty container on the new port while the real one, and its data, sit untouched on the old one. `berth env --compose-override` detects this and prints a warning per service, on stderr and as a `warnings` array with `--json`, naming the recreate command:

```
penguin-platform-db (5433) was started with docker run; the override will not apply. Recreate it on 12002: docker stop penguin-platform-db && docker rm penguin-platform-db && docker run -d --name penguin-platform-db -p 12002:5432 -v a1b2…:/var/lib/postgresql/data postgres:16
  caution: volume a1b2… is anonymous; recreating loses it unless you keep this exact name
```

Review the command before running it: it carries over the volumes `docker inspect` reports, but not flags berth cannot see (networks, extra env). A caution line calls out an anonymous volume or an image that keeps state only in memory unless configured (mailpit without `MP_DATABASE`). `berth who <port>` shows the same `started by: docker run` line and the volume names under "how we know" for any container holder, Compose-managed or not.

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
