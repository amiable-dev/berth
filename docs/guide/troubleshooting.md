# Troubleshooting

Start with `berth doctor`: it checks Node, the policy, the state directory, `lsof`, `netstat`, `ps -E`, Docker, Colima, portless, and whether the Claude Code plugin or the manual hooks are installed.

## "This directory is not a project"

`berth env` only knows directories under a registered project path (or a git worktree of one). Register the repository: `berth project add .` from its root, or ask the agent to "register this repo in berth".

## I used to see "... is not inside any project in policy.toml" on every new shell

That was `berth env --shell` outside a registered project: it exited 1 with the message on stderr, which is what you saw on every terminal that opened at `$HOME` or any other unregistered directory. `berth env --shell` is quiet there now — exit 0, only the machine-wide `BERTH_SHARED_*` exports plus a comment naming the fix, nothing on stderr — and `berth shell-init zsh|bash|fish` gives you a cd-aware hook so the exports actually update as you move around, instead of being fixed at shell startup. Pass `--strict` to get the old loud failure back for a one-off check. If you still see the message, you are passing `--dotenv`, `--compose-override` or `--json`, which are explicit requests and keep failing loudly by design — or an explicit `--project <name>` names a project that does not exist.

## Every Docker port shows the same project

Colima and Docker Desktop publish container ports through one proxy process; without container metadata every port would be attributed to whichever repository ran `colima start`. berth reads `docker ps` compose labels to attribute containers to their repositories. Containers started with plain `docker run` have no such label: they are reported by container name, and a lease (`berth adopt` or `berth claim` before starting them) settles ownership. If `docker` is not reachable, `check` says so and attributes by process only.

## A port shows `conflict` but it is mine

`conflict` means the live holder could not be matched to the lease's owner. That happens when the server was started with a scrubbed environment (no `CLAUDE_CODE_SESSION_ID`) from a different working directory than the lease. `berth who <port>` shows the evidence; `berth release --port <port>` then `berth claim` from the right session and directory clears it.

## Noise from IDE helpers

VS Code, Cursor and macOS daemons bind random loopback ports that can land inside a project's block. They are on the policy's `ignore_processes` list and hidden unless they collide with a lease. Add names there for other tools; `berth check` reports how many listeners it left out.

## The hook did not run, or context is missing

- Run `berth doctor`. It reports the plugin version or the manual hooks, and warns if both are present.
- Hooks run with the app's environment, which may not include version-manager shims. The plugin's launcher finds Node in the common locations (Homebrew, mise, volta, fnm, asdf, nvm); the manual install uses the absolute interpreter path. If Node truly cannot be found, the hook exits 0 with a one-line diagnostic on stderr rather than failing the session.
- Hooks are read-only. If the session started in a new git worktree, the context says the worktree has no slot yet; `berth env --shell` assigns one.

## `berth free` or `--force` is refused

Those are human-only commands. From an agent session, or any non-interactive shell, they are refused and logged. Run them from your own terminal, or set `BERTH_ALLOW_DESTRUCTIVE=1` deliberately for that one invocation.

## Two sessions claimed the same port

Claims fold into the ledger with the earlier creation time winning; the later `berth claim` exits 1 and names the holder. Dynamic claims retry other ports automatically. `~/.local/state/berth/compact.log` records every dropped claim.

## The policy was renumbered

Never change a project's `P` once ports have been claimed. If it happens, leases in the old block show as `drift` with the new owner named; release them and claim again.

## Where are the logs?

- `~/.local/state/berth/audit.log`: refused and overridden human-only commands.
- `~/.local/state/berth/compact.log`: claims dropped during compaction.
- `~/.local/state/berth/truth.cache.json`: the last full snapshot the reconciler used.
