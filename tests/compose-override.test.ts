import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { cmdEnv } from '../src/commands/allocate.js';
import {
  buildOverrideWarnings,
  formatOverrideWarning,
  type OverrideMappingEntry,
} from '../src/compose.js';
import type { ContainerInspect } from '../src/truth.js';
import type { Container } from '../src/types.js';
import { fixturePolicy, useTempState, writePolicy } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const HEX64 = 'a1b2c3'.repeat(10).slice(0, 64);

function dbMapping(over: Partial<OverrideMappingEntry> = {}): OverrideMappingEntry {
  return {
    service: 'db',
    currentHost: 5433,
    newHost: 12002,
    containerPort: 5432,
    role: 'db',
    ...over,
  };
}

describe('buildOverrideWarnings', () => {
  it('warns when a compose-declared port is already held by a container without compose labels', () => {
    const containers: Container[] = [
      { id: 'abc123', name: 'penguin-platform-db', hostPorts: [5433] },
    ];
    const mounts = new Map<string, ContainerInspect>([
      [
        'abc123',
        {
          mounts: [
            {
              name: HEX64,
              destination: '/var/lib/postgresql/data',
              type: 'volume',
              anonymous: true,
            },
          ],
          env: [],
          image: 'postgres:16',
        },
      ],
    ]);
    const warnings = buildOverrideWarnings([dbMapping()], containers, mounts);
    expect(warnings).toHaveLength(1);
    const w = warnings[0];
    expect(w).toBeDefined();
    expect(w?.service).toBe('db');
    expect(w?.container).toBe('penguin-platform-db');
    expect(w?.message).toBe(
      'penguin-platform-db (5433) was started with docker run; the override will not apply.',
    );
    expect(w?.recreateCommand).toBe(
      `docker stop penguin-platform-db && docker rm penguin-platform-db && docker run -d --name penguin-platform-db -p 12002:5432 -v ${HEX64}:/var/lib/postgresql/data postgres:16`,
    );
    expect(w?.cautions).toEqual([
      `volume ${HEX64} is anonymous; recreating loses it unless you keep this exact name`,
    ]);
    expect(formatOverrideWarning(w as NonNullable<typeof w>)[0]).toBe(
      `penguin-platform-db (5433) was started with docker run; the override will not apply. Recreate it on 12002: ${w?.recreateCommand}`,
    );
  });

  it('does not warn when the current holder carries compose labels', () => {
    const containers: Container[] = [
      {
        id: 'abc123',
        name: 'deploy-db-1',
        hostPorts: [5433],
        composeProject: 'deploy',
        workingDir: '/x/deploy',
      },
    ];
    expect(buildOverrideWarnings([dbMapping()], containers, new Map())).toEqual([]);
  });

  it('does not warn when nothing is bound to the compose-declared port yet', () => {
    expect(buildOverrideWarnings([dbMapping()], [], new Map())).toEqual([]);
  });

  it('groups a multi-port service into one warning and cautions about in-memory mail state', () => {
    const mapping: OverrideMappingEntry[] = [
      { service: 'mail', currentHost: 1025, newHost: 12004, containerPort: 1025, role: 'smtp' },
      { service: 'mail', currentHost: 8025, newHost: 12005, containerPort: 8025, role: 'mail-ui' },
    ];
    const containers: Container[] = [
      { id: 'm1', name: 'penguin-platform-mail', hostPorts: [1025, 8025] },
    ];
    const mounts = new Map<string, ContainerInspect>([
      ['m1', { mounts: [], env: [], image: 'axllent/mailpit' }],
    ]);
    const warnings = buildOverrideWarnings(mapping, containers, mounts);
    expect(warnings).toHaveLength(1);
    const w = warnings[0];
    expect(w?.ports).toEqual([
      { current: 1025, new: 12004, containerPort: 1025 },
      { current: 8025, new: 12005, containerPort: 8025 },
    ]);
    expect(w?.recreateCommand).toContain('-p 12004:1025 -p 12005:8025');
    expect(w?.cautions).toEqual([
      'axllent/mailpit keeps received mail in memory; recreating loses it unless MP_DATABASE is set',
    ]);
  });

  it('does not caution about in-memory state once MP_DATABASE is already configured', () => {
    const mapping: OverrideMappingEntry[] = [
      { service: 'mail', currentHost: 1025, newHost: 12004, containerPort: 1025, role: 'smtp' },
    ];
    const containers: Container[] = [
      { id: 'm1', name: 'penguin-platform-mail', hostPorts: [1025] },
    ];
    const mounts = new Map<string, ContainerInspect>([
      ['m1', { mounts: [], env: ['MP_DATABASE=/data/mailpit.db'], image: 'axllent/mailpit' }],
    ]);
    expect(buildOverrideWarnings(mapping, containers, mounts)[0]?.cautions).toEqual([]);
  });
});

describe('cmdEnv --compose-override', () => {
  it('honours --json together with --compose-override instead of returning the plain ports shape', async () => {
    const { root } = useTempState();
    const fx = fixturePolicy(root);
    writePolicy(process.env.BERTH_POLICY as string, fx.text);
    writeFileSync(
      path.join(fx.paths.alpha, 'compose.yaml'),
      'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
    );
    const c = capture();
    const code = await cmdEnv(
      parseArgs(['env', '--compose-override', '--json', '--cwd', fx.paths.alpha]),
      c.io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out.join('')) as {
      mapping: OverrideMappingEntry[];
      warnings: unknown[];
      override: string;
      composeCommand: string;
    };
    expect(parsed.mapping[0]).toMatchObject({ service: 'db', containerPort: 5432 });
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(existsSync(parsed.override)).toBe(true);
    expect(typeof parsed.composeCommand).toBe('string');
  });

  it('prints the mapping, the COMPOSE_FILE export and a next-step hint in text mode', async () => {
    const { root } = useTempState();
    const fx = fixturePolicy(root);
    writePolicy(process.env.BERTH_POLICY as string, fx.text);
    writeFileSync(
      path.join(fx.paths.alpha, 'compose.yaml'),
      'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
    );
    const c = capture();
    const code = await cmdEnv(
      parseArgs(['env', '--compose-override', '--cwd', fx.paths.alpha]),
      c.io,
    );
    expect(code).toBe(0);
    const text = c.out.join('\n');
    expect(text).toMatch(/^# wrote /m);
    expect(text).toContain('export COMPOSE_FILE=');
    expect(text).toMatch(/# then: docker(-compose| compose) up/);
  });
});
