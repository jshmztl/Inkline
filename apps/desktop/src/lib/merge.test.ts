import { describe, expect, it } from 'vitest';

import type { SavedRequest } from './api';
import { planThreeWayMerge } from './merge';

function request(id: string, overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id,
    name: `请求 ${id}`,
    method: 'GET',
    url: `http://127.0.0.1/${id}`,
    headers: [],
    body: null,
    dataLevel: 'L1',
    updatedAt: null,
    ...overrides,
  };
}

describe('planThreeWayMerge', () => {
  it('无冲突时分别归类本地与远端改动', () => {
    const base = [request('a'), request('b'), request('c')];
    const local = [
      request('a', { url: 'http://127.0.0.1/a?local=1' }),
      request('b'),
      request('c'),
    ];
    const remote = [request('a'), request('b', { method: 'POST' }), request('c')];

    const plan = planThreeWayMerge(base, local, remote);

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.localChanges.map((item) => item.id)).toEqual(['a']);
    expect(plan.remoteChanges.map((item) => item.id)).toEqual(['b']);
    expect(plan.identical).toBe(1);
  });

  it('同一字段双方改成不同值时产生冲突', () => {
    const base = [request('a')];
    const local = [request('a', { url: 'http://127.0.0.1/local' })];
    const remote = [request('a', { url: 'http://127.0.0.1/remote' })];

    const plan = planThreeWayMerge(base, local, remote);

    expect(plan.localChanges).toHaveLength(0);
    expect(plan.remoteChanges).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].fields.map((field) => field.field)).toEqual(['url']);
    expect(plan.conflicts[0].local.url).toBe('http://127.0.0.1/local');
    expect(plan.conflicts[0].remote.url).toBe('http://127.0.0.1/remote');
  });

  it('双方改动不同字段时按本地版本自动合并', () => {
    const base = [request('a')];
    const local = [request('a', { name: '本地改名' })];
    const remote = [request('a', { url: 'http://127.0.0.1/remote' })];

    const plan = planThreeWayMerge(base, local, remote);

    // 本地先改的字段与远端改动不重叠，仍按本地版本保留，不生成冲突。
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.localChanges.map((item) => item.name)).toEqual(['本地改名']);
  });

  it('远端新增的请求进入远端改动，本地删除的请求不会复活', () => {
    const base = [request('a')];
    const local: SavedRequest[] = [];
    const remote = [request('a'), request('new')];

    const plan = planThreeWayMerge(base, local, remote);

    // 本地已删除的请求不会被远端旧版本复活，也不计入待合并改动。
    expect(plan.localChanges).toHaveLength(0);
    expect(plan.remoteChanges.map((item) => item.id)).toEqual(['new']);
    expect(plan.conflicts).toHaveLength(0);
  });
});
