import { describe, expect, it } from 'vitest';
import {
  checkNetworkAccess,
  inIpv6Cidr,
  isSameSubnet,
  resolveHostCidrs,
} from './networkPolicy';

describe('networkPolicy', () => {
  it('A 模式只允许本机地址', () => {
    expect(checkNetworkAccess('http://127.0.0.1:8080/health', 'A').allowed).toBe(true);
    expect(checkNetworkAccess('http://192.168.1.10/api', 'A').allowed).toBe(false);
  });

  it('B 模式放行内网并拦截公网', () => {
    expect(checkNetworkAccess('http://192.168.1.10/api', 'B')).toMatchObject({
      allowed: true,
      scope: 'intranet',
    });
    expect(checkNetworkAccess('https://api.deepseek.com/chat', 'B')).toMatchObject({
      allowed: false,
      scope: 'public',
    });
  });

  it('C 模式允许访问公网', () => {
    expect(checkNetworkAccess('https://api.deepseek.com/chat', 'C').allowed).toBe(true);
  });

  it('按本机 CIDR 判断同网段', () => {
    expect(isSameSubnet('192.168.1.23', ['192.168.1.5/24'])).toBe(true);
    expect(isSameSubnet('192.168.2.23', ['192.168.1.5/24'])).toBe(false);
    expect(isSameSubnet('10.0.0.8', ['10.0.0.0/8'])).toBe(true);
  });

  it('支持 IPv6 网段判断', () => {
    expect(inIpv6Cidr('fd00::1', 'fd00::/8')).toBe(true);
    expect(inIpv6Cidr('2001:db8::1', 'fd00::/8')).toBe(false);
    expect(inIpv6Cidr('fe80::a1b2', 'fe80::/10')).toBe(true);
    expect(isSameSubnet('fd12::5', ['fd00::/8'])).toBe(true);
    expect(isSameSubnet('192.168.1.23', ['fd00::/8'])).toBe(false);
  });

  it('把字面量 IP 转为白名单 CIDR', async () => {
    await expect(resolveHostCidrs('http://32.26.139.82:8080')).resolves.toEqual([
      '32.26.139.82/32',
    ]);
    await expect(resolveHostCidrs('32.26.139.82:8080')).resolves.toEqual([
      '32.26.139.82/32',
    ]);
    await expect(resolveHostCidrs('http://[fd00::1]:8080')).resolves.toEqual([
      'fd00::1/128',
    ]);
    await expect(resolveHostCidrs('not a url')).resolves.toEqual([]);
  });

  it('非 Tauri 环境无法解析域名时返回空列表', async () => {
    await expect(resolveHostCidrs('http://team.local:8080')).resolves.toEqual([]);
  });
});
