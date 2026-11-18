import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { kvGet, kvRemove, kvSet } from './kv';

export const APP_VERSION = __APP_VERSION__;

export type UpdateSource = 'domestic' | 'github';

export const UPDATE_SOURCE_KEY = 'aw-update-source';

export function readUpdateSource(): UpdateSource {
  return kvGet(UPDATE_SOURCE_KEY) === 'github' ? 'github' : 'domestic';
}

export function writeUpdateSource(source: UpdateSource) {
  kvSet(UPDATE_SOURCE_KEY, source);
}

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

export interface KnownUpdate {
  version: string;
  notes: string;
  date: string;
}

const KNOWN_UPDATE_KEY = 'aw-update-known';
const NOTIFIED_UPDATE_KEY = 'aw-update-notified';

let pendingUpdate: Update | null = null;

/** 读取上次检查到的可用更新，供离线/内网模式下的红点提醒使用。 */
export function readKnownUpdate(): KnownUpdate | null {
  const raw = kvGet(KNOWN_UPDATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<KnownUpdate>;
    if (!parsed.version) return null;
    return {
      version: parsed.version,
      notes: parsed.notes ?? '',
      date: parsed.date ?? '',
    };
  } catch {
    return null;
  }
}

function rememberKnownUpdate(info: UpdateInfo) {
  if (!info.available) {
    kvRemove(KNOWN_UPDATE_KEY);
    return;
  }
  kvSet(
    KNOWN_UPDATE_KEY,
    JSON.stringify({
      version: info.latest,
      notes: info.notes,
      date: info.date,
    } satisfies KnownUpdate),
  );
}

export function forgetKnownUpdate() {
  kvRemove(KNOWN_UPDATE_KEY);
}

export function wasUpdateNotified(version: string): boolean {
  return kvGet(NOTIFIED_UPDATE_KEY) === version;
}

export function markUpdateNotified(version: string) {
  kvSet(NOTIFIED_UPDATE_KEY, version);
}

function describeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/error sending request|failed to fetch|network|connect/i.test(text)) {
    return '无法连接更新源，请检查网络或使用内网更新地址。';
  }
  return text;
}

export async function checkUpdate(source: UpdateSource = readUpdateSource()): Promise<UpdateInfo> {
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
    const update = await check({
      headers: { 'X-Inkline-Update-Source': source },
      timeout: 20000,
    });
    pendingUpdate = update;

    if (!update) {
      const info: UpdateInfo = {
        current,
        latest: current,
        notes: '当前已是最新版本。',
        date: '',
        available: false,
        runtime: 'tauri',
      };
      rememberKnownUpdate(info);
      return info;
    }

    const info: UpdateInfo = {
      current,
      latest: update.version,
      notes: update.body ?? '',
      date: update.date ?? '',
      available: true,
      runtime: 'tauri',
    };
    rememberKnownUpdate(info);
    return info;
  } catch (error) {
    throw new Error(describeError(error));
  }
}

async function downloadAndInstall(
  update: Update,
  onProgress: (progress: UpdateProgress) => void,
) {
  let downloaded = 0;
  let total: number | null = null;
  onProgress({ downloaded, total });

  await update.downloadAndInstall((event) => {
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
}

export async function installUpdate(
  onProgress: (progress: UpdateProgress) => void,
  source: UpdateSource = readUpdateSource(),
) {
  if (!pendingUpdate) {
    throw new Error('没有可安装的更新，请重新检查。');
  }

  try {
    try {
      await downloadAndInstall(pendingUpdate, onProgress);
    } catch (error) {
      if (source !== 'domestic') throw error;

      // 国内镜像下载失败时，自动改用 GitHub 直连再试一次。
      const failed = pendingUpdate;
      pendingUpdate = null;
      try {
        await failed?.close();
      } catch {
        // 忽略资源释放失败。
      }

      const fallback = await checkUpdate('github');
      if (!fallback.available || !pendingUpdate) throw error;
      onProgress({ downloaded: 0, total: null });
      await downloadAndInstall(pendingUpdate, onProgress);
    }
  } finally {
    pendingUpdate = null;
  }

  forgetKnownUpdate();
  await relaunch();
}
