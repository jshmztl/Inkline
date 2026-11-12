import type { Collection, SavedRequest } from './api';
import type { DraftField } from './docTask';
import { kvGet, kvKeys, kvRemove, kvSet } from './kv';

const REMOTE_KEY = 'aw-team-remote';
const BASE_KEY = 'aw-team-base';
const DOC_PREFIX = 'aw-doc-draft:';

function remoteKey(teamId?: string) {
  return teamId ? `${REMOTE_KEY}:${teamId}` : REMOTE_KEY;
}

function baseKey(teamId?: string) {
  return teamId ? `${BASE_KEY}:${teamId}` : BASE_KEY;
}

export interface TeamSnapshot {
  revision: number;
  updatedAt: string;
  pushedBy: string;
  workspace: string;
  schemaVersion?: number;
  collections?: Collection[];
  requests: SavedRequest[];
  documents: Record<string, DraftField[]>;
  deltaChanges?: number;
}

export interface SnapshotDelta {
  collections: Collection[];
  requests: SavedRequest[];
  documents: Record<string, DraftField[]>;
  deletions: {
    collections: string[];
    requests: string[];
    documents: string[];
  };
  changed: number;
}

export interface RemoteSnapshotPayload {
  schemaVersion: number;
  collections?: Collection[];
  requests?: SavedRequest[];
  documents?: Record<string, DraftField[]>;
}

function validSnapshot(parsed: TeamSnapshot | null): TeamSnapshot | null {
  if (!parsed || typeof parsed.revision !== 'number' || !Array.isArray(parsed.requests)) {
    return null;
  }
  return {
    ...parsed,
    collections: Array.isArray(parsed.collections) ? parsed.collections : [],
    documents: parsed.documents && typeof parsed.documents === 'object' ? parsed.documents : {},
  };
}

export function readTeamSnapshot(teamId?: string): TeamSnapshot | null {
  try {
    const raw = kvGet(remoteKey(teamId));
    if (!raw) return null;
    return validSnapshot(JSON.parse(raw) as TeamSnapshot);
  } catch {
    return null;
  }
}

export function readTeamBase(teamId?: string): TeamSnapshot | null {
  try {
    const raw = kvGet(baseKey(teamId));
    if (!raw) return null;
    return validSnapshot(JSON.parse(raw) as TeamSnapshot);
  } catch {
    return null;
  }
}

export function writeTeamBase(snapshot: TeamSnapshot, teamId?: string) {
  try {
    kvSet(baseKey(teamId), JSON.stringify(snapshot));
  } catch {
    // 基准快照写入失败时下次按双端比较处理。
  }
}

/** 用远端快照覆盖本地缓存，供三方合并与状态展示使用。 */
export function writeTeamSnapshot(snapshot: TeamSnapshot, teamId?: string) {
  try {
    kvSet(remoteKey(teamId), JSON.stringify(snapshot));
  } catch {
    // 本地缓存写入失败不影响服务端同步。
  }
}

export function buildRemotePayload(snapshot: TeamSnapshot): Record<string, unknown> {
  return {
    schemaVersion: 2,
    collections: (snapshot.collections ?? []).map((collection) => ({
      id: collection.id,
      name: collection.name,
      sort: collection.sort ?? 0,
    })),
    requests: snapshot.requests,
    documents: snapshot.documents,
  };
}

function requestSignature(request: SavedRequest) {
  return JSON.stringify({
    name: request.name,
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    dataLevel: request.dataLevel,
    collectionId: request.collectionId ?? '',
    sort: request.sort ?? 0,
  });
}

function collectionSignature(collection: Collection) {
  return JSON.stringify({
    name: collection.name,
    sort: collection.sort ?? 0,
  });
}

/** 对比上一次同步基准，得到单接口级增量。 */
export function buildSnapshotDelta(
  base: TeamSnapshot,
  collections: Collection[],
  requests: SavedRequest[],
  documents: Record<string, DraftField[]>,
): SnapshotDelta {
  const baseRequests = new Map((base.requests ?? []).map((request) => [request.id, request]));
  const baseCollections = new Map(
    (base.collections ?? []).map((collection) => [collection.id, collection]),
  );
  const baseDocuments = base.documents ?? {};

  const currentRequests = new Map(requests.map((request) => [request.id, request]));
  const currentCollections = new Map(
    collections.map((collection) => [collection.id, collection]),
  );
  const currentDocuments = Object.fromEntries(
    Object.entries(documents).filter(([, fields]) => Array.isArray(fields) && fields.length > 0),
  );

  const changedRequests = requests.filter((request) => {
    const previous = baseRequests.get(request.id);
    return !previous || requestSignature(previous) !== requestSignature(request);
  });
  const changedCollections = collections.filter((collection) => {
    const previous = baseCollections.get(collection.id);
    return !previous || collectionSignature(previous) !== collectionSignature(collection);
  });
  const changedDocuments = Object.fromEntries(
    Object.entries(currentDocuments).filter(
      ([requestId, fields]) =>
        JSON.stringify(fields) !== JSON.stringify(baseDocuments[requestId] ?? null),
    ),
  );

  const deletedRequests = [...baseRequests.keys()].filter((id) => !currentRequests.has(id));
  const deletedCollections = [...baseCollections.keys()].filter(
    (id) => !currentCollections.has(id),
  );
  const deletedDocuments = Object.keys(baseDocuments).filter(
    (id) => !(id in currentDocuments),
  );

  return {
    collections: changedCollections,
    requests: changedRequests,
    documents: changedDocuments,
    deletions: {
      collections: deletedCollections,
      requests: deletedRequests,
      documents: deletedDocuments,
    },
    changed:
      changedCollections.length +
      changedRequests.length +
      Object.keys(changedDocuments).length +
      deletedCollections.length +
      deletedRequests.length +
      deletedDocuments.length,
  };
}

export function buildDeltaPayload(
  delta: SnapshotDelta,
  baseRevision: number,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    partial: true,
    baseRevision,
    collections: delta.collections,
    requests: delta.requests,
    documents: delta.documents,
    deletions: delta.deletions,
  };
}

export function snapshotFromRemote(
  payload: RemoteSnapshotPayload,
  meta: {
    revision: number;
    createdAt: string;
    createdBy?: { displayName?: string };
    workspace: string;
  },
): TeamSnapshot {
  return {
    revision: meta.revision,
    updatedAt: meta.createdAt,
    pushedBy: meta.createdBy?.displayName ?? '',
    workspace: meta.workspace,
    schemaVersion: payload.schemaVersion ?? 2,
    collections: Array.isArray(payload.collections) ? payload.collections : [],
    requests: Array.isArray(payload.requests) ? payload.requests : [],
    documents: payload.documents && typeof payload.documents === 'object' ? payload.documents : {},
  };
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
  collections: Collection[],
  requests: SavedRequest[],
  documents: Record<string, DraftField[]>,
  workspace = '本机工作区',
): TeamSnapshot {
  const previous = readTeamSnapshot();
  const snapshot: TeamSnapshot = {
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    pushedBy,
    workspace,
    schemaVersion: 2,
    collections,
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

export function removeRemoteDocuments(requestIds: string[]) {
  try {
    for (const requestId of requestIds) {
      kvRemove(`${DOC_PREFIX}${requestId}`);
    }
  } catch {
    // 忽略文档草稿清理失败。
  }
}
