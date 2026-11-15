import { executeScript } from './scriptInterpreter';
import ScriptWorker from './scriptSandbox.worker.ts?worker';

export interface ScriptRequestContext {
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body: string | null;
}

export interface ScriptResponseContext {
  status: number;
  statusText: string;
  headers: { name: string; value: string }[];
  body: string;
  durationMs: number;
}

export interface ScriptContext {
  variables: Record<string, string>;
  request: ScriptRequestContext;
  response?: ScriptResponseContext | null;
}

export interface ScriptRunResult {
  logs: string[];
  variables: Record<string, string>;
  error: string | null;
}

export { executeScript };

function shouldUseWorker(): boolean {
  if (typeof Worker === 'undefined') return false;
  const env = import.meta.env as { VITEST?: boolean };
  if (env && env.VITEST) return false;
  return true;
}

function runInWorker(
  source: string,
  context: ScriptContext,
  timeoutMs: number,
  fallbackVariables: Record<string, string>,
): Promise<ScriptRunResult> {
  const worker = new ScriptWorker();
  return new Promise<ScriptRunResult>((resolve) => {
    let settled = false;

    function finish(result: ScriptRunResult) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      resolve(result);
    }

    const timer = window.setTimeout(() => {
      finish({ logs: [], variables: fallbackVariables, error: `脚本执行超时（>${timeoutMs}ms）` });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        logs?: string[];
        variables?: Record<string, string>;
        error?: string | null;
      };
      finish({
        logs: Array.isArray(data.logs) ? data.logs : [],
        variables: data.variables ?? fallbackVariables,
        error: data.error ?? null,
      });
    };

    worker.onerror = (event) => {
      finish({
        logs: [],
        variables: fallbackVariables,
        error: event.message || '脚本执行失败',
      });
    };

    worker.postMessage({ source, context, timeoutMs });
  });
}

/**
 * 在 CSP 不允许 eval / new Function 的环境中执行前置 / 后置脚本。
 * 优先放入 Worker，以便超时后强制终止；Worker 不可用时回退到同进程解释器。
 */
export async function runScript(
  source: string,
  context: ScriptContext,
  timeoutMs = 2000,
): Promise<ScriptRunResult> {
  const variables = { ...context.variables };
  if (!source.trim()) {
    return { logs: [], variables, error: null };
  }

  if (shouldUseWorker()) {
    try {
      return await runInWorker(source, context, timeoutMs, variables);
    } catch {
      // Worker 构造失败时回退到同进程解释器，保证安装包内仍可执行脚本。
      return executeScript(source, context, { timeoutMs });
    }
  }

  return executeScript(source, context, { timeoutMs });
}
