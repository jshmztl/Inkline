import type { DraftField, GlossaryEntry } from './docTask';

export type BodyFieldMode = 'json' | 'xml' | 'text' | 'form' | 'multipart';

export interface BodyField {
  path: string;
  name: string;
  type: string;
  depth: number;
  sample: string;
}

export interface BodyFieldNote extends BodyField {
  description: string;
}

const MAX_FIELDS = 400;

/** 把请求体解析成可映射的字段列表，JSON 与 XML 支持嵌套路径。 */
export function extractBodyFields(body: string, mode: BodyFieldMode): BodyField[] {
  if (!body.trim()) return [];
  if (mode === 'json') return extractJsonFields(body);
  if (mode === 'xml') return extractXmlFields(body);
  return [];
}

/**
 * 为字段补充说明：优先使用 AI 文档草稿中已应用的说明，
 * 其次按字段名匹配字段术语表。
 */
export function describeBodyFields(
  fields: BodyField[],
  draft: DraftField[],
  glossary: GlossaryEntry[],
): BodyFieldNote[] {
  const draftByPath = new Map(
    draft
      .filter((entry) => entry.source === '请求')
      .map((entry) => [entry.path, entry.description.trim()] as const),
  );

  return fields.map((field) => {
    const fromDraft = draftByPath.get(field.path) ?? '';
    if (fromDraft) return { ...field, description: fromDraft };

    const entry = glossary.find((item) => item.term === field.name);
    return {
      ...field,
      description: entry ? `${entry.label}：${entry.description}` : '',
    };
  });
}

function fieldType(value: unknown) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function lastSegment(path: string) {
  const clean = path.replace(/\[\]$/, '');
  const index = clean.lastIndexOf('.');
  return index === -1 ? clean : clean.slice(index + 1);
}

function sampleOf(value: unknown) {
  if (typeof value === 'string') return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  return String(value);
}

function extractJsonFields(body: string): BodyField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const out: BodyField[] = [];
  walkJson(parsed, '', 0, out);
  return out.slice(0, MAX_FIELDS);
}

function walkJson(value: unknown, path: string, depth: number, out: BodyField[]) {
  if (out.length >= MAX_FIELDS) return;

  if (Array.isArray(value)) {
    if (!path) {
      const first = value.find((item) => item !== null && typeof item === 'object');
      if (first !== undefined) walkJson(first, '', depth, out);
      return;
    }
    out.push({
      path,
      name: lastSegment(path),
      type: 'array',
      depth,
      sample: `[${value.length}]`,
    });
    const first = value.find((item) => item !== null && typeof item === 'object');
    if (first !== undefined) walkJson(first, `${path}[]`, depth + 1, out);
    return;
  }

  if (value && typeof value === 'object') {
    if (path) {
      out.push({
        path,
        name: lastSegment(path),
        type: 'object',
        depth,
        sample: `{${Object.keys(value as Record<string, unknown>).length}}`,
      });
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkJson(child, path ? `${path}.${key}` : key, path ? depth + 1 : depth, out);
    }
    return;
  }

  if (!path) return;
  out.push({
    path,
    name: lastSegment(path),
    type: fieldType(value),
    depth,
    sample: sampleOf(value),
  });
}

function extractXmlFields(body: string): BodyField[] {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return [];

  const out: BodyField[] = [];
  const walk = (element: Element, path: string, depth: number) => {
    if (out.length >= MAX_FIELDS) return;
    const nextPath = path ? `${path}.${element.tagName}` : element.tagName;
    const children = Array.from(element.children);
    out.push({
      path: nextPath,
      name: element.tagName,
      type: children.length > 0 ? 'element' : 'text',
      depth,
      sample: children.length > 0 ? `${children.length} 子节点` : (element.textContent ?? '').slice(0, 24),
    });
    for (const child of children) walk(child, nextPath, depth + 1);
  };

  if (doc.documentElement) walk(doc.documentElement, '', 0);
  return out;
}
