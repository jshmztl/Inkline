import { kvGet, kvRemove, kvSet } from './kv';
import {
  deleteSecretNow,
  persistSecretNow,
  secretGet,
  secretSet,
} from './secretStore';
import { TEAM_TOKENS_SECRET_KEY } from './secretMigration';

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

function parseTokens(raw: string | null): TeamTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TeamTokens>;
    if (!parsed?.accessToken || !parsed.refreshToken) return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

/** 启动时从密钥仓库加载令牌，并把旧版明文连接信息迁移出去。 */
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

  cachedTokens = parseTokens(secretGet(TEAM_TOKENS_SECRET_KEY));

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
    const saved = await persistTokens();
    if (saved) kvRemove(LEGACY_CONNECTION_KEY);
    return;
  }

  if (legacy) kvRemove(LEGACY_CONNECTION_KEY);
}

export async function persistTokens(): Promise<boolean> {
  if (!cachedTokens) return true;
  const payload = JSON.stringify(cachedTokens);
  secretSet(TEAM_TOKENS_SECRET_KEY, payload);
  return persistSecretNow(TEAM_TOKENS_SECRET_KEY, payload);
}

export async function clearStoredTokens(): Promise<void> {
  cachedTokens = null;
  await deleteSecretNow(TEAM_TOKENS_SECRET_KEY);
}

/** 测试辅助：重置内存令牌与hydrate标记。 */
export function resetTeamSecretsForTests() {
  cachedTokens = null;
  hydrated = false;
}
