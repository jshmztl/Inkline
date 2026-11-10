import type { NetworkMode } from '../data/types';

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
  if (/^\[(fc|fd|fe80)/.test(host)) return true;
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

  if (mode === 'C') {
    return {
      allowed: true,
      scope: isIntranetHost(host) ? 'intranet' : 'public',
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

  if (isIntranetHost(host)) {
    return { allowed: true, scope: 'intranet', host, reason: '内网地址' };
  }

  return {
    allowed: false,
    scope: 'public',
    host,
    reason: `B 内网模式禁止访问公网地址 ${host}，请切换到 C 外网或改用内网地址`,
  };
}
