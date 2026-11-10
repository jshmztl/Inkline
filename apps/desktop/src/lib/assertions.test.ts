import { describe, expect, it } from 'vitest';
import { assertionActual, evaluateAssertions } from './assertions';
import type { SendResponse } from './api';

const response: SendResponse = {
  status: 200,
  statusText: 'OK',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: JSON.stringify({ data: { id: 42, tags: ['a', 'b'] }, ok: true }),
  durationMs: 12,
  sizeBytes: 100,
};

describe('assertions', () => {
  it('读取状态码、响应头与 JSON 路径', () => {
    expect(assertionActual(response, 'status')).toBe(200);
    expect(assertionActual(response, 'body.data.id')).toBe(42);
    expect(assertionActual(response, 'headers.content-type')).toBe('application/json');
  });

  it('按操作符评估断言结果', () => {
    const results = evaluateAssertions(
      [
        { id: '1', path: 'status', operator: 'equals', expected: '200', enabled: true },
        { id: '2', path: 'body.data.tags', operator: 'contains', expected: 'a', enabled: true },
        { id: '3', path: 'body.data.id', operator: 'gt', expected: '40', enabled: true },
        { id: '4', path: 'body.missing', operator: 'notExists', expected: '', enabled: true },
      ],
      response,
    );

    expect(results).toHaveLength(4);
    expect(results.every((item) => item.passed)).toBe(true);
  });

  it('未启用的断言不参与评估', () => {
    const results = evaluateAssertions(
      [{ id: '1', path: 'status', operator: 'equals', expected: '500', enabled: false }],
      response,
    );

    expect(results).toHaveLength(0);
  });

  it('支持正则与类型断言', () => {
    const results = evaluateAssertions(
      [
        { id: '1', path: 'body.ok', operator: 'matches', expected: '^(true|false)$', enabled: true },
        { id: '2', path: 'body.data.tags', operator: 'typeIs', expected: 'array', enabled: true },
        { id: '3', path: 'body.data.id', operator: 'typeIs', expected: 'number', enabled: true },
        { id: '4', path: 'body.missing', operator: 'typeIs', expected: 'undefined', enabled: true },
      ],
      response,
    );

    expect(results.every((item) => item.passed)).toBe(true);
  });
});
