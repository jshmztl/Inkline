import type { DataLevel, HttpMethod } from '../data/mock';

export interface JsonField {
  path: string;
  name: string;
  type: string;
  sample: string;
}

export interface RequestContext {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  dataLevel: DataLevel;
  headers: { name: string; value: string }[];
  body: string | null;
  response: {
    status: number;
    statusText: string;
    body: string;
  } | null;
}

export interface GlossaryEntry {
  term: string;
  label: string;
  description: string;
}

export const glossary: GlossaryEntry[] = [
  { term: 'id', label: '资源 ID', description: '服务端生成的唯一标识' },
  { term: 'code', label: '业务码', description: '0 表示成功，非 0 为业务错误' },
  { term: 'message', label: '提示信息', description: '面向调用方的结果说明' },
  { term: 'amount', label: '金额', description: '最小货币单位（分）' },
  { term: 'currency', label: '币种', description: 'ISO 4217 三字母币种' },
  { term: 'idempotencyKey', label: '幂等键', description: '客户端生成，用于重试去重' },
  { term: 'channel', label: '支付渠道', description: 'wechat_pay / alipay / card' },
  { term: 'status', label: '状态', description: '资源当前生命周期状态' },
  { term: 'paidAt', label: '支付时间', description: 'ISO 8601 UTC 时间' },
  { term: 'metadata', label: '扩展字段', description: '调用方自定义键值对' },
  { term: 'tenantId', label: '租户标识', description: '多租户隔离标识' },
  { term: 'description', label: '描述', description: '业务可读说明，非结构化' },
];

export interface GlossaryHit {
  field: JsonField;
  entry: GlossaryEntry;
}

export interface FieldReview {
  key: string;
  name: string;
  path: string;
  type: string;
  source: '请求' | '响应';
  confidence: number;
  note: string;
  term?: string;
}

export interface DraftField {
  key: string;
  path: string;
  type: string;
  source: FieldReview['source'];
  description: string;
  updatedAt: string;
}

export interface DocDiffRow {
  key: string;
  path: string;
  type: string;
  before: string | null;
  after: string;
  kind: 'add' | 'update';
}

export interface DocTask {
  id: string;
  createdAt: string;
  request: {
    id: string;
    name: string;
    method: HttpMethod;
    url: string;
    dataLevel: DataLevel;
    headers: { name: string; value: string }[];
    body: string | null;
    fields: JsonField[];
  };
  response: {
    status: number;
    statusText: string;
    body: string;
    fields: JsonField[];
  } | null;
  glossary: GlossaryHit[];
  stats: {
    requestFields: number;
    responseFields: number;
    glossaryHits: number;
    sources: number;
  };
}

function fieldType(value: unknown) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function lastSegment(path: string) {
  const index = path.lastIndexOf('.');
  return index === -1 ? path : path.slice(index + 1);
}

function sampleOf(value: unknown) {
  if (typeof value === 'string') return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  return String(value);
}

function walkJson(value: unknown, prefix: string, out: JsonField[]) {
  if (Array.isArray(value)) {
    if (prefix) {
      out.push({
        path: prefix,
        name: lastSegment(prefix),
        type: 'array',
        sample: `[${value.length}]`,
      });
    }
    return;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (prefix) {
      out.push({
        path: prefix,
        name: lastSegment(prefix),
        type: 'object',
        sample: `{${entries.length}}`,
      });
    }
    for (const [key, child] of entries) {
      walkJson(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }

  if (!prefix) return;
  out.push({
    path: prefix,
    name: lastSegment(prefix),
    type: fieldType(value),
    sample: sampleOf(value),
  });
}

export function extractJsonFields(source: string | null): JsonField[] {
  if (!source) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const fields: JsonField[] = [];
  walkJson(parsed, '', fields);
  return fields;
}

export function matchGlossary(fields: JsonField[], entries: GlossaryEntry[] = glossary) {
  const seen = new Set<string>();
  const hits: GlossaryHit[] = [];

  for (const field of fields) {
    const entry = entries.find((item) => item.term === field.name);
    if (!entry || seen.has(entry.term)) continue;
    seen.add(entry.term);
    hits.push({ field, entry });
  }

  return hits;
}

export function buildDocTask(
  context: RequestContext,
  entries: GlossaryEntry[] = glossary,
): DocTask {
  const requestFields = extractJsonFields(context.body);
  const responseFields = extractJsonFields(context.response?.body ?? null);
  const hits = matchGlossary([...requestFields, ...responseFields], entries);

  return {
    id: `doc_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    request: {
      id: context.id,
      name: context.name,
      method: context.method,
      url: context.url,
      dataLevel: context.dataLevel,
      headers: context.headers,
      body: context.body,
      fields: requestFields,
    },
    response: context.response
      ? { ...context.response, fields: responseFields }
      : null,
    glossary: hits,
    stats: {
      requestFields: requestFields.length,
      responseFields: responseFields.length,
      glossaryHits: hits.length,
      sources: 1 + (context.response ? 1 : 0) + (hits.length > 0 ? 1 : 0),
    },
  };
}

export function buildFieldReview(
  task: DocTask,
  entries: GlossaryEntry[] = glossary,
): FieldReview[] {
  const collect = (fields: JsonField[], source: FieldReview['source']) =>
    fields.map((field): FieldReview => {
      const entry = entries.find((item) => item.term === field.name);
      const base = 62;
      const confidence = Math.min(
        98,
        base +
          (entry ? 28 : 0) +
          (field.sample ? 4 : 0) +
          (field.type === 'object' || field.type === 'array' ? 2 : 0),
      );
      return {
        key: `${source}:${field.path}`,
        name: field.name,
        path: field.path,
        type: field.type,
        source,
        confidence,
        note: entry
          ? `${entry.label}：${entry.description}`
          : '未命中团队术语表，需人工补充说明',
        term: entry?.term,
      };
    });

  return [
    ...collect(task.request.fields, '请求'),
    ...collect(task.response?.fields ?? [], '响应'),
  ].sort((a, b) => a.confidence - b.confidence);
}

function selectedReviews(review: FieldReview[], accepted: Record<string, boolean>) {
  return review.filter((item) => accepted[item.key] ?? true);
}

export function buildDraftDiff(
  draft: DraftField[],
  review: FieldReview[],
  accepted: Record<string, boolean>,
): DocDiffRow[] {
  const rows: DocDiffRow[] = [];

  for (const item of selectedReviews(review, accepted)) {
    const current = draft.find((entry) => entry.key === item.key);
    if (!current) {
      rows.push({
        key: item.key,
        path: item.path,
        type: item.type,
        before: null,
        after: item.note,
        kind: 'add',
      });
    } else if (current.description !== item.note || current.type !== item.type) {
      rows.push({
        key: item.key,
        path: item.path,
        type: item.type,
        before: current.description,
        after: item.note,
        kind: 'update',
      });
    }
  }

  return rows;
}

export function mergeDraftFields(
  draft: DraftField[],
  review: FieldReview[],
  accepted: Record<string, boolean>,
): DraftField[] {
  const now = new Date().toISOString();
  const next = draft.map((entry) => ({ ...entry }));

  for (const item of selectedReviews(review, accepted)) {
    const entry: DraftField = {
      key: item.key,
      path: item.path,
      type: item.type,
      source: item.source,
      description: item.note,
      updatedAt: now,
    };
    const index = next.findIndex((current) => current.key === item.key);
    if (index === -1) {
      next.push(entry);
    } else {
      next[index] = entry;
    }
  }

  return next;
}
