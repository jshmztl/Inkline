import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 浏览器模式下由 api.ts 保存的模拟数据，不迁移进 SQLite。 */
const LEGACY_EXCLUDED_KEYS = new Set([
  'aw-request-history',
  'aw-saved-requests',
  'aw-collections',
]);

const MIGRATED_KEY = '__kv_migrated';
const SETTINGS_PREFIX = 'aw-';

const cache = new Map<string, string>();
const pending = new Set<string>();
const removed = new Set<string>();
let flushTimer: number | null = null;

function readLegacyStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(SETTINGS_PREFIX) || LEGACY_EXCLUDED_KEYS.has(key)) {
        continue;
      }
      const value = localStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
  } catch {
    // 浏览器存储不可用时返回已读取的部分。
  }
  return entries;
}

/**
 * 启动时预热设置缓存。
 * 桌面端从 SQLite 读取，并在首次启动时把旧 localStorage 数据迁入；
 * 浏览器模式继续使用 localStorage。
 */
export async function initKv(): Promise<void> {
  if (!isTauri) {
    for (const [key, value] of Object.entries(readLegacyStorage())) {
      cache.set(key, value);
    }
    return;
  }

  try {
    const stored = await invoke<Record<string, string>>('load_settings');
    for (const [key, value] of Object.entries(stored)) {
      cache.set(key, value);
    }

    if (!cache.has(MIGRATED_KEY)) {
      const legacy = readLegacyStorage();
      if (Object.keys(legacy).length > 0) {
        await invoke('save_settings', { entries: legacy });
        for (const [key, value] of Object.entries(legacy)) {
          cache.set(key, value);
        }
      }
      const marker = new Date().toISOString();
      await invoke('save_settings', { entries: { [MIGRATED_KEY]: marker } });
      cache.set(MIGRATED_KEY, marker);
    }
  } catch (error) {
    console.warn('加载本地设置失败，本次会话仅使用内存缓存', error);
  }
}

export function kvGet(key: string): string | null {
  return cache.get(key) ?? null;
}

export function kvSet(key: string, value: string): void {
  cache.set(key, value);

  if (!isTauri) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 浏览器存储不可用时仅保留在内存中。
    }
    return;
  }

  pending.add(key);
  scheduleFlush();
}

export function kvRemove(key: string): void {
  cache.delete(key);

  if (!isTauri) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 忽略浏览器存储清理失败。
    }
    return;
  }

  pending.delete(key);
  removed.add(key);
  scheduleFlush();
}

export function kvKeys(prefix: string): string[] {
  return [...cache.keys()].filter((key) => key.startsWith(prefix));
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushKv();
  }, 300);
}

/** 立即把待写入的设置刷进 SQLite；应用关闭前可主动调用。 */
export async function flushKv(): Promise<void> {
  if (!isTauri) return;

  const entries: Record<string, string> = {};
  for (const key of pending) {
    const value = cache.get(key);
    if (value !== undefined) entries[key] = value;
  }
  const removeKeys = [...removed];
  pending.clear();
  removed.clear();

  try {
    if (Object.keys(entries).length > 0) {
      await invoke('save_settings', { entries });
    }
    if (removeKeys.length > 0) {
      await invoke('delete_settings', { keys: removeKeys });
    }
  } catch (error) {
    for (const key of Object.keys(entries)) pending.add(key);
    for (const key of removeKeys) removed.add(key);
    console.warn('保存本地设置失败，稍后重试', error);
    if (flushTimer === null) {
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        void flushKv();
      }, 3000);
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void flushKv();
  });
}
