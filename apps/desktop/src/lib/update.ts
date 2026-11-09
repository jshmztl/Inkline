export interface UpdateInfo {
  current: string;
  latest: string;
  notes: string;
  url: string;
  available: boolean;
  simulated: boolean;
}

export const APP_VERSION = '0.1.0';

const UPDATE_ENDPOINT = 'https://updates.example.com/api-workbench/latest.json';

function compareVersion(a: string, b: string) {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkUpdate(): Promise<UpdateInfo> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(UPDATE_ENDPOINT, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as {
      version?: string;
      notes?: string;
      url?: string;
    };
    const latest = data.version ?? APP_VERSION;
    return {
      current: APP_VERSION,
      latest,
      notes: data.notes ?? '',
      url: data.url ?? '',
      available: compareVersion(latest, APP_VERSION) > 0,
      simulated: false,
    };
  } catch {
    return {
      current: APP_VERSION,
      latest: APP_VERSION,
      notes: '无法连接更新服务，当前为离线或内网未配置更新源。',
      url: '',
      available: false,
      simulated: true,
    };
  } finally {
    window.clearTimeout(timer);
  }
}
