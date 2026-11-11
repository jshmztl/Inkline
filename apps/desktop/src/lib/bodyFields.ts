import type { DraftField, GlossaryEntry } from './docTask';

export type BodyFieldMode = 'json' | 'xml' | 'text' | 'form' | 'multipart';

export interface BodyLineField {
  /** 0 基行号，与编辑器行一一对应 */
  line: number;
  path: string;
  name: string;
}

export interface BodyLineNote extends BodyLineField {
  description: string;
}

/**
 * 提取请求体中每个字段所在的行与路径，用于在编辑器右侧按行对齐展示注释。
 * JSON 采用容错扫描，输入到一半（如缺右括号）也能尽量给出映射。
 */
export function extractBodyLineFields(
  body: string,
  mode: BodyFieldMode,
): BodyLineField[] {
  if (!body.trim()) return [];
  if (mode === 'json') return jsonLineFields(body);
  if (mode === 'xml') return xmlLineFields(body);
  return [];
}

/** 为每行字段补充说明：优先 AI 文档草稿，其次字段术语表。 */
export function describeBodyLines(
  body: string,
  mode: BodyFieldMode,
  draft: DraftField[],
  glossary: GlossaryEntry[],
): BodyLineNote[] {
  const draftByPath = new Map(
    draft
      .filter((entry) => entry.source === '请求')
      .map((entry) => [entry.path, entry.description.trim()] as const),
  );

  return extractBodyLineFields(body, mode).map((field) => {
    const fromDraft = draftByPath.get(field.path) ?? '';
    const entry = glossary.find((item) => item.term === field.name);
    return {
      ...field,
      description: fromDraft || (entry ? `${entry.label}：${entry.description}` : ''),
    };
  });
}

interface JsonFrame {
  kind: 'object' | 'array';
  path: string;
  keyPath: string | null;
}

function jsonLineFields(source: string): BodyLineField[] {
  const out: BodyLineField[] = [];
  const stack: JsonFrame[] = [];
  let line = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1;
      continue;
    }

    if (char === '"') {
      const startLine = line;
      let cursor = index + 1;
      let raw = '';
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === '\\') {
          raw += source.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if (current === '"') break;
        if (current === '\n') line += 1;
        raw += current;
        cursor += 1;
      }
      const end = cursor + 1;

      let probe = end;
      while (probe < source.length && /\s/.test(source[probe])) probe += 1;
      const parent = stack[stack.length - 1];
      const isKey =
        source[probe] === ':' && parent !== undefined && parent.kind === 'object';

      if (isKey) {
        let name = raw;
        try {
          name = JSON.parse(`"${raw}"`) as string;
        } catch {
          // 保留原始文本
        }
        const path = parent.path ? `${parent.path}.${name}` : name;
        out.push({ line: startLine, path, name });
        parent.keyPath = path;
      } else if (parent) {
        parent.keyPath = null;
      }

      index = end;
      continue;
    }

    if (char === '{' || char === '[') {
      const parent = stack[stack.length - 1];
      let path = '';
      if (parent) {
        if (parent.kind === 'array') {
          path = parent.path ? `${parent.path}[]` : '';
        } else {
          path = parent.keyPath ?? parent.path;
        }
        parent.keyPath = null;
      }
      stack.push({
        kind: char === '{' ? 'object' : 'array',
        path,
        keyPath: null,
      });
      index += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      stack.pop();
      index += 1;
      continue;
    }

    if (char !== ':' && char !== ',') {
      const parent = stack[stack.length - 1];
      if (parent) parent.keyPath = null;
    }
    index += 1;
  }

  return out;
}

const XML_TAG = /<(\/?)([\w:.-]+)([^>]*)>/g;

function xmlLineFields(body: string): BodyLineField[] {
  const out: BodyLineField[] = [];
  const stack: string[] = [];

  body.split('\n').forEach((text, line) => {
    for (const match of text.matchAll(XML_TAG)) {
      const closing = match[1] === '/';
      const name = match[2];
      const rest = match[3] ?? '';

      if (closing) {
        const at = stack.lastIndexOf(name);
        if (at >= 0) stack.length = at;
        continue;
      }

      const path = stack.length > 0 ? `${stack.join('.')}.${name}` : name;
      out.push({ line, path, name });
      if (!/\/\s*$/.test(rest)) stack.push(name);
    }
  });

  return out;
}
