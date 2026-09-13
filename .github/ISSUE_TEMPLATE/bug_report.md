---
name: Bug Report
about: Report a bug or unexpected behavior
title: '[BUG] '
labels: bug, needs-triage
assignees: ''
---

## Description

A clear and concise description of the bug.

## Steps to Reproduce

1. Policy: '...' (the relevant lines of `~/.config/berth/policy.toml`, or "default")
2. Run '...'
3. See error / wrong state

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened.

## Environment

- **OS**: [e.g., macOS 15.6, Ubuntu 24.04]
- **Node version**: [`node --version`]
- **berth version**: [`berth --version`]
- **Installation method**: [npm -g, npx, source (`node dist/berth.js`)]
- **Docker runtime**: [Colima x.y, Docker Desktop, OrbStack, none]
- **Agent**: [Claude Code x.y via hooks, other, none]

## Output

`berth check --json` and `berth who <port> --json` are the most useful. **Redact before posting**: working directories, session IDs and process command lines can identify you and your projects.

```
Paste any relevant output or error messages here
```

## Additional Context

Add any other context about the problem here.

## Checklist

- [ ] I have searched existing issues for duplicates
- [ ] I have included the version information above
- [ ] I have redacted paths and session IDs from the output
- [ ] I can reproduce this issue consistently
