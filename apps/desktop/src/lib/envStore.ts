import { kvGet, kvSet } from './kv';

export interface WorkspaceEnvironment {
  value: string;
  label: string;
  variables: Record<string, string>;
}

const STORAGE_KEY = 'aw-environments';

const legacyPresetHosts: Record<string, string> = {
  local: 'http://127.0.0.1:8080',
  dev: 'https://dev-api.internal',
  staging: 'https://staging-api.internal',
  prod: 'https://api.internal',
};

function isLegacyPreset(environment: WorkspaceEnvironment) {
  const legacyHost = legacyPresetHosts[environment.value];
  if (!legacyHost) return false;
  const keys = Object.keys(environment.variables ?? {});
  if (keys.length === 0) return true;
  return environment.variables.host === legacyHost;
}

function sanitize(list: WorkspaceEnvironment[]) {
  return list.filter((environment) => !isLegacyPreset(environment));
}

export function listEnvironments(): WorkspaceEnvironment[] {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkspaceEnvironment[];
    if (!Array.isArray(parsed)) return [];
    const cleaned = sanitize(parsed);
    if (cleaned.length !== parsed.length) {
      writeEnvironments(cleaned);
    }
    return cleaned;
  } catch {
    return [];
  }
}

export function writeEnvironments(list: WorkspaceEnvironment[]) {
  try {
    kvSet(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 存储不可用时仅对本次会话生效。
  }
}

export function readEnvironmentVariables(value: string): Record<string, string> {
  const matched = listEnvironments().find((item) => item.value === value);
  return matched?.variables ?? {};
}

export function saveEnvironmentVariables(
  value: string,
  variables: Record<string, string>,
  label?: string,
): WorkspaceEnvironment[] {
  const list = listEnvironments().map((item) =>
    item.value === value
      ? { ...item, label: label?.trim() || item.label, variables }
      : item,
  );
  writeEnvironments(list);
  return list;
}
