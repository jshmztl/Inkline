import { invoke } from '@tauri-apps/api/core';
import { kvGet, kvRemove, kvSet } from './kv';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const TOKENS_KEY = 'team-tokens-v1';
const LEGACY_CONNECTION_KEY = 'aw-team-connection';

export const CONNECTION_META_KEY = 'aw-team-connection-meta';

export interface TeamTokens {
  accessToken: string;
  refreshToken: string;
}

export interface TeamConnectionMeta {
  serverUrl: string;
  user: {
    id: string;
    account: string;
    displayName: string;
  };
}

let cachedTokens: TeamTokens | null = null;
let hydrated = false;

export function readCachedTokens(): TeamTokens | null {
  return cachedTokens;
}

export function setCachedTokens(tokens: TeamTokens | null) {
  cachedTokens = tokens;
}

async function loadTokens(): Promise<TeamTokens | null> {
  if (!isTauri) {
    const raw = kvGet(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as TeamTokens) : null;
  }
  try {
    const raw = await invoke<string | null>('load_secret', { key: TOKENS_KEY });
    return raw ? (JSON.parse(raw) as TeamTokens) : null;
  } catch (error) {
    console.warn('从系统凭据库读取团队令牌失败', error);
    return null;
  }
}

/** 启动时从系统凭据库加载令牌，并把旧版明文连接信息迁移出去。 */
export async function hydrateTeamSecrets(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  let legacy: (TeamConnectionMeta & TeamTokens) | null = null;
  try {
    const raw = kvGet(LEGACY_CONNECTION_KEY);
    if (raw) legacy = JSON.parse(raw) as TeamConnectionMeta & TeamTokens;
  } catch {
    legacy = null;
  }

  cachedTokens = await loadTokens();

  if (legacy?.accessToken && legacy.refreshToken) {
    cachedTokens = {
      accessToken: legacy.accessToken,
      refreshToken: legacy.refreshToken,
    };
    if (legacy.serverUrl && legacy.user) {
      kvSet(
        CONNECTION_META_KEY,
        JSON.stringify({ serverUrl: legacy.serverUrl, user: legacy.user }),
      );
    }
    await persistTokens();
  }

  if (legacy) kvRemove(LEGACY_CONNECTION_KEY);
}

export async function persistTokens(): Promise<void> {
  if (!cachedTokens) return;

  if (!isTauri) {
    kvSet(TOKENS_KEY, JSON.stringify(cachedTokens));
    return;
  }

  try {
    await invoke('save_secret', {
      key: TOKENS_KEY,
      value: JSON.stringify(cachedTokens),
    });
  } catch (error) {
    console.warn('保存团队令牌到系统凭据库失败', error);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('aw-kv-error', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export async function clearStoredTokens(): Promise<void> {
  cachedTokens = null;
  if (!isTauri) {
    kvRemove(TOKENS_KEY);
    return;
  }
  try {
    await invoke('delete_secret', { key: TOKENS_KEY });
  } catch (error) {
    console.warn('删除系统凭据库中的团队令牌失败', error);
  }
}
