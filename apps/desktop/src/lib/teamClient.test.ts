import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setActiveNetworkMode } from './network';
import {
  changeTeamPassword,
  clearTeamConnection,
  fetchLatestSnapshot,
  loginTeam,
  pushSnapshotRemote,
  TeamApiError,
} from './teamClient';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetch(
  handler: (call: Call) => Response,
): { calls: Call[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('teamClient', () => {
  beforeEach(() => {
    clearTeamConnection();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearTeamConnection();
    setActiveNetworkMode('B');
  });

  it('登录后携带令牌推送快照，并带上基础版本与幂等键', async () => {
    const { calls } = installFetch((call) => {
      if (call.url.endsWith('/v1/auth/login')) {
        return jsonResponse(200, {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          user: { id: 'u1', account: 'alice', displayName: 'Alice' },
        });
      }
      if (call.url.endsWith('/v1/me')) {
        return jsonResponse(200, {
          teams: [{ id: 't1', name: '支付团队', role: 'owner', revision: 3, memberCount: 2, maxDataLevel: 'L2' }],
        });
      }
      if (call.url.endsWith('/v1/teams/t1/snapshots')) {
        return jsonResponse(201, { revision: 4, hash: 'abc', createdAt: '2026-11-12T00:00:00Z' });
      }
      return jsonResponse(404, {});
    });

    const { connection, teams } = await loginTeam('team.local', 'alice', 'secret');
    expect(connection.accessToken).toBe('access-1');
    expect(teams.map((team) => team.id)).toEqual(['t1']);

    const payload = { collections: [], requests: [] };
    const result = await pushSnapshotRemote(connection, 't1', payload, 3);

    expect(result.revision).toBe(4);
    const pushCall = calls.find((call) => call.url.endsWith('/v1/teams/t1/snapshots'));
    expect(pushCall?.method).toBe('POST');
    expect(pushCall?.headers.Authorization).toBe('Bearer access-1');
    expect(pushCall?.headers['X-Inkline-Base-Revision']).toBe('3');
    expect(pushCall?.headers['Idempotency-Key']).toBeTruthy();
    expect(pushCall?.body).toEqual(payload);
  });

  it('服务端返回 409 时抛出带当前版本的冲突错误', async () => {
    installFetch((call) => {
      if (call.url.endsWith('/v1/auth/login')) {
        return jsonResponse(200, {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          user: { id: 'u1', account: 'alice', displayName: 'Alice' },
        });
      }
      if (call.url.endsWith('/v1/me')) return jsonResponse(200, { teams: [] });
      return jsonResponse(409, {
        error: {
          code: 'revision_conflict',
          message: '版本落后，请先拉取最新快照',
          details: { currentRevision: 5 },
        },
      });
    });

    const { connection } = await loginTeam('http://team.local', 'alice', 'secret');

    await expect(pushSnapshotRemote(connection, 't1', { collections: [] }, 3)).rejects.toMatchObject({
      status: 409,
      code: 'revision_conflict',
    });

    try {
      await pushSnapshotRemote(connection, 't1', { collections: [] }, 3);
      throw new Error('应当抛出冲突错误');
    } catch (error) {
      expect(error).toBeInstanceOf(TeamApiError);
      expect((error as TeamApiError).details).toEqual({ currentRevision: 5 });
    }
  });

  it('访问令牌过期时自动刷新并重试推送', async () => {
    let snapshotAttempts = 0;
    const { calls } = installFetch((call) => {
      if (call.url.endsWith('/v1/auth/login')) {
        return jsonResponse(200, {
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          user: { id: 'u1', account: 'alice', displayName: 'Alice' },
        });
      }
      if (call.url.endsWith('/v1/me')) return jsonResponse(200, { teams: [] });
      if (call.url.endsWith('/v1/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'access-new', refreshToken: 'refresh-new' });
      }
      if (call.url.endsWith('/v1/teams/t1/snapshots')) {
        snapshotAttempts += 1;
        return snapshotAttempts === 1
          ? jsonResponse(401, { error: { code: 'token_expired', message: '令牌已过期' } })
          : jsonResponse(200, { revision: 6, hash: 'def', createdAt: '2026-11-12T00:00:00Z' });
      }
      return jsonResponse(404, {});
    });

    const { connection } = await loginTeam('team.local', 'alice', 'secret');
    const result = await pushSnapshotRemote(connection, 't1', { collections: [] }, 5);

    expect(result.revision).toBe(6);
    expect(connection.accessToken).toBe('access-new');
    expect(snapshotAttempts).toBe(2);
    const refreshCall = calls.find((call) => call.url.endsWith('/v1/auth/refresh'));
    expect(refreshCall?.body).toEqual({ refreshToken: 'refresh-old' });
  });

  it('拉取到加密快照但本地没有密钥时给出明确错误', async () => {
    installFetch((call) => {
      if (call.url.endsWith('/v1/auth/login')) {
        return jsonResponse(200, {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          user: { id: 'u1', account: 'alice', displayName: 'Alice' },
        });
      }
      if (call.url.endsWith('/v1/me')) return jsonResponse(200, { teams: [] });
      if (call.url.endsWith('/v1/teams/t1/snapshots/latest')) {
        return jsonResponse(200, {
          revision: 7,
          downloadUrl: '/v1/teams/t1/snapshots/7',
          createdAt: '2026-11-12T00:00:00Z',
        });
      }
      if (call.url.endsWith('/v1/teams/t1/snapshots/7')) {
        return jsonResponse(200, {
          encryption: { keyId: 'fingerprint', iv: 'abc' },
          collections: [],
          requests: [],
        });
      }
      return jsonResponse(404, {});
    });

    const { connection } = await loginTeam('team.local', 'alice', 'secret');

    await expect(fetchLatestSnapshot(connection, 't1')).rejects.toMatchObject({
      code: 'encryption_key_missing',
    });
  });

  it('首次登录要求修改口令，修改后更新令牌', async () => {
    let meCalls = 0;
    const { calls } = installFetch((call) => {
      if (call.url.endsWith('/v1/auth/login')) {
        return jsonResponse(200, {
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          mustChangePassword: true,
          user: { id: 'u1', account: 'alice', displayName: 'Alice' },
        });
      }
      if (call.url.endsWith('/v1/me')) {
        meCalls += 1;
        return jsonResponse(200, { teams: [] });
      }
      if (call.url.endsWith('/v1/auth/change-password')) {
        return jsonResponse(200, {
          accessToken: 'access-new',
          refreshToken: 'refresh-new',
          mustChangePassword: false,
          user: { id: 'u1', account: 'alice', displayName: 'Alice' },
        });
      }
      return jsonResponse(404, {});
    });

    const result = await loginTeam('team.local', 'alice', 'secret');
    expect(result.mustChangePassword).toBe(true);
    expect(result.teams).toEqual([]);
    expect(meCalls).toBe(0);

    const updated = await changeTeamPassword(result.connection, 'secret', 'NewSecret123');
    expect(updated.accessToken).toBe('access-new');
    expect(updated.refreshToken).toBe('refresh-new');

    const changeCall = calls.find((call) => call.url.endsWith('/v1/auth/change-password'));
    expect(changeCall?.headers.Authorization).toBe('Bearer access-old');
    expect(changeCall?.body).toEqual({
      currentPassword: 'secret',
      newPassword: 'NewSecret123',
    });
  });

  it('A 离线模式阻止非本机团队服务', async () => {
    setActiveNetworkMode('A');
    const { fetchMock } = installFetch(() => jsonResponse(200, {}));

    await expect(
      loginTeam('https://team.example.com', 'alice', 'secret'),
    ).rejects.toMatchObject({ code: 'network_blocked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
