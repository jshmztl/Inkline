import type { HeaderPair } from './api';

export const RESPONSE_CACHE_ENABLED_KEY = 'aw-response-cache-enabled';
export const RESPONSE_CACHE_MAX_BODY = 2 * 1024 * 1024;
export const RESPONSE_CACHE_MAX_BODY_LABEL = '2 MB';

export interface ResponseCacheMeta {
  cachedAt: string;
  truncated: boolean;
  stale: boolean;
}

/** 稳定的请求指纹：方法、URL、请求头与 Body 相同则视为同一请求。 */
export function buildRequestFingerprint(input: {
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string | null;
}): string {
  const headers = [...input.headers]
    .map((header) => `${header.name.trim().toLowerCase()}:${header.value}`)
    .sort()
    .join('\n');
  const text = `${input.method.trim().toUpperCase()}\n${input.url}\n${headers}\n${input.body ?? ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 只截断写入缓存的内容，界面上的实时响应不受影响。 */
export function truncateResponseBody(
  body: string,
  maxChars = RESPONSE_CACHE_MAX_BODY,
): { body: string; truncated: boolean } {
  if (body.length <= maxChars) {
    return { body, truncated: false };
  }
  return { body: body.slice(0, maxChars), truncated: true };
}
