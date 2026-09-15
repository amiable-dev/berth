export type State =
  | 'ok'
  | 'idle'
  | 'stale'
  | 'orphan'
  | 'unmanaged'
  | 'squatter'
  | 'conflict'
  | 'drift';

export const STATES: State[] = [
  'ok',
  'idle',
  'stale',
  'orphan',
  'unmanaged',
  'squatter',
  'conflict',
  'drift',
];

/** Severity order used to pick a session's "worst" state (highest first). */
export const SEVERITY: State[] = [
  'drift',
  'conflict',
  'squatter',
  'unmanaged',
  'orphan',
  'stale',
  'idle',
  'ok',
];

export type LeaseKind = 'block' | 'dynamic' | 'declared' | 'shared';
export type OwnerTool = 'claude-code' | 'human' | 'macos' | 'unknown';

export interface Owner {
  session_id?: string;
  tool: OwnerTool;
  pid?: number;
  pid_start?: string;
}

export interface Lease {
  port: number;
  project: string;
  worktree: number;
  role: string;
  kind: LeaseKind;
  owner: Owner;
  cwd: string;
  created: string;
  expires?: string | null;
  note?: string;
  /** Set by session-end: the owning session ended; lease kept visible until it goes stale. */
  ended?: string | null;
}

export interface Live {
  holder: string;
  pid?: number;
  container?: string;
  cwd?: string;
  sessionId?: string;
  tool?: OwnerTool;
  proxy?: boolean;
  /** Project the live holder is attributed to, when known. */
  project?: string;
}

export interface Decoded {
  P: number;
  W: number;
  R: number;
}

export interface PortRecord {
  port: number;
  state: State;
  project?: string;
  worktree?: number;
  role?: string;
  kind?: LeaseKind;
  decoded: Decoded | null;
  lease: Lease | null;
  live: Live | null;
  evidence: string[];
  advisory: { text: string; command?: string } | null;
  url?: string;
  age?: string;
  /** How the project/worktree/role attribution is known: a lease record, or live evidence (compose label, cwd). Omitted when there is no attribution. */
  attribution?: 'lease' | 'evidence';
}

export interface SessionRecord {
  id: string;
  short: string;
  tool: OwnerTool;
  pid?: number;
  started?: string;
  ended?: string | null;
  alive: boolean;
  project?: string;
  worktree?: number;
  cwd?: string;
  cwdExists: boolean;
  leases: number[];
  worst: State;
  howWeKnow: string[];
}

export interface PolicySummary {
  scheme: { base: number; projectMax: number; worktreeMax: number; roles: Record<string, number> };
  pools: { dynamic: [number, number]; ttlHours: number };
  reserved: {
    ranges: [number, number][];
    ports: number[];
    lint: number[];
    ignoreProcesses?: string[];
  };
  shared: Record<string, { owner: string; ports: Record<string, number>; note?: string }>;
  projects: {
    name: string;
    P: number;
    path: string;
    base: number;
    declared: number[];
    extras: Record<string, number>;
    note?: string;
  }[];
}

export interface CheckReport {
  version: string;
  generatedAt: string;
  cacheAgeMs: number;
  host: { platform: string; user: string; dockerAvailable: boolean; colima: boolean };
  policy: PolicySummary;
  ports: PortRecord[];
  sessions: SessionRecord[];
  summary: {
    ports: number;
    attention: number;
    liveSessions: number;
    byState: Record<State, number>;
    /** Live listeners left out of the report because their process is on the policy ignore list. */
    ignored?: number;
  };
}

/** A listener observed on the host (lsof/netstat), before attribution. */
export interface Listener {
  port: number;
  addr: string;
  pid?: number;
  cmd: string;
  cwd?: string;
  sessionId?: string;
  claudeMarker?: boolean;
  source: 'lsof' | 'netstat';
}

export interface Container {
  id: string;
  name: string;
  hostPorts: number[];
  composeProject?: string;
  workingDir?: string;
  service?: string;
}

export interface TruthSnapshot {
  takenAt: string;
  /** True when every source ran (no skip flags); only full snapshots are cached and served from cache. */
  full: boolean;
  listeners: Listener[];
  containers: Container[];
  dockerAvailable: boolean;
  colima: boolean;
}

export interface SessionFile {
  id: string;
  tool: OwnerTool;
  pid?: number;
  started: string;
  ended?: string | null;
  cwd: string;
  project?: string;
  worktree?: number;
}
