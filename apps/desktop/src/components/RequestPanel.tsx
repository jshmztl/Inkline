import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  CloseCircleOutlined,
  EditOutlined,
  GlobalOutlined,
  LockOutlined,
  SaveOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { App, Button, Input, Select, Tooltip } from 'antd';
import type { ApiRequest, HttpMethod, KvRow, NetworkMode } from '../data/types';
import { recordAudit } from '../lib/audit';
import { enqueueTask } from '../lib/queue';
import {
  cancelHttpRequest,
  recordHistory,
  saveRequest,
  sendHttpRequest,
  type SavedRequest,
  type SendResponse,
} from '../lib/api';
import type { RequestContext } from '../lib/docTask';
import {
  nextEventId,
  openWebSocket,
  streamSse,
  type ProtocolKind,
  type StreamEvent,
  type WebSocketHandle,
} from '../lib/protocol';
import { resolveHeaders, resolveTemplate } from '../lib/variables';
import { checkNetworkAccessResolved } from '../lib/networkPolicy';
import {
  evaluateAssertions,
  type AssertionResult,
  type AssertionRow,
} from '../lib/assertions';
import { runScript } from '../lib/scriptSandbox';
import { readNetworkOptions } from '../lib/network';
import { kvGet, kvSet } from '../lib/kv';
import { RequestTabs } from './RequestTabs';
import {
  RequestResponsePanel,
  type ResponseTabKey,
  type ScriptLog,
} from './RequestResponsePanel';
import { RequestKvPanel } from './RequestKvPanel';
import {
  RequestBodyPanel,
  RequestGraphqlPanel,
  type BodyMode,
  type FileRow,
} from './RequestBodyPanel';
import { RequestAuthPanel, type AuthType } from './RequestAuthPanel';
import { RequestAssertionsPanel } from './RequestAssertionsPanel';
import { RequestScriptsPanel } from './RequestScriptsPanel';
import { NetworkSettingsModal } from './NetworkSettingsModal';
import { fetchGraphqlSchema, type GraphqlType } from '../lib/graphql';

const GraphqlSchemaModal = lazy(() =>
  import('./GraphqlSchemaModal').then((module) => ({
    default: module.GraphqlSchemaModal,
  })),
);

const ResponseDiffModal = lazy(() =>
  import('./ResponseDiffModal').then((module) => ({
    default: module.ResponseDiffModal,
  })),
);

interface ResponseBaseline {
  body: string;
  status?: number;
  savedAt: string;
}

interface RequestPanelProps {
  activeRequest: ApiRequest;
  openTabs: ApiRequest[];
  replay: { method: HttpMethod; url: string; nonce: number } | null;
  saved: SavedRequest | null;
  variables: Record<string, string>;
  actor: string;
  networkMode: NetworkMode;
  collectionId: string;
  onSelectTab: (requestId: string) => void;
  onCloseTab: (requestId: string) => void;
  onCreateRequest: () => void;
  onHistoryRecorded: () => void;
  onSaved: () => void;
  onQueued: () => void;
  onContextChange: (context: RequestContext) => void;
  onVariablesChange: (variables: Record<string, string>) => void;
}

type RequestTabKey = 'params' | 'headers' | 'body' | 'auth' | 'assertions' | 'scripts';

interface RequestMeta {
  bodyMode: BodyMode;
  authType: AuthType;
  authToken: string;
  authUser: string;
  authPass: string;
  apiKeyName: string;
  apiKeyValue: string;
  timeoutMs: number;
  formRows: KvRow[];
  params: KvRow[];
  fileRows: FileRow[];
  assertionRows: AssertionRow[];
  protocol: ProtocolKind;
  gqlQuery: string;
  gqlVariables: string;
  preScript: string;
  postScript: string;
}

const defaultMeta: RequestMeta = {
  bodyMode: 'json',
  authType: 'none',
  authToken: '',
  authUser: '',
  authPass: '',
  apiKeyName: 'X-Api-Key',
  apiKeyValue: '',
  timeoutMs: 30_000,
  formRows: [],
  params: [],
  fileRows: [],
  assertionRows: [],
  protocol: 'http',
  gqlQuery: '',
  gqlVariables: '{}',
  preScript: '',
  postScript: '',
};

function readRequestMeta(id: string): RequestMeta {
  try {
    const raw = kvGet(`aw-request-meta:${id}`);
    if (!raw) return { ...defaultMeta };
    const parsed = JSON.parse(raw) as Partial<RequestMeta>;
    return {
      ...defaultMeta,
      ...parsed,
      formRows: parsed.formRows ?? defaultMeta.formRows,
      params: parsed.params ?? defaultMeta.params,
      fileRows: parsed.fileRows ?? defaultMeta.fileRows,
      assertionRows: parsed.assertionRows ?? defaultMeta.assertionRows,
    };
  } catch {
    return { ...defaultMeta };
  }
}

function writeRequestMeta(id: string, meta: RequestMeta) {
  try {
    kvSet(`aw-request-meta:${id}`, JSON.stringify(meta));
  } catch {
    // 存储不可用时仅保留在内存中。
  }
}

