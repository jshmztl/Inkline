import type { NetworkMode } from '../data/types';
import { readNetworkOptions } from './network';

export type NetworkScope = 'local' | 'intranet' | 'public' | 'invalid';

export interface NetworkAccess {
  allowed: boolean;
  scope: NetworkScope;
  host: string;
  reason: string;
}

function isLoopback(host: string) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  );
}

function isPrivateIpv4(host: string) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isIntranetHost(host: string) {
  if (isLoopback(host) || isPrivateIpv4(host)) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare.includes(':') && /^(fc|fd|fe80)/.test(bare)) return true;
  if (!host.includes('.')) return true;
  return ['.internal', '.local', '.lan', '.corp', '.intra', '.home', '.svc'].some((suffix) =>
    host.endsWith(suffix),
  );
}

export function checkNetworkAccess(url: string, mode: NetworkMode): NetworkAccess {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return {
      allowed: false,
      scope: 'invalid',
      host: '',
      reason: `无法解析目标地址：${url}`,
    };
  }

  if (isLoopback(host)) {
    return { allowed: true, scope: 'local', host, reason: '本机地址' };
  }

  const whitelist = matchIntranetCidr(host);

  if (mode === 'C') {
    return {
      allowed: true,
      scope: isIntranetHost(host) || whitelist ? 'intranet' : 'public',
      host,
      reason: 'C 外网模式允许访问',
    };
  }

  if (mode === 'A') {
    return {
      allowed: false,
      scope: isIntranetHost(host) ? 'intranet' : 'public',
      host,
      reason: `A 离线模式只允许本机地址（localhost / 127.0.0.1），已阻止 ${host}`,
    };
  }

  if (whitelist) {
    return {
      allowed: true,
      scope: 'intranet',
      host,
      reason: `内网网段 ${whitelist}`,
    };
  }

  if (isIntranetHost(host)) {
    return { allowed: true, scope: 'intranet', host, reason: '内网地址' };
  }

  return {
    allowed: false,
    scope: 'public',
    host,
    reason: `B 内网模式已阻止 ${host}：跨网段内网地址请到「网络设置」添加内网网段，公网访问请切换到 C 外网`,
  };
}

interface NetworkProbe {
  hostIps: string[];
  localCidrs: string[];
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = ((value << 8) + octet) >>> 0;
  }
  return value >>> 0;
}

function inIpv4Cidr(ip: string, cidr: string): boolean {
  const [base, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const ipValue = ipv4ToNumber(ip);
  const baseValue = ipv4ToNumber(base);
  if (
    ipValue === null ||
    baseValue === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1) >>> 0);
  return ((ipValue & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

function isIpv6Address(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  return bare.includes(':') && /^[0-9a-fA-F:.%]+$/.test(bare);
}

function ipv6ToBigInt(value: string): bigint | null {
  let ip = value.trim().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return null;

  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = ipv4ToNumber(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;

  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) + BigInt(parseInt(group, 16));
  }
  return result;
}

export function inIpv6Cidr(ip: string, cidr: string): boolean {
  const [base, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;

  const ipValue = ipv6ToBigInt(ip);
  const baseValue = ipv6ToBigInt(base);
  if (ipValue === null || baseValue === null) return false;
  if (prefix === 0) return true;

  const shift = BigInt(128 - prefix);
  return ipValue >> shift === baseValue >> shift;
}

export function isSameSubnet(ip: string, localCidrs: string[]): boolean {
  const ipv6 = isIpv6Address(ip);
  return localCidrs.some((cidr) => {
    const base = cidr.split('/')[0];
    if (ipv6 !== isIpv6Address(base)) return false;
    return ipv6 ? inIpv6Cidr(ip, cidr) : inIpv4Cidr(ip, cidr);
  });
}

export function readIntranetCidrs(): string[] {
  return readNetworkOptions()
    .intranetCidrs.split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => {
      const [base, prefixText] = item.split('/');
      const prefix = Number(prefixText);
      if (!Number.isInteger(prefix)) return false;
      if (isIpv6Address(base)) return prefix >= 0 && prefix <= 128;
      return ipv4ToNumber(base) !== null && prefix >= 0 && prefix <= 32;
    });
}

function matchIntranetCidr(ip: string): string | null {
  const ipv6 = isIpv6Address(ip);
  if (!ipv6 && ipv4ToNumber(ip) === null) return null;

  for (const cidr of readIntranetCidrs()) {
    const base = cidr.split('/')[0];
    if (ipv6 !== isIpv6Address(base)) continue;
    if (ipv6 ? inIpv6Cidr(ip, cidr) : inIpv4Cidr(ip, cidr)) return cidr;
  }
  return null;
}

async function probeNetwork(url: string, mode: NetworkMode): Promise<NetworkProbe | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : 80;
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<NetworkProbe>('probe_network', {
      host: parsed.hostname.replace(/^\[|\]$/g, ''),
      port,
      mode,
    });
  } catch {
    return null;
  }
}

/**
 * B 内网模式下，除 RFC1918 私网地址外，还允许：
 * - 与任一本地网卡处于同一网段的目标 IP；
 * - 解析结果落在本机同网段或私网范围内的内网域名。
 * 浏览器模式无法读取本机网卡，退回纯网段规则。
 */
export async function checkNetworkAccessResolved(
  url: string,
  mode: NetworkMode,
): Promise<NetworkAccess> {
  const basic = checkNetworkAccess(url, mode);
  if (basic.allowed || basic.scope === 'invalid' || mode !== 'B') return basic;

  const probe = await probeNetwork(url, mode);
  if (!probe) return basic;

  const hostIsIp = ipv4ToNumber(basic.host) !== null || isIpv6Address(basic.host);
  const candidates = hostIsIp ? [basic.host] : probe.hostIps;

  for (const ip of candidates) {
    if (ipv4ToNumber(ip) !== null || isIpv6Address(ip)) {
      if (isSameSubnet(ip, probe.localCidrs)) {
        return {
          allowed: true,
          scope: 'intranet',
          host: basic.host,
          reason: `内网地址 · 与本地同网段（${ip}）`,
        };
      }
      const cidr = matchIntranetCidr(ip);
      if (cidr) {
        return {
          allowed: true,
          scope: 'intranet',
          host: basic.host,
          reason: `内网网段 ${cidr}${basic.host === ip ? '' : ` · ${ip}`}`,
        };
      }
    }
    if (isIntranetHost(ip)) {
      return {
        allowed: true,
        scope: 'intranet',
        host: basic.host,
        reason: `内网地址 · 解析到 ${ip}`,
      };
    }
  }

  return basic;
}
