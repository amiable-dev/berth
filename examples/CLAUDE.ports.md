## Ports (berth)

Every project on this machine has a permanent number P in `~/.config/berth/policy.toml`, and its ports are `10000 + 1000·P + 100·W + R` (W = worktree, 0 for the main checkout; R = role: 00 web, 01 api, 02 db, 03 cache, 04 smtp, 05 mail-ui, 06 docs, 07 worker, 08 otlp-grpc, 09 otlp-http, 10–99 project-named extras). Reading a port is decoding it: 13204 is project 3, worktree 2, smtp.

- At session start berth injects this project's block and exports `PORT`, `API_PORT`, `DB_PORT` and the other role ports. If they are missing, run `berth env --shell` (or `berth env --dotenv`, `berth env --compose-override`).
- Pass the port explicitly (`--port $PORT`, `-p $PORT`) and use strict mode (`vite --strictPort`). Never let a framework pick a port. If the port is taken, stop and report; do not increment.
- Before binding anything outside your exports, ask who holds it: `berth who <port>`. New service: `berth claim --role <role>` or `berth claim --extra <name>`. Scratch server: `berth claim --dynamic 1` (40000–41999, 8 h TTL). Release what you no longer need: `berth release --port <port>`.
- Do not kill a listener you do not own. `berth free <port>` refuses other sessions' ports; report and ask instead.
- Grafana 3000, Langfuse 3001, Tempo 3200, OTLP 4317/4318 and Prometheus 9090 are one shared stack owned by skills-telemetry. Do not start another; point at it (`BERTH_SHARED_*` exports).
- 5000 and 7000 belong to macOS (AirPlay). 4000–4999 belongs to portless.
- Tell the human the exact URL you bound. `berth check` shows what needs attention; it never blocks or kills.
