import { describe, expect, it } from 'vitest';
import { executeScript, runScript, type ScriptContext } from './scriptSandbox';
import interpreterSource from './scriptInterpreter.ts?raw';
import sandboxSource from './scriptSandbox.ts?raw';
import workerSource from './scriptSandbox.worker.ts?raw';

function context(partial: Partial<ScriptContext> = {}): ScriptContext {
  return {
    variables: {},
    request: {
      method: 'GET',
      url: 'https://example.internal/api',
      headers: [{ name: 'Accept', value: 'application/json' }],
      body: null,
    },
    response: null,
    ...partial,
  };
}

describe('scriptSandbox', () => {
  it('空脚本直接成功且不改动变量', async () => {
    const result = await runScript('   ', context({ variables: { a: '1' } }));
    expect(result).toEqual({ logs: [], variables: { a: '1' }, error: null });
  });

  it('支持 pm.variables 与 pm.environment 读写', async () => {
    const result = await runScript(
      `
        const current = pm.variables.get('token') ?? 'none';
        pm.variables.set('token', current + '-next');
        pm.environment.set('copied', pm.variables.get('token'));
        pm.variables.unset('removeMe');
        console.log(JSON.stringify(pm.variables.toObject()));
      `,
      context({ variables: { token: 'abc', removeMe: 'x' } }),
    );
    expect(result.error).toBeNull();
    expect(result.variables).toEqual({ token: 'abc-next', copied: 'abc-next' });
    expect(result.logs[0]).toContain('abc-next');
  });

  it('后置脚本可读取 pm.request 与 pm.response.json()', async () => {
    const result = await runScript(
      `
        const data = pm.response.json();
        pm.variables.set('id', data.id);
        pm.variables.set('method', pm.request.method);
        console.log('status', pm.response.status, pm.response.statusText);
        console.warn('len', pm.response.body.length);
      `,
      context({
        request: {
          method: 'POST',
          url: 'https://example.internal/login',
          headers: [],
          body: '{"user":"a"}',
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          body: '{"id":42}',
          durationMs: 12,
        },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.variables).toEqual({ id: '42', method: 'POST' });
    expect(result.logs).toEqual(['status 200 OK', '[warn] len 9']);
  });

  it('非法 JSON 时 pm.response.json() 返回 null', async () => {
    const result = await runScript(
      `console.log(pm.response.json());`,
      context({
        response: {
          status: 500,
          statusText: 'Error',
          headers: [],
          body: 'not-json',
          durationMs: 1,
        },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.logs).toEqual(['null']);
  });

  it('脚本运行时错误会作为可见错误返回', async () => {
    const result = await runScript(`throw new Error('签名失败');`, context());
    expect(result.error).toContain('签名失败');
  });

  it('语法错误会作为可见错误返回', async () => {
    const result = await runScript(`const x = {`, context());
    expect(result.error).toMatch(/^Error: 脚本语法错误：/);
  });

  it('调用网络 API 时抛出明确的禁止访问错误', async () => {
    for (const source of [
      'fetch("https://example.com")',
      'new XMLHttpRequest()',
      'new WebSocket("wss://example.com")',
      'new EventSource("/events")',
      'importScripts("https://example.com/x.js")',
      'navigator.sendBeacon("/x", "1")',
    ]) {
      const result = await runScript(source, context());
      expect(result.error, source).toContain('脚本沙箱禁止网络访问');
    }
  });

  it('禁止 eval / Function 以及 constructor 逃逸', async () => {
    const evalResult = await runScript(`eval('pm.variables.set("x", 1)')`, context());
    expect(evalResult.error).toContain('脚本沙箱禁止动态脚本');

    const fnResult = await runScript(`Function('return 1')()`, context());
    expect(fnResult.error).toContain('脚本沙箱禁止动态脚本');

    const escapeResult = await runScript(`('').constructor.constructor('return fetch')()`, context());
    expect(escapeResult.error).toMatch(/脚本沙箱禁止访问该能力|脚本沙箱禁止动态脚本/);
  });

  it('禁止修改内置原型', async () => {
    const result = await runScript(`Object.prototype.hacked = 1;`, context());
    expect(result.error).toContain('脚本沙箱禁止修改内置对象');
  });

  it('支持从响应 JSON 解构并写入变量', async () => {
    const result = await runScript(
      `
        const { token, user: { name } } = pm.response.json();
        pm.variables.set('token', token);
        pm.variables.set('name', name);
      `,
      context({
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          body: '{"token":"abc","user":{"name":"ada"}}',
          durationMs: 3,
        },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.variables).toEqual({ token: 'abc', name: 'ada' });
  });

  it('支持现代语法：let/const、箭头函数、可选链与模板字符串', async () => {
    const result = await runScript(
      `
        const pick = (input) => input?.token ?? 'missing';
        const data = { token: 't-1' };
        pm.variables.set('msg', \`token=\${pick(data)}\`);
      `,
      context(),
    );
    expect(result.error).toBeNull();
    expect(result.variables.msg).toBe('token=t-1');
  });

  it('顶层 return 不会导致语法错误', async () => {
    const result = await runScript(
      `
        pm.variables.set('ok', '1');
        return;
        pm.variables.set('ok', '2');
      `,
      context(),
    );
    expect(result.error).toBeNull();
    expect(result.variables.ok).toBe('1');
  });

  it('async/await 给出明确错误而不是静默失败', async () => {
    const result = await runScript(`await Promise.resolve(1);`, context());
    expect(result.error).toMatch(/脚本语法错误|暂不支持 async\/await/);
  });

  it('解释器在超时后返回可见错误', () => {
    const result = executeScript('while (true) {}', context(), { timeoutMs: 20 });
    expect(result.error).toContain('脚本执行超时');
  });

  it('实现文件不再使用 eval 或 new Function', () => {
    for (const [name, source] of [
      ['scriptSandbox.ts', sandboxSource],
      ['scriptInterpreter.ts', interpreterSource],
      ['scriptSandbox.worker.ts', workerSource],
    ] as const) {
      expect(source, name).not.toMatch(/new\s+Function\s*\(/);
      expect(source, name).not.toMatch(/\beval\s*\(/);
    }
  });
});
