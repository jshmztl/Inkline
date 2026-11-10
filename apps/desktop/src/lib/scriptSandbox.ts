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

const WORKER_SOURCE = String.raw`
// 脚本沙箱禁止一切网络与外部资源能力，避免绕过应用的网络模式策略。
function blockNetwork() {
  var blocked = function () {
    throw new Error('脚本沙箱禁止网络访问');
  };
  self.fetch = blocked;
  self.XMLHttpRequest = blocked;
  self.WebSocket = blocked;
  self.EventSource = blocked;
  self.importScripts = blocked;
  if (self.navigator) {
    try {
      Object.defineProperty(self.navigator, 'sendBeacon', { value: blocked });
    } catch (error) {
      // 部分环境不允许改写 navigator，忽略即可。
    }
  }
}

blockNetwork();

function formatValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

self.onmessage = function (event) {
  var source = event.data.source;
  var context = event.data.context;
  var logs = [];
  var state = { variables: Object.assign({}, context.variables) };
  var variablesApi = {
    get: function (name) { return state.variables[name]; },
    set: function (name, value) { state.variables[name] = String(value); },
    unset: function (name) { delete state.variables[name]; },
    toObject: function () { return Object.assign({}, state.variables); }
  };
  var pm = {
    variables: variablesApi,
    environment: variablesApi,
    request: context.request,
    response: context.response ? {
      status: context.response.status,
      statusText: context.response.statusText,
      headers: context.response.headers,
      body: context.response.body,
      durationMs: context.response.durationMs,
      json: function () {
        try {
          return JSON.parse(context.response.body);
        } catch (error) {
          return null;
        }
      }
    } : null
  };
  var scriptConsole = {
    log: function () {
      logs.push(Array.prototype.slice.call(arguments).map(formatValue).join(' '));
    },
    warn: function () {
      logs.push('[warn] ' + Array.prototype.slice.call(arguments).map(formatValue).join(' '));
    },
    error: function () {
      logs.push('[error] ' + Array.prototype.slice.call(arguments).map(formatValue).join(' '));
    }
  };

  function reply(error) {
    self.postMessage({ logs: logs, variables: state.variables, error: error || null });
  }

  try {
    var runner = new Function('pm', 'console', '"use strict";\n' + source);
    var result = runner(pm, scriptConsole);
    if (result && typeof result.then === 'function') {
      result.then(
        function () { reply(null); },
        function (error) { reply(String(error)); }
      );
    } else {
      reply(null);
    }
  } catch (error) {
    reply(String(error));
  }
};
`;

export async function runScript(
  source: string,
  context: ScriptContext,
  timeoutMs = 2000,
): Promise<ScriptRunResult> {
  const variables = { ...context.variables };
  if (!source.trim()) {
    return { logs: [], variables, error: null };
  }

  if (typeof Worker === 'undefined') {
    return { logs: [], variables, error: '当前环境不支持脚本沙箱' };
  }

  const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  return new Promise<ScriptRunResult>((resolve) => {
    let settled = false;

    function finish(result: ScriptRunResult) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    }

    const timer = window.setTimeout(() => {
      finish({ logs: [], variables, error: `脚本执行超时（>${timeoutMs}ms）` });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        logs?: string[];
        variables?: Record<string, string>;
        error?: string | null;
      };
      finish({
        logs: Array.isArray(data.logs) ? data.logs : [],
        variables: data.variables ?? variables,
        error: data.error ?? null,
      });
    };

    worker.onerror = (event) => {
      finish({ logs: [], variables, error: event.message || '脚本执行失败' });
    };

    worker.postMessage({ source, context });
  });
}
