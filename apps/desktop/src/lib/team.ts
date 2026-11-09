import type { SavedRequest } from './api';
import type { DraftField } from './docTask';

const REMOTE_KEY = 'aw-team-remote';
const BASE_KEY = 'aw-team-base';
const DOC_PREFIX = 'aw-doc-draft:';

export interface TeamSnapshot {
  revision: number;
  updatedAt: string;
  pushedBy: string;
  workspace: string;
  requests: SavedRequest[];
  documents: Record<string, DraftField[]>;
}

export function readTeamSnapshot(): TeamSnapshot | null {
  try {
    const raw = localStorage.getItem(REMOTE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TeamSnapshot;
    if (!parsed?.revision || !Array.isArray(parsed.requests)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readTeamBase(): TeamSnapshot | null {
  try {
    const raw = localStorage.getItem(BASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TeamSnapshot;
    if (!parsed?.revision || !Array.isArray(parsed.requests)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeTeamBase(snapshot: TeamSnapshot) {
  try {
    localStorage.setItem(BASE_KEY, JSON.stringify(snapshot));
  } catch {
    // 基准快照写入失败时下次按双端比较处理。
  }
}

export function collectLocalDocuments(): Record<string, DraftField[]> {
  const documents: Record<string, DraftField[]> = {};

  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(DOC_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as DraftField[];
      if (Array.isArray(parsed)) {
        documents[key.slice(DOC_PREFIX.length)] = parsed;
      }
    }
  } catch {
    // 本地存储不可用时返回已收集的部分。
  }

  return documents;
}

export function pushTeamSnapshot(
  pushedBy: string,
  requests: SavedRequest[],
  documents: Record<string, DraftField[]>,
): TeamSnapshot {
  const previous = readTeamSnapshot();
  const snapshot: TeamSnapshot = {
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    pushedBy,
    workspace: '支付中台 · 团队工作区',
    requests,
    documents,
  };

  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify(snapshot));
  } catch {
    // 存储不可用时仍返回快照供界面展示。
  }

  writeTeamBase(snapshot);
  return snapshot;
}

export async function pullTeamSnapshot(): Promise<TeamSnapshot | null> {
  await new Promise((resolve) => window.setTimeout(resolve, 320));
  const snapshot = readTeamSnapshot();
  if (snapshot) writeTeamBase(snapshot);
  return snapshot;
}

export function writeRemoteDocuments(documents: Record<string, DraftField[]>) {
  try {
    for (const [requestId, fields] of Object.entries(documents)) {
      localStorage.setItem(`${DOC_PREFIX}${requestId}`, JSON.stringify(fields));
    }
  } catch {
    // 忽略文档草稿写入失败。
  }
}
