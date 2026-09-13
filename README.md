# port-visualiser

Research and design for coordinating local dev ports across many concurrent AI-agent sessions on one Mac: who may use which port, who actually holds it, and a view for the human of what is running where and which rules were agreed.

- [docs/RESEARCH.md](docs/RESEARCH.md): the verified OSS landscape (allocators, proxies, orchestrators, visualizers, Claude Code platform facts) and the measured state of this machine.
- [docs/DESIGN.md](docs/DESIGN.md): the council-reviewed design. Advisory registry, decodable port scheme, lock-free claims, reconciler with Docker/Colima and session attribution, CLI, Claude Code hooks, dashboard, rollout.
- [examples/policy.example.toml](examples/policy.example.toml): the policy for this machine (installed at `~/.config/berth/policy.toml`).
- [examples/CLAUDE.ports.md](examples/CLAUDE.ports.md): the phase-0 Ports rules installed in `~/.claude/CLAUDE.md`.

Status: design accepted, decisions closed and phase 0 applied on 2026-09-13 (policy installed, global rules written, lsoff and portless installed). The tool is `berth`; this directory is its repository and will be published as amiable-dev/berth.
