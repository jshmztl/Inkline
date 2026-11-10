import { invoke } from '@tauri-apps/api/core';
import { kvGet, kvRemove, kvSet } from './kv';

export type AuditType = 'request' | 'ai-task' | 'egress' | 'sync';

export interface AuditEntry {
  id: number | string;
  type: AuditType;
  action: string;
  detail: string;
  actor: string;
  level?: string;
  at: string;
}

const AUDIT_KEY = 'aw-audit';
const MAX_ENTRIES = 200;
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function readLocal(): AuditEntry[] {
  try {
    const raw = kvGet(AUDIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AuditEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && entry.action && entry.type);
  } catch {
    return [];
  }
}

export async function recordAudit(
  entry: Omit<AuditEntry, 'id' | 'at'>,
): Promise<AuditEntry | null> {
  if (isTauri) {
    try {
      return await invoke<AuditEntry>('record_audit', { entry });
    } catch (error) {
      console.warn('写入审计日志失败', error);
      return null;
    }
  }

  const record: AuditEntry = {
    ...entry,
    id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
  };

  try {
    const entries = readLocal();
    entries.unshift(record);
    kvSet(AUDIT_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // 浏览器存储不可用时仅保留返回值。
  }

  return record;
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  if (isTauri) {
    try {
      return await invoke<AuditEntry[]>('list_audit', { limit, offset: 0 });
    } catch (error) {
      console.warn('读取审计日志失败', error);
      return [];
    }
  }

  return readLocal().slice(0, limit);
}

export async function clearAudit(): Promise<void> {
  if (isTauri) {
    try {
      await invoke('clear_audit');
    } catch (error) {
      console.warn('清空审计日志失败', error);
    }
    return;
  }

  kvRemove(AUDIT_KEY);
}

/** 把旧版本存在 localStorage / settings 中的审计 JSON 一次性导入 SQLite。 */
export async function migrateLegacyAudit(): Promise<void> {
  if (!isTauri) return;

  const raw = kvGet(AUDIT_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as AuditEntry[];
    if (Array.isArray(parsed)) {
      for (const entry of parsed.slice(0, 500).reverse()) {
        if (!entry?.action || !entry?.type) continue;
        await invoke('record_audit', {
          entry: {
            type: entry.type,
            action: entry.action,
            detail: entry.detail ?? '',
            actor: entry.actor ?? '',
            level: entry.level ?? null,
            at: entry.at ?? null,
          },
        });
      }
    }
  } catch (error) {
    console.warn('迁移旧审计日志失败', error);
  }

  kvRemove(AUDIT_KEY);
}
