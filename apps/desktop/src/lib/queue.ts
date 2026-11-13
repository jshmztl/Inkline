import { sendHttpRequest, type HeaderPair, type SendResponse } from './api';
import { kvGet, kvSet } from './kv';
import { checkNetworkAccessResolved } from './networkPolicy';
import { backendNetworkOptions } from './network';
import type { NetworkMode } from '../data/types';

export interface QueuedTask {
  id: string;
  requestId: string;
  name: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | null;
  dataLevel: string;
  attempts: number;
  lastError: string;
  createdAt: string;
}

const QUEUE_KEY = 'aw-offline-queue';
const MAX_TASKS = 50;

function readQueue(): QueuedTask[] {
  try {
    const raw = kvGet(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(tasks: QueuedTask[]) {
  try {
    kvSet(QUEUE_KEY, JSON.stringify(tasks.slice(0, MAX_TASKS)));
  } catch {
    // 本地存储不可用时队列仅保留在内存调用栈中。
  }
}

export function listQueue(): QueuedTask[] {
  return readQueue();
}

export function enqueueTask(
  task: Omit<QueuedTask, 'id' | 'attempts' | 'lastError' | 'createdAt'>,
): QueuedTask {
  const record: QueuedTask = {
    ...task,
    id: `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    attempts: 0,
    lastError: '',
    createdAt: new Date().toISOString(),
  };
  writeQueue([record, ...readQueue()]);
  return record;
}

export function removeQueueTask(id: string) {
  writeQueue(readQueue().filter((task) => task.id !== id));
}

export function clearQueue() {
  writeQueue([]);
}

export function queueCount() {
  return readQueue().length;
}

export async function retryTask(
  task: QueuedTask,
  networkMode: NetworkMode,
): Promise<SendResponse> {
  try {
    const access = await checkNetworkAccessResolved(task.url, networkMode);
    if (!access.allowed) throw new Error(access.reason);
    const result = await sendHttpRequest({
      method: task.method,
      url: task.url,
      headers: task.headers,
      body: task.body ?? undefined,
      timeoutMs: 30_000,
      network: backendNetworkOptions(networkMode),
    });
    removeQueueTask(task.id);
    return result;
  } catch (caught) {
    const text = caught instanceof Error ? caught.message : String(caught);
    writeQueue(
      readQueue().map((item) =>
        item.id === task.id
          ? { ...item, attempts: item.attempts + 1, lastError: text }
          : item,
      ),
    );
    throw caught;
  }
}

export async function retryQueue(networkMode: NetworkMode) {
  const tasks = readQueue();
  let success = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      await retryTask(task, networkMode);
      success += 1;
    } catch {
      failed += 1;
    }
  }
  return { success, failed, remaining: queueCount() };
}
