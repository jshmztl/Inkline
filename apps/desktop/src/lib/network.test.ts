import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kvRemove, kvSet } from './kv';
import {
  addIntranetCidrs,
  currentNetworkMode,
  parseCidrText,
  readNetworkMode,
  readNetworkOptions,
  writeNetworkMode,
  writeNetworkOptions,
} from './network';

describe('network mode', () => {
  beforeEach(() => {
    kvRemove('aw-network-mode');
    kvRemove('aw-network-options');
    writeNetworkMode('B');
  });

  afterEach(() => {
    writeNetworkMode('B');
    kvRemove('aw-network-mode');
    kvRemove('aw-network-options');
  });

  it('缺少或非法配置时回落 B', () => {
    expect(readNetworkMode()).toBe('B');
    kvSet('aw-network-mode', 'D');
    expect(readNetworkMode()).toBe('B');
  });

  it('写入模式后持久化并同步模块级状态', () => {
    writeNetworkMode('A');
    expect(readNetworkMode()).toBe('A');
    expect(currentNetworkMode()).toBe('A');

    writeNetworkMode('C');
    expect(readNetworkMode()).toBe('C');
    expect(currentNetworkMode()).toBe('C');
  });

  it('解析多分隔符的白名单文本', () => {
    expect(parseCidrText('10.0.0.0/8\n192.168.0.0/16, 172.16.0.0/12;203.0.113.10/32')).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
      '172.16.0.0/12',
      '203.0.113.10/32',
    ]);
    expect(parseCidrText(' \n , ; ')).toEqual([]);
  });

  it('加入白名单时去重并保留已有顺序', () => {
    writeNetworkOptions({
      ...readNetworkOptions(),
      intranetCidrs: '10.0.0.0/8\n192.168.1.0/24',
    });

    const merged = addIntranetCidrs(['192.168.1.0/24', '203.0.113.82/32']);
    expect(merged).toEqual(['10.0.0.0/8', '192.168.1.0/24', '203.0.113.82/32']);
    expect(parseCidrText(readNetworkOptions().intranetCidrs)).toEqual(merged);
  });

  it('IPv6 白名单按大小写不敏感去重', () => {
    writeNetworkOptions({
      ...readNetworkOptions(),
      intranetCidrs: 'FD00::/8',
    });

    expect(addIntranetCidrs(['fd00::/8'])).toEqual(['FD00::/8']);
  });
});
