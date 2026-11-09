import { environmentVariables, environments } from '../data/mock';

export interface WorkspaceEnvironment {
  value: string;
  label: string;
  variables: Record<string, string>;
}

const STORAGE_KEY = 'aw-environments';

export function listEnvironments(): WorkspaceEnvironment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceEnvironment[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // 解析失败时回退到默认环境。
  }

  return environments.map((item) => ({
    value: item.value,
    label: item.label,
    variables: { ...(environmentVariables[item.value] ?? {}) },
  }));
}

export function readEnvironmentVariables(value: string): Record<string, string> {
  const matched = listEnvironments().find((item) => item.value === value);
  return matched?.variables ?? {};
}

export function saveEnvironmentVariables(
  value: string,
  variables: Record<string, string>,
): WorkspaceEnvironment[] {
  const list = listEnvironments().map((item) =>
    item.value === value ? { ...item, variables } : item,
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 存储不可用时仅对本次会话生效。
  }
  return list;
}
