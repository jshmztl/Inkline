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

/** 把本地设置与当前网络模式组装成 Rust 端可直接反序列化的结构。 */
export function backendNetworkOptions(mode: NetworkMode): BackendNetworkOptions {
  const options = readNetworkOptions();
  return {
    proxy: options.proxy,
    clientCertPath: options.clientCertPath,
    intranetCidrs: options.intranetCidrs
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean),
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
