import type { HttpMethod } from '../data/types';
import type { HeaderPair } from './api';

export interface RequestDraft {
  name: string;
  method: HttpMethod;
  url: string;
  headers: HeaderPair[];
  body: string | null;
}

export const httpMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * 解析 AI 返回的接口 JSON。模型可能附带解释文字或 Markdown 代码块，
 * 这里只截取第一个完整的 JSON 对象并做字段归一化。
 */
export function parseRequestDraft(text: string): RequestDraft | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;

  const url = normalizeUrl(typeof parsed.url === 'string' ? parsed.url : '');
  if (!url) return null;

  const rawMethod =
    typeof parsed.method === 'string' ? parsed.method.trim().toUpperCase() : '';
  const method = httpMethods.includes(rawMethod as HttpMethod)
    ? (rawMethod as HttpMethod)
    : 'GET';

  const rawName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  const name = rawName || `${method} ${url.replace(/^\{\{host\}\}/, '')}`;

  return {
    name,
    method,
    url,
    headers: normalizeHeaders(parsed.headers),
    body: normalizeBody(parsed.body),
  };
}

/** 判断一段文本是否像从文档中复制的接口说明，用于发送时自动触发解析。 */
export function looksLikeApiDoc(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  const hasMethodLine = /(^|\n)\s*(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/|\/|\{\{host\}\})/i.test(
    trimmed,
  );
  if (hasMethodLine) return true;
  if (trimmed.length < 60) return false;

  const hasDocLabel = /(接口地址|请求地址|请求URL|请求 url|请求方式|请求方法|接口名称)/i.test(
    trimmed,
  );
  const hasTarget = /(https?:\/\/|\/api\/|\{\{host\}\})/i.test(trimmed);
  return hasDocLabel && hasTarget;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (/^(https?:\/\/|\{\{host\}\})/i.test(url)) return url;
  if (url.startsWith('/')) return `{{host}}${url}`;
  if (/^[\w.-]+(\/|$)/.test(url) && !/\s/.test(url)) return `{{host}}/${url}`;
  return '';
}

function normalizeHeaders(value: unknown): HeaderPair[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name) return [];
      return [{ name, value: record.value == null ? '' : String(record.value).trim() }];
    });
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, headerValue]) => ({
        name: name.trim(),
        value: headerValue == null ? '' : String(headerValue).trim(),
      }))
      .filter((item) => item.name);
  }

  return [];
}

function normalizeBody(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() ? value : null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}
