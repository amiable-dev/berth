import type { OwnerTool } from './types.js';
import { hostUser } from './util.js';

export interface CurrentSession {
  id: string;
  tool: OwnerTool;
  pid: number;
}

/** Who is asking: the Claude session (from its exported env), or the human at this shell. */
export function currentSession(override?: string): CurrentSession {
  const env = process.env;
  if (override) {
    return {
      id: override,
      tool: override.startsWith('human') ? 'human' : 'claude-code',
      pid: process.ppid,
    };
  }
  const sid = env.CLAUDE_CODE_SESSION_ID;
  if (sid && /^[A-Za-z0-9-]{8,64}$/.test(sid)) {
    const pid = Number(env.CLAUDE_PID);
    return {
      id: sid,
      tool: 'claude-code',
      pid: Number.isInteger(pid) && pid > 0 ? pid : process.ppid,
    };
  }
  return { id: `human-${hostUser()}`, tool: 'human', pid: process.ppid };
}
