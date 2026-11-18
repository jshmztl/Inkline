import { kvGet, kvKeys, kvRemove, kvSet } from './kv';
import {
  deleteSecretNow,
  persistSecretNow,
  secretGet,
  secretSet,
} from './secretStore';

export const TEAM_TOKENS_SECRET_KEY = 'team-tokens-v1';
export const AI_GATEWAY_SECRET_KEY = 'ai-gateway-key';
export const AI_GATEWAY_SETTINGS_KEY = 'aw-ai-gateway';
export const ENVIRONMENTS_SETTINGS_KEY = 'aw-environments';
export const TEAM_KEY_SETTINGS_PREFIX = 'aw-team-key:';
export const REQUEST_META_PREFIX = 'aw-request-meta:';
export const TEAM_KEY_SECRET_PREFIX = 'team-key:';
export const REQUEST_AUTH_SECRET_PREFIX = 'request-auth:';
export const ENV_VALUES_SECRET_PREFIX = 'env-values:';

export interface RequestAuthSecrets {
  authToken: string;
  authPass: string;
  apiKeyValue: string;
}

export interface MigrationReport {
  migrated: string[];
  skipped: string[];
  failed: string[];
}

export function teamKeySecretKey(teamId: string): string {
  return `${TEAM_KEY_SECRET_PREFIX}${teamId}`;
}

export function requestAuthSecretKey(requestId: string): string {
  return `${REQUEST_AUTH_SECRET_PREFIX}${requestId}`;
}

export function envValuesSecretKey(environmentId: string): string {
  return `${ENV_VALUES_SECRET_PREFIX}${environmentId}`;
}

export function extractRequestAuthSecrets(
  meta: Record<string, unknown>,
): { publicMeta: Record<string, unknown>; secrets: RequestAuthSecrets } {
  const secrets: RequestAuthSecrets = {
    authToken: typeof meta.authToken === 'string' ? meta.authToken : '',
    authPass: typeof meta.authPass === 'string' ? meta.authPass : '',
    apiKeyValue: typeof meta.apiKeyValue === 'string' ? meta.apiKeyValue : '',
  };
  const publicMeta = { ...meta };
  delete publicMeta.authToken;
  delete publicMeta.authPass;
  delete publicMeta.apiKeyValue;
  return { publicMeta, secrets };
}

export function mergeRequestAuthSecrets(
  meta: Record<string, unknown>,
  secrets: RequestAuthSecrets | null,
): Record<string, unknown> {
  return {
    ...meta,
    authToken: secrets?.authToken || (typeof meta.authToken === 'string' ? meta.authToken : ''),
    authPass: secrets?.authPass || (typeof meta.authPass === 'string' ? meta.authPass : ''),
    apiKeyValue: secrets?.apiKeyValue || (typeof meta.apiKeyValue === 'string' ? meta.apiKeyValue : ''),
  };
}

export function hasRequestAuthSecrets(secrets: RequestAuthSecrets): boolean {
  return Boolean(secrets.authToken || secrets.authPass || secrets.apiKeyValue);
}

