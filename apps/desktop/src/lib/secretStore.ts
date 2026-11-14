import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const cache = new Map<string, string>();
const pending = new Set<string>();
const removed = new Set<string>();
let flushTimer: number | null = null;
let lastErrorAt = 0;

function notifyError(error: unknown) {
  const now = Date.now();
  if (now - lastErrorAt < 60_000) return;
  lastErrorAt = now;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('aw-secret-error', {
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function rustLoad(key: string): Promise<string | null> {
  return invoke<string | null>('load_secret', { key });
}

async function rustSave(key: string, value: string): Promise<void> {
  await invoke('save_secret', { key, value });
}

async function rustDelete(key: string): Promise<void> {
  await invoke('delete_secret', { key });
}

function memoryGet(key: string): string | null {
  return cache.get(key) ?? null;
}

/** 同步读取已hydrate的密钥；未加载时返回 null。 */
export function secretGet(key: string): string | null {
  return memoryGet(key);
}

export function secretSet(key: string, value: string): void {
  cache.set(key, value);
  if (!isTauri) {
    try {
      localStorage.setItem(`aw-secret:${key}`, value);
    } catch {
      // 浏览器存储不可用时仅保留在内存中。
    }
    return;
  }
  pending.add(key);
  removed.delete(key);
  scheduleFlush();
}

export function secretRemove(key: string): void {
  cache.delete(key);
  if (!isTauri) {
    try {
      localStorage.removeItem(`aw-secret:${key}`);
    } catch {
      // 忽略浏览器存储清理失败。
    }
    return;
  }
  pending.delete(key);
  removed.add(key);
  scheduleFlush();
}

export function secretKeys(prefix: string): string[] {
  return [...cache.keys()].filter((key) => key.startsWith(prefix));
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushSecrets();
  }, 300);
}

export async function flushSecrets(): Promise<boolean> {
  if (!isTauri) return true;

  const entries: Array<[string, string]> = [];
  for (const key of pending) {
    const value = cache.get(key);
    if (value !== undefined) entries.push([key, value]);
  }
  const removeKeys = [...removed];
  pending.clear();
  removed.clear();

  try {
    for (const [key, value] of entries) {
      await rustSave(key, value);
    }
    for (const key of removeKeys) {
      await rustDelete(key);
    }
    return true;
  } catch (error) {
    for (const [key] of entries) pending.add(key);
    for (const key of removeKeys) removed.add(key);
    console.warn('保存凭据失败，稍后重试', error);
    notifyError(error);
    if (flushTimer === null) {
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        void flushSecrets();
      }, 3000);
    }
    return false;
  }
}

/** 立即写入一条密钥，成功后才可删除明文残留。 */
export async function persistSecretNow(key: string, value: string): Promise<boolean> {
  cache.set(key, value);
  pending.delete(key);
  removed.delete(key);
  if (!isTauri) {
    secretSet(key, value);
    return true;
  }
  try {
    await rustSave(key, value);
    return true;
  } catch (error) {
    pending.add(key);
    console.warn('保存凭据失败', error);
    notifyError(error);
    return false;
  }
}

export async function loadSecretNow(key: string): Promise<string | null> {
  if (!isTauri) {
    if (cache.has(key)) return cache.get(key) ?? null;
    try {
      const raw = localStorage.getItem(`aw-secret:${key}`);
      if (raw !== null) cache.set(key, raw);
      return raw;
    } catch {
      return cache.get(key) ?? null;
    }
  }
  try {
    const value = await rustLoad(key);
    if (value === null || value === undefined) {
      cache.delete(key);
      return null;
    }
    cache.set(key, value);
    return value;
  } catch (error) {
    console.warn('读取凭据失败', error);
    return cache.get(key) ?? null;
  }
}

export async function deleteSecretNow(key: string): Promise<boolean> {
  cache.delete(key);
  pending.delete(key);
  removed.delete(key);
  if (!isTauri) {
    secretRemove(key);
    return true;
  }
  try {
    await rustDelete(key);
    return true;
  } catch (error) {
    removed.add(key);
    console.warn('删除凭据失败', error);
    notifyError(error);
    return false;
  }
}

/**
 * 启动时预热密钥缓存。
 * 桌面端从加密仓库读取；浏览器 / 非 Tauri 环境回退到带前缀的 localStorage。
 */
export async function hydrateSecretStore(): Promise<void> {
  if (!isTauri) {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith('aw-secret:')) continue;
        const value = localStorage.getItem(key);
        if (value !== null) cache.set(key.slice('aw-secret:'.length), value);
      }
    } catch {
      // 浏览器存储不可用时使用已有内存缓存。
    }
    return;
  }

  try {
    const stored = await invoke<Record<string, string>>('load_all_secrets');
    cache.clear();
    for (const [key, value] of Object.entries(stored ?? {})) {
      cache.set(key, value);
    }
  } catch (error) {
    console.warn('加载凭据仓库失败，本次会话仅使用内存缓存', error);
    notifyError(error);
  }
}

/** 测试辅助：清空内存缓存与待写队列。 */
export function resetSecretStoreForTests() {
  cache.clear();
  pending.clear();
  removed.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void flushSecrets();
  });
}
