import type { RequestContext } from './docTask';

export interface EgressMask {
  location: '请求头' | '请求体';
  path: string;
  before: string;
  after: string;
}

export interface EgressReport {
  level: string;
  blocked: boolean;
  masks: EgressMask[];
}

const sensitiveKey = /token|secret|password|authorization|api[-_]?key|idempotency|tenant/i;

function maskValue(value: string) {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 4)}****`;
}

function walkBody(value: unknown, prefix: string, masks: EgressMask[]) {
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') {
      walkBody(child, path, masks);
      continue;
    }
    if (!sensitiveKey.test(key)) continue;
    if (typeof child !== 'string' && typeof child !== 'number') continue;
    const before = String(child);
    masks.push({ location: '请求体', path, before, after: maskValue(before) });
  }
}

export function preflightEgress(context: RequestContext): EgressReport {
  const masks: EgressMask[] = [];

  for (const header of context.headers) {
    if (!sensitiveKey.test(header.name)) continue;
    masks.push({
      location: '请求头',
      path: header.name,
      before: header.value,
      after: maskValue(header.value),
    });
  }

  if (context.body) {
    try {
      walkBody(JSON.parse(context.body), '', masks);
    } catch {
      // 非 JSON 请求体不做字段级脱敏预览。
    }
  }

  return {
    level: context.dataLevel,
    blocked: context.dataLevel === 'L2' || context.dataLevel === 'L3',
    masks,
  };
}
