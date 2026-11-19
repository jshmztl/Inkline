import {
  addTeamWrappedKeys,
  createTeamKeyVersion,
  escrowTeamKey,
  fetchTeamEncryption,
  registerTeamEncryptionDevice,
  TeamApiError,
  type TeamConnection,
  type TeamEncryptionDevice,
  type TeamEncryptionStatus,
} from './teamClient';
import {
  base64ToBytes,
  bytesToBase64,
  generateTeamKey,
  keyFingerprint,
  readTeamKey,
  type TeamKeyring,
} from './teamCrypto';
import { persistSecretNow, secretGet } from './secretStore';

const DEVICE_ALGORITHM = 'RSA-OAEP-256';

export interface DeviceKeyRecord {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  algorithm: 'RSA-OAEP-256';
}

export interface TeamEncryptionResult {
  status: TeamEncryptionStatus;
  keyring: TeamKeyring;
  pending: boolean;
}

function deviceSecretKey(teamId: string, userId: string) {
  return `team-device:${teamId}:${userId}`;
}

function teamKeySecretKey(teamId: string, userId: string, version: number) {
  return `team-key:${teamId}:${userId}:${version}`;
}

function isManager(role: string) {
  return role === 'owner' || role === 'admin';
}

function parseDeviceKey(raw: string | null): DeviceKeyRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceKeyRecord>;
    if (
      !parsed?.deviceId ||
      !parsed.publicKey ||
      !parsed.privateKey ||
      parsed.algorithm !== DEVICE_ALGORITHM
    ) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      algorithm: DEVICE_ALGORITHM,
    };
  } catch {
    return null;
  }
}

async function generateDeviceKey(
  teamId: string,
  userId: string,
): Promise<DeviceKeyRecord> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );

  const publicKey = bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
  );
  const privateKey = bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  );
  const record: DeviceKeyRecord = {
    deviceId: crypto.randomUUID(),
    publicKey,
    privateKey,
    algorithm: DEVICE_ALGORITHM,
  };
  await persistSecretNow(deviceSecretKey(teamId, userId), JSON.stringify(record));
  return record;
}

const deviceKeyInflight = new Map<string, Promise<DeviceKeyRecord>>();

export function ensureDeviceKey(
  teamId: string,
  userId: string,
): Promise<DeviceKeyRecord> {
  const storageKey = deviceSecretKey(teamId, userId);
  const cached = parseDeviceKey(secretGet(storageKey));
  if (cached) return Promise.resolve(cached);

  const existing = deviceKeyInflight.get(storageKey);
  if (existing) return existing;

  const promise = generateDeviceKey(teamId, userId);
  deviceKeyInflight.set(storageKey, promise);
  const clear = () => {
    if (deviceKeyInflight.get(storageKey) === promise) {
      deviceKeyInflight.delete(storageKey);
    }
  };
  promise.then(clear, clear);
  return promise;
}

export async function wrapTeamKey(
  publicKeyBase64: string,
  teamKeyBase64: string,
): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKeyBase64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const wrapped = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    base64ToBytes(teamKeyBase64),
  );
  return bytesToBase64(new Uint8Array(wrapped));
}

export async function unwrapTeamKey(
  privateKeyBase64: string,
  wrappedKeyBase64: string,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyBase64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
  const raw = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    base64ToBytes(wrappedKeyBase64),
  );
  return bytesToBase64(new Uint8Array(raw));
}

interface CachedTeamKey {
  key: string;
  keyId?: string;
}

function readCachedTeamKey(
  teamId: string,
  userId: string,
  version: number,
): CachedTeamKey | null {
  try {
    const raw = secretGet(teamKeySecretKey(teamId, userId, version));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: string; keyId?: string };
    if (typeof parsed.key !== 'string') return null;
    return {
      key: parsed.key,
      keyId: typeof parsed.keyId === 'string' ? parsed.keyId : undefined,
    };
  } catch {
    return null;
  }
}

async function saveCachedTeamKey(
  teamId: string,
  userId: string,
  version: number,
  key: string,
) {
  const keyId = await keyFingerprint(key);
  await persistSecretNow(
    teamKeySecretKey(teamId, userId, version),
    JSON.stringify({
      key,
      keyId,
      version,
      createdAt: new Date().toISOString(),
    }),
  );
}

function ownDevice(
  device: DeviceKeyRecord,
  userId: string,
): TeamEncryptionDevice {
  return {
    deviceId: device.deviceId,
    userId,
    publicKey: device.publicKey,
    algorithm: device.algorithm,
    hasCurrentKey: false,
  };
}

