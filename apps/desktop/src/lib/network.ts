import { kvGet, kvSet } from './kv';

export interface NetworkOptions {
  proxy: string;
  clientCertPath: string;
  intranetCidrs: string;
  acceptInvalidCerts: boolean;
  followRedirects: boolean;
}

const STORAGE_KEY = 'aw-network-options';

export const defaultNetworkOptions: NetworkOptions = {
  proxy: '',
  clientCertPath: '',
  intranetCidrs: '',
  acceptInvalidCerts: false,
  followRedirects: true,
};

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

export function writeNetworkOptions(options: NetworkOptions) {
  try {
    kvSet(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // 本地存储不可用时仅保留内存配置。
  }
}
