# Safety model

berth reads process lists and Docker metadata on your machine and runs at the start of every Claude Code session, so its safety properties matter more than its features. Report vulnerabilities through GitHub's private vulnerability reporting for the repository; see `SECURITY.md`.

## Read-only truth, no sudo

Every observation comes from `lsof`, `netstat`, `docker ps` and `ps` run through `execFile` with argument arrays and timeouts; berth never spawns a shell. From process environments it extracts only `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE`, and retains nothing else.

## Advisory, and a rail for agents

berth never blocks a command and never kills a process on its own. `berth free` exists for humans, signals only processes you own, never containers or VM proxies, and refuses ports held by another live session unless forced. Human-only commands (`free`, any `--force`, `hooks install|uninstall`, `worktrees prune`, `init --force`, `adopt --owner human`) run only for a human at an interactive terminal with no Claude marker in the environment, or with `BERTH_ALLOW_DESTRUCTIVE=1` set deliberately. Refusals and overrides are appended to `~/.local/state/berth/audit.log`. This is protection against accidental misuse by an agent, not a security boundary: a person with a shell can always run the same command.

## No daemon, safe writes

Reads never lock. Each session writes its own claim file; the single ledger lock guards compaction and explicit writes, records the holder's pid and start time, and is broken only when that pid is provably gone, by rename so two waiters cannot both break it. Files are written atomically with a `.bak`, 0600, in a 0700 directory. The policy has its own lock for `project add` and `scan --write`.

## The dashboard

Binds 127.0.0.1 only, serves GET and HEAD, never touches the file system, sends a per-response nonce content-security policy with `frame-ancestors 'none'`, `nosniff` and `no-store`, and refuses cross-site requests to `/api/state`. Exception text is never returned to the browser.

## Supply chain

The package has no runtime dependencies; the TOML parser is inlined at build time. Releases are staged on npm by GitHub Actions through OIDC trusted publishing with a Sigstore provenance attestation, and go live only after a maintainer approves them with 2FA. CI actions are pinned to commit SHAs; CodeQL, OpenSSF Scorecard, Dependency Review and Dependabot run on the repository, and `main` is protected by a ruleset with no bypass.
