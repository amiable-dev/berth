# Policy file

`~/.config/berth/policy.toml` is the human-readable statement of the agreed rules. `berth init` writes it; `berth project add` and `berth scan --write` append or edit single lines and never rewrite it, so comments and ordering are yours. Writers serialise on `policy.toml.lock`.

```toml
[scheme]
base = 10000              # port = base + 1000·P + 100·W + R
project_max = 29          # P 0–29 → blocks 10000–39999
worktree_max = 9          # W 0–9; 0 is the main checkout
roles = { web = 0, api = 1, db = 2, cache = 3, smtp = 4, mail-ui = 5, docs = 6, worker = 7, otlp-grpc = 8, otlp-http = 9 }

[pools]
dynamic = "40000-41999"   # berth claim --dynamic N
ttl_hours = 8

[reserved]
ranges = ["0-1023", "4000-4999", "49152-65535"]    # privileged, portless, macOS ephemeral
ports  = [5000, 7000]                               # macOS AirPlay
lint   = [11211, 11434, 15672, 16686, 19999, 27017] # well-known defaults inside the block range
ignore_processes = ["Code Helper (Plugin)", "rapportd", "tailscaled"]

[names]
provider = "portless"     # or "none"

[shared.observability]
owner = "skills-telemetry"
ports = { grafana = 3000, prometheus = 9090, otlp-grpc = 4317, otlp-http = 4318 }
note  = "One stack for every project."

[projects.my-app]
P = 1
path = "~/projects/my-app"
declared = [3000, 5432]
extras = { grafana = 10, search = 11 }
note = "optional"
```

## `[scheme]`

| Key | Default | Meaning |
|---|---|---|
| `base` | 10000 | first port of block 0; 1024–60000 |
| `project_max` | 29 | highest project number; the top block must stay below 65536 |
| `worktree_max` | 9 | highest worktree number |
| `roles` | the ten canonical roles | name → slot 0–9, distinct |

## `[pools]`

| Key | Default | Meaning |
|---|---|---|
| `dynamic` | `"40000-41999"` | range for `--dynamic` claims; must not overlap the blocks |
| `ttl_hours` | 8 | lease lifetime for dynamic ports; liveness overrides it |

## `[reserved]`

| Key | Meaning |
|---|---|
| `ranges` | never allocated; defaults cover privileged ports and the macOS ephemeral range |
| `ports` | individual reserved ports; a listener there is reported `ok`, not `unmanaged` |
| `lint` | well-known defaults inside the block range; never given to a canonical role, flagged if an extra lands on one |
| `ignore_processes` | process names whose listeners are hidden unless they collide with a lease, declared or shared port |

## `[shared.<name>]`

`owner` must be a registered project. `ports` maps service names to ports. A bound shared port is `ok` whoever connects; an unbound one is `idle`, or `drift` when its siblings are up.

## `[projects.<name>]`

| Key | Meaning |
|---|---|
| `P` | permanent project number, unique, 0–`project_max` |
| `path` | repository root; `~` is expanded |
| `declared` | legacy hardcoded ports, recorded for visibility; they take part in collision checks |
| `extras` | name → slot 10–99 for services beyond the canonical roles; names must not collide with roles |
| `note` | free text |

Project names match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Changing a project's `P` after ports were claimed turns its leases into `drift`.
