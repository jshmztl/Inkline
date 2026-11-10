import { describe, expect, it } from 'vitest';
import { parsePostmanEnvironment } from './importer';

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
