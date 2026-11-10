import { invoke } from '@tauri-apps/api/core';
import type { NetworkOptions } from './network';

export interface HeaderPair {
  name: string;
  value: string;
}

export interface Collection {
  id: string;
  name: string;
  sort?: number;
  updatedAt?: string | null;
}

export interface MultipartField {
  name: string;
  value?: string;
  fileName?: string;
  fileBase64?: string;
  contentType?: string;
}

export interface SendRequestPayload {
  id?: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string;
  timeoutMs?: number;
  multipart?: MultipartField[];
  network?: NetworkOptions;
}

export interface SendResponse {
  status: number;
  statusText: string;
  headers: HeaderPair[];
  body: string;
  durationMs: number;
  sizeBytes: number;
}

export interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | null;
  dataLevel: string;
  collectionId?: string;
  sort?: number;
  updatedAt: string | null;
}

export interface HistoryEntry {
  id?: number;
  requestId?: string | null;
  method: string;
  url: string;
  status?: number | null;
  durationMs?: number | null;
  sizeBytes?: number | null;
  error?: string | null;
  createdAt?: string | null;
}

const HISTORY_KEY = 'aw-request-history';
const SAVED_KEY = 'aw-saved-requests';
const COLLECTIONS_KEY = 'aw-collections';

const legacySeedRequestIds = new Set([
  'orders-list',
  'orders-create',
  'orders-detail',
  'refunds-create',
  'users-detail',
  'users-create',
  'auth-token',
]);
const legacySeedCollectionIds = new Set(['payment', 'user']);

function cleanupLegacySeed() {
  try {
    const saved = readJson<SavedRequest[]>(SAVED_KEY, []);
    const remaining = saved.filter((request) => !legacySeedRequestIds.has(request.id));
    const collections = readJson<Collection[]>(COLLECTIONS_KEY, []);

    const hasSeedCollection = collections.some((collection) =>
      legacySeedCollectionIds.has(collection.id),
    );
    const needsMigration = remaining.some((request) =>
      legacySeedCollectionIds.has(request.collectionId ?? ''),
    );

    const nextSaved = needsMigration
      ? remaining.map((request) =>
          legacySeedCollectionIds.has(request.collectionId ?? '')
            ? { ...request, collectionId: 'migrated' }
            : request,
        )
      : remaining;

    const nextCollections = collections.filter(
      (collection) => !legacySeedCollectionIds.has(collection.id),
    );
    if (needsMigration && !nextCollections.some((collection) => collection.id === 'migrated')) {
      nextCollections.push({
        id: 'migrated',
        name: '我的集合',
        sort: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    if (nextSaved.length !== saved.length || nextSaved !== remaining) {
      writeJson(SAVED_KEY, nextSaved);
      legacySeedRequestIds.forEach((id) => {
        localStorage.removeItem(`aw-request-meta:${id}`);
        localStorage.removeItem(`aw-doc-draft:${id}`);
      });
    }
    if (hasSeedCollection) {
      writeJson(COLLECTIONS_KEY, nextCollections);
    }
  } catch {
    // 清理失败时保持现状。
  }
}

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 本地存储不可用时忽略；历史不是关键路径。
  }
}

async function browserSendRequest(
  payload: SendRequestPayload,
  signal?: AbortSignal,
): Promise<SendResponse> {
  const headers = new Headers();
  for (const header of payload.headers) {
    if (header.name.trim()) headers.set(header.name, header.value);
  }

  let requestBody: BodyInit | undefined;
  if (payload.multipart && payload.multipart.length > 0) {
    const form = new FormData();
    for (const field of payload.multipart) {
      if (!field.name.trim()) continue;
      if (field.fileBase64 !== undefined) {
        const binary = atob(field.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const blob = new Blob([bytes], {
          type: field.contentType || 'application/octet-stream',
        });
        form.append(field.name, blob, field.fileName || 'file');
      } else {
        form.append(field.name, field.value ?? '');
      }
    }
    headers.delete('Content-Type');
    requestBody = form;
  } else if (payload.body) {
    requestBody = payload.body;
  }

  const started = performance.now();
  const response = await fetch(payload.url, {
    method: payload.method,
    headers,
    body: requestBody,
    signal,
  });
  const body = await response.text();

  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()).map(([name, value]) => ({
      name,
      value,
    })),
    body,
    durationMs: Math.round(performance.now() - started),
    sizeBytes: new TextEncoder().encode(body).length,
  };
}

export async function sendHttpRequest(
  payload: SendRequestPayload,
  signal?: AbortSignal,
): Promise<SendResponse> {
  if (isTauri) {
    return invoke<SendResponse>('send_http_request', { payload });
  }

  try {
    return await browserSendRequest(payload, signal);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`请求失败：${text}`);
  }
}

