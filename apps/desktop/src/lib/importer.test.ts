import { describe, expect, it } from 'vitest';
import { exportCollection, parsePostmanEnvironment } from './importer';
import type { SavedRequest } from './api';
import type { DraftField } from './docTask';

const sampleRequest: SavedRequest = {
  id: 'req-1',
  name: '创建订单',
  method: 'POST',
  url: '{{host}}/orders',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: '{"sku":"A100"}',
  dataLevel: 'L1',
  collectionId: 'col-1',
  sort: 1,
  updatedAt: null,
};

const sampleFields: DraftField[] = [
  {
    key: '请求:sku',
    path: 'sku',
    type: 'string',
    source: '请求',
    description: '商品编码',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('exportCollection 文档导出', () => {
  it('Markdown 包含接口、请求体与字段说明', () => {
    const markdown = exportCollection('订单服务', [sampleRequest], 'markdown', {
      'req-1': sampleFields,
    });

    expect(markdown).toContain('# 订单服务');
    expect(markdown).toContain('## 创建订单');
    expect(markdown).toContain('```json');
    expect(markdown).toContain('商品编码');
    expect(markdown).toContain('L1 · 内部');
  });

  it('HTML 转义字段内容并包含表格', () => {
    const html = exportCollection('订单服务', [sampleRequest], 'html', {
      'req-1': [
        { ...sampleFields[0], description: '<script>alert(1)</script>' },
      ],
    });

    expect(html).toContain('<table>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('parsePostmanEnvironment', () => {
  it('解析 Postman 环境变量并跳过禁用项', () => {
    const raw = JSON.stringify({
      name: '内网测试',
      values: [
        { key: 'host', value: 'http://192.168.1.20:8080', enabled: true },
        { key: 'token', value: 'abc', enabled: true },
        { key: 'disabled', value: 'x', enabled: false },
      ],
    });

    expect(parsePostmanEnvironment(raw)).toEqual({
      name: '内网测试',
      variables: {
        host: 'http://192.168.1.20:8080',
        token: 'abc',
      },
    });
  });

  it('非环境 JSON 返回 null', () => {
    expect(parsePostmanEnvironment(JSON.stringify({ info: {}, item: [] }))).toBeNull();
    expect(parsePostmanEnvironment('not json')).toBeNull();
  });

  it('没有可用变量时返回 null', () => {
    const raw = JSON.stringify({
      name: '空环境',
      values: [{ key: 'a', value: '1', enabled: false }],
    });
    expect(parsePostmanEnvironment(raw)).toBeNull();
  });
});
