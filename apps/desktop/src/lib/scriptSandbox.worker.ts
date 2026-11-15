import { executeScript } from './scriptInterpreter';
import type { ScriptContext } from './scriptSandbox';

self.onmessage = (event: MessageEvent<{ source: string; context: ScriptContext; timeoutMs: number }>) => {
  const { source, context, timeoutMs } = event.data;
  try {
    self.postMessage(executeScript(source, context, { timeoutMs }));
  } catch (error) {
    self.postMessage({
      logs: [],
      variables: context.variables ?? {},
      error: String(error),
    });
  }
};
