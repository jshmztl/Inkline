import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export const APP_VERSION = __APP_VERSION__;

export interface UpdateInfo {
  current: string;
  latest: string;
  notes: string;
  date: string;
  available: boolean;
  runtime: 'tauri' | 'browser';
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

let pendingUpdate: Update | null = null;

function describeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/error sending request|failed to fetch|network|connect/i.test(text)) {
    return '无法连接更新源，请检查网络或使用内网更新地址。';
  }
  return text;
}

export async function checkUpdate(): Promise<UpdateInfo> {
  if (!isTauri()) {
    return {
      current: APP_VERSION,
      latest: APP_VERSION,
      notes: '浏览器预览不支持自动更新，请在桌面端检查。',
      date: '',
      available: false,
      runtime: 'browser',
    };
  }

  const current = await getVersion();

  try {
    const update = await check();
    pendingUpdate = update;

    if (!update) {
      return {
        current,
        latest: current,
        notes: '当前已是最新版本。',
        date: '',
        available: false,
        runtime: 'tauri',
      };
    }

    return {
      current,
      latest: update.version,
      notes: update.body ?? '',
      date: update.date ?? '',
      available: true,
      runtime: 'tauri',
    };
  } catch (error) {
    throw new Error(describeError(error));
  }
}

export async function installUpdate(onProgress: (progress: UpdateProgress) => void) {
  if (!pendingUpdate) {
    throw new Error('没有可安装的更新，请重新检查。');
  }

  let downloaded = 0;
  let total: number | null = null;
  onProgress({ downloaded, total });

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null;
        onProgress({ downloaded, total });
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
      } else {
        onProgress({ downloaded: total ?? downloaded, total });
      }
    });
  } finally {
    pendingUpdate = null;
  }

  await relaunch();
}
