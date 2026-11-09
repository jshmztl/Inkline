import type { HttpMethod } from '../data/mock';
import type { HeaderPair, SavedRequest } from './api';

export type ImportSource = 'curl' | 'postman' | 'openapi';

export interface ImportedRequest {
  name: string;
  method: HttpMethod;
  url: string;
  headers: HeaderPair[];
  body: string | null;
}

export interface ImportPayload {
  name: string;
  source: ImportSource;
  requests: ImportedRequest[];
}

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function toMethod(value: string | undefined): HttpMethod {
  const upper = (value ?? 'GET').toUpperCase();
  return (METHODS as string[]).includes(upper) ? (upper as HttpMethod) : 'GET';
}

function tokenizeCurl(input: string): string[] {
  const tokens: string[] = [];
  const text = input.replace(/\\\r?\n/g, ' ');
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseCurl(raw: string): ImportPayload {
  const tokens = tokenizeCurl(raw);
  let method = '';
  let url = '';
  let body: string | null = null;
  const headers: HeaderPair[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'curl') continue;

    if (token === '-X' || token === '--request') {
      method = tokens[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (token.startsWith('-X') && token.length > 2) {
      method = token.slice(2);
      continue;
    }
    if (token === '-H' || token === '--header') {
      const header = tokens[index + 1] ?? '';
      index += 1;
      const split = header.indexOf(':');
      if (split > 0) {
        headers.push({
          name: header.slice(0, split).trim(),
          value: header.slice(split + 1).trim(),
        });
      }
      continue;
    }
    if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary' ||
      token === '--data-ascii'
    ) {
      body = tokens[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (token === '-u' || token === '--user') {
      const pair = tokens[index + 1] ?? '';
      index += 1;
      try {
        headers.push({ name: 'Authorization', value: `Basic ${btoa(pair)}` });
      } catch {
        // 非 ASCII 凭据仍按原文写入。
        headers.push({ name: 'Authorization', value: `Basic ${pair}` });
      }
      continue;
    }
    if (token === '--url') {
      url = tokens[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      // 跳过后续无关键（-s、--compressed 等）。
      continue;
    }
    if (!url) url = token;
  }

  if (!url) throw new Error('未找到 curl 中的 URL');
  if (!method) method = body ? 'POST' : 'GET';

  return {
    name: 'curl 导入',
    source: 'curl',
    requests: [
      {
        name: `${method.toUpperCase()} ${url.replace(/^https?:\/\/[^/]+/, '') || '/'}`,
        method: toMethod(method),
        url,
        headers,
        body,
      },
    ],
  };
}

function joinPostmanUrl(url: unknown): string {
  if (typeof url === 'string') return url;
  if (!url || typeof url !== 'object') return '';
  const value = url as {
    raw?: string;
    protocol?: string;
    host?: string[] | string;
    path?: (string | { value?: string })[];
    query?: { key?: string; value?: string; disabled?: boolean }[];
  };
  if (value.raw) return value.raw;
  const host = Array.isArray(value.host)
    ? value.host.join('.')
    : (value.host ?? '').toString();
  const path = (value.path ?? [])
    .map((segment) => (typeof segment === 'string' ? segment : (segment.value ?? '')))
    .join('/');
  const query = (value.query ?? [])
    .filter((pair) => pair.key && !pair.disabled)
    .map((pair) => `${pair.key}=${pair.value ?? ''}`)
    .join('&');
  const prefix = value.protocol ? `${value.protocol}://` : '';
  return `${prefix}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
}

function parsePostman(raw: string): ImportPayload {
  const doc = JSON.parse(raw) as {
    info?: { name?: string };
    item?: unknown[];
  };

  const requests: ImportedRequest[] = [];

  function walk(items: unknown[]) {
    for (const entry of items) {
      const item = entry as {
        name?: string;
        item?: unknown[];
        request?: {
          method?: string;
          url?: unknown;
          header?: { key?: string; value?: string; disabled?: boolean }[];
          body?: {
            mode?: string;
            raw?: string;
            urlencoded?: { key?: string; value?: string; disabled?: boolean }[];
          };
        };
      };
      if (Array.isArray(item.item)) {
        walk(item.item);
        continue;
      }
      if (!item.request) continue;

      const request = item.request;
      let body: string | null = null;
      if (request.body?.mode === 'raw') {
        body = request.body.raw ?? null;
      } else if (request.body?.mode === 'urlencoded' && request.body.urlencoded) {
        body = request.body.urlencoded
          .filter((pair) => pair.key && !pair.disabled)
          .map(
            (pair) =>
              `${encodeURIComponent(pair.key ?? '')}=${encodeURIComponent(pair.value ?? '')}`,
          )
          .join('&');
      }

      requests.push({
        name: item.name ?? request.method ?? '未命名请求',
        method: toMethod(request.method),
        url: joinPostmanUrl(request.url),
        headers: (request.header ?? [])
          .filter((header) => header.key && !header.disabled)
          .map((header) => ({ name: header.key ?? '', value: header.value ?? '' })),
        body,
      });
    }
  }

  walk(doc.item ?? []);
  if (requests.length === 0) throw new Error('Postman 集合中没有可导入的请求');

  return {
    name: doc.info?.name ?? 'Postman 导入',
    source: 'postman',
    requests,
  };
}

function exampleFromSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return null;
  const value = schema as {
    example?: unknown;
    default?: unknown;
    type?: string;
    properties?: Record<string, unknown>;
    items?: unknown;
  };
  if (value.example !== undefined) return value.example;
  if (value.default !== undefined) return value.default;
  if (value.type === 'object' && value.properties) {
    return Object.fromEntries(
      Object.entries(value.properties).map(([key, child]) => [key, exampleFromSchema(child)]),
    );
  }
  if (value.type === 'array') return [exampleFromSchema(value.items)];
  if (value.type === 'string') return '';
  if (value.type === 'number' || value.type === 'integer') return 0;
  if (value.type === 'boolean') return false;
  return null;
}

function parseOpenApi(raw: string): ImportPayload {
  let doc: {
    openapi?: string;
    swagger?: string;
    info?: { title?: string };
    servers?: { url?: string }[];
    host?: string;
    basePath?: string;
    schemes?: string[];
    paths?: Record<string, Record<string, unknown>>;
  };
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('OpenAPI 目前仅支持 JSON 格式，请导出为 JSON 后重试');
  }

  const base =
    doc.servers?.[0]?.url ??
    (doc.host
      ? `${doc.schemes?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}`
      : '');

  const requests: ImportedRequest[] = [];
  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const operation = operations[method.toLowerCase()] as
        | {
            summary?: string;
            operationId?: string;
            requestBody?: {
              content?: Record<string, { example?: unknown; schema?: unknown }>;
            };
          }
        | undefined;
      if (!operation) continue;

      const headers: HeaderPair[] = [];
      let body: string | null = null;
      const content = operation.requestBody?.content?.['application/json'];
      if (content) {
        const example = content.example ?? exampleFromSchema(content.schema);
        if (example !== null) body = JSON.stringify(example, null, 2);
        headers.push({ name: 'Content-Type', value: 'application/json' });
      }

      requests.push({
        name: operation.summary ?? operation.operationId ?? `${method} ${path}`,
        method,
        url: `${base.replace(/\/$/, '')}${path}`,
        headers,
        body,
      });
    }
  }

  if (requests.length === 0) throw new Error('OpenAPI 文档中没有可导入的接口');

  return {
    name: doc.info?.title ?? 'OpenAPI 导入',
    source: 'openapi',
    requests,
  };
}

export function detectImportSource(raw: string): ImportSource | 'unknown' {
  const text = raw.trim();
  if (!text) return 'unknown';
  if (/^curl\b/i.test(text)) return 'curl';
  try {
    const doc = JSON.parse(text) as {
      info?: { schema?: string; _postman_id?: string };
      item?: unknown;
      openapi?: string;
      swagger?: string;
      paths?: unknown;
    };
    if (Array.isArray(doc.item) || doc.info?.schema?.includes('postman')) return 'postman';
    if (doc.openapi || doc.swagger) return 'openapi';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function parseImport(raw: string): ImportPayload {
  const source = detectImportSource(raw);
  if (source === 'curl') return parseCurl(raw);
  if (source === 'postman') return parsePostman(raw);
  if (source === 'openapi') return parseOpenApi(raw);
  throw new Error('无法识别格式，支持 curl、Postman 集合 JSON、OpenAPI JSON');
}

export function toCurl(request: ImportedRequest): string {
  const lines = [`curl -X ${request.method} '${request.url}'`];
  for (const header of request.headers) {
    lines.push(`  -H '${header.name}: ${header.value}'`);
  }
  if (request.body) {
    lines.push(`  -d '${request.body.replace(/'/g, `'\\''`)}'`);
  }
  return lines.join(' \\\n');
}

export function toFetchSnippet(request: ImportedRequest): string {
  const init: Record<string, unknown> = {
    method: request.method,
    headers: Object.fromEntries(request.headers.map((header) => [header.name, header.value])),
  };
  if (request.body) init.body = request.body;
  return `fetch('${request.url}', ${JSON.stringify(init, null, 2)})`;
}

export type ExportFormat = 'json' | 'curl' | 'fetch';

export function exportCollection(
  name: string,
  requests: SavedRequest[],
  format: ExportFormat,
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        info: {
          name,
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: requests.map((request) => ({
          name: request.name,
          request: {
            method: request.method,
            url: { raw: request.url },
            header: request.headers.map((header) => ({
              key: header.name,
              value: header.value,
            })),
            ...(request.body
              ? { body: { mode: 'raw', raw: request.body } }
              : {}),
          },
        })),
      },
      null,
      2,
    );
  }

  const items: ImportedRequest[] = requests.map((request) => ({
    name: request.name,
    method: toMethod(request.method),
    url: request.url,
    headers: request.headers,
    body: request.body,
  }));

  return items
    .map((request) => (format === 'curl' ? toCurl(request) : toFetchSnippet(request)))
    .join('\n\n');
}