function encodeBasic(user: string, password: string) {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function mergeQuery(base: string, pairs: { key: string; value: string }[]) {
  if (pairs.length === 0) return base;
  const hashIndex = base.indexOf('#');
  const head = hashIndex >= 0 ? base.slice(0, hashIndex) : base;
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : '';
  const query = pairs
    .map((pair) => `${encodeURIComponent(pair.key)}=${encodeURIComponent(pair.value)}`)
    .join('&');
  const separator = head.includes('?')
    ? head.endsWith('&') || head.endsWith('?')
      ? ''
      : '&'
    : '?';
  return `${head}${separator}${query}${hash}`;
}

const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function RequestPanel({
  activeRequest,
  openTabs,
  replay,
  saved,
  variables,
  actor,
  networkMode,
  collectionId,
  onSelectTab,
  onCloseTab,
  onCreateRequest,
  onHistoryRecorded,
  onSaved,
  onQueued,
  onContextChange,
  onVariablesChange,
}: RequestPanelProps) {
  const { message } = App.useApp();
  const [method, setMethod] = useState<HttpMethod>(activeRequest.method);
  const [url, setUrl] = useState(`{{host}}${activeRequest.path}`);
  const [requestTab, setRequestTab] = useState<RequestTabKey>('body');
  const [responseTab, setResponseTab] = useState<ResponseTabKey>('body');
  const [responseQuery, setResponseQuery] = useState('');
  const [params, setParams] = useState<KvRow[]>([]);
  const [headers, setHeaders] = useState<KvRow[]>([]);
  const [body, setBody] = useState('');
  const [bodyMode, setBodyMode] = useState<BodyMode>(defaultMeta.bodyMode);
  const [formRows, setFormRows] = useState<KvRow[]>(defaultMeta.formRows);
  const [fileRows, setFileRows] = useState<FileRow[]>(defaultMeta.fileRows);
  const [assertionRows, setAssertionRows] = useState<AssertionRow[]>(
    defaultMeta.assertionRows,
  );
  const [assertionResults, setAssertionResults] = useState<AssertionResult[]>([]);
  const [authType, setAuthType] = useState<AuthType>(defaultMeta.authType);
  const [authToken, setAuthToken] = useState(defaultMeta.authToken);
  const [authUser, setAuthUser] = useState(defaultMeta.authUser);
  const [authPass, setAuthPass] = useState(defaultMeta.authPass);
  const [apiKeyName, setApiKeyName] = useState(defaultMeta.apiKeyName);
  const [apiKeyValue, setApiKeyValue] = useState(defaultMeta.apiKeyValue);
  const [timeoutMs, setTimeoutMs] = useState(defaultMeta.timeoutMs);
  const [metaFor, setMetaFor] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<ProtocolKind>(defaultMeta.protocol);
  const [gqlQuery, setGqlQuery] = useState(defaultMeta.gqlQuery);
  const [gqlVariables, setGqlVariables] = useState(defaultMeta.gqlVariables);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState('');
  const [schemaTypes, setSchemaTypes] = useState<GraphqlType[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffBaseline, setDiffBaseline] = useState<ResponseBaseline | null>(null);
  const [preScript, setPreScript] = useState(defaultMeta.preScript);
  const [postScript, setPostScript] = useState(defaultMeta.postScript);
  const [scriptLogs, setScriptLogs] = useState<ScriptLog[]>([]);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const socketRef = useRef<WebSocketHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const httpAbortRef = useRef<AbortController | null>(null);
  const pendingRequestId = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<SendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [requestName, setRequestName] = useState(activeRequest.name);
  const appliedKey = useRef<string | null>(null);

  useEffect(() => {
    setRequestName(saved?.name ?? activeRequest.name);
  }, [activeRequest.id, activeRequest.name, saved?.name]);

  useEffect(() => {
    const key = `${activeRequest.id}:${saved ? 'saved' : 'new'}`;
    if (appliedKey.current === key) return;
    appliedKey.current = key;

    setMethod((saved?.method as HttpMethod) ?? activeRequest.method);
    setUrl(saved?.url ?? `{{host}}${activeRequest.path}`);
    setBody(saved?.body ?? '');
    setHeaders(
      saved && saved.headers.length > 0
        ? saved.headers.map((header, index) => ({
            id: `saved-${index}`,
            key: header.name,
            value: header.value,
            description: '来自已保存请求',
            enabled: true,
          }))
        : [],
    );
    setResponse(null);
    setError(null);
    setFeedback(null);
    setResponseQuery('');
  }, [activeRequest, saved]);

  useEffect(() => {
    const meta = readRequestMeta(activeRequest.id);
    setBodyMode(meta.bodyMode);
    setAuthType(meta.authType);
    setAuthToken(meta.authToken);
    setAuthUser(meta.authUser);
    setAuthPass(meta.authPass);
    setApiKeyName(meta.apiKeyName);
    setApiKeyValue(meta.apiKeyValue);
    setTimeoutMs(meta.timeoutMs);
    setFormRows(meta.formRows);
    setFileRows(meta.fileRows);
    setAssertionRows(meta.assertionRows);
    setAssertionResults([]);
    setParams(meta.params);
    setProtocol(meta.protocol);
    setGqlQuery(meta.gqlQuery);
    setGqlVariables(meta.gqlVariables);
    setPreScript(meta.preScript);
    setPostScript(meta.postScript);
    setScriptLogs([]);
    setMetaFor(activeRequest.id);
  }, [activeRequest.id]);

  useEffect(() => {
    if (metaFor !== activeRequest.id) return;
    writeRequestMeta(activeRequest.id, {
      bodyMode,
      authType,
      authToken,
      authUser,
      authPass,
      apiKeyName,
      apiKeyValue,
      timeoutMs,
      formRows,
      params,
      fileRows,
      assertionRows,
      protocol,
      gqlQuery,
      gqlVariables,
      preScript,
      postScript,
    });
  }, [
    metaFor,
    activeRequest.id,
    bodyMode,
    authType,
    authToken,
    authUser,
    authPass,
    apiKeyName,
    apiKeyValue,
    timeoutMs,
    formRows,
    params,
    fileRows,
    assertionRows,
    protocol,
    gqlQuery,
    gqlVariables,
    preScript,
    postScript,
  ]);

  useEffect(() => {
    if (!replay) return;
    const host = (variables.host ?? '').trim();
    setMethod(replay.method);
    setUrl(
      host && replay.url.startsWith(host)
        ? `{{host}}${replay.url.slice(host.length)}`
        : replay.url,
    );
    setError(null);
  }, [replay]);

  const resolvedUrl = useMemo(() => resolveTemplate(url, variables), [url, variables]);

  useEffect(() => {
    onContextChange({
      id: activeRequest.id,
      name: requestName.trim() || activeRequest.name,
      method,
      url: resolvedUrl.value,
      dataLevel: activeRequest.dataLevel,
      headers: headers
        .filter((row) => row.enabled && row.key.trim())
        .map((row) => ({ name: row.key.trim(), value: row.value })),
      body: method === 'GET' || method === 'DELETE' ? null : body,
      response: response
        ? {
            status: response.status,
            statusText: response.statusText,
            body: response.body,
          }
        : null,
    });
  }, [
    activeRequest,
    method,
    resolvedUrl.value,
    headers,
    body,
    response,
    requestName,
    onContextChange,
  ]);

  const hostPrefix = '{{host}}';
  const usesHostTemplate = url.startsWith(hostPrefix);
  const editablePath = usesHostTemplate ? url.slice(hostPrefix.length) : url;
  const resolvedHost = (variables.host ?? '').trim();
  const streamMode = protocol === 'websocket' || protocol === 'sse';
  const hasResponseContent = streamMode ? streamEvents.length > 0 : response !== null;

  function updateUrlInput(next: string) {
    if (!usesHostTemplate || /^https?:\/\//i.test(next)) {
      setUrl(next);
      return;
    }
    setUrl(`${hostPrefix}${next}`);
  }

  function normalizeUrlPath() {
    if (!usesHostTemplate) return;
    const path = url.slice(hostPrefix.length);
    if (!path || /^[/?#]/.test(path)) return;
    setUrl(`${hostPrefix}/${path}`);
  }

  const responseMatchCount = useMemo(() => {
    const needle = responseQuery.trim().toLowerCase();
    if (!needle) return 0;
    return (response?.body ?? '').toLowerCase().split(needle).length - 1;
  }, [response, responseQuery]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      abortRef.current?.abort();
    };
  }, []);

  function appendStreamEvent(event: StreamEvent) {
    setStreamEvents((current) => [...current.slice(-199), event]);
  }

  function disconnectStream() {
    socketRef.current?.close();
    socketRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setConnected(false);
  }

  function connectWebSocket(
    finalUrl: string,
    headers: { name: string; value: string }[],
  ) {
    disconnectStream();
    setStreamEvents([]);
    setError(null);
    setFeedback('WebSocket 连接中…');
    try {
      socketRef.current = openWebSocket(
        finalUrl,
        (event) => {
          appendStreamEvent(event);
          if (event.kind === 'open') {
            setConnected(true);
            setFeedback('WebSocket 已连接');
          }
          if (event.kind === 'close' || event.kind === 'error') {
            setConnected(false);
            if (event.kind === 'error') setError(event.payload);
          }
        },
        headers,
      );
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      setError(text);
      setFeedback(null);
    }
  }

  async function startSse(
    finalUrl: string,
    resolvedHeaderPairs: { name: string; value: string }[],
  ) {
    disconnectStream();
    setStreamEvents([]);
    setError(null);
    setConnected(true);
    setFeedback('SSE 连接中…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamSse(finalUrl, resolvedHeaderPairs, null, appendStreamEvent, controller.signal);
      setFeedback('SSE 流已结束');
    } catch (caught) {
      if (controller.signal.aborted) {
        setFeedback('SSE 已断开');
      } else {
        const text = caught instanceof Error ? caught.message : String(caught);
        setError(text);
        setFeedback(null);
      }
    } finally {
      setConnected(false);
      abortRef.current = null;
    }
  }

  function sendDraftMessage() {
    const text = draftMessage.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.send(text);
    setDraftMessage('');
  }

  function appendScriptLogs(
    phase: 'pre' | 'post',
    logs: string[],
    error: string | null,
  ) {
    if (logs.length === 0 && !error) return;
    const base = Date.now().toString(36);
    setScriptLogs((current) =>
      [
        ...current,
        ...logs.map((text, index) => ({
          id: `${phase}-${base}-${index}`,
          phase,
          text,
          bad: false,
        })),
        ...(error
          ? [{ id: `${phase}-${base}-err`, phase, text: error, bad: true }]
          : []),
      ].slice(-60),
    );
  }

  async function openSchema() {
    setSchemaOpen(true);
    setSchemaLoading(true);
    setSchemaError('');

    try {
      const resolvedUrl = resolveTemplate(url, variables);
      const paramPairs = params
        .filter((row) => row.enabled && row.key.trim())
        .map((row) => ({
          key: resolveTemplate(row.key, variables).value,
          value: resolveTemplate(row.value, variables).value,
        }));
      const finalUrl = mergeQuery(resolvedUrl.value, paramPairs);
      const baseHeaders = headers
        .filter((row) => row.enabled && row.key.trim())
        .map((row) => ({
          name: row.key.trim(),
          value: resolveTemplate(row.value, variables).value,
        }));

      setSchemaTypes(await fetchGraphqlSchema(finalUrl, baseHeaders));
    } catch (error) {
      setSchemaError(error instanceof Error ? error.message : String(error));
    } finally {
      setSchemaLoading(false);
    }
  }

  async function handleSend() {
    if (sending) return;
    setScriptLogs([]);

    const preResult = await runScript(preScript, {
      variables,
      request: {
        method,
        url,
        headers: headers
          .filter((row) => row.enabled && row.key.trim())
          .map((row) => ({ name: row.key.trim(), value: row.value })),
        body: body || null,
      },
    });
    appendScriptLogs('pre', preResult.logs, preResult.error);
    if (preResult.error) {
      setError(`前置脚本执行失败：${preResult.error}`);
      setFeedback(null);
      return;
    }

    const effectiveVariables = preResult.variables;
    const resolvedUrlNow = resolveTemplate(url, effectiveVariables);
    const paramPairs = params
      .filter((row) => row.enabled && row.key.trim())
      .map((row) => ({
        key: resolveTemplate(row.key, effectiveVariables),
        value: resolveTemplate(row.value, effectiveVariables),
      }));
    const finalUrl = mergeQuery(
      resolvedUrlNow.value,
      paramPairs.map((pair) => ({ key: pair.key.value, value: pair.value.value })),
    );

    let authHeader: { name: string; value: string } | null = null;
    const authMissing: string[] = [];

    if (authType === 'bearer') {
      const token = resolveTemplate(authToken, effectiveVariables);
      authMissing.push(...token.missing);
      if (token.value.trim()) {
        authHeader = { name: 'Authorization', value: `Bearer ${token.value.trim()}` };
      }
    } else if (authType === 'basic') {
      const user = resolveTemplate(authUser, effectiveVariables);
      const pass = resolveTemplate(authPass, effectiveVariables);
      authMissing.push(...user.missing, ...pass.missing);
      if (user.value || pass.value) {
        authHeader = {
          name: 'Authorization',
          value: `Basic ${encodeBasic(user.value, pass.value)}`,
        };
      }
    } else if (authType === 'apikey') {
      const name = resolveTemplate(apiKeyName, effectiveVariables);
      const value = resolveTemplate(apiKeyValue, effectiveVariables);
      authMissing.push(...name.missing, ...value.missing);
      if (name.value.trim() && value.value) {
        authHeader = { name: name.value.trim(), value: value.value };
      }
    }

    const baseHeaders = headers
      .filter((row) => row.enabled && row.key.trim())
      .map((row) => ({ name: row.key.trim(), value: row.value }));
    const withoutAuth = authHeader
      ? baseHeaders.filter(
          (header) => header.name.toLowerCase() !== authHeader.name.toLowerCase(),
        )
      : baseHeaders;
    const resolvedHeaders = resolveHeaders(
      authHeader ? [...withoutAuth, authHeader] : withoutAuth,
      effectiveVariables,
    );

    if (protocol === 'websocket' || protocol === 'sse') {
      const urlMissing = [
        ...new Set([
          ...resolvedUrlNow.missing,
          ...paramPairs.flatMap((pair) => [...pair.key.missing, ...pair.value.missing]),
          ...resolvedHeaders.missing,
          ...authMissing,
        ]),
      ];
      if (urlMissing.length > 0) {
        const names = urlMissing.map((name) => `{{${name}}}`).join('、');
        setError(`缺少环境变量：${names}`);
        setFeedback(null);
        return;
      }
      if (connected) {
        disconnectStream();
        setFeedback('已断开连接');
        return;
      }
      const access = await checkNetworkAccessResolved(finalUrl, networkMode);
      if (!access.allowed) {
        setError(access.reason);
        setFeedback(null);
        message.error({ content: access.reason, duration: 3 });
        return;
      }
      if (protocol === 'websocket') {
        const wsUrl = finalUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        if (!/^wss?:\/\//i.test(wsUrl)) {
          setError('WebSocket 地址需以 ws:// 或 wss:// 开头');
          setFeedback(null);
          return;
        }
        connectWebSocket(wsUrl, resolvedHeaders.headers);
      } else {
        void startSse(finalUrl, resolvedHeaders.headers);
      }
      return;
    }

    let bodyText = '';
    const bodyMissing: string[] = [];

    if (bodyMode === 'form') {
      const pairs = formRows
        .filter((row) => row.enabled && row.key.trim())
        .map((row) => ({
          key: resolveTemplate(row.key, effectiveVariables),
          value: resolveTemplate(row.value, effectiveVariables),
        }));
      pairs.forEach((pair) => {
        bodyMissing.push(...pair.key.missing, ...pair.value.missing);
      });
      bodyText = pairs
        .map(
          (pair) =>
            `${encodeURIComponent(pair.key.value)}=${encodeURIComponent(pair.value.value)}`,
        )
        .join('&');
      if (!resolvedHeaders.headers.some((header) => header.name.toLowerCase() === 'content-type')) {
        resolvedHeaders.headers.push({
          name: 'Content-Type',
          value: 'application/x-www-form-urlencoded',
        });
      }
    } else {
      const resolvedBody = resolveTemplate(body, effectiveVariables);
      bodyMissing.push(...resolvedBody.missing);
      bodyText = resolvedBody.value;
      if (
        bodyMode === 'xml' &&
        !resolvedHeaders.headers.some(
          (header) => header.name.toLowerCase() === 'content-type',
        )
      ) {
        resolvedHeaders.headers.push({ name: 'Content-Type', value: 'application/xml' });
      }
    }

    if (protocol === 'graphql') {
      let variablesValue: unknown = {};
      if (gqlVariables.trim()) {
        try {
          variablesValue = JSON.parse(gqlVariables);
        } catch {
          setError('GraphQL Variables 不是合法 JSON');
          setFeedback(null);
          return;
        }
        if (
          variablesValue === null ||
          typeof variablesValue !== 'object' ||
          Array.isArray(variablesValue)
        ) {
          setError('GraphQL Variables 必须是 JSON 对象');
          setFeedback(null);
          return;
        }
      }
      bodyText = JSON.stringify({ query: gqlQuery, variables: variablesValue });
      if (
        !resolvedHeaders.headers.some(
          (header) => header.name.toLowerCase() === 'content-type',
        )
      ) {
        resolvedHeaders.headers.push({
          name: 'Content-Type',
          value: 'application/json',
        });
      }
    }

    const effectiveMethod = protocol === 'graphql' ? 'POST' : method;

    const missing = [
      ...new Set([
        ...resolvedUrlNow.missing,
        ...paramPairs.flatMap((pair) => [...pair.key.missing, ...pair.value.missing]),
        ...resolvedHeaders.missing,
        ...bodyMissing,
        ...authMissing,
      ]),
    ];

    if (missing.length > 0) {
      const names = missing.map((name) => `{{${name}}}`).join('、');
      setError(`缺少环境变量：${names}`);
      setFeedback(null);
      message.error({ content: `缺少环境变量：${names}`, duration: 2.4 });
      return;
    }

    const access = await checkNetworkAccessResolved(finalUrl, networkMode);
    if (!access.allowed) {
      setError(access.reason);
      setFeedback(null);
      message.error({ content: access.reason, duration: 3 });
      return;
    }

    setSending(true);
    setError(null);
    const controller = new AbortController();
    httpAbortRef.current = controller;
    const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    pendingRequestId.current = requestId;
    cancelledRef.current = false;
    const started = performance.now();

    const multipartPayload =
      bodyMode === 'multipart'
        ? [
            ...formRows
              .filter((row) => row.enabled && row.key.trim())
              .map((row) => ({ name: row.key.trim(), value: row.value })),
            ...fileRows
              .filter((row) => row.enabled && row.key.trim() && row.contentBase64)
              .map((row) => ({
                name: row.key.trim(),
                fileName: row.fileName,
                contentType: row.contentType,
                fileBase64: row.contentBase64,
              })),
          ]
        : undefined;

    const finalHeaders = multipartPayload
      ? resolvedHeaders.headers.filter(
          (header) => header.name.toLowerCase() !== 'content-type',
        )
      : resolvedHeaders.headers;

    try {
      const result = await sendHttpRequest({
        id: requestId,
        method: effectiveMethod,
        url: finalUrl,
        headers: finalHeaders,
        body: multipartPayload
          ? undefined
          : effectiveMethod === 'GET' || effectiveMethod === 'DELETE'
            ? undefined
            : bodyText,
        multipart: multipartPayload,
        timeoutMs,
        network: readNetworkOptions(),
      }, controller.signal);

      if (cancelledRef.current) {
        setFeedback('请求已取消');
        return;
      }

      setResponse(result);
      const results = evaluateAssertions(assertionRows, result);
      setAssertionResults(results);
      const failedCount = results.filter((row) => !row.passed).length;
      if (failedCount > 0) {
        setResponseTab('assertions');
      }
      setFeedback(
        failedCount > 0
          ? `请求完成 · ${result.status} ${result.statusText} · ${failedCount} 条断言失败`
          : `请求完成 · ${result.status} ${result.statusText}`,
      );

      const postResult = await runScript(postScript, {
        variables: effectiveVariables,
        request: {
          method: effectiveMethod,
          url: finalUrl,
          headers: finalHeaders,
          body:
            multipartPayload || effectiveMethod === 'GET' || effectiveMethod === 'DELETE'
              ? null
              : bodyText,
        },
        response: {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          body: result.body,
          durationMs: result.durationMs,
        },
      });
      appendScriptLogs('post', postResult.logs, postResult.error);
      const variablesChanged =
        Object.keys(postResult.variables).some(
          (key) => postResult.variables[key] !== effectiveVariables[key],
        ) ||
        Object.keys(effectiveVariables).some(
          (key) => !(key in postResult.variables),
        );
      if (variablesChanged) {
        onVariablesChange(postResult.variables);
      }

      recordAudit({
        type: 'request',
        action: `${effectiveMethod} ${finalUrl}`,
        detail: `${result.status} ${result.statusText} · ${result.durationMs}ms · ${formatBytes(result.sizeBytes)}`,
        actor,
        level: activeRequest.dataLevel,
      });

      try {
        await recordHistory({
          method: effectiveMethod,
          url: finalUrl,
          status: result.status,
          durationMs: result.durationMs,
          sizeBytes: result.sizeBytes,
        });
      } catch {
        // 历史写入失败不影响请求结果。
      }

      message.success({
        content: `请求完成 · ${result.status} ${result.statusText}`,
        duration: 2.2,
      });
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      if (cancelledRef.current || text.includes('已取消')) {
        setError(null);
        setFeedback('请求已取消');
        return;
      }
      setError(text);
      setFeedback('请求失败 · 已加入离线队列');
      message.error({ content: '请求失败，已加入离线队列', duration: 2.2 });

      enqueueTask({
        requestId: activeRequest.id,
        name: activeRequest.name,
        method: effectiveMethod,
        url: finalUrl,
        headers: finalHeaders,
        body:
          multipartPayload || effectiveMethod === 'GET' || effectiveMethod === 'DELETE'
            ? null
            : bodyText,
        dataLevel: activeRequest.dataLevel,
      });
      onQueued();

      recordAudit({
        type: 'request',
        action: `${effectiveMethod} ${finalUrl}`,
        detail: `失败 · ${text}`,
        actor,
        level: activeRequest.dataLevel,
      });

      try {
        await recordHistory({
          method: effectiveMethod,
          url: finalUrl,
          error: text,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        // 历史写入失败不影响错误提示。
      }
    } finally {
      pendingRequestId.current = null;
      httpAbortRef.current = null;
      setSending(false);
      onHistoryRecorded();
      window.setTimeout(() => setFeedback(null), 3000);
    }
  }

  async function cancelSend() {
    if (!pendingRequestId.current) return;
    cancelledRef.current = true;
    httpAbortRef.current?.abort();
    setFeedback('正在中断请求…');
    await cancelHttpRequest(pendingRequestId.current);
    setFeedback('已中断请求');
  }

  useEffect(() => {
    if (!sending) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void cancelSend();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [sending]);

  const sendRef = useRef(handleSend);
  sendRef.current = handleSend;
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;

  useEffect(() => {
    function handleHotkey(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        sendRef.current();
        return;
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  }, []);

  async function handleSave() {
    try {
      await saveRequest({
        id: activeRequest.id,
        name: requestName.trim() || activeRequest.name,
        method,
        url,
        headers: headers
          .filter((row) => row.enabled && row.key.trim())
          .map((row) => ({ name: row.key.trim(), value: row.value })),
        body: method === 'GET' || method === 'DELETE' ? null : body,
        dataLevel: activeRequest.dataLevel,
        collectionId,
        updatedAt: null,
      });
      message.success({ content: '已保存到本地 SQLite', duration: 2 });
      onSaved();
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      message.error({ content: `保存失败：${text}`, duration: 2.4 });
    }
  }

  async function copyResponse() {
    try {
      const text = streamMode
        ? streamEvents.map((event) => `[${event.kind}] ${event.payload}`).join('\n')
        : (response?.body ?? '');
      await navigator.clipboard.writeText(text);
      message.success(streamMode ? '已复制消息记录' : '已复制响应');
    } catch {
      message.warning('当前环境无法访问剪贴板');
    }
  }

  function downloadResponse() {
    const text = streamMode
      ? streamEvents.map((event) => `[${event.kind}] ${event.payload}`).join('\n')
      : (response?.body ?? '');
    if (!text) {
      message.warning('当前没有可下载的响应');
      return;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeRequest.name || 'response'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    message.success('已下载响应');
  }

  function clearResponse() {
    setResponse(null);
    setError(null);
    setAssertionResults([]);
    setStreamEvents([]);
    setFeedback(null);
    message.success('已清空响应');
  }

  function readResponseBaseline(): ResponseBaseline | null {
    try {
      const raw = kvGet(`aw-response-baseline:${activeRequest.id}`);
      return raw ? (JSON.parse(raw) as ResponseBaseline) : null;
    } catch {
      return null;
    }
  }

  function saveResponseBaseline() {
    if (!response) return;
    kvSet(
      `aw-response-baseline:${activeRequest.id}`,
      JSON.stringify({
        body: response.body,
        status: response.status,
        savedAt: new Date().toISOString(),
      }),
    );
    message.success('已保存为响应基线');
  }

  function openResponseDiff() {
    const baseline = readResponseBaseline();
    if (!baseline || !response) return;
    setDiffBaseline(baseline);
    setDiffOpen(true);
  }

  return (
    <section className="request-pane">
      <RequestTabs
        openTabs={openTabs}
        activeRequestId={activeRequest.id}
        dataLevel={activeRequest.dataLevel}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCreateRequest={onCreateRequest}
      />

      <div className="request-name-bar">
        <EditOutlined className="request-name-icon" />
        <Input
          variant="borderless"
          value={requestName}
          maxLength={60}
          onChange={(event) => setRequestName(event.target.value)}
          onPressEnter={() => void handleSave()}
          className="request-name-input"
          placeholder="接口名称"
          aria-label="接口名称"
        />
        <span className="request-name-hint">回车或保存后更新名称</span>
      </div>

      <div className="url-bar">
        <Select
          value={protocol === 'graphql' ? 'POST' : method}
          options={methods.map((item) => ({ value: item, label: item }))}
          onChange={(value) => setMethod(value as HttpMethod)}
          className={`method-select method-${(protocol === 'graphql' ? 'post' : method).toLowerCase()}`}
          popupMatchSelectWidth={false}
          disabled={protocol !== 'http'}
          optionRender={(option) => (
            <span className={`method-option method-${String(option.value).toLowerCase()}`}>
              {option.label}
            </span>
          )}
        />
        <Select
          value={protocol}
          onChange={(value) => {
            const next = value as ProtocolKind;
            if (next !== 'websocket' && next !== 'sse') disconnectStream();
            setProtocol(next);
          }}
          options={[
            { value: 'http', label: 'HTTP' },
            { value: 'graphql', label: 'GraphQL' },
            { value: 'websocket', label: 'WS' },
            { value: 'sse', label: 'SSE' },
          ]}
          className="protocol-select"
          popupMatchSelectWidth={false}
          aria-label="协议"
        />
        {usesHostTemplate && (
          <Tooltip
            title={
              resolvedHost
                ? `环境地址：${resolvedHost}。如需修改，请到左侧环境配置中调整 host。`
                : '当前环境未配置 host，请在左侧环境中新增或修改。'
            }
          >
            <span className={`url-host${resolvedHost ? '' : ' missing'}`}>
              <LockOutlined />
              <span className="url-host-text">{resolvedHost || '未配置 host'}</span>
            </span>
          </Tooltip>
        )}
        <Input
          value={editablePath}
          onChange={(event) => updateUrlInput(event.target.value)}
          className="url-input"
          placeholder={usesHostTemplate ? '/orders/123' : 'https://api.example.com/orders'}
          title={
            usesHostTemplate ? `${resolvedHost}${editablePath}` : url
          }
          aria-label="请求地址"
          spellCheck={false}
          onPressEnter={handleSend}
          onBlur={normalizeUrlPath}
        />
        {protocol === 'websocket' || protocol === 'sse' ? (
          <Button
            type={connected ? 'default' : 'primary'}
            danger={connected}
            icon={connected ? <CloseCircleOutlined /> : <SendOutlined />}
            onClick={handleSend}
            className="send-button"
          >
            {connected ? '断开' : '连接'}
          </Button>
        ) : sending ? (
          <Button
            danger
            icon={<StopOutlined />}
            onClick={cancelSend}
            className="send-button cancel-button"
            title="中断当前请求（Esc）"
          >
            中断
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            className="send-button"
          >
            发送
          </Button>
        )}
        <Tooltip title="保存到当前集合">
          <Button
            icon={<SaveOutlined />}
            className="save-button"
            color="green"
            variant="filled"
            onClick={handleSave}
          >
            保存
          </Button>
        </Tooltip>
        <Select
          value={timeoutMs}
          onChange={(value) => setTimeoutMs(value)}
          options={[
            { value: 5_000, label: '5s' },
            { value: 10_000, label: '10s' },
            { value: 30_000, label: '30s' },
            { value: 60_000, label: '60s' },
          ]}
          className="timeout-select"
          popupMatchSelectWidth={false}
          aria-label="请求超时"
        />
        <Tooltip title="代理与客户端证书">
          <Button
            icon={<GlobalOutlined />}
            color="cyan"
            variant="filled"
            onClick={() => setNetworkOpen(true)}
            aria-label="网络设置"
          />
        </Tooltip>
      </div>

      <NetworkSettingsModal
        open={networkOpen}
        onClose={() => setNetworkOpen(false)}
      />

      {schemaOpen && (
        <Suspense fallback={null}>
          <GraphqlSchemaModal
            open={schemaOpen}
            loading={schemaLoading}
            error={schemaError}
            types={schemaTypes}
            onClose={() => setSchemaOpen(false)}
            onRefresh={() => void openSchema()}
          />
        </Suspense>
      )}

      {diffOpen && diffBaseline && (
        <Suspense fallback={null}>
          <ResponseDiffModal
            open={diffOpen}
            before={diffBaseline.body}
            after={response?.body ?? ''}
            savedAt={new Date(diffBaseline.savedAt).toLocaleString()}
            onClose={() => setDiffOpen(false)}
          />
        </Suspense>
      )}

      <div className="request-subtabs" role="tablist" aria-label="请求配置">
        {(
          [
            ['params', 'Params', params.filter((row) => row.enabled).length],
            ['headers', 'Headers', headers.filter((row) => row.enabled).length],
            ['body', 'Body', null],
            ['auth', 'Auth', null],
            ['assertions', '断言', assertionRows.filter((row) => row.enabled).length],
            ['scripts', 'Scripts', null],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={requestTab === key}
            className={`subtab${requestTab === key ? ' active' : ''}`}
            onClick={() => setRequestTab(key)}
          >
            {label}
            {count !== null && <em>{count}</em>}
          </button>
        ))}
        <div className="subtab-spacer" />
        <span className={`request-hint${resolvedUrl.missing.length > 0 ? ' bad' : ''}`}>
          <ThunderboltOutlined /> {Object.keys(variables).length} 个变量
          <code className="request-hint-url">{resolvedUrl.value}</code>
        </span>
      </div>

      <div className="request-body">
        {(requestTab === 'params' || requestTab === 'headers') && (
          <RequestKvPanel
            rows={requestTab === 'headers' ? headers : params}
            onChange={requestTab === 'headers' ? setHeaders : setParams}
          />
        )}

        {requestTab === 'body' && protocol === 'graphql' && (
          <RequestGraphqlPanel
            gqlQuery={gqlQuery}
            onGqlQueryChange={setGqlQuery}
            gqlVariables={gqlVariables}
            onGqlVariablesChange={setGqlVariables}
            onOpenSchema={() => void openSchema()}
          />
        )}

        {requestTab === 'body' && protocol !== 'graphql' && (
          <RequestBodyPanel
            requestId={activeRequest.id}
            body={body}
            onBodyChange={setBody}
            bodyMode={bodyMode}
            onBodyModeChange={setBodyMode}
            formRows={formRows}
            onFormRowsChange={setFormRows}
            fileRows={fileRows}
            onFileRowsChange={setFileRows}
          />
        )}

        {requestTab === 'auth' && (
          <RequestAuthPanel
            authType={authType}
            onAuthTypeChange={setAuthType}
            authToken={authToken}
            onAuthTokenChange={setAuthToken}
            authUser={authUser}
            onAuthUserChange={setAuthUser}
            authPass={authPass}
            onAuthPassChange={setAuthPass}
            apiKeyName={apiKeyName}
            onApiKeyNameChange={setApiKeyName}
            apiKeyValue={apiKeyValue}
            onApiKeyValueChange={setApiKeyValue}
          />
        )}

        {requestTab === 'assertions' && (
          <RequestAssertionsPanel rows={assertionRows} onChange={setAssertionRows} />
        )}

        {requestTab === 'scripts' && (
          <RequestScriptsPanel
            preScript={preScript}
            onPreScriptChange={setPreScript}
            postScript={postScript}
            onPostScriptChange={setPostScript}
          />
        )}
      </div>

      <RequestResponsePanel
        protocol={protocol}
        method={method}
        url={url}
        response={response}
        streamMode={streamMode}
        connected={connected}
        feedback={feedback}
        error={error}
        assertionResults={assertionResults}
        responseTab={responseTab}
        onResponseTabChange={setResponseTab}
        responseQuery={responseQuery}
        onResponseQueryChange={setResponseQuery}
        responseMatchCount={responseMatchCount}
        hasResponseContent={hasResponseContent}
        hasBaseline={Boolean(readResponseBaseline())}
        streamEvents={streamEvents}
        draftMessage={draftMessage}
        onDraftMessageChange={setDraftMessage}
        onSendDraftMessage={sendDraftMessage}
        onClearStream={() => setStreamEvents([])}
        onCopy={() => void copyResponse()}
        onDownload={downloadResponse}
        onSaveBaseline={saveResponseBaseline}
        onOpenDiff={openResponseDiff}
        onClear={clearResponse}
        scriptLogs={scriptLogs}
      />
    </section>
  );
}
