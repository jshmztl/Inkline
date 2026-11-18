import type { NetworkMode } from '../data/types';
import { kvGet, kvSet } from './kv';

export interface NetworkOptions {
  proxy: string;
  clientCertPath: string;
  intranetCidrs: string;
  acceptInvalidCerts: boolean;
  followRedirects: boolean;
}

/** Rust 命令接收的网络策略参数。 */
export interface BackendNetworkOptions {
  proxy: string;
  clientCertPath: string;
  intranetCidrs: string[];
  acceptInvalidCerts: boolean;
  followRedirects: boolean;
  mode: NetworkMode;
}

const STORAGE_KEY = 'aw-network-options';
const MODE_STORAGE_KEY = 'aw-network-mode';

export const defaultNetworkOptions: NetworkOptions = {
  proxy: '',
  clientCertPath: '',
  intranetCidrs: '',
  acceptInvalidCerts: false,
  followRedirects: true,
};

let activeNetworkMode: NetworkMode = 'B';

/** 供不经过请求面板的模块（团队同步、在线状态）读取当前全局网络模式。 */
export function setActiveNetworkMode(mode: NetworkMode) {
  activeNetworkMode = mode;
}

export function currentNetworkMode(): NetworkMode {
  return activeNetworkMode;
}

export function readNetworkMode(): NetworkMode {
  const stored = kvGet(MODE_STORAGE_KEY);
  return stored === 'A' || stored === 'C' ? stored : 'B';
}

/** 唯一写入口：同步模块级模式并持久化，避免切换后立即登录仍按旧模式出站。 */
export function writeNetworkMode(mode: NetworkMode) {
  activeNetworkMode = mode;
  try {
    kvSet(MODE_STORAGE_KEY, mode);
  } catch {
    // 本地存储不可用时仅保留内存状态。
  }
}

export function readNetworkOptions(): NetworkOptions {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { ...defaultNetworkOptions };
    const parsed = JSON.parse(raw) as Partial<NetworkOptions>;
    return { ...defaultNetworkOptions, ...parsed };
  } catch {
    return { ...defaultNetworkOptions };
  }
}

export function parseCidrText(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 把本地设置与当前网络模式组装成 Rust 端可直接反序列化的结构。 */
export function backendNetworkOptions(mode: NetworkMode): BackendNetworkOptions {
  const options = readNetworkOptions();
  return {
    proxy: options.proxy,
    clientCertPath: options.clientCertPath,
    intranetCidrs: parseCidrText(options.intranetCidrs),
    acceptInvalidCerts: options.acceptInvalidCerts,
    followRedirects: options.followRedirects,
    mode,
  };
}

export function writeNetworkOptions(options: NetworkOptions) {
  try {
    kvSet(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // 本地存储不可用时仅保留内存配置。
  }
}

/** 把登录时遇到的团队服务地址加入 B 模式内网白名单，返回合并后的完整列表。 */
export function addIntranetCidrs(cidrs: string[]): string[] {
  const options = readNetworkOptions();
  const existing = parseCidrText(options.intranetCidrs);
  const seen = new Set(existing.map((item) => item.toLowerCase()));
  const merged = [...existing];

  for (const raw of cidrs) {
    const cidr = raw.trim();
    const normalized = cidr.toLowerCase();
    if (!cidr || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(cidr);
  }

  writeNetworkOptions({ ...options, intranetCidrs: merged.join('\n') });
  return merged;
}
