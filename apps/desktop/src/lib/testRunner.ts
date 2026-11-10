import { listRequests, sendHttpRequest } from './api';
import {
  evaluateAssertions,
  readAssertionRows,
  type AssertionRow,
  type AssertionResult,
} from './assertions';
import { checkNetworkAccessResolved } from './networkPolicy';
import { readRequestScripts } from './requestMeta';
import { runScript } from './scriptSandbox';
import { resolveTemplate } from './variables';
import type { NetworkMode } from '../data/types';

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
  networkMode: NetworkMode,
): Promise<TestCaseResult[]> {
  const requests = (await listRequests()).filter(
    (request) => (request.collectionId ?? 'payment') === collectionId,
  );

  const results: TestCaseResult[] = [];
  // 集合测试按顺序执行，后置脚本写入的变量可供后续请求使用。
  let currentVariables = { ...variables };

  for (const request of requests) {
    const base: Omit<TestCaseResult, 'assertions'> = {
      id: request.id,
      name: request.name,
      method: request.method,
      url: request.url,
    };

    const scripts = readRequestScripts(request.id);

    if (scripts.preScript.trim()) {
      const pre = await runScript(scripts.preScript, {
        variables: currentVariables,
        request: {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body,
        },
        response: null,
      });
      currentVariables = pre.variables;
      if (pre.error) {
        results.push({
          ...base,
          url: request.url,
          error: `前置脚本执行失败：${pre.error}`,
          assertions: [],
        });
        continue;
      }
    }

    const resolvedUrl = resolveTemplate(request.url, currentVariables);
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
      const value = resolveTemplate(header.value, currentVariables);
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
      const resolvedBody = resolveTemplate(request.body, currentVariables);
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

    const access = await checkNetworkAccessResolved(resolvedUrl.value, networkMode);
    if (!access.allowed) {
      results.push({
        ...base,
        url: resolvedUrl.value,
        error: access.reason,
        assertions: [],
      });
      continue;
    }

    try {
      const response = await sendHttpRequest({
        method: request.method,
        url: resolvedUrl.value,
        headers,
        body,
      });

      const assertions = evaluateAssertions(rows, response);

      if (scripts.postScript.trim()) {
        const post = await runScript(scripts.postScript, {
          variables: currentVariables,
          request: {
            method: request.method,
            url: resolvedUrl.value,
            headers,
            body: body ?? null,
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body,
            durationMs: response.durationMs,
          },
        });
        currentVariables = post.variables;
        if (post.error) {
          assertions.push({
            id: `post-script-${request.id}`,
            path: 'script.post',
            operator: 'equals',
            expected: '执行成功',
            actual: post.error,
            passed: false,
          });
        }
      }

      results.push({
        ...base,
        url: resolvedUrl.value,
        status: response.status,
        durationMs: response.durationMs,
        assertions,
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