export function stripGatewayApiKey(config: Record<string, unknown>): {
  publicConfig: Record<string, unknown>;
  apiKey: string;
} {
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  const publicConfig = { ...config, apiKey: '' };
  return { publicConfig, apiKey };
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function migrateOne(
  report: MigrationReport,
  label: string,
  persist: () => Promise<boolean>,
  clear: () => void,
): Promise<void> {
  const ok = await persist();
  if (ok) {
    clear();
    report.migrated.push(label);
  } else {
    report.failed.push(label);
  }
}

/**
 * 把历史明文密钥从 settings / localStorage 迁入密钥仓库，成功后再删除明文残留。
 * 可重复执行：已迁移且无明文的项会被跳过。
 */
export async function migratePlaintextSecrets(): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], skipped: [], failed: [] };

  const legacyTokens = kvGet(TEAM_TOKENS_SECRET_KEY);
  if (legacyTokens) {
    await migrateOne(
      report,
      TEAM_TOKENS_SECRET_KEY,
      () => persistSecretNow(TEAM_TOKENS_SECRET_KEY, legacyTokens),
      () => kvRemove(TEAM_TOKENS_SECRET_KEY),
    );
  }

  for (const key of kvKeys(TEAM_KEY_SETTINGS_PREFIX)) {
    const raw = kvGet(key);
    if (!raw) {
      report.skipped.push(key);
      continue;
    }
    const teamId = key.slice(TEAM_KEY_SETTINGS_PREFIX.length);
    await migrateOne(
      report,
      key,
      () => persistSecretNow(teamKeySecretKey(teamId), raw),
      () => kvRemove(key),
    );
  }

  const gatewayRaw = kvGet(AI_GATEWAY_SETTINGS_KEY);
  const gateway = parseJson(gatewayRaw);
  if (gateway && typeof gateway === 'object') {
    const { publicConfig, apiKey } = stripGatewayApiKey(gateway as Record<string, unknown>);
    if (apiKey) {
      await migrateOne(
        report,
        AI_GATEWAY_SETTINGS_KEY,
        async () => {
          const saved = await persistSecretNow(AI_GATEWAY_SECRET_KEY, apiKey);
          if (saved) kvSet(AI_GATEWAY_SETTINGS_KEY, JSON.stringify(publicConfig));
          return saved;
        },
        () => undefined,
      );
    }
  }

  for (const key of kvKeys(REQUEST_META_PREFIX)) {
    const raw = kvGet(key);
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object') continue;
    const { publicMeta, secrets } = extractRequestAuthSecrets(parsed as Record<string, unknown>);
    if (!hasRequestAuthSecrets(secrets)) continue;
    const requestId = key.slice(REQUEST_META_PREFIX.length);
    await migrateOne(
      report,
      key,
      async () => {
        const saved = await persistSecretNow(requestAuthSecretKey(requestId), JSON.stringify(secrets));
        if (saved) kvSet(key, JSON.stringify(publicMeta));
        return saved;
      },
      () => undefined,
    );
  }

  const envRaw = kvGet(ENVIRONMENTS_SETTINGS_KEY);
  const envList = parseJson(envRaw);
  if (Array.isArray(envList)) {
    let changed = false;
    const next: unknown[] = [];
    for (const item of envList) {
      if (!item || typeof item !== 'object') {
        next.push(item);
        continue;
      }
      const env = item as { value?: unknown; variables?: unknown };
      const envId = typeof env.value === 'string' ? env.value : '';
      const variables =
        env.variables && typeof env.variables === 'object' && !Array.isArray(env.variables)
          ? (env.variables as Record<string, string>)
          : {};
      const hasPlaintext = Object.values(variables).some((value) => String(value ?? '').length > 0);
      if (envId && hasPlaintext) {
        const saved = await persistSecretNow(envValuesSecretKey(envId), JSON.stringify(variables));
        if (saved) {
          const stripped: Record<string, string> = {};
          for (const name of Object.keys(variables)) stripped[name] = '';
          next.push({ ...env, variables: stripped });
          changed = true;
          report.migrated.push(`${ENVIRONMENTS_SETTINGS_KEY}:${envId}`);
        } else {
          next.push(item);
          report.failed.push(`${ENVIRONMENTS_SETTINGS_KEY}:${envId}`);
        }
      } else {
        next.push(item);
      }
    }
    if (changed) kvSet(ENVIRONMENTS_SETTINGS_KEY, JSON.stringify(next));
  }

  return report;
}

export async function copyRequestAuthSecrets(fromId: string, toId: string): Promise<void> {
  const raw = secretGet(requestAuthSecretKey(fromId));
  if (!raw) return;
  secretSet(requestAuthSecretKey(toId), raw);
}

export async function deleteRequestAuthSecrets(requestId: string): Promise<void> {
  await deleteSecretNow(requestAuthSecretKey(requestId));
}

export function readRequestAuthSecrets(requestId: string): RequestAuthSecrets {
  const raw = secretGet(requestAuthSecretKey(requestId));
  if (!raw) return { authToken: '', authPass: '', apiKeyValue: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<RequestAuthSecrets>;
    return {
      authToken: typeof parsed.authToken === 'string' ? parsed.authToken : '',
      authPass: typeof parsed.authPass === 'string' ? parsed.authPass : '',
      apiKeyValue: typeof parsed.apiKeyValue === 'string' ? parsed.apiKeyValue : '',
    };
  } catch {
    return { authToken: '', authPass: '', apiKeyValue: '' };
  }
}

export function writeRequestAuthSecrets(requestId: string, secrets: RequestAuthSecrets): void {
  if (!hasRequestAuthSecrets(secrets)) {
    secretRemoveIfPresent(requestAuthSecretKey(requestId));
    return;
  }
  secretSet(requestAuthSecretKey(requestId), JSON.stringify(secrets));
}

function secretRemoveIfPresent(key: string) {
  if (secretGet(key) !== null) {
    void deleteSecretNow(key);
  }
}
