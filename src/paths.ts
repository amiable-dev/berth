import os from 'node:os';
import path from 'node:path';

function xdg(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.length > 0 ? v : fallback;
}

export function configDir(): string {
  return (
    process.env.BERTH_CONFIG_DIR ??
    path.join(xdg('XDG_CONFIG_HOME', path.join(os.homedir(), '.config')), 'berth')
  );
}

export function stateDir(): string {
  return (
    process.env.BERTH_STATE_DIR ??
    path.join(xdg('XDG_STATE_HOME', path.join(os.homedir(), '.local', 'state')), 'berth')
  );
}

export const policyPath = (): string =>
  process.env.BERTH_POLICY ?? path.join(configDir(), 'policy.toml');
export const leasesPath = (): string => path.join(stateDir(), 'leases.json');
export const lockPath = (): string => path.join(stateDir(), 'ledger.lock');
export const claimsDir = (): string => path.join(stateDir(), 'claims');
export const sessionsDir = (): string => path.join(stateDir(), 'sessions');
export const worktreesDir = (): string => path.join(stateDir(), 'worktrees');
export const overridesDir = (): string => path.join(stateDir(), 'overrides');
export const truthCachePath = (): string => path.join(stateDir(), 'truth.cache.json');
export const compactLogPath = (): string => path.join(stateDir(), 'compact.log');
export const auditLogPath = (): string => path.join(stateDir(), 'audit.log');
/** Lock for writers of policy.toml (project add, scan --write). */
export const policyLockPath = (): string => `${policyPath()}.lock`;
