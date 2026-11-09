import { invoke } from '@tauri-apps/api/core';
import { folders } from '../data/mock';

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

function seedBrowserWorkspace() {
  try {
    if (localStorage.getItem(COLLECTIONS_KEY)) return;
    const now = new Date().toISOString();
    const collections = folders.map((folder, index) => ({
      id: folder.id,
      name: folder.name,
      sort: index,
      updatedAt: now,
    }));
    const existing = readJson<SavedRequest[]>(SAVED_KEY, []);
    const existingIds = new Set(existing.map((item) => item.id));
    const seeded = folders.flatMap((folder) =>
      folder.requests
        .filter((request) => !existingIds.has(request.id))
        .map((request) => ({
          id: request.id,
          name: request.name,
          method: request.method,
          url: `{{host}}${request.path}`,
          headers: [],
          body: null,
          dataLevel: request.dataLevel,
          collectionId: folder.id,
          updatedAt: now,
        })),
    );
    writeJson(COLLECTIONS_KEY, collections);
    writeJson(SAVED_KEY, [...existing, ...seeded]);
  } catch {
    // 初始化失败时保持空工作区。
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

function mockResponse(payload: SendRequestPayload): SendResponse {
  if (payload.url.includes('fail')) {
    throw new Error('请求失败：目标服务不可达（浏览器演示）');
  }

  const durationMs = 96 + Math.round(Math.random() * 64);

  if (payload.url.includes('big')) {
    const items = Array.from({ length: 3000 }, (_, index) => ({
      id: `ord_${index.toString(36).padStart(6, '0')}`,
      status: index % 3 === 0 ? 'paid' : 'pending',
      amount: 1000 + index,
      currency: 'CNY',
      note: `示例订单 ${index}`,
    }));
    const bigBody = JSON.stringify({ code: 0, message: 'ok', total: items.length, data: { items } }, null, 2);
    return {
      status: 200,
      statusText: 'OK',
      headers: [
        { name: 'content-type', value: 'application/json; charset=utf-8' },
        { name: 'x-request-id', value: `req_${Math.random().toString(16).slice(2, 10)}` },
      ],
      body: bigBody,
      durationMs,
      sizeBytes: bigBody.length,
    };
  }

  const body = JSON.stringify(
    {
      code: 0,
      message: 'ok',
      data: {
        id: 'ord_9f2c8b41e7',
        status: 'paid',
        amount: 12800,
        currency: 'CNY',
        paidAt: new Date().toISOString(),
        echo: {
          method: payload.method,
          url: payload.url,
        },
      },
    },
    null,
    2,
  );

  return {
    status: 200,
    statusText: 'OK',
    headers: [
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'x-request-id', value: `req_${Math.random().toString(16).slice(2, 10)}` },
      { name: 'server-timing', value: `app;dur=${durationMs}` },
    ],
    body,
    durationMs,
    sizeBytes: body.length,
  };
}

export async function sendHttpRequest(
  payload: SendRequestPayload,
): Promise<SendResponse> {
  if (isTauri) {
    return invoke<SendResponse>('send_http_request', { payload });
  }

  await new Promise((resolve) => window.setTimeout(resolve, 520));
  return mockResponse(payload);
}

export async function cancelHttpRequest(id: string): Promise<void> {
  if (isTauri) {
    await invoke('cancel_http_request', { id });
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
): Promise<number> {
  if (isTauri) {
    return invoke<number>('start_mock_server', { port, routes });
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

export async function listHistory(limit = 6): Promise<HistoryEntry[]> {
  if (isTauri) {
    return invoke<HistoryEntry[]>('list_history', { limit });
  }

  return readJson<HistoryEntry[]>(HISTORY_KEY, []).slice(0, limit);
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

  seedBrowserWorkspace();
  return readJson<SavedRequest[]>(SAVED_KEY, []);
}

export async function deleteRequest(id: string): Promise<void> {
  if (isTauri) {
    return invoke('delete_request', { id });
  }

  seedBrowserWorkspace();
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

  seedBrowserWorkspace();
  return readJson<Collection[]>(COLLECTIONS_KEY, []).sort(
    (left, right) => (left.sort ?? 0) - (right.sort ?? 0),
  );
}

export async function saveCollection(collection: Collection): Promise<Collection> {
  if (isTauri) {
    return invoke<Collection>('save_collection', { collection });
  }

  seedBrowserWorkspace();
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

  seedBrowserWorkspace();
  writeJson(
    COLLECTIONS_KEY,
    readJson<Collection[]>(COLLECTIONS_KEY, []).filter((collection) => collection.id !== id),
  );
  writeJson(
    SAVED_KEY,
    readJson<SavedRequest[]>(SAVED_KEY, []).filter((request) => request.collectionId !== id),
  );
}
