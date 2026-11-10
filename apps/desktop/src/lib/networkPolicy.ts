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

export function isSameSubnet(ip: string, localCidrs: string[]): boolean {
  return localCidrs.some((cidr) => inIpv4Cidr(ip, cidr));
}

export function readIntranetCidrs(): string[] {
  return readNetworkOptions()
    .intranetCidrs.split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => {
      const [base, prefixText] = item.split('/');
      const prefix = Number(prefixText);
      return (
        ipv4ToNumber(base) !== null &&
        Number.isInteger(prefix) &&
        prefix >= 0 &&
        prefix <= 32
      );
    });
}

function matchIntranetCidr(ip: string): string | null {
  if (ipv4ToNumber(ip) === null) return null;
  for (const cidr of readIntranetCidrs()) {
    if (inIpv4Cidr(ip, cidr)) return cidr;
  }
  return null;
}

async function probeNetwork(url: string): Promise<NetworkProbe | null> {
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

  const probe = await probeNetwork(url);
  if (!probe) return basic;

  const hostIsIpv4 = ipv4ToNumber(basic.host) !== null;
  const candidates = hostIsIpv4 ? [basic.host] : probe.hostIps;

  for (const ip of candidates) {
    if (ipv4ToNumber(ip) !== null) {
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
