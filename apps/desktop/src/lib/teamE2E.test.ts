import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureDeviceKey,
  ensureTeamEncryption,
  unwrapTeamKey,
  wrapTeamKey,
} from './teamE2E';
import {
  base64ToBytes,
  encryptSnapshotPayload,
  generateTeamKey,
} from './teamCrypto';
import { resetSecretStoreForTests } from './secretStore';
import type { TeamConnection } from './teamClient';

const connection: TeamConnection = {
  serverUrl: 'http://team.local',
  accessToken: 'access',
  refreshToken: 'refresh',
  user: { id: 'u1', account: 'alice', displayName: 'Alice' },
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('teamE2E', () => {
  beforeEach(() => {
    resetSecretStoreForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('用设备公钥包裹团队密钥并可解包', async () => {
    const device = await ensureDeviceKey('team-1', 'user-1');
    const teamKey = await generateTeamKey();
    const wrapped = await wrapTeamKey(device.publicKey, teamKey);
    const unwrapped = await unwrapTeamKey(device.privateKey, wrapped);

    expect(base64ToBytes(unwrapped)).toHaveLength(32);
    expect(unwrapped).toBe(teamKey);
  });

  it('其他设备的私钥无法解包', async () => {
    const device = await ensureDeviceKey('team-1', 'user-1');
    const other = await ensureDeviceKey('team-2', 'user-1');
    const teamKey = await generateTeamKey();
    const wrapped = await wrapTeamKey(device.publicKey, teamKey);

    await expect(unwrapTeamKey(other.privateKey, wrapped)).rejects.toThrow();
  });

  it('加密信封写入团队密钥版本', async () => {
    const teamKey = await generateTeamKey();
    const encrypted = await encryptSnapshotPayload(
      { requests: [], documents: {} },
      teamKey,
      7,
    );

    expect(encrypted.encryption).toMatchObject({
      algorithm: 'AES-GCM',
      version: 1,
      keyVersion: 7,
    });
  });

  it('所有者首次进入时自动创建 v1 并解包自己的密钥', async () => {
    let deviceId = '';
    let publicKey = '';
    let escrowVersion = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/teams/t-owner/encryption/devices')) {
          const body = JSON.parse(String(init?.body)) as {
            deviceId: string;
            publicKey: string;
          };
          deviceId = body.deviceId;
          publicKey = body.publicKey;
          return jsonResponse(200, {
            device: { deviceId, algorithm: 'RSA-OAEP-256' },
          });
        }
        if (url.includes('/v1/teams/t-owner/encryption?')) {
          return jsonResponse(200, {
            enabled: true,
            currentVersion: 0,
            device: {
              deviceId,
              userId: 'u1',
              publicKey,
              algorithm: 'RSA-OAEP-256',
              hasCurrentKey: false,
              wrappedVersions: [],
            },
            wrappedKeys: [],
            devices: [
              {
                deviceId,
                userId: 'u1',
                publicKey,
                algorithm: 'RSA-OAEP-256',
                hasCurrentKey: false,
                wrappedVersions: [],
              },
            ],
            pendingDevices: 1,
            serverReview: {
              enabled: true,
              featureEnabled: true,
              teamEnabled: true,
              activeKekId: 'kek-test',
              versions: [],
            },
          });
        }
        if (url.endsWith('/v1/teams/t-owner/encryption/keys')) {
          const body = JSON.parse(String(init?.body)) as {
            version: number;
            wrappedKeys: unknown[];
          };
          expect(body.version).toBe(1);
          expect(body.wrappedKeys).toHaveLength(1);
          return jsonResponse(200, { version: 1, distributed: 1 });
        }
        if (url.endsWith('/v1/teams/t-owner/encryption/escrow')) {
          const body = JSON.parse(String(init?.body)) as {
            version: number;
            teamKey: string;
          };
          escrowVersion = body.version;
          expect(base64ToBytes(body.teamKey)).toHaveLength(32);
          return jsonResponse(200, { version: body.version, stored: true });
        }
        return jsonResponse(404, {});
      }),
    );

    const result = await ensureTeamEncryption(connection, 't-owner', 'owner');

    expect(result.status.currentVersion).toBe(1);
    expect(result.pending).toBe(false);
    expect(result.keyring.keys.get(1)).toBeTruthy();
    expect(escrowVersion).toBe(1);
    expect(result.status.serverReview.versions).toContain(1);
  });

  it('成员在管理员创建密钥前保持等待', async () => {
    let deviceId = '';
    let publicKey = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/teams/t-member/encryption/devices')) {
          const body = JSON.parse(String(init?.body)) as {
            deviceId: string;
            publicKey: string;
          };
          deviceId = body.deviceId;
          publicKey = body.publicKey;
          return jsonResponse(200, { device: { deviceId } });
        }
        if (url.includes('/v1/teams/t-member/encryption?')) {
          return jsonResponse(200, {
            enabled: true,
            currentVersion: 0,
            device: {
              deviceId,
              userId: 'u1',
              publicKey,
              algorithm: 'RSA-OAEP-256',
              hasCurrentKey: false,
              wrappedVersions: [],
            },
            wrappedKeys: [],
            devices: [
              {
                deviceId,
                userId: 'u1',
                publicKey,
                algorithm: 'RSA-OAEP-256',
                hasCurrentKey: false,
                wrappedVersions: [],
              },
            ],
            pendingDevices: 0,
          });
        }
        return jsonResponse(404, {});
      }),
    );

    const result = await ensureTeamEncryption(connection, 't-member', 'member');

    expect(result.pending).toBe(true);
    expect(result.keyring.keys.size).toBe(0);
  });

  it('成员可以解包服务端分发的当前版本密钥', async () => {
    const teamKey = await generateTeamKey();
    let deviceId = '';
    let publicKey = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/teams/t-distributed/encryption/devices')) {
          const body = JSON.parse(String(init?.body)) as {
            deviceId: string;
            publicKey: string;
          };
          deviceId = body.deviceId;
          publicKey = body.publicKey;
          return jsonResponse(200, { device: { deviceId } });
        }
        if (url.includes('/v1/teams/t-distributed/encryption?')) {
          return jsonResponse(200, {
            enabled: true,
            currentVersion: 1,
            device: {
              deviceId,
              userId: 'u1',
              publicKey,
              algorithm: 'RSA-OAEP-256',
              hasCurrentKey: true,
              wrappedVersions: [1],
            },
            wrappedKeys: [
              {
                version: 1,
                wrappedKey: await wrapTeamKey(publicKey, teamKey),
                algorithm: 'RSA-OAEP-256',
              },
            ],
            devices: [
              {
                deviceId,
                userId: 'u1',
                publicKey,
                algorithm: 'RSA-OAEP-256',
                hasCurrentKey: true,
                wrappedVersions: [1],
              },
            ],
            pendingDevices: 0,
          });
        }
        return jsonResponse(404, {});
      }),
    );

    const result = await ensureTeamEncryption(connection, 't-distributed', 'member');

    expect(result.pending).toBe(false);
    expect(result.keyring.keys.get(1)).toBe(teamKey);
  });
});
