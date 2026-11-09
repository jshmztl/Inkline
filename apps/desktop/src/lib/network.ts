export interface NetworkOptions {
  proxy: string;
  clientCertPath: string;
}

const STORAGE_KEY = 'aw-network-options';

export const defaultNetworkOptions: NetworkOptions = {
  proxy: '',
  clientCertPath: '',
};

export function readNetworkOptions(): NetworkOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultNetworkOptions };
    const parsed = JSON.parse(raw) as Partial<NetworkOptions>;
    return { ...defaultNetworkOptions, ...parsed };
  } catch {
    return { ...defaultNetworkOptions };
  }
}

export function writeNetworkOptions(options: NetworkOptions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // 本地存储不可用时仅保留内存配置。
  }
}
