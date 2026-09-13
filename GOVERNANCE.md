# berth Governance

This document describes the governance structure and decision-making process for the berth project.

## Project Structure

### Roles

#### Maintainers

Maintainers have full commit access and are responsible for:

- Reviewing and merging pull requests
- Triaging issues
- Making architectural decisions and accepting ADRs
- Releasing new versions to npm
- Enforcing the code of conduct

The current maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md). Today that is one person, @amiable-dev, who is also the project lead.

#### Contributors

Anyone who contributes to the project through:

- Code contributions (pull requests)
- Documentation improvements
- Bug reports and feature requests
- Policy files, hook recipes and integrations shared in Discussions
- Helping others in discussions
- Reviewing pull requests

All contributors are listed in the commit history and release notes.

To become a maintainer:
- Demonstrate sustained, quality contributions
- Be nominated by a maintainer
- Receive approval from existing maintainers

New maintainers are recorded in [MAINTAINERS.md](MAINTAINERS.md).

## Decision Making

### Architecture Decision Records (ADRs)

Significant technical decisions are documented as ADRs in `docs/adr/`. We follow the Michael Nygard format, using the [template](docs/adr/ADR-000-template.md).

The initial design, [docs/DESIGN.md](docs/DESIGN.md), was reviewed in two rounds by an LLM council (its §6) before being accepted on 2026-09-13, and the five ADRs that record it are marked council-reviewed. Council review is an input to a decision, never the decision itself: a human maintainer accepts every ADR.

**Summary of Process:**

1. **Draft**: Create an ADR from the template, numbered sequentially.
2. **Propose**: Open a PR for discussion (Status: Proposed).
3. **Decide**: Maintainers review and merge (Status: Accepted).
4. **Change**: Supersede with a new ADR; never silently edit an accepted decision.

An ADR is required for any change that alters a decision in `docs/DESIGN.md` §3 or §7 or in an existing ADR; changes the port formula, ledger or claim formats, lock protocol or policy schema; adds or removes a truth source; breaks a `--json` shape or the hook contract; or adds a runtime dependency. See [CONTRIBUTING.md](CONTRIBUTING.md#architecture-decision-records).

### Consensus-Based Decisions

For most decisions, we seek consensus:

1. Proposals are made via GitHub Issues or Discussions
2. Community feedback is gathered
3. Maintainers synthesize feedback
4. Decision is documented (ADR for technical, issue for operational)

### Voting

For contentious decisions without clear consensus, once there is more than one maintainer:

- Maintainers vote after a reasonable discussion period (minimum 7 days)
- Simple majority required
- Ties broken by the project lead

## Contributions

### Pull Request Process

1. **Open Issue First**: For significant changes, discuss in an issue first
2. **Fork and Branch**: Create a feature branch from `main`
3. **Develop**: Follow the coding standards in [CONTRIBUTING.md](CONTRIBUTING.md)
4. **Test**: `npm run check` must pass; add tests as needed
5. **Submit PR**: Reference related issues
6. **Review**: Address feedback from reviewers
7. **Merge**: A maintainer merges after approval and green CI

### Review Requirements

| Change Type | Required Reviewers |
|-------------|-------------------|
| Bug fixes | 1 maintainer |
| New features | 1 maintainer |
| Breaking changes | 1 maintainer plus an accepted ADR |
| Security fixes | 1 maintainer (expedited) |

### Breaking Changes

berth is pre-1.0. Under Semantic Versioning, a **minor** release may therefore contain breaking changes to the `--json` output shapes, the policy file schema, the ledger and claim file formats, or the hook contract. Each such change requires:

- An ADR documenting the change
- A migration note in `CHANGELOG.md`, and, for ledger format changes, either an automatic migration or a documented `berth compact` step
- A minimum 14-day discussion period, unless it is a security fix

Once 1.0 is released, breaking changes require a major version.

## Releases

### Versioning

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible; pre-1.0, see above)
- **PATCH**: Bug fixes (backward compatible)

### Release Process

1. Update `CHANGELOG.md`: move `[Unreleased]` into a versioned section
2. Update the version in `package.json` (`npm version x.y.z --no-git-tag-version`)
3. Create a release PR and merge it to `main`
4. Tag the merge commit `vx.y.z` and push the tag
5. CI publishes `@amiable-dev/berth` to npm with provenance via trusted publishing and creates the GitHub Release from the CHANGELOG section

## Code of Conduct

All participants must follow our [Code of Conduct](CODE_OF_CONDUCT.md). Violations can be reported to chris@amiable.dev.

## Amendments

This governance document can be amended by:

1. Opening a PR with proposed changes
2. 14-day discussion period
3. Approval by majority of maintainers
4. Changes take effect upon merge

## Contact

- **General**: Open a GitHub Discussion
- **Security**: chris@amiable.dev (see [SECURITY.md](SECURITY.md))
- **Conduct**: chris@amiable.dev
