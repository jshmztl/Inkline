import { describe, expect, it } from 'vitest';
import { buildRequestFingerprint, truncateResponseBody } from './responseCache';

describe('buildRequestFingerprint', () => {
  it('ignores header order and case', () => {
    const first = buildRequestFingerprint({
      method: 'get',
      url: 'https://example.com/api',
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'X-Trace', value: '1' },
      ],
      body: '{"a":1}',
    });
    const second = buildRequestFingerprint({
      method: 'GET',
      url: 'https://example.com/api',
      headers: [
        { name: 'x-trace', value: '1' },
        { name: 'accept', value: 'application/json' },
      ],
      body: '{"a":1}',
    });
    expect(first).toBe(second);
  });

  it('changes when the request changes', () => {
    const base = {
      method: 'POST',
      url: 'https://example.com/api',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"a":1}',
    };
    const original = buildRequestFingerprint(base);
    expect(
      buildRequestFingerprint({ ...base, url: 'https://example.com/v2' }),
    ).not.toBe(original);
    expect(buildRequestFingerprint({ ...base, body: '{"a":2}' })).not.toBe(original);
    expect(
      buildRequestFingerprint({
        ...base,
        headers: [{ name: 'Content-Type', value: 'text/plain' }],
      }),
    ).not.toBe(original);
  });
});

describe('truncateResponseBody', () => {
  it('keeps small bodies unchanged', () => {
    expect(truncateResponseBody('hello', 10)).toEqual({
      body: 'hello',
      truncated: false,
    });
  });

  it('truncates large bodies and marks them', () => {
    const result = truncateResponseBody('abcdef', 3);
    expect(result.body).toBe('abc');
    expect(result.truncated).toBe(true);
  });

  it('truncates by characters for non-ASCII bodies', () => {
    const result = truncateResponseBody('中文响应', 2);
    expect(result.body).toBe('中文');
    expect(result.truncated).toBe(true);
  });
});