async function wrapForDevices(
  devices: TeamEncryptionDevice[],
  device: DeviceKeyRecord,
  userId: string,
  teamKey: string,
): Promise<{ deviceId: string; wrappedKey: string; algorithm: string }[]> {
  const targets = new Map<string, TeamEncryptionDevice>();
  for (const item of devices) {
    if (item.publicKey) targets.set(item.deviceId, item);
  }
  if (!targets.has(device.deviceId)) {
    const own = ownDevice(device, userId);
    targets.set(own.deviceId, own);
  }

  const results = await Promise.all(
    [...targets.values()].map(async (item) => {
      try {
        return {
          deviceId: item.deviceId,
          wrappedKey: await wrapTeamKey(item.publicKey!, teamKey),
          algorithm: DEVICE_ALGORITHM,
        };
      } catch {
        return null;
      }
    }),
  );
  const wrappedKeys = results.filter(
    (
      item,
    ): item is { deviceId: string; wrappedKey: string; algorithm: string } =>
      item !== null,
  );
  if (!wrappedKeys.some((item) => item.deviceId === device.deviceId)) {
    throw new Error('无法为本机设备包裹团队密钥，请检查设备密钥是否有效');
  }
  return wrappedKeys;
}

function legacyEncryptionResult(teamId: string): TeamEncryptionResult {
  const legacyKey = readTeamKey(teamId)?.key ?? null;
  const keys = new Map<number, string>();
  if (legacyKey) keys.set(0, legacyKey);
  return {
    status: {
      enabled: false,
      currentVersion: 0,
      device: null,
      wrappedKeys: [],
      devices: [],
      pendingDevices: 0,
      serverReview: {
        enabled: false,
        featureEnabled: false,
        teamEnabled: false,
        activeKekId: null,
        versions: [],
      },
    },
    keyring: {
      currentVersion: 0,
      keys,
      legacyKey,
    },
    pending: false,
  };
}

async function ensureTeamEncryptionNow(
  connection: TeamConnection,
  teamId: string,
  role: string,
  attempt = 0,
): Promise<TeamEncryptionResult> {
  const device = await ensureDeviceKey(teamId, connection.user.id);

  let status: TeamEncryptionStatus;
  try {
    await registerTeamEncryptionDevice(connection, teamId, {
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      algorithm: device.algorithm,
    });
    status = await fetchTeamEncryption(connection, teamId, device.deviceId);
  } catch (error) {
    // 兼容尚未升级到端到端加密 API 的旧服务端；成员校验失败的 404 不在此列。
    if (
      error instanceof TeamApiError &&
      error.status === 404 &&
      error.code === 'request_failed'
    ) {
      return legacyEncryptionResult(teamId);
    }
    throw error;
  }

  const keys = new Map<number, string>();

  let pinMismatch = '';
  for (const wrapped of status.wrappedKeys) {
    try {
      const key = await unwrapTeamKey(device.privateKey, wrapped.wrappedKey);
      const keyId = await keyFingerprint(key);
      const cached = readCachedTeamKey(teamId, connection.user.id, wrapped.version);
      const cachedKeyId = cached
        ? cached.keyId ?? (await keyFingerprint(cached.key))
        : null;
      if (cachedKeyId && cachedKeyId !== keyId) {
        pinMismatch = `团队密钥 v${wrapped.version} 指纹不一致，可能被替换`;
        continue;
      }
      keys.set(wrapped.version, key);
      if (cached?.keyId !== keyId) {
        await saveCachedTeamKey(teamId, connection.user.id, wrapped.version, key);
      }
    } catch {
      // 单个版本损坏时不阻断其他版本的解密。
    }
  }
  if (pinMismatch) throw new Error(pinMismatch);

  if (status.currentVersion > 0 && !keys.has(status.currentVersion)) {
    const cached = readCachedTeamKey(teamId, connection.user.id, status.currentVersion);
    if (cached) keys.set(status.currentVersion, cached.key);
  }

  if (status.enabled && status.currentVersion === 0 && isManager(role)) {
    const teamKey = await generateTeamKey();
    const wrappedKeys = await wrapForDevices(
      status.devices,
      device,
      connection.user.id,
      teamKey,
    );
    let created: { version: number; distributed: number };
    try {
      created = await createTeamKeyVersion(connection, teamId, 1, wrappedKeys);
    } catch (error) {
      if (
        attempt < 1 &&
        error instanceof TeamApiError &&
        (error.code === 'encryption_version_conflict' ||
          error.code === 'encryption_version_unknown')
      ) {
        return ensureTeamEncryptionNow(connection, teamId, role, attempt + 1);
      }
      throw error;
    }
    keys.set(created.version, teamKey);
    await saveCachedTeamKey(teamId, connection.user.id, created.version, teamKey);
    const wrappedDeviceIds = new Set(wrappedKeys.map((item) => item.deviceId));
    status = {
      ...status,
      currentVersion: created.version,
      pendingDevices: status.devices.filter(
        (item) => !wrappedDeviceIds.has(item.deviceId),
      ).length,
      devices: status.devices.map((item) =>
        wrappedDeviceIds.has(item.deviceId)
          ? { ...item, hasCurrentKey: true, wrappedVersions: [created.version] }
          : item,
      ),
    };
  }

  if (status.enabled && status.currentVersion > 0 && isManager(role) && keys.size > 0) {
    const missingByVersion = new Map<
      number,
      { deviceId: string; wrappedKey: string; algorithm: string }[]
    >();
    const skippedDevices = new Set<string>();

    for (const [version, teamKey] of keys) {
      if (version > status.currentVersion) continue;
      for (const item of status.devices) {
        if (!item.publicKey) continue;
        const knownVersions =
          item.wrappedVersions ??
          (item.hasCurrentKey ? [status.currentVersion] : []);
        if (knownVersions.includes(version)) continue;

        let wrappedKey: string;
        try {
          wrappedKey = await wrapTeamKey(item.publicKey, teamKey);
        } catch {
          if (item.deviceId === device.deviceId) {
            throw new Error('无法为本机设备包裹团队密钥，请检查设备密钥是否有效');
          }
          skippedDevices.add(item.deviceId);
          continue;
        }
        const entries = missingByVersion.get(version) ?? [];
        entries.push({
          deviceId: item.deviceId,
          wrappedKey,
          algorithm: DEVICE_ALGORITHM,
        });
        missingByVersion.set(version, entries);
      }
    }

    for (const [version, entries] of missingByVersion) {
      if (entries.length > 0) {
        await addTeamWrappedKeys(connection, teamId, version, entries);
      }
    }

    if (missingByVersion.size > 0) {
      const distributedVersions = new Set(missingByVersion.keys());
      const devices = status.devices.map((item) => {
        if (!item.publicKey || skippedDevices.has(item.deviceId)) return item;
        const knownVersions =
          item.wrappedVersions ??
          (item.hasCurrentKey ? [status.currentVersion] : []);
        const versions = new Set([...knownVersions, ...distributedVersions]);
        return {
          ...item,
          wrappedVersions: [...versions].sort((left, right) => left - right),
          hasCurrentKey: item.hasCurrentKey || versions.has(status.currentVersion),
        };
      });
      status = {
        ...status,
        devices,
        pendingDevices: devices.filter((item) => !item.hasCurrentKey).length,
      };
    }
  }

  // 所有者 / 管理员把当前与历史团队密钥的受控副本托管到服务端，
  // 仅用于管理台审阅请求头、请求体与字段文档。
  if (
    status.enabled &&
    status.currentVersion > 0 &&
    isManager(role) &&
    status.serverReview.enabled
  ) {
    const missing = [...keys.entries()]
      .filter(
        ([version, key]) =>
          version > 0 &&
          version <= status.currentVersion &&
          Boolean(key) &&
          !status.serverReview.versions.includes(version),
      )
      .map(([version]) => version);

    if (missing.length > 0) {
      const uploaded: number[] = [];
      for (const version of missing) {
        const key = keys.get(version);
        if (!key) continue;
        try {
          await escrowTeamKey(connection, teamId, version, key);
          uploaded.push(version);
        } catch {
          // 旧版服务端没有托管接口时停止尝试，不阻断团队同步。
          break;
        }
      }
      if (uploaded.length > 0) {
        status = {
          ...status,
          serverReview: {
            ...status.serverReview,
            versions: [...new Set([...status.serverReview.versions, ...uploaded])].sort(
              (left, right) => left - right,
            ),
          },
        };
      }
    }
  }

  const currentKey = keys.get(status.currentVersion);

  return {
    status,
    keyring: {
      currentVersion: status.currentVersion,
      keys,
      legacyKey: readTeamKey(teamId)?.key ?? null,
    },
    pending: status.enabled && !currentKey,
  };
}

