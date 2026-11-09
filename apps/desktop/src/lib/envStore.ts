export interface WorkspaceEnvironment {
  value: string;
  label: string;
  variables: Record<string, string>;
}

const STORAGE_KEY = 'aw-environments';

const defaultEnvironments: WorkspaceEnvironment[] = [
  { value: 'local', label: '本地环境', variables: {} },
  { value: 'dev', label: '开发环境', variables: {} },
  { value: 'staging', label: '预发环境', variables: {} },
  { value: 'prod', label: '生产环境', variables: {} },
];

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

  return defaultEnvironments.map((item) => ({
    ...item,
    variables: { ...item.variables },
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
