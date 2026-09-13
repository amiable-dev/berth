# port-visualiser

Research and design for coordinating local dev ports across many concurrent AI-agent sessions on one Mac: who may use which port, who actually holds it, and a view for the human of what is running where and which rules were agreed.

- [docs/RESEARCH.md](docs/RESEARCH.md): the verified OSS landscape (allocators, proxies, orchestrators, visualizers, Claude Code platform facts) and the measured state of this machine.
- [docs/DESIGN.md](docs/DESIGN.md): the council-reviewed design. Advisory registry, decodable port scheme, lock-free claims, reconciler with Docker/Colima and session attribution, CLI, Claude Code hooks, dashboard, rollout.
- [examples/policy.example.toml](examples/policy.example.toml): a starter policy drafted from the repos under `~/projects`.

Status: design accepted and all five open decisions closed, 2026-09-13. The tool is `berth`; this directory is its repository and will be published as amiable-dev/berth.
