import { describe, expect, it } from 'vitest';
import { renderWho } from '../src/commands/query.js';
import { containerHolderEvidence, isUnlabelledContainer, startedByDesc } from '../src/truth.js';
import type { Container, PortRecord } from '../src/types.js';

function container(over: Partial<Container> = {}): Container {
  return { id: 'c1', name: 'penguin-platform-db', hostPorts: [5433], ...over };
}

describe('container holder attribution', () => {
  it('names a compose-managed container by its project', () => {
    const c = container({ composeProject: 'deploy', workingDir: '/x/deploy' });
    expect(isUnlabelledContainer(c)).toBe(false);
    expect(startedByDesc(c)).toBe('compose deploy');
    expect(containerHolderEvidence(c)).toEqual(['started by: compose deploy']);
  });

  it('names a hand-run container and lists its volumes', () => {
    const c = container();
    expect(isUnlabelledContainer(c)).toBe(true);
    expect(startedByDesc(c)).toBe('docker run');
    const evidence = containerHolderEvidence(c, {
      mounts: [
        {
          name: 'pgdata',
          destination: '/var/lib/postgresql/data',
          type: 'volume',
          anonymous: false,
        },
      ],
      env: [],
    });
    expect(evidence).toEqual(['started by: docker run', 'volumes: pgdata']);
  });

  it('lists every mounted volume by name, in order', () => {
    const c = container();
    const evidence = containerHolderEvidence(c, {
      mounts: [
        {
          name: 'pgdata',
          destination: '/var/lib/postgresql/data',
          type: 'volume',
          anonymous: false,
        },
        { name: '/host/backups', destination: '/backups', type: 'bind', anonymous: false },
      ],
      env: [],
    });
    expect(evidence).toEqual(['started by: docker run', 'volumes: pgdata, /host/backups']);
  });

  it('omits the volumes line when nothing was mounted or inspect was unavailable', () => {
    const c = container();
    expect(containerHolderEvidence(c, { mounts: [], env: [] })).toEqual(['started by: docker run']);
    expect(containerHolderEvidence(c)).toEqual(['started by: docker run']);
  });
});

describe('renderWho', () => {
  it('shows started-by and volume evidence under "how we know" for a container holder', () => {
    const rec: PortRecord = {
      port: 13202,
      state: 'ok',
      project: 'penguin-platform',
      kind: 'block',
      decoded: { P: 3, W: 0, R: 2 },
      lease: null,
      live: {
        holder: 'penguin-platform-db',
        container: 'penguin-platform-db',
        proxy: true,
        tool: 'unknown',
      },
      evidence: [
        'docker: container penguin-platform-db',
        'started by: docker run',
        'volumes: a1b2c3',
      ],
      advisory: { text: 'none' },
    };
    const text = renderWho(rec, 13202, 10000);
    expect(text).toContain('› started by: docker run');
    expect(text).toContain('› volumes: a1b2c3');
  });
});