const ensureInflight = new Map<string, Promise<TeamEncryptionResult>>();

export function ensureTeamEncryption(
  connection: TeamConnection,
  teamId: string,
  role: string,
): Promise<TeamEncryptionResult> {
  const cacheKey = `${connection.serverUrl}:${teamId}:${connection.user.id}`;
  const existing = ensureInflight.get(cacheKey);
  if (existing) return existing;

  const promise = ensureTeamEncryptionNow(connection, teamId, role);
  ensureInflight.set(cacheKey, promise);
  const clear = () => {
    if (ensureInflight.get(cacheKey) === promise) ensureInflight.delete(cacheKey);
  };
  promise.then(clear, clear);
  return promise;
}

export async function rotateTeamEncryption(
  connection: TeamConnection,
  teamId: string,
  role: string,
): Promise<TeamEncryptionResult> {
  if (!isManager(role)) {
    throw new Error('只有所有者或管理员可以轮换团队密钥');
  }

  ensureInflight.delete(`${connection.serverUrl}:${teamId}:${connection.user.id}`);
  const device = await ensureDeviceKey(teamId, connection.user.id);
  await registerTeamEncryptionDevice(connection, teamId, {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    algorithm: device.algorithm,
  });

  const status = await fetchTeamEncryption(connection, teamId, device.deviceId);
  if (!status.enabled) {
    throw new Error('团队未启用端到端加密');
  }
  if (status.currentVersion < 1) {
    return ensureTeamEncryption(connection, teamId, role);
  }

  const version = status.currentVersion + 1;
  const teamKey = await generateTeamKey();
  const wrappedKeys = await wrapForDevices(
    status.devices,
    device,
    connection.user.id,
    teamKey,
  );
  await createTeamKeyVersion(connection, teamId, version, wrappedKeys);
  await saveCachedTeamKey(teamId, connection.user.id, version, teamKey);
  ensureInflight.delete(`${connection.serverUrl}:${teamId}:${connection.user.id}`);

  return ensureTeamEncryption(connection, teamId, role);
}
