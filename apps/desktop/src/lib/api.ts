import { invoke } from '@tauri-apps/api/core';

export interface HeaderPair {
  name: string;
  value: string;
}

export interface SendRequestPayload {
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string;
  timeoutMs?: number;
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

  return readJson<SavedRequest[]>(SAVED_KEY, []);
}
