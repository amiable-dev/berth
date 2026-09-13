## Summary

Brief description of the changes in this PR.

## Related Issues

- Closes #XXX (if applicable)
- Related to #XXX

## Changes Made

- Change 1
- Change 2
- Change 3

## Test Plan

Describe how you tested these changes:

- [ ] Unit tests added/updated (`npm test`)
- [ ] Ran `node dist/berth.js check` against a real machine (say which OS and Docker runtime)
- [ ] Manual testing of the dashboard (if `berth ui` changed)

## Checklist

- [ ] `npm run check` passes locally (lint, typecheck, test, build)
- [ ] No new runtime dependencies: `package.json` still has no `dependencies` block ([ADR-005](../docs/adr/ADR-005-node20-single-bundle-zero-runtime-deps.md))
- [ ] Hooks and `berth check` still exit 0 on every path this touches ([ADR-001](../docs/adr/ADR-001-advisory-registry-not-enforcement.md))
- [ ] `--json` output is backward compatible, or the change is called out below
- [ ] Documentation updated (README, ADRs). `docs/DESIGN.md` is the historical record of the accepted design; record changes as ADRs rather than editing it
- [ ] CHANGELOG.md updated under `[Unreleased]` (for user-facing changes)
- [ ] ADR added or superseded if this changes a recorded decision
- [ ] Commit messages follow conventional commit format

## Screenshots (if applicable)

Add screenshots for dashboard changes.

## Additional Notes

Any additional context or notes for reviewers.
