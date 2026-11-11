import { describe, expect, it } from 'vitest';
import { looksLikeApiDoc, parseRequestDraft } from './requestDraft';

describe('parseRequestDraft', () => {
  it('解析完整接口 JSON 并归一化方法、请求头', () => {
    const raw = [
      '```json',
      JSON.stringify({
        name: '创建订单',
        method: 'post',
        url: 'https://api.internal/orders',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: '{"sku":"A1"}',
      }),
      '```',
    ].join('\n');

    expect(parseRequestDraft(raw)).toEqual({
      name: '创建订单',
      method: 'POST',
      url: 'https://api.internal/orders',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"sku":"A1"}',
    });
  });

  it('路径补全主机变量，对象请求头转为数组，对象请求体格式化', () => {
    const raw = JSON.stringify({
      method: 'PUT',
      url: '/api/users/1',
      headers: { Authorization: 'Bearer demo' },
      body: { nickname: '墨线' },
    });

    expect(parseRequestDraft(raw)).toEqual({
      name: 'PUT /api/users/1',
      method: 'PUT',
      url: '{{host}}/api/users/1',
      headers: [{ name: 'Authorization', value: 'Bearer demo' }],
      body: '{\n  "nickname": "墨线"\n}',
    });
  });

  it('缺少地址或无法解析时返回 null', () => {
    expect(parseRequestDraft('没有 JSON')).toBeNull();
    expect(parseRequestDraft(JSON.stringify({ method: 'GET' }))).toBeNull();
  });
});

describe('looksLikeApiDoc', () => {
  it('识别含有请求行或文档标签的接口说明', () => {
    expect(
      looksLikeApiDoc(
        '创建订单\nPOST /api/orders\n请求参数：sku 商品编码，num 数量\n响应示例：{"id": 1}',
      ),
    ).toBe(true);
    expect(
      looksLikeApiDoc(
        '接口名称：创建订单\n接口地址：https://api.internal/orders\n请求方式：POST\n请求参数见下表，包含商品编码与数量等字段说明。',
      ),
    ).toBe(true);
  });

  it('普通对话不触发解析', () => {
    expect(looksLikeApiDoc('为什么这个接口返回 401？')).toBe(false);
    expect(
      looksLikeApiDoc(
        '我在排查一个问题，某个接口 POST 请求一直失败，麻烦帮我看看可能是什么原因导致的，谢谢。',
      ),
    ).toBe(false);
  });
});
