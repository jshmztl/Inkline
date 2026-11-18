import * as acorn from 'acorn';
import type { ScriptContext, ScriptRunResult } from './scriptSandbox';

const NETWORK_ERROR = '脚本沙箱禁止网络访问';
const DYNAMIC_SCRIPT_ERROR = '脚本沙箱禁止动态脚本（eval / Function）';

type AnyNode = acorn.Node & Record<string, any>;

class ControlSignal {
  // 用于 return / break / continue 的内部控制流。
}

export class ReturnSignal extends ControlSignal {
  constructor(public value: unknown) {
    super();
  }
}

class BreakSignal extends ControlSignal {
  constructor(public label: string | null) {
    super();
  }
}

class ContinueSignal extends ControlSignal {
  constructor(public label: string | null) {
    super();
  }
}

const OPTIONAL_END = Symbol('optional-end');

interface Binding {
  kind: 'var' | 'let' | 'const';
  value: unknown;
  initialized: boolean;
}

interface Scope {
  parent: Scope | null;
  kind: 'global' | 'function' | 'block';
  bindings: Map<string, Binding>;
  thisValue: unknown;
}

interface InterpreterOptions {
  timeoutMs?: number;
  now?: () => number;
}

const DANGEROUS_KEYS = new Set([
  'constructor',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
]);

const NETWORK_NAMES = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'sendBeacon',
]);

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isControlSignal(value: unknown): value is ControlSignal {
  return value instanceof ControlSignal;
}

function thrownMessage(error: unknown): string {
  return String(error);
}

function networkStub(): never {
  throw new Error(NETWORK_ERROR);
}

function dynamicScriptStub(): never {
  throw new Error(DYNAMIC_SCRIPT_ERROR);
}

function hostGlobal(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function collectForbiddenValues(): Set<unknown> {

  const values: unknown[] = [
    Function,
    eval,
    Object.getOwnPropertyDescriptor,
    Object.getOwnPropertyDescriptors,
    Object.getPrototypeOf,
    Object.setPrototypeOf,
    Object.defineProperty,
    Object.defineProperties,
    Object.getOwnPropertyNames,
    Object.getOwnPropertySymbols,
    Object.create,
    Reflect,
    Proxy,
    hostGlobal('Worker'),
    hostGlobal('SharedWorker'),
    hostGlobal('WebAssembly'),
    hostGlobal('fetch'),
    hostGlobal('XMLHttpRequest'),
    hostGlobal('WebSocket'),
    hostGlobal('EventSource'),
    hostGlobal('importScripts'),
    (hostGlobal('navigator') as { sendBeacon?: unknown } | undefined)?.sendBeacon,
  ];
  return new Set(values.filter((value) => value != null));
}

const FORBIDDEN_VALUES = collectForbiddenValues();

const PROTECTED_TARGETS = new Set<unknown>([
  Object,
  Object.prototype,
  Array,
  Array.prototype,
  Function,
  Function.prototype,
  String,
  String.prototype,
  Number,
  Number.prototype,
  Boolean,
  Boolean.prototype,
  Date,
  Date.prototype,
  RegExp,
  RegExp.prototype,
  Error,
  Error.prototype,
  Math,
  JSON,
  Map,
  Map.prototype,
  Set,
  Set.prototype,
  Promise,
  Reflect,
]);

function isForbiddenValue(value: unknown): boolean {
  if (FORBIDDEN_VALUES.has(value)) return true;
  if (typeof value === 'function') {
    const name = (value as { name?: string }).name;
    if (name && NETWORK_NAMES.has(name) && FORBIDDEN_VALUES.has(value)) return true;
  }
  return false;
}

function assertSafeValue(value: unknown): unknown {
  if (isForbiddenValue(value)) {
    if (typeof value === 'function' && NETWORK_NAMES.has((value as { name?: string }).name ?? '')) {
      throw new Error(NETWORK_ERROR);
    }
    throw new Error('脚本沙箱禁止访问该能力');
  }
  return value;
}

function readProperty(object: unknown, key: unknown): unknown {
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot read properties of ${object}`);
  }
  const name = typeof key === 'symbol' ? key : String(key);
  if (typeof name === 'string' && DANGEROUS_KEYS.has(name)) {
    const value = (object as Record<string, unknown>)[name];
    if (name === 'constructor' && typeof object !== 'function') {
      return assertSafeValue(value);
    }
    if (isForbiddenValue(value) || name !== 'constructor') {
      if (typeof value === 'function' && NETWORK_NAMES.has(value.name)) {
        throw new Error(NETWORK_ERROR);
      }
      throw new Error('脚本沙箱禁止访问该能力');
    }
    return assertSafeValue(value);
  }
  return assertSafeValue((object as Record<PropertyKey, unknown>)[name as PropertyKey]);
}

function writeProperty(object: unknown, key: unknown, value: unknown): unknown {
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot set properties of ${object}`);
  }
  if (PROTECTED_TARGETS.has(object)) {
    throw new Error('脚本沙箱禁止修改内置对象');
  }
  const name = typeof key === 'symbol' ? key : String(key);
  if (typeof name === 'string' && DANGEROUS_KEYS.has(name)) {
    throw new Error('脚本沙箱禁止访问该能力');
  }
  (object as Record<PropertyKey, unknown>)[name as PropertyKey] = value;
  return value;
}

