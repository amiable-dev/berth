---
name: berth-onboard
description: Use when asked to add, register or set up this repository (or another path) in berth, when `berth env` reports the directory is not a project, or when a new project needs its ports, launch config or Compose override. Registers the repo with the next free project number and its existing ports, then wires the checkout.
---

# berth: register this repository

Goal: this checkout gets a permanent project number, its hardcoded ports are recorded, and the tools that start servers here use berth's numbers. Everything below is additive; nothing renumbers or edits other projects.

`berth` is on this session's PATH when the berth plugin is installed (the SessionStart hook adds the plugin's `bin/`); the same operations are also available as MCP tools (`berth_env`, `berth_check`, `berth_who`, `berth_ls`, `berth_claim`, `berth_release`). If neither works, the plugin is not installed: tell the human to run `claude plugin marketplace add amiable-dev/berth` and `claude plugin install berth@berth`.

## Steps

1. **Check the machine.** `berth doctor --json`. If the `policy` check fails because the file is missing, create the starting policy: `berth init`. (If a policy exists, never re-run `init`; replacing a policy is a human decision.)
2. **Register the repo.** From the repository root:
   ```bash
   berth project add . --json
   ```
   The path must be a git repository root (pass `--allow-non-git` for a plain directory). This assigns the lowest free `P`, records the ports found in Compose, Vite, Next, `.env` and similar files as `declared`, and names `extras` slots (10–99) for Compose services that are not one of the ten canonical roles. It is idempotent: running it again returns the existing entry. Show the human the result: the block range, the declared ports, and the extras names. If an extras name is wrong for them, they edit the `[projects.<name>]` table by hand; do not edit the policy file yourself.
3. **Give the checkout its numbers.**
   - Shell: `eval "$(berth env --shell)"`; for a `.env`-driven app, `berth env --dotenv >> .env.local` (or wherever the project reads its env), never overwriting an existing file without asking.
   - Docker Compose with hardcoded host ports: `eval "$(berth env --compose-override)"` and show the human the mapping it printed (service → new host port).
   - Claude Code desktop preview pane: `berth launch-json --write` creates or updates `.claude/launch.json` entries named `<project> web (berth W0)` and similar, keeping any entries that are not berth's. The file is excluded from git automatically (`.git/info/exclude`, never `.gitignore`) unless it is already tracked or ignored, so it is never committed by accident.
4. **Point the code at the numbers, with the human's approval.** Where a config hardcodes a port, prefer reading the environment (`PORT`, `API_PORT`, `DB_PORT`, …) and turn on strict mode (`vite --strictPort`, `server.strictPort: true`). Propose the diff; apply it only when asked. Do not rewrite Compose files: the override covers them.
5. **Verify.** `berth check` should show the project's ports as `ok` or `idle` and nothing under attention for this block. `berth ls --project <name>` shows the table. If the dashboard is running, `http://127.0.0.1:10000/?view=map` shows the new row.
6. **Report** the project number, the block, the ports by role, and any legacy ports still hardcoded, in one short message.

## Worktrees

A git worktree of a registered repo gets its own hundred-port slice the first time `berth env` or `berth claim` runs inside it (W1–W9). Nothing to register.

## Never

- Never change an existing project's `P`, never edit another project's table, never replace an existing policy, never kill a process or override an ownership refusal, never install or remove hooks. The CLI refuses those commands in an agent session; ask the human instead.
