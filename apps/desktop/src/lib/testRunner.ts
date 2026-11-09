import { listRequests, sendHttpRequest } from './api';
import {
  evaluateAssertions,
  readAssertionRows,
  type AssertionRow,
  type AssertionResult,
} from './assertions';
import { resolveTemplate } from './variables';

export interface TestCaseResult {
  id: string;
  name: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  error?: string;
  assertions: AssertionResult[];
}

const defaultAssertions: AssertionRow[] = [
  { id: 'default-status', path: 'status', operator: 'equals', expected: '200', enabled: true },
];

function missingNames(names: string[]) {
  return [...new Set(names)].map((name) => `{{${name}}}`).join('、');
}

export async function runCollectionTests(
  collectionId: string,
  variables: Record<string, string>,
): Promise<TestCaseResult[]> {
  const requests = (await listRequests()).filter(
    (request) => (request.collectionId ?? 'payment') === collectionId,
  );

  const results: TestCaseResult[] = [];

  for (const request of requests) {
    const base: Omit<TestCaseResult, 'assertions'> = {
      id: request.id,
      name: request.name,
      method: request.method,
      url: request.url,
    };

    const resolvedUrl = resolveTemplate(request.url, variables);
    if (resolvedUrl.missing.length > 0) {
      results.push({
        ...base,
        url: resolvedUrl.value,
        error: `缺少环境变量：${missingNames(resolvedUrl.missing)}`,
        assertions: [],
      });
      continue;
    }

    const headerMissing: string[] = [];
    const headers = request.headers.map((header) => {
      const value = resolveTemplate(header.value, variables);
      headerMissing.push(...value.missing);
      return { name: header.name, value: value.value };
    });
    if (headerMissing.length > 0) {
      results.push({
        ...base,
        url: resolvedUrl.value,
        error: `缺少环境变量：${missingNames(headerMissing)}`,
        assertions: [],
      });
      continue;
    }

    let body: string | undefined;
    if (request.body && request.method !== 'GET' && request.method !== 'DELETE') {
      const resolvedBody = resolveTemplate(request.body, variables);
      if (resolvedBody.missing.length > 0) {
        results.push({
          ...base,
          url: resolvedUrl.value,
          error: `缺少环境变量：${missingNames(resolvedBody.missing)}`,
          assertions: [],
        });
        continue;
      }
      body = resolvedBody.value;
    }

    const configured = readAssertionRows(request.id);
    const rows = configured.length > 0 ? configured : defaultAssertions;

    try {
      const response = await sendHttpRequest({
        method: request.method,
        url: resolvedUrl.value,
        headers,
        body,
      });
      results.push({
        ...base,
        url: resolvedUrl.value,
        status: response.status,
        durationMs: response.durationMs,
        assertions: evaluateAssertions(rows, response),
      });
    } catch (caught) {
      results.push({
        ...base,
        url: resolvedUrl.value,
        error: caught instanceof Error ? caught.message : String(caught),
        assertions: [],
      });
    }
  }

  return results;
}
