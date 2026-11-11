import { describe, expect, it } from 'vitest';
import { describeBodyFields, extractBodyFields } from './bodyFields';
import { glossary } from './docTask';

describe('extractBodyFields', () => {
  it('解析嵌套对象、数组与字段层级', () => {
    const body = JSON.stringify({
      orderId: 'A1',
      amount: 100,
      items: [{ sku: 'sku-1', count: 2 }],
      meta: { note: '' },
    });

    const fields = extractBodyFields(body, 'json');
    expect(fields.map((field) => field.path)).toEqual([
      'orderId',
      'amount',
      'items',
      'items[]',
      'items[].sku',
      'items[].count',
      'meta',
      'meta.note',
    ]);
    expect(fields.find((field) => field.path === 'items')?.type).toBe('array');
    expect(fields.find((field) => field.path === 'items[].sku')?.depth).toBe(2);
    expect(fields.find((field) => field.path === 'items[].sku')?.name).toBe('sku');
    expect(fields.find((field) => field.path === 'amount')?.type).toBe('integer');
  });

  it('非法 JSON 与非结构化模式返回空列表', () => {
    expect(extractBodyFields('{bad', 'json')).toEqual([]);
    expect(extractBodyFields('a=1', 'form')).toEqual([]);
    expect(extractBodyFields('', 'json')).toEqual([]);
  });
});

describe('describeBodyFields', () => {
  it('优先使用 AI 草稿说明，其次匹配术语表', () => {
    const fields = extractBodyFields(JSON.stringify({ orderId: 'A1', amount: 100 }), 'json');
    const notes = describeBodyFields(
      fields,
      [
        {
          key: '请求:orderId',
          path: 'orderId',
          type: 'string',
          source: '请求',
          description: '订单编号，调用方生成',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      glossary,
    );

    expect(notes[0].description).toBe('订单编号，调用方生成');
    expect(notes[1].description).toBe('金额：最小货币单位（分）');
  });

  it('响应字段的草稿不会套用到请求体', () => {
    const fields = extractBodyFields(JSON.stringify({ status: 1 }), 'json');
    const notes = describeBodyFields(
      fields,
      [
        {
          key: '响应:status',
          path: 'status',
          type: 'integer',
          source: '响应',
          description: '响应里的状态',
          updatedAt: '',
        },
      ],
      glossary,
    );

    expect(notes[0].description).toBe('状态：资源当前生命周期状态');
  });
});
