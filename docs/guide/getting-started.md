# Getting started

berth runs on macOS and Linux with Node 20 or newer. It has no runtime dependencies, no daemon, and needs no `sudo`: everything it learns comes from `lsof`, `netstat`, `docker ps` and `ps`, read-only.

## Install

::: code-group

```bash [Terminal]
npm install -g @amiable-dev/berth
berth doctor          # lsof, docker, the policy, the Claude Code wiring
```

```bash [Claude Code]
claude plugin marketplace add amiable-dev/berth
claude plugin install berth@berth
```

:::

The plugin carries the CLI, so an agent session needs nothing else: the SessionStart hook puts `berth` on the session's PATH, injects the project's ports, and registers the MCP tools and skills. The global install is for your own terminal.

## Create the policy

The policy is one TOML file, `~/.config/berth/policy.toml`, that states the agreed rules: the scheme, reserved ranges, shared services and one table per project. Start it with:

```bash
berth init
```

It writes a generic policy with no projects. Nothing in it is machine-specific; keep it in your dotfiles.

## Register a repository

From the repository root:

```bash
berth project add .
```

```
registered: my-app  P=1  block 11000–11999  ~/projects/my-app
  declared (found in configs): 3000, 5432
  extras: grafana=10
  next: eval "$(berth env --shell)" · berth env --compose-override · berth launch-json --write · berth check
```

What happened:

- **P=1** is the lowest free project number. It is permanent: berth will never renumber a project, and it refuses `--number` values that are taken.
- **declared** are the ports your repo already hardcodes (Compose files, Vite and Next configs, `.env`, `wrangler.toml`, Procfiles). Recording them makes conflicts visible before you migrate anything; nothing is allocated from them.
- **extras** are Compose services that are not one of the ten canonical roles, given slots 10, 11, … Rename them in the policy if the inferred names are wrong.

The command appends exactly one `[projects.my-app]` table to the policy and touches nothing else. Run it again and it returns the existing entry. It requires a git repository root (`--allow-non-git` for a plain directory). In a Claude Code session, the `berth-onboard` skill does all of this when you ask the agent to "register this repo in berth".

## Use the numbers

```bash
eval "$(berth env --shell)"
echo $PORT $API_PORT $DB_PORT $BERTH_BLOCK     # 11000 11001 11002 11000-11099
vite --port "$PORT" --strictPort
```

Strict mode matters: a taken port must fail loudly, not slide to the next number and leave every record wrong. See [Day to day](./day-to-day) for each framework and for Docker Compose.

## See what is going on

```bash
berth check          # summary, then everything that needs attention with the command that fixes it
berth ls             # Project → Worktree → Role table
berth who 5432       # lease, live holder, evidence, advisory
berth ui             # dashboard on http://127.0.0.1:10000
```

`check` always exits 0. berth informs; it never blocks a command and never kills a process on its own.

## Where things live

| Path | Contents |
|---|---|
| `~/.config/berth/policy.toml` | the rules, hand-edited, versioned with your dotfiles |
| `~/.local/state/berth/leases.json` | the ledger of who holds which port |
| `~/.local/state/berth/claims/` | one file per session with claims not yet folded into the ledger |
| `~/.local/state/berth/sessions/` | one record per Claude session (from the hooks) |
| `~/.local/state/berth/worktrees/` | worktree slot assignments and tombstones |
| `~/.local/state/berth/audit.log` | refused and overridden human-only commands |

Override the locations with `BERTH_POLICY`, `BERTH_CONFIG_DIR` and `BERTH_STATE_DIR`.
