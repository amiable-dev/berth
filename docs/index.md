---
layout: home
hero:
  name: berth
  text: Ports your agents and your terminal agree on
  tagline: Every project gets a permanent, decodable block of ports. A ledger records who holds what, a reconciler checks it against what is really listening, and every Claude Code session is told its ports before it binds anything. Advisory by design; it never kills.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: Claude Code and agents
      link: /guide/claude-code
    - theme: alt
      text: GitHub
      link: https://github.com/amiable-dev/berth
features:
  - title: The number is the rule
    details: "port = 10000 + 1000·P + 100·W + R. Reading a port is decoding it: 13204 is project 3, worktree 2, smtp. No allocation table to remember."
  - title: Truth, not guesses
    details: lsof, netstat, Docker compose labels and the Claude session marker in a process's environment attribute every listener, including containers behind Colima or Docker Desktop.
  - title: Built for agent sessions
    details: A Claude Code plugin injects each session's ports at start, puts berth on its PATH, exposes MCP tools and ships skills. Commands with teeth are fenced off from agents.
  - title: A map you can read
    details: One row per project, live legacy ports as numbered cells, eight states with an advisory each, and a drawer that shows the evidence for any port.
---

<div class="vp-doc" style="max-width: 1152px; margin: 32px auto 0; padding: 0 24px;">

<img class="dark-only" src="./images/port-rule-dark.png" alt="Port 13204 decoded: base 10000, P=3 breach-resolve, W=2 second worktree, R=04 smtp">
<img class="light-only" src="./images/port-rule-light.png" alt="Port 13204 decoded: base 10000, P=3 breach-resolve, W=2 second worktree, R=04 smtp">

## Sixty seconds

```bash
npm install -g @amiable-dev/berth
berth init                                   # a starting policy in ~/.config/berth/policy.toml
cd ~/projects/my-app && berth project add .  # permanent project number, ports found in your configs
eval "$(berth env --shell)"                  # PORT, API_PORT, DB_PORT … for this checkout
berth check                                  # what is listening, who holds it, what needs attention
```

With Claude Code, install the plugin instead and let the agent register its own repository:

```bash
claude plugin marketplace add amiable-dev/berth
claude plugin install berth@berth
```

<img class="dark-only" src="./images/dashboard-map-dark.png" alt="berth ui map view">
<img class="light-only" src="./images/dashboard-map-light.png" alt="berth ui map view">

</div>
