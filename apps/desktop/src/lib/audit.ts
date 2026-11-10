import { kvGet, kvRemove, kvSet } from './kv';

export type AuditType = 'request' | 'ai-task' | 'egress' | 'sync';

export interface AuditEntry {
  id: string;
  type: AuditType;
  action: string;
  detail: string;
  actor: string;
  level?: string;
  at: string;
}

const AUDIT_KEY = 'aw-audit';
const MAX_ENTRIES = 200;

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
  const record: AuditEntry = {
    ...entry,
    id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
  };

  try {
    const entries = listAudit(MAX_ENTRIES);
    entries.unshift(record);
    kvSet(AUDIT_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // 存储不可用时审计仅保留在返回值中。
  }

  return record;
}

export function listAudit(limit = 50): AuditEntry[] {
  try {
    const raw = kvGet(AUDIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AuditEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit);
  } catch {
    return [];
  }
}

export function clearAudit() {
  try {
    kvRemove(AUDIT_KEY);
  } catch {
    // 忽略清理失败。
  }
}
