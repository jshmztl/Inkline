import { describe, expect, it } from 'vitest';
import {
  decryptSnapshotPayload,
  encryptSnapshotPayload,
  generateTeamKey,
  isValidTeamKey,
  keyFingerprint,
} from './teamCrypto';

const payload = {
  schemaVersion: 2,
  collections: [{ id: 'c1', name: '订单服务', sort: 0, parentId: null }],
  requests: [
    {
      id: 'r1',
      name: '创建订单',
      method: 'POST',
      url: 'https://api.internal/orders',
      headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      body: '{"amount":100}',
      dataLevel: 'L1',
      collectionId: 'c1',
    },
  ],
  documents: {
    r1: [{ key: 'amount', path: 'amount', type: 'number', description: '金额' }],
  },
};

describe('teamCrypto', () => {
  it('round-trips sensitive snapshot fields', async () => {
    const key = await generateTeamKey();
    expect(isValidTeamKey(key)).toBe(true);

    const encrypted = await encryptSnapshotPayload(structuredClone(payload), key);
    const request = (encrypted.requests as Record<string, unknown>[])[0];
    expect(String(request.headers)).toMatch(/^enc:v1:/);
    expect(String(request.body)).toMatch(/^enc:v1:/);
    expect(typeof (encrypted.documents as Record<string, unknown>).r1).toBe('string');
    expect(encrypted.collections).toEqual(payload.collections);

    const decrypted = await decryptSnapshotPayload(encrypted, key);
    expect(decrypted).toEqual(payload);
  });

  it('rejects a different key', async () => {
    const key = await generateTeamKey();
    const other = await generateTeamKey();
    const encrypted = await encryptSnapshotPayload(structuredClone(payload), key);
    await expect(decryptSnapshotPayload(encrypted, other)).rejects.toThrow(/密钥不匹配/);
  });

  it('keeps plaintext payloads untouched', async () => {
    const key = await generateTeamKey();
    const decrypted = await decryptSnapshotPayload(structuredClone(payload), key);
    expect(decrypted).toEqual(payload);
  });

  it('fingerprints are stable and key-specific', async () => {
    const key = await generateTeamKey();
    const other = await generateTeamKey();
    expect(await keyFingerprint(key)).toBe(await keyFingerprint(key));
    expect(await keyFingerprint(key)).not.toBe(await keyFingerprint(other));
  });
});
