import { describe, expect, it } from 'vitest';
import type { RequestContext } from './docTask';
import { buildDocTask, buildFieldReview, extractJsonFields, glossary } from './docTask';

function pathsOf(source: string) {
  return extractJsonFields(source).map((field) => field.path);
}

function contextWithResponse(body: string): RequestContext {
  return {
    id: 'req-1',
    name: '订单列表',
    method: 'GET',
    url: 'https://example.com/orders',
    dataLevel: 'L1',
    headers: [],
    body: null,
    response: { status: 200, statusText: 'OK', body },
  };
}

describe('extractJsonFields', () => {
  it('解析顶层数组中的对象字段', () => {
    const paths = pathsOf('[{"id":1,"items":[{"sku":"A","count":2}]}]');

    expect(paths).toEqual(
      expect.arrayContaining(['[].id', '[].items', '[].items[].sku', '[].items[].count']),
    );
  });

  it('解析嵌套数组并合并不同元素的字段', () => {
    const fields = extractJsonFields(
      '{"code":0,"data":{"items":[{"sku":"A"},{"sku":"B","extra":true}]},"comments":["ok"]}',
    );
    const paths = fields.map((field) => field.path);

    expect(paths).toEqual(
      expect.arrayContaining(['code', 'data', 'data.items', 'data.items[].sku', 'data.items[].extra', 'comments']),
    );
    expect(fields.find((field) => field.path === 'data.items[].extra')?.type).toBe('boolean');
  });

  it('支持带注释、尾逗号和代码块的 JSON 示例', () => {
    const paths = pathsOf(
      '```json\n{\n  "code": 0, // 成功\n  "data": { "id": 1, },\n}\n```',
    );

    expect(paths).toEqual(expect.arrayContaining(['code', 'data', 'data.id']));
  });

  it('解析失败时退回容错扫描保留字段路径', () => {
    const fields = extractJsonFields('{\n  "id": 1,\n  "name": "demo"\n  // 缺少右括号');
    const paths = fields.map((field) => field.path);

    expect(paths).toEqual(expect.arrayContaining(['id', 'name']));
    expect(fields.every((field) => field.type === 'unknown')).toBe(true);
  });
});

describe('buildFieldReview', () => {
  it('为响应字段保留示例值', () => {
    const task = buildDocTask(
      contextWithResponse('{"data":{"items":[{"sku":"A","count":2}]}}'),
    );
    const review = buildFieldReview(task, glossary);
    const sku = review.find((field) => field.path === 'data.items[].sku');

    expect(sku?.sample).toBe('A');
    expect(sku?.source).toBe('响应');
  });

  it('识别注释、备注类字段并给出说明', () => {
    const task = buildDocTask(
      contextWithResponse('{"data":{"comment":"加急","remark":"工作日处理"}}'),
    );
    const review = buildFieldReview(task, glossary);

    expect(review.find((field) => field.path === 'data.comment')?.note).toContain('注释');
    expect(review.find((field) => field.path === 'data.remark')?.note).toContain('备注');
  });
});
