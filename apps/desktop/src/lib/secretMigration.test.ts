import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { kvGet, kvRemove, kvSet } from './kv';
import {
  AI_GATEWAY_SECRET_KEY,
  AI_GATEWAY_SETTINGS_KEY,
  ENVIRONMENTS_SETTINGS_KEY,
  REQUEST_META_PREFIX,
  TEAM_KEY_SETTINGS_PREFIX,
  envValuesSecretKey,
  extractRequestAuthSecrets,
  mergeRequestAuthSecrets,
  migratePlaintextSecrets,
  requestAuthSecretKey,
  teamKeySecretKey,
} from './secretMigration';
import { resetSecretStoreForTests, secretGet } from './secretStore';

describe('secretMigration', () => {
  beforeEach(() => {
    resetSecretStoreForTests();
    kvRemove(`${REQUEST_META_PREFIX}req-1`);
    kvRemove(AI_GATEWAY_SETTINGS_KEY);
    kvRemove(ENVIRONMENTS_SETTINGS_KEY);
    kvRemove(`${TEAM_KEY_SETTINGS_PREFIX}team-1`);
  });

  afterEach(() => {
    resetSecretStoreForTests();
    kvRemove(`${REQUEST_META_PREFIX}req-1`);
    kvRemove(AI_GATEWAY_SETTINGS_KEY);
    kvRemove(ENVIRONMENTS_SETTINGS_KEY);
    kvRemove(`${TEAM_KEY_SETTINGS_PREFIX}team-1`);
  });

  it('strips and restores request auth fields without dropping other meta', () => {
    const { publicMeta, secrets } = extractRequestAuthSecrets({
      bodyMode: 'json',
      authType: 'bearer',
      authToken: 'tok-1',
      authUser: 'alice',
      authPass: 'p@ss',
      apiKeyName: 'X-Api-Key',
      apiKeyValue: 'abc',
      preScript: 'pm.variables.set("a", 1)',
    });

    expect(publicMeta.authToken).toBeUndefined();
    expect(publicMeta.authPass).toBeUndefined();
    expect(publicMeta.apiKeyValue).toBeUndefined();
    expect(publicMeta.authUser).toBe('alice');
    expect(publicMeta.preScript).toBe('pm.variables.set("a", 1)');
    expect(secrets).toEqual({ authToken: 'tok-1', authPass: 'p@ss', apiKeyValue: 'abc' });

    expect(mergeRequestAuthSecrets(publicMeta, secrets)).toMatchObject({
      authToken: 'tok-1',
      authPass: 'p@ss',
      apiKeyValue: 'abc',
      authUser: 'alice',
      bodyMode: 'json',
    });
  });

  it('moves plaintext request auth, AI keys, team keys and env values out of settings', async () => {
    kvSet(
      `${REQUEST_META_PREFIX}req-1`,
      JSON.stringify({
        authType: 'basic',
        authUser: 'alice',
        authPass: 's3cret',
        authToken: '',
        apiKeyValue: '',
        preScript: 'console.log(1)',
      }),
    );
    kvSet(
      AI_GATEWAY_SETTINGS_KEY,
      JSON.stringify({
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-live',
      }),
    );
    kvSet(
      `${TEAM_KEY_SETTINGS_PREFIX}team-1`,
      JSON.stringify({ key: 'dGVhbS1rZXktMzItYnl0ZXMtYmFzZTY0Cg==', createdAt: '2026-11-14T00:00:00+08:00' }),
    );
    kvSet(
      ENVIRONMENTS_SETTINGS_KEY,
      JSON.stringify([
        {
          value: 'prod',
          label: '生产',
          variables: { host: 'https://api.internal', token: 'env-token' },
        },
      ]),
    );

    const report = await migratePlaintextSecrets();
    expect(report.failed).toEqual([]);
    expect(report.migrated.length).toBeGreaterThanOrEqual(4);

    const meta = JSON.parse(kvGet(`${REQUEST_META_PREFIX}req-1`) ?? '{}') as Record<string, unknown>;
    expect(meta.authPass).toBeUndefined();
    expect(meta.authUser).toBe('alice');
    expect(meta.preScript).toBe('console.log(1)');
    expect(JSON.parse(secretGet(requestAuthSecretKey('req-1')) ?? '{}')).toMatchObject({
      authPass: 's3cret',
    });

    const gateway = JSON.parse(kvGet(AI_GATEWAY_SETTINGS_KEY) ?? '{}') as { apiKey?: string; baseUrl?: string };
    expect(gateway.apiKey).toBe('');
    expect(gateway.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(secretGet(AI_GATEWAY_SECRET_KEY)).toBe('sk-live');

    expect(kvGet(`${TEAM_KEY_SETTINGS_PREFIX}team-1`)).toBeNull();
    expect(secretGet(teamKeySecretKey('team-1'))).toContain('createdAt');

    const envs = JSON.parse(kvGet(ENVIRONMENTS_SETTINGS_KEY) ?? '[]') as Array<{
      variables: Record<string, string>;
    }>;
    expect(envs[0].variables).toEqual({ host: '', token: '' });
    expect(JSON.parse(secretGet(envValuesSecretKey('prod')) ?? '{}')).toEqual({
      host: 'https://api.internal',
      token: 'env-token',
    });
  });

  it('does not delete plaintext if the destination already has no leftover to move on a second run', async () => {
    kvSet(
      AI_GATEWAY_SETTINGS_KEY,
      JSON.stringify({ provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', apiKey: 'sk-1' }),
    );
    await migratePlaintextSecrets();
    const second = await migratePlaintextSecrets();
    expect(second.failed).toEqual([]);
    expect(secretGet(AI_GATEWAY_SECRET_KEY)).toBe('sk-1');
    expect(JSON.parse(kvGet(AI_GATEWAY_SETTINGS_KEY) ?? '{}')).toMatchObject({ apiKey: '' });
  });
});
