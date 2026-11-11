import { describe, expect, it } from 'vitest';
import { describeBodyLines, extractBodyLineFields } from './bodyFields';
import { glossary } from './docTask';

describe('extractBodyLineFields', () => {
  it('把 JSON 字段映射到所在行并保留嵌套路径', () => {
    const body = [
      '{',
      '  "orderId": "A1",',
      '  "items": [',
      '    {',
      '      "sku": "sku-1",',
      '      "count": 2',
      '    }',
      '  ],',
      '  "meta": {',
      '    "note": ""',
      '  }',
      '}',
    ].join('\n');

    expect(extractBodyLineFields(body, 'json')).toEqual([
      { line: 1, path: 'orderId', name: 'orderId' },
      { line: 2, path: 'items', name: 'items' },
      { line: 4, path: 'items[].sku', name: 'sku' },
      { line: 5, path: 'items[].count', name: 'count' },
      { line: 8, path: 'meta', name: 'meta' },
      { line: 9, path: 'meta.note', name: 'note' },
    ]);
  });

  it('非法 JSON 也尽量给出字段行', () => {
    expect(extractBodyLineFields('{\n  "type": 1,\n}', 'json')).toEqual([
      { line: 1, path: 'type', name: 'type' },
    ]);
  });

  it('XML 按标签行映射', () => {
    const body = ['<root>', '  <order>', '    <amount>100</amount>', '  </order>', '</root>'].join(
      '\n',
    );

    expect(extractBodyLineFields(body, 'xml')).toEqual([
      { line: 0, path: 'root', name: 'root' },
      { line: 1, path: 'root.order', name: 'order' },
      { line: 2, path: 'root.order.amount', name: 'amount' },
    ]);
  });

  it('文本与空请求体返回空列表', () => {
    expect(extractBodyLineFields('plain text', 'text')).toEqual([]);
    expect(extractBodyLineFields('', 'json')).toEqual([]);
  });
});

describe('describeBodyLines', () => {
  const draft = [
    {
      key: '请求:orderId',
      path: 'orderId',
      type: 'string',
      source: '请求' as const,
      description: '订单编号，调用方生成',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  it('优先使用 AI 草稿说明，其次匹配术语表', () => {
    const body = '{\n  "orderId": "A1",\n  "amount": 100\n}';
    const notes = describeBodyLines(body, 'json', draft, glossary);

    expect(notes[0]).toMatchObject({ path: 'orderId', description: '订单编号，调用方生成' });
    expect(notes[1]).toMatchObject({ path: 'amount', description: '金额：最小货币单位（分）' });
  });

  it('响应来源的草稿不会套用到请求体', () => {
    const notes = describeBodyLines(
      '{\n  "status": 1\n}',
      'json',
      [{ ...draft[0], key: '响应:status', path: 'status', source: '响应' }],
      glossary,
    );

    expect(notes[0].description).toBe('状态：资源当前生命周期状态');
  });
});
