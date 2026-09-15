import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorChecks } from '../src/commands/query.js';
import { detectComposeFlavour } from '../src/compose.js';
import { stubPath, useTempState } from './helpers.js';

describe('compose flavour detection', () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    useTempState();
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('detects the docker compose plugin when `docker compose version` succeeds', async () => {
    const stub = stubPath(
      {
        docker: [
          'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then echo "2.29.1"; exit 0; fi',
          'exit 1',
        ].join('\n'),
      },
      { inherit: false },
    );
    restore = stub.restore;
    expect(await detectComposeFlavour()).toEqual({
      kind: 'plugin',
      command: 'docker compose',
      version: '2.29.1',
    });
  });

  it('falls back to standalone docker-compose when the plugin subcommand is unknown', async () => {
    const stub = stubPath(
      {
        docker: [
          'if [ "$1" = "compose" ]; then echo "docker: \'compose\' is not a docker command." 1>&2; exit 1; fi',
          'exit 1',
        ].join('\n'),
        'docker-compose': [
          'if [ "$1" = "version" ] && [ "$2" = "--short" ]; then echo "5.1.4"; exit 0; fi',
          'exit 1',
        ].join('\n'),
      },
      { inherit: false },
    );
    restore = stub.restore;
    expect(await detectComposeFlavour()).toEqual({
      kind: 'standalone',
      command: 'docker-compose',
      version: '5.1.4',
    });
  });

  it('reports none when neither docker compose nor docker-compose is reachable', async () => {
    const stub = stubPath({}, { inherit: false });
    restore = stub.restore;
    expect(await detectComposeFlavour()).toEqual({ kind: 'none', command: 'docker compose' });
  });
});

describe('doctor compose check', () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    useTempState();
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('reports the standalone docker-compose version on a machine without the plugin', async () => {
    const stub = stubPath(
      {
        docker: [
          'if [ "$1" = "compose" ]; then echo "docker: \'compose\' is not a docker command." 1>&2; exit 1; fi',
          'if [ "$1" = "version" ]; then echo "24.0.0"; exit 0; fi',
          'exit 1',
        ].join('\n'),
        'docker-compose': [
          'if [ "$1" = "version" ] && [ "$2" = "--short" ]; then echo "5.1.4"; exit 0; fi',
          'exit 1',
        ].join('\n'),
      },
      { inherit: false },
    );
    restore = stub.restore;
    const checks = await doctorChecks();
    const compose = checks.find((c) => c.name === 'compose');
    expect(compose).toMatchObject({
      ok: true,
      warn: false,
      detail: 'standalone docker-compose 5.1.4',
    });
  });

  it('warns when neither docker compose nor docker-compose is on PATH', async () => {
    const stub = stubPath({}, { inherit: false });
    restore = stub.restore;
    const checks = await doctorChecks();
    const compose = checks.find((c) => c.name === 'compose');
    expect(compose).toMatchObject({ ok: true, warn: true });
  });
});
