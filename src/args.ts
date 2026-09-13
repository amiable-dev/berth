export interface ParsedArgs {
  cmd: string;
  sub?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value. Everything else is boolean. */
const VALUE_FLAGS = new Set([
  'port',
  'project',
  'role',
  'extra',
  'dynamic',
  'note',
  'session',
  'cwd',
  'worktree',
  'owner',
  'state',
  'settings',
  'w',
  'name',
  'format',
]);

export class UsageError extends Error {
  override name = 'UsageError';
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new UsageError(`unknown flag ${a}`);
      if (eq > 0) {
        flags[name] = a.slice(eq + 1);
      } else if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next))) {
          throw new UsageError(`--${name} needs a value`);
        }
        flags[name] = next;
        i++;
      } else if (name.startsWith('no-')) {
        flags[name.slice(3)] = false;
      } else {
        flags[name] = true;
      }
    } else if (a === '-h') {
      flags.help = true;
    } else if (a === '-v') {
      flags.version = true;
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      throw new UsageError(`unknown flag ${a}`);
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift() ?? 'help';
  return { cmd, positional, flags };
}

export function flagString(f: ParsedArgs['flags'], name: string): string | undefined {
  const v = f[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(f: ParsedArgs['flags'], name: string): boolean {
  return f[name] === true;
}
