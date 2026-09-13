## Ports (berth, phase 0)

Port allocation for every project on this machine is defined in `~/.config/berth/policy.toml`.

- Each project has a permanent number P. Its ports are `10000 + 1000·P + 100·W + R`. W is the worktree (0 = main checkout, 1–9 = additional worktrees). R is the role: 00 web, 01 api, 02 db, 03 cache, 04 smtp, 05 mail-ui, 06 docs, 07 worker, 08 otlp-grpc, 09 otlp-http, 10–99 project-named extras. Example: breach-resolve is P=3, so its main api is 13001 and its second worktree's web is 13200.
- Before starting any server, find this project's P in the policy file (`grep -A3 'projects\.<name>' ~/.config/berth/policy.toml`) and compute the port. Use 40000–41999 for throwaway servers.
- Pass the port explicitly (`--port $PORT`, `-p $PORT`) and use strict mode (`vite --strictPort`, `next dev -p`). Never let a framework pick a port. If the port is taken, stop and report; do not increment.
- Check who holds a port before binding it: `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Docker ports appear under `ssh` (Colima); run `docker ps` to see the container. `lsoff` shows the same with project attribution.
- Do not kill a listener you do not own. Report it and ask.
- Grafana 3000, Langfuse 3001, Tempo 3200, OTLP 4317/4318 and Prometheus 9090 are one shared stack owned by skills-telemetry. Do not start another; point at it.
- 5000 and 7000 belong to macOS (AirPlay). 4000–4999 belongs to portless.
- Tell the human the exact URL you bound.
- `berth env`, `berth claim` and `berth who` arrive in phase 1. Until then the policy file and lsof are the source of truth.
