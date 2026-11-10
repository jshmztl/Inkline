import type { SendResponse } from './api';
import { kvGet } from './kv';

export type AssertionOperator =
  | 'exists'
  | 'notExists'
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'gt'
  | 'lt';

export interface AssertionRow {
  id: string;
  path: string;
  operator: AssertionOperator;
  expected: string;
  enabled: boolean;
}

export interface AssertionResult {
  id: string;
  path: string;
  operator: AssertionOperator;
  expected: string;
  actual: string;
  passed: boolean;
}

export const assertionOperators: { value: AssertionOperator; label: string }[] = [
  { value: 'exists', label: '存在' },
  { value: 'notExists', label: '不存在' },
  { value: 'equals', label: '等于' },
  { value: 'notEquals', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'gt', label: '大于' },
  { value: 'lt', label: '小于' },
];

export function operatorLabel(operator: AssertionOperator) {
  return assertionOperators.find((item) => item.value === operator)?.label ?? operator;
}

export function readPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current)) return current[Number(key)];
      if (typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, source);
}

export function assertionActual(result: SendResponse, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'status') return result.status;
  if (trimmed.startsWith('headers.')) {
    const name = trimmed.slice('headers.'.length).toLowerCase();
    return result.headers.find((header) => header.name.toLowerCase() === name)?.value;
  }
  let parsed: unknown = result.body;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    // 非 JSON 响应按原始文本处理。
  }
  const clean = trimmed.replace(/^body\./, '').replace(/^\$\./, '');
  return readPath(parsed, clean);
}

export function evaluateAssertions(
  rows: AssertionRow[],
  result: SendResponse,
): AssertionResult[] {
  return rows
    .filter((row) => row.enabled && row.path.trim())
    .map((row) => {
      const actual = assertionActual(result, row.path);
      const expected = row.expected.trim();
      const actualText =
        actual === undefined
          ? 'undefined'
          : typeof actual === 'object'
            ? JSON.stringify(actual)
            : String(actual);

      let passed = false;
      switch (row.operator) {
        case 'exists':
          passed = actual !== undefined && actual !== null;
          break;
        case 'notExists':
          passed = actual === undefined || actual === null;
          break;
        case 'equals':
          passed = actualText === expected;
          break;
        case 'notEquals':
          passed = actualText !== expected;
          break;
        case 'contains':
          passed = actualText.includes(expected);
          break;
        case 'gt':
          passed = Number(actualText) > Number(expected);
          break;
        case 'lt':
          passed = Number(actualText) < Number(expected);
          break;
        default:
          passed = false;
      }

      return {
        id: row.id,
        path: row.path,
        operator: row.operator,
        expected,
        actual: actualText,
        passed,
      };
    });
}

const META_PREFIX = 'aw-request-meta:';

export function readAssertionRows(requestId: string): AssertionRow[] {
  try {
    const raw = kvGet(`${META_PREFIX}${requestId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { assertionRows?: AssertionRow[] };
    return Array.isArray(parsed.assertionRows) ? parsed.assertionRows : [];
  } catch {
    return [];
  }
}
