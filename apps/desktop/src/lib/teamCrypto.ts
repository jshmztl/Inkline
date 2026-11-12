import { kvGet, kvRemove, kvSet } from './kv';

const KEY_PREFIX = 'aw-team-key:';
const ENCRYPTED_PREFIX = 'enc:v1:';

export interface TeamKeyInfo {
  key: string;
  createdAt: string;
}

export interface EncryptedEnvelope {
  algorithm: 'AES-GCM';
  version: 1;
  keyId: string;
}

type SnapshotPayload = Record<string, unknown>;

export function readTeamKey(teamId: string): TeamKeyInfo | null {
  try {
    const raw = kvGet(`${KEY_PREFIX}${teamId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TeamKeyInfo>;
    if (!parsed?.key || !isValidTeamKey(parsed.key)) return null;
    return { key: parsed.key, createdAt: parsed.createdAt ?? new Date().toISOString() };
  } catch {
    return null;
  }
}

export function saveTeamKey(teamId: string, key: string): TeamKeyInfo {
  const trimmed = key.trim();
  if (!isValidTeamKey(trimmed)) {
    throw new Error('团队密钥必须是 32 字节的 Base64 字符串');
  }
  const info: TeamKeyInfo = { key: trimmed, createdAt: new Date().toISOString() };
  kvSet(`${KEY_PREFIX}${teamId}`, JSON.stringify(info));
  return info;
}

export function clearTeamKey(teamId: string) {
  kvRemove(`${KEY_PREFIX}${teamId}`);
}

export function isValidTeamKey(key: string): boolean {
  try {
    return base64ToBytes(key.trim()).length === 32;
  } catch {
    return false;
  }
}

export async function generateTeamKey(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes);
}

export async function keyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(key));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isEncryptedPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as SnapshotPayload).encryption &&
      typeof (payload as SnapshotPayload).encryption === 'object',
  );
}

export async function encryptSnapshotPayload(
  payload: SnapshotPayload,
  key: string,
): Promise<SnapshotPayload> {
  const keyId = await keyFingerprint(key);
  const copy = structuredClone(payload) as SnapshotPayload;

  if (Array.isArray(copy.requests)) {
    for (const request of copy.requests as Record<string, unknown>[]) {
      if (Array.isArray(request.headers)) {
        request.headers = await encryptValue(key, JSON.stringify(request.headers));
      }
      if (typeof request.body === 'string' && request.body.length > 0) {
        request.body = await encryptValue(key, request.body);
      }
    }
  }

  const documents = copy.documents;
  if (documents && typeof documents === 'object' && !Array.isArray(documents)) {
    const encryptedDocuments: Record<string, unknown> = {};
    for (const [requestId, value] of Object.entries(documents as Record<string, unknown>)) {
      encryptedDocuments[requestId] = Array.isArray(value)
        ? await encryptValue(key, JSON.stringify(value))
        : value;
    }
    copy.documents = encryptedDocuments;
  }

  copy.encryption = {
    algorithm: 'AES-GCM',
    version: 1,
    keyId,
  } satisfies EncryptedEnvelope;
  return copy;
}

export async function decryptSnapshotPayload(
  payload: SnapshotPayload,
  key: string,
): Promise<SnapshotPayload> {
  if (!isEncryptedPayload(payload)) return payload;

  const envelope = payload.encryption as EncryptedEnvelope;
  const keyId = await keyFingerprint(key);
  if (envelope.keyId && envelope.keyId !== keyId) {
    throw new Error(`团队密钥不匹配：快照密钥指纹 ${envelope.keyId}，当前 ${keyId}`);
  }

  const copy = structuredClone(payload) as SnapshotPayload;

  if (Array.isArray(copy.requests)) {
    for (const request of copy.requests as Record<string, unknown>[]) {
      if (typeof request.headers === 'string' && isEncryptedValue(request.headers)) {
        request.headers = JSON.parse(await decryptValue(key, request.headers));
      }
      if (typeof request.body === 'string' && isEncryptedValue(request.body)) {
        request.body = await decryptValue(key, request.body);
      }
    }
  }

  const documents = copy.documents;
  if (documents && typeof documents === 'object' && !Array.isArray(documents)) {
    const decryptedDocuments: Record<string, unknown> = {};
    for (const [requestId, value] of Object.entries(documents as Record<string, unknown>)) {
      decryptedDocuments[requestId] =
        typeof value === 'string' && isEncryptedValue(value)
          ? JSON.parse(await decryptValue(key, value))
          : value;
    }
    copy.documents = decryptedDocuments;
  }

  delete copy.encryption;
  return copy;
}

function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

async function importAesKey(key: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(key);
  if (bytes.length !== 32) throw new Error('团队密钥长度不正确');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptValue(key: string, plaintext: string): Promise<string> {
  const aesKey = await importAesKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(cipher), iv.length);
  return `${ENCRYPTED_PREFIX}${bytesToBase64(combined)}`;
}

async function decryptValue(key: string, encrypted: string): Promise<string> {
  const payload = encrypted.slice(ENCRYPTED_PREFIX.length);
  const combined: Uint8Array<ArrayBuffer> = base64ToBytes(payload);
  const iv = new Uint8Array(combined.buffer, combined.byteOffset, 12);
  const cipher = new Uint8Array(combined.buffer, combined.byteOffset + 12);
  const aesKey = await importAesKey(key);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  return new TextDecoder().decode(plain);
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
