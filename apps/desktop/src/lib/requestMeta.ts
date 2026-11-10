import { kvGet } from './kv';

export const REQUEST_META_PREFIX = 'aw-request-meta:';

export interface RequestScripts {
  preScript: string;
  postScript: string;
}

export function readRequestScripts(requestId: string): RequestScripts {
  try {
    const raw = kvGet(`${REQUEST_META_PREFIX}${requestId}`);
    if (!raw) return { preScript: '', postScript: '' };
    const parsed = JSON.parse(raw) as { preScript?: unknown; postScript?: unknown };
    return {
      preScript: typeof parsed.preScript === 'string' ? parsed.preScript : '',
      postScript: typeof parsed.postScript === 'string' ? parsed.postScript : '',
    };
  } catch {
    return { preScript: '', postScript: '' };
  }
}
