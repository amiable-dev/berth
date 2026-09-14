# JSON and MCP

`berth check --json` and the dashboard's `GET /api/state` return the same report. Additive changes keep the shape backward compatible; removals or type changes are called out in the changelog.

## The report

```ts
type State = 'ok' | 'idle' | 'stale' | 'orphan' | 'unmanaged' | 'squatter' | 'conflict' | 'drift';

interface CheckReport {
  version: string;               // berth version
  generatedAt: string;           // ISO time
  cacheAgeMs: number;            // age of the truth snapshot used
  host: { platform: string; user: string; dockerAvailable: boolean; colima: boolean };
  policy: PolicySummary;         // scheme, pools, reserved, shared, projects[] with base
  ports: PortRecord[];           // one per leased, declared, shared or bound port of interest
  sessions: SessionRecord[];
  summary: { ports: number; attention: number; liveSessions: number; byState: Record<State, number>; ignored?: number };
}

interface PortRecord {
  port: number;
  state: State;
  project?: string; worktree?: number; role?: string;
  kind?: 'block' | 'dynamic' | 'declared' | 'shared';
  decoded: { P: number; W: number; R: number } | null;   // null outside the block range
  lease: Lease | null;
  live: { holder: string; pid?: number; container?: string; cwd?: string; sessionId?: string; tool?: string; proxy?: boolean; project?: string } | null;
  evidence: string[];            // one line per source, e.g. "docker: container x, compose y, working_dir ~/p"
  advisory: { text: string; command?: string } | null;
  url?: string; age?: string;
}

interface Lease {
  port: number; project: string; worktree: number; role: string;
  kind: 'block' | 'dynamic' | 'declared' | 'shared';
  owner: { session_id?: string; tool: 'claude-code' | 'human' | 'macos' | 'unknown'; pid?: number; pid_start?: string };
  cwd: string; created: string; expires?: string | null; note?: string; ended?: string | null;
}

interface SessionRecord {
  id: string; short: string; tool: string; pid?: number; started?: string; ended?: string | null; alive: boolean;
  project?: string; worktree?: number; cwd?: string; cwdExists: boolean;
  leases: number[]; worst: State; howWeKnow: string[];
}
```

Other commands: `berth ls --json` is `ports[]`; `berth who N --json` is one `PortRecord`; `berth env --json` is `{ project, P, W, worktree, block, ports: [{ role, R, port, env }] }`; `berth project add --json` is the registered entry with `created` and `block`.

## MCP tools

`berth mcp` speaks JSON-RPC 2.0 over stdio (newline-delimited) and supports `initialize`, `ping`, `tools/list` and `tools/call`. The plugin registers it automatically; by hand: `claude mcp add --scope user berth -- berth mcp`.

| Tool | Input | Returns |
|---|---|---|
| `berth_check` | `{ text?: boolean }` | the report as JSON, or the human summary |
| `berth_who` | `{ port }` | the `berth who` text followed by the JSON record |
| `berth_ls` | `{ project?, all? }` | `ports[]` |
| `berth_claim` | `{ role? \| extra? \| port? \| dynamic?, cwd?, project?, note?, session? }` | the claim result; `isError` when refused |
| `berth_release` | `{ port? \| all?, session? }` | `{ released, refused }` |
| `berth_env` | `{ cwd? }` | the `berth env --json` object |

Only self-scoped operations are exposed; there is no tool for `free`, `hooks`, `prune` or `init`.
