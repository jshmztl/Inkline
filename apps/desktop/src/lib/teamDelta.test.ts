import { describe, expect, it } from 'vitest';
import type { Collection, SavedRequest } from './api';
import { buildDeltaPayload, buildSnapshotDelta, type TeamSnapshot } from './team';

function request(id: string, name: string, extra: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id,
    name,
    method: 'GET',
    url: `{{host}}/${id}`,
    headers: [],
    body: null,
    dataLevel: 'L1',
    collectionId: 'c1',
    sort: 1,
    updatedAt: null,
    ...extra,
  };
}

function baseSnapshot(): TeamSnapshot {
  const collections: Collection[] = [{ id: 'c1', name: '订单服务', sort: 0 }];
  return {
    revision: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
    pushedBy: 'admin',
    workspace: '订单中台',
    collections,
    requests: [request('r1', '创建订单'), request('r2', '订单详情')],
    documents: { r1: [{ key: '请求:sku', path: 'sku', type: 'string', source: '请求', description: '商品编码', updatedAt: '' }] },
  };
}

describe('buildSnapshotDelta', () => {
  it('只返回变更的集合、接口与文档', () => {
    const base = baseSnapshot();
    const collections: Collection[] = [{ id: 'c1', name: '订单中心', sort: 0 }];
    const requests = [
      request('r1', '创建订单（改名）'),
      request('r3', '取消订单'),
    ];
    const documents = {
      r1: [{ key: '请求:sku', path: 'sku', type: 'string' as const, source: '请求' as const, description: '商品编码（更新）', updatedAt: '' }],
    };

    const delta = buildSnapshotDelta(base, collections, requests, documents);
    expect(delta.collections.map((item) => item.id)).toEqual(['c1']);
    expect(delta.requests.map((item) => item.id)).toEqual(['r1', 'r3']);
    expect(delta.deletions.requests).toEqual(['r2']);
    expect(delta.deletions.collections).toEqual([]);
    expect(Object.keys(delta.documents)).toEqual(['r1']);
    expect(delta.deletions.documents).toEqual([]);
    expect(delta.changed).toBe(5);
  });

  it('没有变更时不产生增量', () => {
    const base = baseSnapshot();
    const delta = buildSnapshotDelta(
      base,
      base.collections ?? [],
      base.requests,
      base.documents,
    );
    expect(delta.changed).toBe(0);
  });

  it('增量 payload 带有 partial 标记与删除列表', () => {
    const payload = buildDeltaPayload(
      {
        collections: [],
        requests: [request('r1', '改名')],
        documents: {},
        deletions: { collections: [], requests: ['r2'], documents: [] },
        changed: 2,
      },
      7,
    );
    expect(payload).toMatchObject({
      schemaVersion: 2,
      partial: true,
      baseRevision: 7,
      deletions: { requests: ['r2'] },
    });
  });
});
