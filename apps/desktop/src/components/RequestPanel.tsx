import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircleFilled,
  CloseCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FormatPainterOutlined,
  GlobalOutlined,
  LockOutlined,
  MoreOutlined,
  PlusOutlined,
  SaveOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Dropdown, Input, Segmented, Select, Tag, Tooltip } from 'antd';
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
  assertionOperators,
  evaluateAssertions,
  operatorLabel,
  type AssertionOperator,
  type AssertionResult,
  type AssertionRow,
} from '../lib/assertions';
import { runScript } from '../lib/scriptSandbox';
import { readNetworkOptions } from '../lib/network';
import { kvGet, kvSet } from '../lib/kv';
import { MethodTag } from './MethodTag';
import { CodeEditor, formatJson, formatXml } from './CodeEditor';
import { NetworkSettingsModal } from './NetworkSettingsModal';
import { ResponseCode } from './ResponseCode';

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
type ResponseTabKey = 'body' | 'headers' | 'cookies' | 'console' | 'assertions';
type BodyMode = 'json' | 'xml' | 'text' | 'form' | 'multipart';
type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

interface FileRow {
  id: string;
  key: string;
  fileName: string;
  contentType: string;
  contentBase64: string;
  enabled: boolean;
}

interface ScriptLog {
  id: string;
  phase: 'pre' | 'post';
  text: string;
  bad: boolean;
}

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

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
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

  const activeRows = useMemo(
    () => (requestTab === 'headers' ? headers : params),
    [requestTab, headers, params],
  );

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

  const visibleRows = requestTab === 'headers' || requestTab === 'params' ? activeRows : [];

  function updateRow(id: string, patch: Partial<KvRow>) {
    const updater = (rows: KvRow[]) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    if (requestTab === 'headers') {
      setHeaders(updater);
    } else {
      setParams(updater);
    }
  }

  function addRow() {
    const blank: KvRow = {
      id: `row-${Date.now().toString(36)}`,
      key: '',
      value: '',
      description: '',
      enabled: true,
    };
    if (requestTab === 'headers') {
      setHeaders((rows) => [...rows, blank]);
    } else {
      setParams((rows) => [...rows, blank]);
    }
  }

  function removeRow(id: string) {
    if (requestTab === 'headers') {
      setHeaders((rows) => rows.filter((row) => row.id !== id));
    } else {
      setParams((rows) => rows.filter((row) => row.id !== id));
    }
  }

  function updateFormRow(id: string, patch: Partial<KvRow>) {
    setFormRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function updateFileRow(id: string, patch: Partial<FileRow>) {
    setFileRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  async function pickFile(id: string, file: File) {
    try {
      const contentBase64 = await readFileAsBase64(file);
      updateFileRow(id, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64,
      });
    } catch {
      message.error('读取文件失败');
    }
  }

  function addFormRow() {
    setFormRows((rows) => [
      ...rows,
      {
        id: `form-${Date.now().toString(36)}`,
        key: '',
        value: '',
        description: '',
        enabled: true,
      },
    ]);
  }

  function updateAssertionRow(id: string, patch: Partial<AssertionRow>) {
    setAssertionRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function addAssertionRow() {
    setAssertionRows((rows) => [
      ...rows,
      {
        id: `assert-${Date.now().toString(36)}`,
        path: '',
        operator: 'equals',
        expected: '',
        enabled: true,
      },
    ]);
  }

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

  function formatRequestBody() {
    if (bodyMode !== 'json' && bodyMode !== 'xml') return;
    const result = bodyMode === 'json' ? formatJson(body) : formatXml(body);
    if (!result.ok) {
      message.warning(
        bodyMode === 'json' ? 'JSON 语法有误，暂无法格式化' : 'XML 语法有误，暂无法格式化',
      );
      return;
    }
    setBody(result.value);
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

  return (
    <section className="request-pane">
      <div className="request-tabs" role="tablist" aria-label="打开的请求">
            {openTabs.map((request) => (
              <button
                key={request.id}
                type="button"
                role="tab"
                aria-selected={request.id === activeRequest.id}
                className={`request-tab${request.id === activeRequest.id ? ' active' : ''}`}
                onClick={() => onSelectTab(request.id)}
              >
                <MethodTag method={request.method} />
                <span>{request.name || request.path || request.id}</span>
                <span
                  className="tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`关闭 ${request.name || request.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(request.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation();
                      onCloseTab(request.id);
                    }
                  }}
                >
                  <CloseOutlined />
                </span>
              </button>
            ))}
            <button
              type="button"
              className="tab-add"
              aria-label="新建请求"
              onClick={onCreateRequest}
            >
              <PlusOutlined />
            </button>
        <div className="request-tabs-spacer" />
        <Tag className={`level-tag level-${activeRequest.dataLevel.toLowerCase()}`}>
          {activeRequest.dataLevel}
        </Tag>
      </div>

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
          <div className="kv-editor">
            <div className="kv-head">
              <span />
              <span>KEY</span>
              <span>VALUE</span>
              <span>说明</span>
              <span />
            </div>
            {visibleRows.map((row) => (
              <div className={`kv-row${row.enabled ? '' : ' disabled'}`} key={row.id}>
                <Checkbox
                  checked={row.enabled}
                  onChange={(event) => updateRow(row.id, { enabled: event.target.checked })}
                />
                <input
                  className="kv-input mono"
                  value={row.key}
                  onChange={(event) => updateRow(row.id, { key: event.target.value })}
                  aria-label="参数名"
                />
                <input
                  className="kv-input mono"
                  value={row.value}
                  onChange={(event) => updateRow(row.id, { value: event.target.value })}
                  aria-label="参数值"
                />
                <input
                  className="kv-input"
                  value={row.description}
                  onChange={(event) => updateRow(row.id, { description: event.target.value })}
                  aria-label="参数说明"
                />
                <Tooltip title="删除">
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    aria-label="删除该行"
                    onClick={() => removeRow(row.id)}
                  />
                </Tooltip>
              </div>
            ))}
            <button type="button" className="kv-add" onClick={addRow}>
              <PlusOutlined /> 添加一行
            </button>
          </div>
        )}

        {requestTab === 'body' && protocol === 'graphql' && (
          <div className="body-editor gql-editor">
            <div className="editor-toolbar">
              <span className="editor-note">POST · application/json · GraphQL</span>
            </div>
            <label className="gql-field">
              <span>Query</span>
              <Input.TextArea
                value={gqlQuery}
                onChange={(event) => setGqlQuery(event.target.value)}
                autoSize={{ minRows: 5, maxRows: 12 }}
                spellCheck={false}
                aria-label="GraphQL Query"
              />
            </label>
            <label className="gql-field">
              <span>Variables</span>
              <Input.TextArea
                value={gqlVariables}
                onChange={(event) => setGqlVariables(event.target.value)}
                autoSize={{ minRows: 3, maxRows: 8 }}
                spellCheck={false}
                aria-label="GraphQL Variables"
              />
            </label>
          </div>
        )}

        {requestTab === 'body' && protocol !== 'graphql' && (
          <div className="body-editor">
            <div className="editor-toolbar">
              <Segmented
                size="small"
                value={bodyMode}
                onChange={(value) => setBodyMode(value as BodyMode)}
                options={[
                  { label: 'JSON', value: 'json' },
                  { label: 'XML', value: 'xml' },
                  { label: '文本', value: 'text' },
                  { label: '表单', value: 'form' },
                  { label: 'form-data', value: 'multipart' },
                ]}
              />
              <span className="editor-note">
                {bodyMode === 'json'
                  ? 'application/json · 自动格式化'
                  : bodyMode === 'xml'
                    ? 'application/xml · 自动格式化'
                    : bodyMode === 'text'
                      ? 'text/plain'
                      : bodyMode === 'multipart'
                        ? 'multipart/form-data · 支持文件'
                        : 'application/x-www-form-urlencoded'}
              </span>
              <div className="editor-toolbar-spacer" />
              {(bodyMode === 'json' || bodyMode === 'xml') && (
                <Button
                  variant="text"
                  size="small"
                  icon={<FormatPainterOutlined />}
                  color="cyan"
                  onClick={formatRequestBody}
                >
                  格式化
                </Button>
              )}
              <Button variant="text" size="small" icon={<CodeOutlined />} color="geekblue">
                生成代码
              </Button>
            </div>
            {bodyMode === 'form' || bodyMode === 'multipart' ? (
              <div className="kv-editor">
                <div className="kv-head">
                  <span />
                  <span>KEY</span>
                  <span>VALUE</span>
                  <span>说明</span>
                  <span />
                </div>
                {formRows.map((row) => (
                  <div className={`kv-row${row.enabled ? '' : ' disabled'}`} key={row.id}>
                    <Checkbox
                      checked={row.enabled}
                      onChange={(event) =>
                        updateFormRow(row.id, { enabled: event.target.checked })
                      }
                    />
                    <input
                      className="kv-input mono"
                      value={row.key}
                      onChange={(event) => updateFormRow(row.id, { key: event.target.value })}
                      aria-label="表单字段名"
                    />
                    <input
                      className="kv-input mono"
                      value={row.value}
                      onChange={(event) => updateFormRow(row.id, { value: event.target.value })}
                      aria-label="表单字段值"
                    />
                    <input
                      className="kv-input"
                      value={row.description}
                      onChange={(event) =>
                        updateFormRow(row.id, { description: event.target.value })
                      }
                      aria-label="表单字段说明"
                    />
                    <Tooltip title="删除">
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        aria-label="删除表单字段"
                        onClick={() =>
                          setFormRows((rows) => rows.filter((item) => item.id !== row.id))
                        }
                      />
                    </Tooltip>
                  </div>
                ))}
                <button type="button" className="kv-add" onClick={addFormRow}>
                  <PlusOutlined /> 添加字段
                </button>

                {bodyMode === 'multipart' && (
                  <div className="multipart-files">
                    <div className="multipart-head">
                      <span>FILE</span>
                      <span>字段名</span>
                      <span>文件</span>
                      <span />
                    </div>
                    {fileRows.map((row) => (
                      <div className="multipart-row" key={row.id}>
                        <Checkbox
                          checked={row.enabled}
                          onChange={(event) =>
                            updateFileRow(row.id, { enabled: event.target.checked })
                          }
                        />
                        <input
                          className="kv-input mono"
                          value={row.key}
                          placeholder="file"
                          onChange={(event) =>
                            updateFileRow(row.id, { key: event.target.value })
                          }
                          aria-label="文件字段名"
                        />
                        <label className="file-pick">
                          <input
                            type="file"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void pickFile(row.id, file);
                              event.target.value = '';
                            }}
                          />
                          <span title={row.fileName}>
                            {row.fileName || '选择文件'}
                          </span>
                        </label>
                        <Tooltip title="删除">
                          <Button
                            type="text"
                            size="small"
                            icon={<DeleteOutlined />}
                            aria-label="删除文件字段"
                            onClick={() =>
                              setFileRows((rows) =>
                                rows.filter((item) => item.id !== row.id),
                              )
                            }
                          />
                        </Tooltip>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="kv-add"
                      onClick={() =>
                        setFileRows((rows) => [
                          ...rows,
                          {
                            id: `file-${Date.now().toString(36)}`,
                            key: 'file',
                            fileName: '',
                            contentType: '',
                            contentBase64: '',
                            enabled: true,
                          },
                        ])
                      }
                    >
                      <PlusOutlined /> 添加文件字段
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <CodeEditor
                value={body}
                onChange={setBody}
                language={
                  bodyMode === 'json' ? 'json' : bodyMode === 'xml' ? 'xml' : 'text'
                }
                ariaLabel="请求体"
                placeholder={
                  bodyMode === 'json'
                    ? '{\n  "key": "value"\n}'
                    : bodyMode === 'xml'
                      ? '<root>\n  <key>value</key>\n</root>'
                      : '请输入请求体…'
                }
              />
            )}
          </div>
        )}

        {requestTab === 'auth' && (
          <div className="auth-panel">
            <div className="auth-card">
              <Segmented
                size="small"
                value={authType}
                onChange={(value) => setAuthType(value as AuthType)}
                options={[
                  { label: '无', value: 'none' },
                  { label: 'Bearer', value: 'bearer' },
                  { label: 'Basic', value: 'basic' },
                  { label: 'API Key', value: 'apikey' },
                ]}
              />

              {authType === 'bearer' && (
                <label className="auth-field">
                  <span>Token</span>
                  <Input.Password
                    value={authToken}
                    onChange={(event) => setAuthToken(event.target.value)}
                    placeholder="{{token}}"
                    aria-label="Bearer Token"
                  />
                </label>
              )}

              {authType === 'basic' && (
                <>
                  <label className="auth-field">
                    <span>用户名</span>
                    <Input
                      value={authUser}
                      onChange={(event) => setAuthUser(event.target.value)}
                      aria-label="Basic 用户名"
                    />
                  </label>
                  <label className="auth-field">
                    <span>口令</span>
                    <Input.Password
                      value={authPass}
                      onChange={(event) => setAuthPass(event.target.value)}
                      aria-label="Basic 口令"
                    />
                  </label>
                </>
              )}

              {authType === 'apikey' && (
                <>
                  <label className="auth-field">
                    <span>Header 名</span>
                    <Input
                      value={apiKeyName}
                      onChange={(event) => setApiKeyName(event.target.value)}
                      aria-label="API Key 名称"
                    />
                  </label>
                  <label className="auth-field">
                    <span>值</span>
                    <Input.Password
                      value={apiKeyValue}
                      onChange={(event) => setApiKeyValue(event.target.value)}
                      aria-label="API Key 值"
                    />
                  </label>
                </>
              )}

              <p>
                支持 <code>{'{{变量}}'}</code> 引用环境变量。鉴权信息在发送时写入请求头，不额外落盘。
              </p>
            </div>
          </div>
        )}

        {requestTab === 'assertions' && (
          <div className="kv-editor assertion-editor">
            <div className="kv-head assertion-head">
              <span />
              <span>PATH</span>
              <span>运算符</span>
              <span>期望值</span>
              <span />
            </div>
            {assertionRows.map((row) => {
              const noValue = row.operator === 'exists' || row.operator === 'notExists';
              return (
                <div
                  className={`kv-row assertion-row${row.enabled ? '' : ' disabled'}`}
                  key={row.id}
                >
                  <Checkbox
                    checked={row.enabled}
                    onChange={(event) =>
                      updateAssertionRow(row.id, { enabled: event.target.checked })
                    }
                  />
                  <input
                    className="kv-input mono"
                    value={row.path}
                    placeholder="status / data.id / headers.content-type"
                    onChange={(event) =>
                      updateAssertionRow(row.id, { path: event.target.value })
                    }
                    aria-label="断言路径"
                  />
                  <Select
                    size="small"
                    value={row.operator}
                    options={assertionOperators}
                    onChange={(value) =>
                      updateAssertionRow(row.id, { operator: value as AssertionOperator })
                    }
                    className="assertion-op"
                    popupMatchSelectWidth={false}
                    aria-label="断言运算符"
                  />
                  <input
                    className="kv-input mono"
                    value={row.expected}
                    placeholder={noValue ? '无需填写' : '期望值'}
                    disabled={noValue}
                    onChange={(event) =>
                      updateAssertionRow(row.id, { expected: event.target.value })
                    }
                    aria-label="断言期望值"
                  />
                  <Tooltip title="删除">
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label="删除断言"
                      onClick={() =>
                        setAssertionRows((rows) =>
                          rows.filter((item) => item.id !== row.id),
                        )
                      }
                    />
                  </Tooltip>
                </div>
              );
            })}
            <button type="button" className="kv-add" onClick={addAssertionRow}>
              <PlusOutlined /> 添加断言
            </button>
            <p className="assertion-tip">
              路径支持 <code>status</code>、<code>headers.名称</code> 与响应 JSON 路径（如{' '}
              <code>data.items.0.id</code>），请求成功后自动校验。
            </p>
          </div>
        )}

        {requestTab === 'scripts' && (
          <div className="script-editor">
            <div className="script-block">
              <div className="script-head">
                <strong>前置脚本</strong>
                <span>发送前执行 · 可用于签名与写入变量</span>
              </div>
              <textarea
                className="code-block script-input"
                value={preScript}
                onChange={(event) => setPreScript(event.target.value)}
                spellCheck={false}
                aria-label="前置脚本"
              />
            </div>
            <div className="script-block">
              <div className="script-head">
                <strong>后置脚本</strong>
                <span>收到响应后执行 · 可读取 pm.response</span>
              </div>
              <textarea
                className="code-block script-input"
                value={postScript}
                onChange={(event) => setPostScript(event.target.value)}
                spellCheck={false}
                aria-label="后置脚本"
              />
            </div>
            <p className="script-tip">
              沙箱内可用 <code>pm.variables.get/set/unset</code>、
              <code>pm.request</code>、<code>pm.response.status/body/json()</code> 与{' '}
              <code>console.log</code>。执行结果见响应区「Console」，超时 2 秒强制终止。
            </p>
          </div>
        )}
      </div>

      <div className="response-panel">
        <div className="response-head">
          <strong>响应</strong>
          {streamMode ? (
            <span className={`status-pill ${connected ? 'ok' : 'warn'}`}>
              {connected ? '已连接' : '未连接'}
            </span>
          ) : response ? (
            <>
              <span
                className={`status-pill ${
                  response.status >= 200 && response.status < 300
                    ? 'ok'
                    : response.status >= 500
                      ? 'bad'
                      : 'warn'
                }`}
              >
                {response.status} {response.statusText}
              </span>
              <span className="response-meta">{response.durationMs} ms</span>
              {response.ttfbMs != null && (
                <span className="response-meta" title="从发起到收到响应头">
                  首字节 {response.ttfbMs} ms
                </span>
              )}
              {response.downloadMs != null && (
                <span className="response-meta" title="接收响应体耗时">
                  下载 {response.downloadMs} ms
                </span>
              )}
              <span className="response-meta">{formatBytes(response.sizeBytes)}</span>
            </>
          ) : (
            <span className="status-pill">未发送</span>
          )}
          {feedback && (
            <span className="send-feedback">
              <CheckCircleFilled /> {feedback}
            </span>
          )}
          {error && <span className="response-error">{error}</span>}
          {!streamMode && assertionResults.length > 0 && (
            <span
              className={`assertion-pill ${
                assertionResults.some((row) => !row.passed) ? 'bad' : 'ok'
              }`}
            >
              {assertionResults.filter((row) => row.passed).length}/{assertionResults.length}{' '}
              断言通过
            </span>
          )}
          <div className="response-spacer" />
          {streamMode ? (
            <Tooltip title="清空消息">
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                aria-label="清空消息"
                onClick={() => setStreamEvents([])}
              />
            </Tooltip>
          ) : (
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined />}
              className="response-search"
              placeholder="搜索响应"
              value={responseQuery}
              onChange={(event) => setResponseQuery(event.target.value)}
              disabled={responseTab !== 'body'}
              aria-label="搜索响应"
            />
          )}
          {!streamMode && responseQuery.trim() && (
            <span className={`response-meta${responseMatchCount === 0 ? ' bad' : ''}`}>
              {responseMatchCount} 处匹配
            </span>
          )}
          <Tooltip title="复制响应">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label="复制响应"
              onClick={copyResponse}
            />
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'copy',
                  label: '复制响应',
                  icon: <CopyOutlined />,
                  disabled: !hasResponseContent,
                },
                {
                  key: 'download',
                  label: '下载响应体',
                  icon: <DownloadOutlined />,
                  disabled: !hasResponseContent,
                },
                { type: 'divider' },
                {
                  key: 'clear',
                  label: '清空响应',
                  icon: <DeleteOutlined />,
                  danger: true,
                  disabled: !hasResponseContent && !error,
                },
              ],
              onClick: ({ key }) => {
                if (key === 'copy') void copyResponse();
                if (key === 'download') downloadResponse();
                if (key === 'clear') clearResponse();
              },
            }}
          >
            <Button type="text" size="small" icon={<MoreOutlined />} aria-label="响应操作" />
          </Dropdown>
        </div>

        {!streamMode && (
          <div className="response-subtabs" role="tablist" aria-label="响应内容">
            {(
              [
                ['body', 'Body', null],
                ['headers', 'Headers', null],
                ['cookies', 'Cookies', null],
                ['console', 'Console', null],
                [
                  'assertions',
                  '断言',
                  assertionResults.filter((row) => !row.passed).length,
                ],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={responseTab === key}
                className={`subtab${responseTab === key ? ' active' : ''}`}
                onClick={() => setResponseTab(key)}
              >
                {label}
                {count ? <em className="bad">{count}</em> : null}
              </button>
            ))}
          </div>
        )}

        <div className={`response-body${streamMode ? ' stream-body' : ''}`}>
          {streamMode ? (
            <>
              <div className="stream-log">
                {streamEvents.length === 0 ? (
                  <div className="response-empty">点击「连接」开始接收消息。</div>
                ) : (
                  streamEvents.map((event) => (
                    <div className={`stream-event ${event.kind}`} key={event.id}>
                      <div className="stream-event-head">
                        <span className="stream-time">
                          {new Date(event.at).toLocaleTimeString()}
                        </span>
                        <span className="stream-kind">
                          {event.kind === 'open'
                            ? 'OPEN'
                            : event.kind === 'message'
                              ? 'MESSAGE'
                              : event.kind === 'error'
                                ? 'ERROR'
                                : event.kind === 'close'
                                  ? 'CLOSE'
                                  : 'INFO'}
                        </span>
                        {event.label && (
                          <span
                            className="stream-label"
                            title={event.eventId ? `事件 ID：${event.eventId}` : undefined}
                          >
                            {event.label}
                          </span>
                        )}
                      </div>
                      <pre>{event.payload}</pre>
                    </div>
                  ))
                )}
              </div>
              {protocol === 'websocket' && (
                <div className="stream-composer">
                  <Input
                    value={draftMessage}
                    onChange={(event) => setDraftMessage(event.target.value)}
                    onPressEnter={sendDraftMessage}
                    placeholder={connected ? '输入消息，回车发送' : '连接后可发送消息'}
                    disabled={!connected}
                    aria-label="WebSocket 消息"
                  />
                  <Button
                    type="primary"
                    size="small"
                    disabled={!connected || !draftMessage.trim()}
                    onClick={sendDraftMessage}
                  >
                    发送
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              {responseTab === 'body' &&
                (error ? (
                  <div className="response-error-panel">
                    <CloseCircleOutlined />
                    <div>
                      <strong>请求未完成</strong>
                      <p>{error}</p>
                    </div>
                  </div>
                ) : response ? (
                  <ResponseCode body={response.body} query={responseQuery} />
                ) : (
                  <div className="response-empty">发送请求后在此查看响应。</div>
                ))}

              {responseTab === 'headers' &&
                ((response?.headers ?? []).length > 0 ? (
                  <div className="response-kv">
                    {(response?.headers ?? []).map((header) => (
                      <div key={`${header.name}-${header.value}`}>
                        <span>{header.name}</span>
                        <code>{header.value}</code>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="response-empty">该响应没有可显示的响应头。</div>
                ))}

              {responseTab === 'cookies' && (
                <div className="response-empty">该响应没有 Set-Cookie。</div>
              )}

              {responseTab === 'console' && (
                <div className="console-panel">
                  <div className="console-line">
                    <span>{new Date().toLocaleTimeString()}</span>
                    <span className={error ? 'console-bad' : 'console-ok'}>
                      {error ? '×' : '→'} {method} {url}
                    </span>
                    <span>
                      {error
                        ? '请求失败'
                        : response
                          ? `${response.durationMs}ms · ${response.status} ${response.statusText}`
                          : '尚未发送'}
                    </span>
                  </div>
                  {scriptLogs.map((entry) => (
                    <div className="console-line" key={entry.id}>
                      <span>script</span>
                      <span className={entry.bad ? 'console-bad' : 'console-ok'}>
                        [{entry.phase}] {entry.text}
                      </span>
                    </div>
                  ))}
                  {scriptLogs.length === 0 && (
                    <div className="console-line">
                      <span>script</span>
                      <span>暂未执行脚本日志。</span>
                    </div>
                  )}
                </div>
              )}

              {responseTab === 'assertions' &&
                (assertionResults.length === 0 ? (
                  <div className="response-empty">
                    发送请求后在此查看断言结果。可在请求区的「断言」页配置。
                  </div>
                ) : (
                  <div className="assertion-results">
                    {assertionResults.map((row) => (
                      <div
                        className={`assertion-result${row.passed ? ' ok' : ' bad'}`}
                        key={row.id}
                      >
                        <span className="assertion-state">
                          {row.passed ? <CheckCircleFilled /> : <CloseCircleOutlined />}
                        </span>
                        <span className="assertion-path mono">{row.path}</span>
                        <span className="assertion-op-label">{operatorLabel(row.operator)}</span>
                        <span className="assertion-expected mono">
                          {row.operator === 'exists' || row.operator === 'notExists'
                            ? '—'
                            : row.expected}
                        </span>
                        <span className="assertion-actual mono" title={row.actual}>
                          实际：{row.actual}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