export async function cancelHttpRequest(id: string): Promise<void> {
  if (isTauri) {
    await invoke('cancel_http_request', { id });
  }
}

export async function clearCookies(): Promise<void> {
  if (isTauri) {
    await invoke('clear_cookies');
  }
}

export interface MockRoutePayload {
  method: string;
  path: string;
  status: number;
  body: string;
  contentType?: string;
  delayMs?: number;
}

export async function startMockServer(
  port: number,
  routes: MockRoutePayload[],
  host = '127.0.0.1',
): Promise<number> {
  if (isTauri) {
    return invoke<number>('start_mock_server', { port, routes, host });
  }
  throw new Error('Mock Server 仅在桌面应用中可用');
}

export async function stopMockServer(): Promise<void> {
  if (isTauri) {
    await invoke('stop_mock_server');
  }
}

export async function recordHistory(entry: HistoryEntry): Promise<HistoryEntry> {
  if (isTauri) {
    return invoke<HistoryEntry>('record_history', { entry });
  }

  const list = readJson<HistoryEntry[]>(HISTORY_KEY, []);
  const item: HistoryEntry = {
    ...entry,
    id: Date.now(),
    createdAt: new Date().toISOString(),
  };
  writeJson(HISTORY_KEY, [item, ...list].slice(0, 30));
  return item;
}

export async function listHistory(limit = 6, offset = 0): Promise<HistoryEntry[]> {
  if (isTauri) {
    return invoke<HistoryEntry[]>('list_history', { limit, offset });
  }

  return readJson<HistoryEntry[]>(HISTORY_KEY, []).slice(offset, offset + limit);
}

export async function saveRequest(request: SavedRequest): Promise<SavedRequest> {
  if (isTauri) {
    return invoke<SavedRequest>('save_request', { request });
  }

  const list = readJson<SavedRequest[]>(SAVED_KEY, []);
  const item: SavedRequest = {
    ...request,
    updatedAt: new Date().toISOString(),
  };
  writeJson(
    SAVED_KEY,
    [item, ...list.filter((saved) => saved.id !== item.id)].slice(0, 50),
  );
  return item;
}

export async function listRequests(): Promise<SavedRequest[]> {
  if (isTauri) {
    return invoke<SavedRequest[]>('list_requests');
  }

  cleanupLegacySeed();
  return readJson<SavedRequest[]>(SAVED_KEY, []).sort(
    (left, right) =>
      (left.sort ?? 0) - (right.sort ?? 0) ||
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''),
  );
}

export async function deleteRequest(id: string): Promise<void> {
  if (isTauri) {
    return invoke('delete_request', { id });
  }

  cleanupLegacySeed();
  writeJson(
    SAVED_KEY,
    readJson<SavedRequest[]>(SAVED_KEY, []).filter((request) => request.id !== id),
  );
}

export async function clearHistory(): Promise<void> {
  if (isTauri) {
    return invoke('clear_history');
  }

  writeJson(HISTORY_KEY, []);
}

export async function deleteHistory(id: number): Promise<void> {
  if (isTauri) {
    return invoke('delete_history', { id });
  }

  writeJson(
    HISTORY_KEY,
    readJson<HistoryEntry[]>(HISTORY_KEY, []).filter((entry) => entry.id !== id),
  );
}

export async function listCollections(): Promise<Collection[]> {
  if (isTauri) {
    return invoke<Collection[]>('list_collections');
  }

  cleanupLegacySeed();
  return readJson<Collection[]>(COLLECTIONS_KEY, []).sort(
    (left, right) => (left.sort ?? 0) - (right.sort ?? 0),
  );
}

export async function saveCollection(collection: Collection): Promise<Collection> {
  if (isTauri) {
    return invoke<Collection>('save_collection', { collection });
  }

  cleanupLegacySeed();
  const list = readJson<Collection[]>(COLLECTIONS_KEY, []);
  const item: Collection = {
    ...collection,
    sort: collection.sort ?? list.length,
    updatedAt: new Date().toISOString(),
  };
  writeJson(COLLECTIONS_KEY, [...list.filter((entry) => entry.id !== item.id), item]);
  return item;
}

export async function deleteCollection(id: string): Promise<void> {
  if (isTauri) {
    return invoke('delete_collection', { id });
  }

  cleanupLegacySeed();
  writeJson(
    COLLECTIONS_KEY,
    readJson<Collection[]>(COLLECTIONS_KEY, []).filter((collection) => collection.id !== id),
  );
  writeJson(
    SAVED_KEY,
    readJson<SavedRequest[]>(SAVED_KEY, []).filter((request) => request.collectionId !== id),
  );
}