function deleteProperty(object: unknown, key: unknown): boolean {
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot convert ${object} to object`);
  }
  if (PROTECTED_TARGETS.has(object)) {
    throw new Error('脚本沙箱禁止修改内置对象');
  }
  const name = typeof key === 'symbol' ? key : String(key);
  if (typeof name === 'string' && DANGEROUS_KEYS.has(name)) {
    throw new Error('脚本沙箱禁止访问该能力');
  }
  return delete (object as Record<PropertyKey, unknown>)[name as PropertyKey];
}

function toNumber(value: unknown): number {
  return Number(value);
}

function toName(key: unknown): string {
  return typeof key === 'symbol' ? String(key) : String(key);
}

function newScope(parent: Scope | null, kind: Scope['kind'], thisValue?: unknown): Scope {
  return {
    parent,
    kind,
    bindings: new Map(),
    thisValue: thisValue !== undefined ? thisValue : parent ? parent.thisValue : undefined,
  };
}

function findBinding(scope: Scope, name: string): Binding | null {
  let current: Scope | null = scope;
  while (current) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
    current = current.parent;
  }
  return null;
}

function findFunctionScope(scope: Scope): Scope {
  let current: Scope | null = scope;
  while (current) {
    if (current.kind === 'function' || current.kind === 'global') return current;
    current = current.parent;
  }
  return scope;
}

function declare(scope: Scope, name: string, kind: Binding['kind'], value?: unknown, initialized = false) {
  if (kind === 'var') {
    const target = findFunctionScope(scope);
    if (!target.bindings.has(name)) {
      target.bindings.set(name, { kind: 'var', value: initialized ? value : undefined, initialized });
    } else if (initialized) {
      const binding = target.bindings.get(name)!;
      binding.value = value;
      binding.initialized = true;
    }
    return;
  }
  const existing = scope.bindings.get(name);
  if (existing && existing.initialized) {
    throw new SyntaxError(`Identifier '${name}' has already been declared`);
  }
  scope.bindings.set(name, {
    kind,
    value: initialized ? value : undefined,
    initialized,
  });
}

function assignIdentifier(scope: Scope, name: string, value: unknown): unknown {
  const binding = findBinding(scope, name);
  if (binding) {
    if (binding.kind === 'const' && binding.initialized) {
      throw new TypeError("Assignment to constant variable");
    }
    binding.value = value;
    binding.initialized = true;
    return value;
  }
  throw new ReferenceError(`${name} is not defined`);
}

function readIdentifier(scope: Scope, name: string): unknown {
  const binding = findBinding(scope, name);
  if (!binding) {
    throw new ReferenceError(`${name} is not defined`);
  }
  if (!binding.initialized) {
    throw new ReferenceError(`Cannot access '${name}' before initialization`);
  }
  return assertSafeValue(binding.value);
}

function hoist(body: AnyNode | AnyNode[], scope: Scope) {
  const statements = Array.isArray(body) ? body : body.type === 'BlockStatement' ? body.body : [body];
  for (const statement of statements) {
    hoistStatement(statement, scope);
  }
}

function hoistStatement(node: AnyNode, scope: Scope) {
  switch (node.type) {
    case 'VariableDeclaration':
      for (const declarator of node.declarations as AnyNode[]) {
        if (node.kind === 'var') {
          hoistPattern(declarator.id, scope, 'var');
        }
      }
      break;
    case 'FunctionDeclaration':
      if (node.id?.name) {
        // 函数声明在后续求值时再写入具体实现，这里先占位。
        declare(scope, node.id.name, 'var', undefined, false);
      }
      break;
    case 'BlockStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'IfStatement':
    case 'SwitchStatement':
    case 'TryStatement':
    case 'LabeledStatement':
    case 'WithStatement':
      // 仅提升函数作用域的 var / 函数声明，块级内容在进入块时处理。
      walkVarHoist(node, scope);
      break;
    default:
      break;
  }
}

function walkVarHoist(node: AnyNode, scope: Scope) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    if (node.type === 'FunctionDeclaration' && node.id?.name && scope.kind !== 'block') {
      declare(scope, node.id.name, 'var', undefined, false);
    }
    return;
  }
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declarator of node.declarations as AnyNode[]) {
      hoistPattern(declarator.id, scope, 'var');
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && item.type) walkVarHoist(item, scope);
      }
    } else if (value && typeof value === 'object' && value.type) {
      walkVarHoist(value, scope);
    }
  }
}

function hoistPattern(id: AnyNode, scope: Scope, kind: Binding['kind']) {
  switch (id.type) {
    case 'Identifier':
      declare(scope, id.name, kind);
      break;
    case 'ObjectPattern':
      for (const property of id.properties as AnyNode[]) {
        if (property.type === 'RestElement') hoistPattern(property.argument, scope, kind);
        else hoistPattern(property.value ?? property, scope, kind);
      }
      break;
    case 'ArrayPattern':
      for (const element of id.elements as Array<AnyNode | null>) {
        if (element) {
          if (element.type === 'RestElement') hoistPattern(element.argument, scope, kind);
          else hoistPattern(element, scope, kind);
        }
      }
      break;
    case 'AssignmentPattern':
      hoistPattern(id.left, scope, kind);
      break;
    case 'RestElement':
      hoistPattern(id.argument, scope, kind);
      break;
    default:
      break;
  }
}

function assignPattern(id: AnyNode, value: unknown, scope: Scope, kind?: Binding['kind'], initialize = false) {
  switch (id.type) {
    case 'Identifier':
      if (initialize && kind) {
        declare(scope, id.name, kind, value, true);
      } else if (kind === 'var') {
        declare(scope, id.name, 'var', value, true);
      } else {
        assignIdentifier(scope, id.name, value);
      }
      return;
    case 'AssignmentPattern':
      assignPattern(id.left, value === undefined ? undefined : value, scope, kind, initialize);
      if (value === undefined) {
        const fallback = evaluate(id.right, scope);
        assignPattern(id.left, fallback, scope, kind, initialize);
      }
      return;
    case 'ObjectPattern': {
      if (value === null || value === undefined) {
        throw new TypeError('Cannot destructure ' + String(value));
      }
      const used = new Set<PropertyKey>();
      for (const property of id.properties as AnyNode[]) {
        if (property.type === 'RestElement') {
          const rest: Record<string, unknown> = {};
          for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (!used.has(key)) rest[key] = entry;
          }
          assignPattern(property.argument, rest, scope, kind, initialize);
        } else {
          const key = property.computed ? evaluate(property.key, scope) : property.key.type === 'Identifier' ? property.key.name : property.key.value;
          used.add(key as PropertyKey);
          assignPattern(property.value, readProperty(value, key), scope, kind, initialize);
        }
      }
      return;
    }
    case 'ArrayPattern': {
      if (value == null || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
        throw new TypeError('Cannot destructure non-iterable value');
      }
      const values = Array.from(value as Iterable<unknown>);
      let index = 0;
      for (const element of id.elements as Array<AnyNode | null>) {
        if (!element) {
          index += 1;
          continue;
        }
        if (element.type === 'RestElement') {
          assignPattern(element.argument, values.slice(index), scope, kind, initialize);
          break;
        }
        assignPattern(element, values[index], scope, kind, initialize);
        index += 1;
      }
      return;
    }
    case 'RestElement':
      assignPattern(id.argument, value, scope, kind, initialize);
      return;
    default:
      throw new Error(`脚本沙箱暂不支持 ${id.type} 解构`);
  }
}

// AssignmentPattern 在声明时默认值需要在值为 undefined 时求值。上面的实现
// 对「已有值」会先赋值再被默认值覆盖的问题，这里用更精确的版本替换声明路径。
function initPattern(id: AnyNode, value: unknown, scope: Scope, kind: Binding['kind']) {
  switch (id.type) {
    case 'Identifier':
      declare(scope, id.name, kind, value, true);
      return;
    case 'AssignmentPattern': {
      const resolved = value === undefined ? evaluate(id.right, scope) : value;
      initPattern(id.left, resolved, scope, kind);
      return;
    }
    case 'ObjectPattern': {
      if (value === null || value === undefined) {
        throw new TypeError('Cannot destructure ' + String(value));
      }
      const used = new Set<PropertyKey>();
      for (const property of id.properties as AnyNode[]) {
        if (property.type === 'RestElement') {
          const rest: Record<string, unknown> = {};
          for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (!used.has(key)) rest[key] = entry;
          }
          initPattern(property.argument, rest, scope, kind);
        } else {
          const key = property.computed
            ? evaluate(property.key, scope)
            : property.key.type === 'Identifier'
              ? property.key.name
              : property.key.value;
          used.add(key as PropertyKey);
          const raw = readProperty(value, key);
          if (property.value.type === 'AssignmentPattern' && raw === undefined) {
            initPattern(property.value, undefined, scope, kind);
          } else {
            initPattern(property.value, raw, scope, kind);
          }
        }
      }
      return;
    }
    case 'ArrayPattern': {
      if (value == null || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
        throw new TypeError('Cannot destructure non-iterable value');
      }
      const values = Array.from(value as Iterable<unknown>);
      let index = 0;
      for (const element of id.elements as Array<AnyNode | null>) {
        if (!element) {
          index += 1;
          continue;
        }
        if (element.type === 'RestElement') {
          initPattern(element.argument, values.slice(index), scope, kind);
          break;
        }
        initPattern(element, values[index], scope, kind);
        index += 1;
      }
      return;
    }
    default:
      throw new Error(`脚本沙箱暂不支持 ${id.type} 解构`);
  }
}

let evaluate: (node: AnyNode, scope: Scope, chain?: boolean) => unknown;
let timeoutMs = 2000;
let startedAt = 0;
let steps = 0;
let now: () => number = Date.now;

function checkTimeout() {
  steps += 1;
  if (steps % 32 === 0 && now() - startedAt > timeoutMs) {
    throw new Error(`脚本执行超时（>${timeoutMs}ms）`);
  }
  if (steps > 10_000_000) {
    throw new Error(`脚本执行超时（>${timeoutMs}ms）`);
  }
}

function evalStatementList(nodes: AnyNode[], scope: Scope): unknown {
  let result: unknown;
  for (const node of nodes) {
    result = evaluate(node, scope);
  }
  return result;
}

function createFunction(node: AnyNode, closure: Scope, name?: string | null): Function {
  if (node.async) {
    throw new Error('脚本沙箱暂不支持 async/await，请使用同步代码');
  }
  if (node.generator) {
    throw new Error('脚本沙箱暂不支持 generator');
  }

  const isArrow = node.type === 'ArrowFunctionExpression';
  const impl = function (this: unknown, ...args: unknown[]) {
    checkTimeout();
    const fnScope = newScope(closure, 'function', isArrow ? closure.thisValue : this);
    if (!isArrow) {
      fnScope.bindings.set('arguments', {
        kind: 'var',
        value: args,
        initialized: true,
      });
    }
    if (name && !isArrow) {
      if (!fnScope.bindings.has(name)) {
        fnScope.bindings.set(name, { kind: 'var', value: impl, initialized: true });
      }
    }
    const params = node.params as AnyNode[];
    params.forEach((param, index) => {
      initPattern(param, args[index], fnScope, 'let');
    });
    try {
      if (node.expression) {
        return evaluate(node.body, fnScope);
      }
      hoist(node.body, fnScope);
      evaluate(node.body, fnScope);
      return undefined;
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      throw error;
    }
  };
  Object.defineProperty(impl, 'name', { value: name ?? '', configurable: true });
  Object.defineProperty(impl, 'length', { value: node.params.length, configurable: true });
  return impl;
}

function bindFunctionDeclarations(body: AnyNode[], scope: Scope) {
  for (const node of body) {
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      const fn = createFunction(node, scope, node.id.name);
      declare(scope, node.id.name, 'var', fn, true);
    }
  }
}

function getMemberTarget(node: AnyNode, scope: Scope, chain: boolean): { object: unknown; key: unknown } | typeof OPTIONAL_END {
  const object = evaluate(node.object, scope, chain);
  if (chain && node.optional && (object === null || object === undefined)) {
    return OPTIONAL_END;
  }
  if (object === OPTIONAL_END) return OPTIONAL_END;
  const key = node.computed ? evaluate(node.property, scope) : node.property.name;
  return { object, key };
}

function applyBinary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '+':
      return (left as any) + (right as any);
    case '-':
      return (left as any) - (right as any);
    case '*':
      return (left as any) * (right as any);
    case '/':
      return (left as any) / (right as any);
    case '%':
      return (left as any) % (right as any);
    case '**':
      return (left as any) ** (right as any);
    case '==':
      return left == right;
    case '!=':
      return left != right;
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '<':
      return (left as any) < (right as any);
    case '<=':
      return (left as any) <= (right as any);
    case '>':
      return (left as any) > (right as any);
    case '>=':
      return (left as any) >= (right as any);
    case '<<':
      return (left as any) << (right as any);
    case '>>':
      return (left as any) >> (right as any);
    case '>>>':
      return (left as any) >>> (right as any);
    case '&':
      return (left as any) & (right as any);
    case '|':
      return (left as any) | (right as any);
    case '^':
      return (left as any) ^ (right as any);
    case 'in':
      if (right === null || right === undefined) {
        throw new TypeError("Cannot use 'in' operator to search for " + String(left) + " in " + String(right));
      }
      return toName(left) in (right as object);
    case 'instanceof':
      if (typeof right !== 'function') {
        throw new TypeError('Right-hand side of instanceof is not callable');
      }
      return left instanceof (right as Function);
    default:
      throw new Error(`脚本沙箱暂不支持运算符 ${operator}`);
  }
}

function applyUnary(operator: string, value: unknown): unknown {
  switch (operator) {
    case '!':
      return !value;
    case '+':
      return +(value as number);
    case '-':
      return -(value as number);
    case '~':
      return ~(value as number);
    case 'typeof':
      return typeof value;
    case 'void':
      return undefined;
    default:
      throw new Error(`脚本沙箱暂不支持运算符 ${operator}`);
  }
}

function updateValue(current: unknown, operator: string, prefix: boolean): { next: unknown; result: unknown } {
  const numeric = toNumber(current);
  const next = operator === '++' ? numeric + 1 : numeric - 1;
  return { next, result: prefix ? next : numeric };
}

evaluate = function evaluateNode(node: AnyNode, scope: Scope, chain = false): unknown {
  checkTimeout();
  switch (node.type) {
    case 'Program': {
      hoist(node.body, scope);
      bindFunctionDeclarations(node.body, scope);
      return evalStatementList(node.body, scope);
    }
    case 'BlockStatement': {
      const block = newScope(scope, 'block');
      hoist(node.body, block);
      bindFunctionDeclarations(node.body, block);
      return evalStatementList(node.body, block);
    }
    case 'ExpressionStatement':
      return evaluate(node.expression, scope);
    case 'EmptyStatement':
    case 'DebuggerStatement':
      return undefined;
    case 'Literal':
      return node.value;
    case 'Identifier': {
      if (node.name === 'undefined') return undefined;
      return readIdentifier(scope, node.name);
    }
    case 'ThisExpression':
      return scope.thisValue;
    case 'ArrayExpression': {
      const result: unknown[] = [];
      for (const element of node.elements as Array<AnyNode | null>) {
        if (!element) {
          result.length += 1;
          continue;
        }
        if (element.type === 'SpreadElement') {
          const spread = evaluate(element.argument, scope);
          result.push(...(spread as unknown[]));
        } else {
          result.push(evaluate(element, scope));
        }
      }
      return result;
    }
    case 'ObjectExpression': {
      const result: Record<PropertyKey, unknown> = {};
      for (const property of node.properties as AnyNode[]) {
        if (property.type === 'SpreadElement') {
          const spread = evaluate(property.argument, scope);
          if (spread && typeof spread === 'object') Object.assign(result, spread);
          continue;
        }
        if (property.kind !== 'init') {
          throw new Error('脚本沙箱暂不支持 getter / setter');
        }
        const key = property.computed
          ? evaluate(property.key, scope)
          : property.key.type === 'Identifier'
            ? property.key.name
            : property.key.value;
        const value = property.method || property.value.type === 'FunctionExpression'
          ? createFunction(property.value, scope, typeof key === 'string' ? key : undefined)
          : evaluate(property.value, scope);
        writeProperty(result, key, value);
      }
      return result;
    }
    case 'TemplateLiteral': {
      const expressions = node.expressions as AnyNode[];
      const quasis = node.quasis as AnyNode[];
      let out = '';
      for (let i = 0; i < quasis.length; i += 1) {
        out += quasis[i].value.cooked ?? '';
        if (i < expressions.length) out += String(evaluate(expressions[i], scope));
      }
      return out;
    }
    case 'MemberExpression': {
      const target = getMemberTarget(node, scope, chain || node.optional);
      if (target === OPTIONAL_END) return chain || node.optional ? OPTIONAL_END : undefined;
      return readProperty(target.object, target.key);
    }
    case 'ChainExpression': {
      const value = evaluate(node.expression, scope, true);
      return value === OPTIONAL_END ? undefined : value;
    }
    case 'CallExpression': {
      const calleeNode = node.callee as AnyNode;
      let thisArg: unknown = undefined;
      let callee: unknown;
      if (calleeNode.type === 'MemberExpression') {
        const target = getMemberTarget(calleeNode, scope, chain || calleeNode.optional || node.optional);
        if (target === OPTIONAL_END) return chain || node.optional || calleeNode.optional ? OPTIONAL_END : undefined;
        thisArg = target.object;
        callee = readProperty(target.object, target.key);
      } else {
        callee = evaluate(calleeNode, scope, chain || node.optional);
        if (callee === OPTIONAL_END) return OPTIONAL_END;
        if (node.optional && (callee === null || callee === undefined)) {
          return chain ? OPTIONAL_END : undefined;
        }
      }
      if (node.optional && (callee === null || callee === undefined)) {
        return chain ? OPTIONAL_END : undefined;
      }
      if (typeof callee !== 'function') {
        throw new TypeError((typeof callee === 'string' ? callee : String(callee)) + ' is not a function');
      }
      assertSafeValue(callee);
      const args: unknown[] = [];
      for (const argument of node.arguments as AnyNode[]) {
        if (argument.type === 'SpreadElement') {
          const spread = evaluate(argument.argument, scope);
          args.push(...(spread as unknown[]));
        } else {
          args.push(evaluate(argument, scope));
        }
      }
      return assertSafeValue(callee.apply(thisArg, args));
    }
    case 'NewExpression': {
      const ctor = evaluate(node.callee, scope);
      if (typeof ctor !== 'function') {
        throw new TypeError(String(ctor) + ' is not a constructor');
      }
      assertSafeValue(ctor);
      if (ctor === Function) {
        throw new Error(DYNAMIC_SCRIPT_ERROR);
      }
      const args: unknown[] = [];
      for (const argument of node.arguments as AnyNode[]) {
        if (argument.type === 'SpreadElement') {
          args.push(...(evaluate(argument.argument, scope) as unknown[]));
        } else {
          args.push(evaluate(argument, scope));
        }
      }
      return assertSafeValue(new (ctor as new (...fnArgs: unknown[]) => unknown)(...args));
    }
    case 'UnaryExpression': {
      if (node.operator === 'delete') {
        if (node.argument.type === 'MemberExpression') {
          const target = getMemberTarget(node.argument, scope, false);
          if (target === OPTIONAL_END) return true;
          return deleteProperty(target.object, target.key);
        }
        if (node.argument.type === 'Identifier') {
          throw new SyntaxError("Delete of an unqualified identifier in strict mode");
        }
        evaluate(node.argument, scope);
        return true;
      }
      if (node.operator === 'typeof' && node.argument.type === 'Identifier') {
        try {
          return typeof readIdentifier(scope, node.argument.name);
        } catch (error) {
          if (error instanceof ReferenceError) return 'undefined';
          throw error;
        }
      }
      const value = evaluate(node.argument, scope);
      return applyUnary(node.operator, value);
    }
    case 'UpdateExpression': {
      if (node.argument.type === 'Identifier') {
        const current = readIdentifier(scope, node.argument.name);
        const updated = updateValue(current, node.operator, node.prefix);
        assignIdentifier(scope, node.argument.name, updated.next);
        return updated.result;
      }
      if (node.argument.type === 'MemberExpression') {
        const target = getMemberTarget(node.argument, scope, false);
        if (target === OPTIONAL_END) {
          throw new TypeError('Cannot update undefined');
        }
        const current = readProperty(target.object, target.key);
        const updated = updateValue(current, node.operator, node.prefix);
        writeProperty(target.object, target.key, updated.next);
        return updated.result;
      }
      throw new ReferenceError('Invalid left-hand side expression in prefix/postfix operation');
    }
    case 'BinaryExpression':
      return applyBinary(node.operator, evaluate(node.left, scope), evaluate(node.right, scope));
    case 'LogicalExpression': {
      const left = evaluate(node.left, scope);
      if (node.operator === '&&') return left ? evaluate(node.right, scope) : left;
      if (node.operator === '||') return left ? left : evaluate(node.right, scope);
      if (node.operator === '??') return left === null || left === undefined ? evaluate(node.right, scope) : left;
      throw new Error(`脚本沙箱暂不支持运算符 ${node.operator}`);
    }
    case 'ConditionalExpression':
      return evaluate(node.test, scope) ? evaluate(node.consequent, scope) : evaluate(node.alternate, scope);
    case 'SequenceExpression': {
      let result: unknown;
      for (const expression of node.expressions as AnyNode[]) {
        result = evaluate(expression, scope);
      }
      return result;
    }
    case 'AssignmentExpression': {
      const operator = node.operator as string;
      const applyAssign = (current: unknown, right: unknown): unknown => {
        switch (operator) {
          case '=':
            return right;
          case '+=':
            return (current as any) + (right as any);
          case '-=':
            return (current as any) - (right as any);
          case '*=':
            return (current as any) * (right as any);
          case '/=':
            return (current as any) / (right as any);
          case '%=':
            return (current as any) % (right as any);
          case '**=':
            return (current as any) ** (right as any);
          case '<<=':
            return (current as any) << (right as any);
          case '>>=':
            return (current as any) >> (right as any);
          case '>>>=':
            return (current as any) >>> (right as any);
          case '&=':
            return (current as any) & (right as any);
          case '|=':
            return (current as any) | (right as any);
          case '^=':
            return (current as any) ^ (right as any);
          case '&&=':
            return current ? right : current;
          case '||=':
            return current ? current : right;
          case '??=':
            return current === null || current === undefined ? right : current;
          default:
            throw new Error(`脚本沙箱暂不支持运算符 ${operator}`);
        }
      };
      const shortCircuit = operator === '&&=' || operator === '||=' || operator === '??=';
      if (node.left.type === 'Identifier') {
        const current = operator === '=' ? undefined : readIdentifier(scope, node.left.name);
        if (shortCircuit) {
          if (operator === '&&=' && !current) return current;
          if (operator === '||=' && current) return current;
          if (operator === '??=' && current !== null && current !== undefined) return current;
        }
        const right = evaluate(node.right, scope);
        const next = applyAssign(current, right);
        return assignIdentifier(scope, node.left.name, next);
      }
      if (node.left.type === 'MemberExpression') {
        const target = getMemberTarget(node.left, scope, false);
        if (target === OPTIONAL_END) {
          throw new TypeError('Invalid assignment target');
        }
        const current = operator === '=' ? undefined : readProperty(target.object, target.key);
        if (shortCircuit) {
          if (operator === '&&=' && !current) return current;
          if (operator === '||=' && current) return current;
          if (operator === '??=' && current !== null && current !== undefined) return current;
        }
        const right = evaluate(node.right, scope);
        const next = applyAssign(current, right);
        return writeProperty(target.object, target.key, next);
      }
      if (operator !== '=') {
        throw new ReferenceError('Invalid left-hand side in assignment');
      }
      const right = evaluate(node.right, scope);
      assignPattern(node.left, right, scope);
      return right;
    }
    case 'VariableDeclaration': {
      for (const declarator of node.declarations as AnyNode[]) {
        const value = declarator.init ? evaluate(declarator.init, scope) : undefined;
        initPattern(declarator.id, value, scope, node.kind);
      }
      return undefined;
    }
    case 'FunctionDeclaration':
      return undefined;
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return createFunction(node, scope, node.id?.name ?? '');
    case 'ReturnStatement':
      throw new ReturnSignal(node.argument ? evaluate(node.argument, scope) : undefined);
    case 'BreakStatement':
      throw new BreakSignal(node.label?.name ?? null);
    case 'ContinueStatement':
      throw new ContinueSignal(node.label?.name ?? null);
    case 'ThrowStatement':
      throw evaluate(node.argument, scope);
    case 'IfStatement':
      if (evaluate(node.test, scope)) return evaluate(node.consequent, scope);
      if (node.alternate) return evaluate(node.alternate, scope);
      return undefined;
    case 'WhileStatement': {
      let result: unknown;
      while (evaluate(node.test, scope)) {
        try {
          result = evaluate(node.body, scope);
        } catch (error) {
          if (error instanceof BreakSignal && !error.label) break;
          if (error instanceof ContinueSignal && !error.label) continue;
          throw error;
        }
      }
      return result;
    }
    case 'DoWhileStatement': {
      let result: unknown;
      do {
        try {
          result = evaluate(node.body, scope);
        } catch (error) {
          if (error instanceof BreakSignal && !error.label) break;
          if (error instanceof ContinueSignal && !error.label) continue;
          throw error;
        }
      } while (evaluate(node.test, scope));
      return result;
    }
    case 'ForStatement': {
      const loopScope = newScope(scope, 'block');
      if (node.init) {
        if (node.init.type === 'VariableDeclaration') evaluate(node.init, loopScope);
        else evaluate(node.init, loopScope);
      }
      let result: unknown;
      while (node.test ? Boolean(evaluate(node.test, loopScope)) : true) {
        const iterScope = forkLetScope(loopScope);
        try {
          result = evaluate(node.body, iterScope);
        } catch (error) {
          if (error instanceof BreakSignal && !error.label) break;
          if (error instanceof ContinueSignal && !error.label) {
            syncLetScope(loopScope, iterScope);
            if (node.update) evaluate(node.update, loopScope);
            continue;
          }
          throw error;
        }
        syncLetScope(loopScope, iterScope);
        if (node.update) evaluate(node.update, loopScope);
      }
      return result;
    }
    case 'ForOfStatement':
    case 'ForInStatement': {
      const iterated = evaluate(node.right, scope);
      const entries = node.type === 'ForOfStatement'
        ? Array.from(iterated as Iterable<unknown>)
        : Object.keys(iterated as object);
      let result: unknown;
      for (const item of entries) {
        const iterScope = newScope(scope, 'block');
        if (node.left.type === 'VariableDeclaration') {
          const id = node.left.declarations[0].id;
          const kind = node.left.kind as Binding['kind'];
          if (kind === 'var') initPattern(id, item, scope, 'var');
          else initPattern(id, item, iterScope, kind);
        } else {
          assignPattern(node.left, item, iterScope);
        }
        try {
          result = evaluate(node.body, iterScope);
        } catch (error) {
          if (error instanceof BreakSignal && !error.label) break;
          if (error instanceof ContinueSignal && !error.label) continue;
          throw error;
        }
      }
      return result;
    }
    case 'SwitchStatement': {
      const discriminant = evaluate(node.discriminant, scope);
      const block = newScope(scope, 'block');
      const cases = node.cases as AnyNode[];
      let started = false;
      let result: unknown;
      for (const switchCase of cases) {
        if (!started) {
          if (!switchCase.test || evaluate(switchCase.test, block) === discriminant) {
            started = true;
          }
        }
        if (!started) continue;
        try {
          result = evalStatementList(switchCase.consequent, block);
        } catch (error) {
          if (error instanceof BreakSignal && !error.label) return result;
          throw error;
        }
      }
      return result;
    }
    case 'TryStatement': {
      try {
        return evaluate(node.block, scope);
      } catch (error) {
        if (isControlSignal(error)) throw error;
        if (node.handler) {
          const catchScope = newScope(scope, 'block');
          if (node.handler.param) {
            initPattern(node.handler.param, error, catchScope, 'let');
          }
          return evaluate(node.handler.body, catchScope);
        }
        throw error;
      } finally {
        if (node.finalizer) {
          evaluate(node.finalizer, scope);
        }
      }
    }
    case 'LabeledStatement': {
      try {
        return evaluate(node.body, scope);
      } catch (error) {
        if (error instanceof BreakSignal && error.label === node.label.name) return undefined;
        throw error;
      }
    }
    case 'AwaitExpression':
      throw new Error('脚本沙箱暂不支持 async/await，请使用同步代码');
    case 'ImportExpression':
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
    case 'ExportAllDeclaration':
      throw new Error('脚本沙箱禁止加载外部模块');
    case 'WithStatement':
      throw new Error('脚本沙箱禁止 with 语句');
    case 'ClassDeclaration':
    case 'ClassExpression':
      throw new Error('脚本沙箱暂不支持 class');
    case 'MetaProperty':
      throw new Error('脚本沙箱禁止 new.target / import.meta');
    default:
      throw new Error(`脚本沙箱暂不支持 ${node.type}`);
  }
};

function forkLetScope(scope: Scope): Scope {
  const forked = newScope(scope.parent, 'block', scope.thisValue);
  for (const [name, binding] of scope.bindings) {
    forked.bindings.set(name, { ...binding });
  }
  return forked;
}

function syncLetScope(target: Scope, source: Scope) {
  for (const [name, binding] of source.bindings) {
    target.bindings.set(name, { ...binding });
  }
}

function createPm(context: ScriptContext, state: { variables: Record<string, string> }) {
  const variablesApi = {
    get(name: string) {
      return state.variables[String(name)];
    },
    set(name: string, value: unknown) {
      state.variables[String(name)] = String(value);
    },
    unset(name: string) {
      delete state.variables[String(name)];
    },
    toObject() {
      return { ...state.variables };
    },
  };
  return {
    variables: variablesApi,
    environment: variablesApi,
    request: context.request,
    response: context.response
      ? {
          status: context.response.status,
          statusText: context.response.statusText,
          headers: context.response.headers,
          body: context.response.body,
          durationMs: context.response.durationMs,
          json() {
            try {
              return JSON.parse(context.response!.body);
            } catch {
              return null;
            }
          },
        }
      : null,
  };
}

function createSandboxGlobal(pm: unknown, scriptConsole: unknown): Record<string, unknown> {
  const global: Record<string, unknown> = {
    pm,
    console: scriptConsole,
    undefined,
    NaN,
    Infinity,
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    TypeError,
    ReferenceError,
    SyntaxError,
    RangeError,
    URIError,
    Map,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    atob: typeof atob === 'function' ? atob : undefined,
    btoa: typeof btoa === 'function' ? btoa : undefined,
    ArrayBuffer,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    Symbol,
    fetch: networkStub,
    XMLHttpRequest: networkStub,
    WebSocket: networkStub,
    EventSource: networkStub,
    importScripts: networkStub,
    sendBeacon: networkStub,
    navigator: { sendBeacon: networkStub },
    eval: dynamicScriptStub,
    Function: dynamicScriptStub,
    Worker: dynamicScriptStub,
    SharedWorker: dynamicScriptStub,
    WebAssembly: undefined,
    Proxy: undefined,
    Reflect: undefined,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    Deno: undefined,
    document: undefined,
    window: undefined,
    location: undefined,
  };
  global.globalThis = global;
  global.self = global;
  return global;
}

function parseScript(source: string): AnyNode {
  try {
    return acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: false,
    }) as AnyNode;
  } catch (error) {
    const err = error as { message?: string };
    throw new Error(`脚本语法错误：${err.message ?? String(error)}`);
  }
}

export function executeScript(
  source: string,
  context: ScriptContext,
  options: InterpreterOptions = {},
): ScriptRunResult {
  const variables = { ...context.variables };
  const logs: string[] = [];
  if (!source.trim()) {
    return { logs, variables, error: null };
  }

  timeoutMs = options.timeoutMs ?? 2000;
  now = options.now ?? Date.now;
  startedAt = now();
  steps = 0;

  const state = { variables };
  const pm = createPm(context, state);
  const scriptConsole = {
    log(...args: unknown[]) {
      logs.push(args.map(formatValue).join(' '));
    },
    warn(...args: unknown[]) {
      logs.push('[warn] ' + args.map(formatValue).join(' '));
    },
    error(...args: unknown[]) {
      logs.push('[error] ' + args.map(formatValue).join(' '));
    },
  };

  const global = createSandboxGlobal(pm, scriptConsole);
  const globalScope = newScope(null, 'global', undefined);
  for (const [name, value] of Object.entries(global)) {
    globalScope.bindings.set(name, { kind: 'var', value, initialized: true });
  }

  const scriptScope = newScope(globalScope, 'function', undefined);
  scriptScope.bindings.set('pm', { kind: 'var', value: pm, initialized: true });
  scriptScope.bindings.set('console', { kind: 'var', value: scriptConsole, initialized: true });

  try {
    const ast = parseScript(source);
    try {
      evaluate(ast, scriptScope);
    } catch (error) {
      if (error instanceof ReturnSignal) {
        return { logs, variables: state.variables, error: null };
      }
      throw error;
    }
    return { logs, variables: state.variables, error: null };
  } catch (error) {
    return { logs, variables: state.variables, error: thrownMessage(error) };
  }
}
