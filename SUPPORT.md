# Getting Help with berth

Need help? Here are your options:

## Documentation

Start with the documentation:

- **[README](README.md)** - Installation, setup, and usage
- **[docs/DESIGN.md](docs/DESIGN.md)** - The council-reviewed design: port scheme, ledger, reconciler, CLI, hooks, dashboard, rollout, risks
- **[docs/RESEARCH.md](docs/RESEARCH.md)** - The OSS landscape and why berth exists
- **[Architecture Decision Records](docs/adr/)** - Design decisions and rationale
- **[examples/](examples/)** - A policy file drafted from a real machine and the Ports rules for `~/.claude/CLAUDE.md`

## First Things to Try

- `berth --help` and `berth <command> --help`.
- `berth check` reconciles the ledger against what is actually listening and prints one of eight states per port, each with a suggestion. It always exits 0.
- `berth who <port>` shows the lease, the live holder, and how berth knows.
- **A Docker port is attributed to the wrong project?** Containers started with `docker run` carry no compose labels and are attributed by container name only; compose-launched containers are attributed by their `working_dir` label. See `docs/DESIGN.md` §5.4 and §5.11.
- **The SessionStart hook does nothing?** Hook environments do not see nvm or mise shims. The hook command must use an absolute interpreter path (`/opt/homebrew/bin/node …`).
- **Ports 5000 or 7000 show as taken?** That is macOS AirPlay (ControlCenter); they are reserved in the default policy.

## Community Support

### GitHub Discussions

For questions, ideas, and community conversation:

- **[Q&A](https://github.com/amiable-dev/berth/discussions/categories/q-a)** - Ask questions and get help
- **[Ideas](https://github.com/amiable-dev/berth/discussions/categories/ideas)** - Suggest new features
- **[Show and Tell](https://github.com/amiable-dev/berth/discussions/categories/show-and-tell)** - Share your policy files and integrations

## Bug Reports and Feature Requests

### Found a Bug?

1. Search [existing issues](https://github.com/amiable-dev/berth/issues) first
2. If not found, [create a new issue](https://github.com/amiable-dev/berth/issues/new?template=bug_report.md)
3. Include:
   - Version (`berth --version`)
   - Node version and OS
   - Docker runtime, if any (Colima, Docker Desktop, OrbStack)
   - Steps to reproduce
   - Expected vs actual behavior
   - `berth check --json` output, with working directories and session IDs redacted

### Want a Feature?

1. Check [existing feature requests](https://github.com/amiable-dev/berth/issues?q=label%3Aenhancement)
2. Open a [feature request](https://github.com/amiable-dev/berth/issues/new?template=feature_request.md)
3. Describe the use case and expected behavior. If the request changes a recorded decision (for example, berth is advisory and never blocks or kills automatically), say which one and why.

## Security Issues

**Do not open public issues for security vulnerabilities.**

See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## Contributing

Want to contribute? See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development setup
- Coding standards
- Pull request process

## Response Times

| Channel | Expected Response |
|---------|------------------|
| GitHub Discussions | 1-3 days |
| GitHub Issues (bugs) | 1-7 days |
| Security Reports | 48 hours |

*Note: This is an open-source project maintained by volunteers. Response times may vary.*
