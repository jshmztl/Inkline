import type { SavedRequest } from './api';
import type { DraftField } from './docTask';
import { kvGet, kvKeys, kvSet } from './kv';

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
    const raw = kvGet(REMOTE_KEY);
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
    const raw = kvGet(BASE_KEY);
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
    kvSet(BASE_KEY, JSON.stringify(snapshot));
  } catch {
    // 基准快照写入失败时下次按双端比较处理。
  }
}

export function collectLocalDocuments(): Record<string, DraftField[]> {
  const documents: Record<string, DraftField[]> = {};

  for (const key of kvKeys(DOC_PREFIX)) {
    try {
      const raw = kvGet(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as DraftField[];
      if (Array.isArray(parsed)) {
        documents[key.slice(DOC_PREFIX.length)] = parsed;
      }
    } catch {
      // 单条草稿解析失败时跳过。
    }
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
    workspace: '本机工作区',
    requests,
    documents,
  };

  try {
    kvSet(REMOTE_KEY, JSON.stringify(snapshot));
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
      kvSet(`${DOC_PREFIX}${requestId}`, JSON.stringify(fields));
    }
  } catch {
    // 忽略文档草稿写入失败。
  }
}
