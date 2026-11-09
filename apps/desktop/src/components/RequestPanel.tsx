import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircleFilled,
  CloseCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  FormatPainterOutlined,
  LockOutlined,
  MoreOutlined,
  PlusOutlined,
  SaveOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Input, Segmented, Select, Tag, Tooltip } from 'antd';
import type { ApiRequest, HttpMethod, KvRow } from '../data/mock';
import {
  environmentVariables,
  headerRows as initialHeaders,
  queryParams as initialParams,
  requestBody,
} from '../data/mock';
import { recordAudit } from '../lib/audit';
import { enqueueTask } from '../lib/queue';
import {
  recordHistory,
  saveRequest,
  sendHttpRequest,
  type SavedRequest,
  type SendResponse,
} from '../lib/api';
import type { RequestContext } from '../lib/docTask';
import { resolveHeaders, resolveTemplate } from '../lib/variables';
import { MethodTag } from './MethodTag';
import { ResponseCode } from './ResponseCode';

interface RequestPanelProps {
  activeRequest: ApiRequest;
  openTabs: ApiRequest[];
  replay: { method: HttpMethod; url: string; nonce: number } | null;
  saved: SavedRequest | null;
  environment: string;
  actor: string;
  collectionId: string;
  onSelectTab: (requestId: string) => void;
  onCloseTab: (requestId: string) => void;
  onHistoryRecorded: () => void;
  onSaved: () => void;
  onQueued: () => void;
  onContextChange: (context: RequestContext) => void;
}

type RequestTabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts';
type ResponseTabKey = 'body' | 'headers' | 'cookies' | 'console';
type BodyMode = 'json' | 'text' | 'form';
type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

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
}

const defaultMeta: RequestMeta = {
  bodyMode: 'json',
  authType: 'bearer',
  authToken: '{{PAYMENT_TOKEN}}',
  authUser: '',
  authPass: '',
  apiKeyName: 'X-Api-Key',
  apiKeyValue: '',
  timeoutMs: 30_000,
  formRows: [
    { id: 'form-1', key: 'amount', value: '12800', description: '', enabled: true },
    { id: 'form-2', key: 'currency', value: 'CNY', description: '', enabled: true },
  ],
  params: [],
};

function readRequestMeta(id: string): RequestMeta {
  try {
    const raw = localStorage.getItem(`aw-request-meta:${id}`);
    if (!raw) return { ...defaultMeta, params: initialParams };
    const parsed = JSON.parse(raw) as Partial<RequestMeta>;
    return {
      ...defaultMeta,
      ...parsed,
      formRows: parsed.formRows ?? defaultMeta.formRows,
      params: parsed.params ?? initialParams,
    };
  } catch {
    return { ...defaultMeta, params: initialParams };
  }
}

function writeRequestMeta(id: string, meta: RequestMeta) {
  try {
    localStorage.setItem(`aw-request-meta:${id}`, JSON.stringify(meta));
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

const demoResponse: SendResponse = {
  status: 200,
  statusText: 'OK',
  headers: [
    { name: 'content-type', value: 'application/json; charset=utf-8' },
    { name: 'x-request-id', value: 'req_7f3a9c21' },
    { name: 'x-ratelimit-remaining', value: '998' },
    { name: 'server-timing', value: 'db;dur=18, app;dur=42' },
  ],
  body: `{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "ord_9f2c8b41e7",
    "status": "paid",
    "amount": 12800,
    "paidAt": "2026-11-09T10:24:18Z"
  }
}`,
  durationMs: 128,
  sizeBytes: 1229,
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatJsonBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function RequestPanel({
  activeRequest,
  openTabs,
  replay,
  saved,
  environment,
  actor,
  collectionId,
  onSelectTab,
  onCloseTab,
  onHistoryRecorded,
  onSaved,
  onQueued,
  onContextChange,
}: RequestPanelProps) {
  const { message } = App.useApp();
  const [method, setMethod] = useState<HttpMethod>(activeRequest.method);
  const [url, setUrl] = useState(`{{host}}${activeRequest.path}`);
  const [requestTab, setRequestTab] = useState<RequestTabKey>('body');
  const [responseTab, setResponseTab] = useState<ResponseTabKey>('body');
  const [params, setParams] = useState<KvRow[]>(initialParams);
  const [headers, setHeaders] = useState<KvRow[]>(initialHeaders);
  const [body, setBody] = useState(requestBody);
  const [bodyMode, setBodyMode] = useState<BodyMode>(defaultMeta.bodyMode);
  const [formRows, setFormRows] = useState<KvRow[]>(defaultMeta.formRows);
  const [authType, setAuthType] = useState<AuthType>(defaultMeta.authType);
  const [authToken, setAuthToken] = useState(defaultMeta.authToken);
  const [authUser, setAuthUser] = useState(defaultMeta.authUser);
  const [authPass, setAuthPass] = useState(defaultMeta.authPass);
  const [apiKeyName, setApiKeyName] = useState(defaultMeta.apiKeyName);
  const [apiKeyValue, setApiKeyValue] = useState(defaultMeta.apiKeyValue);
  const [timeoutMs, setTimeoutMs] = useState(defaultMeta.timeoutMs);
  const [metaFor, setMetaFor] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<SendResponse>(demoResponse);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const appliedKey = useRef<string | null>(null);

  useEffect(() => {
    const key = `${activeRequest.id}:${saved ? 'saved' : 'new'}`;
    if (appliedKey.current === key) return;
    appliedKey.current = key;

    setMethod((saved?.method as HttpMethod) ?? activeRequest.method);
    setUrl(saved?.url ?? `{{host}}${activeRequest.path}`);
    setBody(saved?.body ?? requestBody);
    setHeaders(
      saved && saved.headers.length > 0
        ? saved.headers.map((header, index) => ({
            id: `saved-${index}`,
            key: header.name,
            value: header.value,
            description: '来自已保存请求',
            enabled: true,
          }))
        : initialHeaders,
    );
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
    setParams(meta.params);
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
  ]);

  useEffect(() => {
    if (!replay) return;
    setMethod(replay.method);
    setUrl(replay.url);
    setError(null);
  }, [replay]);

  useEffect(() => {
    onContextChange({
      id: activeRequest.id,
      name: activeRequest.name,
      method,
      url,
      dataLevel: activeRequest.dataLevel,
      headers: headers
        .filter((row) => row.enabled && row.key.trim())
        .map((row) => ({ name: row.key.trim(), value: row.value })),
      body: method === 'GET' || method === 'DELETE' ? null : body,
      response: {
        status: response.status,
        statusText: response.statusText,
        body: response.body,
      },
    });
  }, [activeRequest, method, url, headers, body, response, onContextChange]);

  const activeRows = useMemo(
    () => (requestTab === 'headers' ? headers : params),
    [requestTab, headers, params],
  );

  const variables = environmentVariables[environment] ?? {};
  const resolvedUrl = useMemo(() => resolveTemplate(url, variables), [url, variables]);

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

  async function handleSend() {
    const paramPairs = params
      .filter((row) => row.enabled && row.key.trim())
      .map((row) => ({
        key: resolveTemplate(row.key, variables),
        value: resolveTemplate(row.value, variables),
      }));
    const finalUrl = mergeQuery(
      resolvedUrl.value,
      paramPairs.map((pair) => ({ key: pair.key.value, value: pair.value.value })),
    );

    let authHeader: { name: string; value: string } | null = null;
    const authMissing: string[] = [];

    if (authType === 'bearer') {
      const token = resolveTemplate(authToken, variables);
      authMissing.push(...token.missing);
      if (token.value.trim()) {
        authHeader = { name: 'Authorization', value: `Bearer ${token.value.trim()}` };
      }
    } else if (authType === 'basic') {
      const user = resolveTemplate(authUser, variables);
      const pass = resolveTemplate(authPass, variables);
      authMissing.push(...user.missing, ...pass.missing);
      if (user.value || pass.value) {
        authHeader = {
          name: 'Authorization',
          value: `Basic ${encodeBasic(user.value, pass.value)}`,
        };
      }
    } else if (authType === 'apikey') {
      const name = resolveTemplate(apiKeyName, variables);
      const value = resolveTemplate(apiKeyValue, variables);
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
      variables,
    );

    let bodyText = '';
    const bodyMissing: string[] = [];

    if (bodyMode === 'form') {
      const pairs = formRows
        .filter((row) => row.enabled && row.key.trim())
        .map((row) => ({
          key: resolveTemplate(row.key, variables),
          value: resolveTemplate(row.value, variables),
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
      const resolvedBody = resolveTemplate(body, variables);
      bodyMissing.push(...resolvedBody.missing);
      bodyText = resolvedBody.value;
    }

    const missing = [
      ...new Set([
        ...resolvedUrl.missing,
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

    setSending(true);
    setError(null);
    const started = performance.now();

    try {
      const result = await sendHttpRequest({
        method,
        url: finalUrl,
        headers: resolvedHeaders.headers,
        body: method === 'GET' || method === 'DELETE' ? undefined : bodyText,
        timeoutMs,
      });

      setResponse(result);
      setFeedback(`请求完成 · ${result.status} ${result.statusText}`);

      recordAudit({
        type: 'request',
        action: `${method} ${finalUrl}`,
        detail: `${result.status} ${result.statusText} · ${result.durationMs}ms · ${formatBytes(result.sizeBytes)}`,
        actor,
        level: activeRequest.dataLevel,
      });

      try {
        await recordHistory({
          method,
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
      setError(text);
      setFeedback('请求失败 · 已加入离线队列');
      message.error({ content: '请求失败，已加入离线队列', duration: 2.2 });

      enqueueTask({
        requestId: activeRequest.id,
        name: activeRequest.name,
        method,
        url: finalUrl,
        headers: resolvedHeaders.headers,
        body: method === 'GET' || method === 'DELETE' ? null : bodyText,
        dataLevel: activeRequest.dataLevel,
      });
      onQueued();

      recordAudit({
        type: 'request',
        action: `${method} ${finalUrl}`,
        detail: `失败 · ${text}`,
        actor,
        level: activeRequest.dataLevel,
      });

      try {
        await recordHistory({
          method,
          url: finalUrl,
          error: text,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        // 历史写入失败不影响错误提示。
      }
    } finally {
      setSending(false);
      onHistoryRecorded();
      window.setTimeout(() => setFeedback(null), 3000);
    }
  }

  const sendRef = useRef(handleSend);
  sendRef.current = handleSend;

  useEffect(() => {
    function handleHotkey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        sendRef.current();
      }
    }
    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  }, []);

  async function handleSave() {
    try {
      await saveRequest({
        id: activeRequest.id,
        name: activeRequest.name,
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
      await navigator.clipboard.writeText(response.body);
      message.success('已复制响应');
    } catch {
      message.warning('当前环境无法访问剪贴板');
    }
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
            <span>{request.path}</span>
            {openTabs.length > 1 && (
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                aria-label={`关闭 ${request.path}`}
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
            )}
          </button>
        ))}
        <button type="button" className="tab-add" aria-label="新建请求">
          <PlusOutlined />
        </button>
        <div className="request-tabs-spacer" />
        <span className="request-title" title={activeRequest.name}>
          {activeRequest.name}
        </span>
        <Tag className={`level-tag level-${activeRequest.dataLevel.toLowerCase()}`}>
          {activeRequest.dataLevel}
        </Tag>
      </div>

      <div className="url-bar">
        <Select
          value={method}
          options={methods.map((item) => ({ value: item, label: item }))}
          onChange={(value) => setMethod(value as HttpMethod)}
          className="method-select"
          popupMatchSelectWidth={false}
        />
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="url-input"
          prefix={<LockOutlined />}
          aria-label="请求地址"
          spellCheck={false}
          onPressEnter={handleSend}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={sending}
          onClick={handleSend}
          className="send-button"
        >
          发送
        </Button>
        <Tooltip title="保存到当前集合">
          <Button
            icon={<SaveOutlined />}
            className="save-button"
            onClick={handleSave}
          >
            保存
          </Button>
        </Tooltip>
        <Select
          size="small"
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
      </div>

      <div className="request-subtabs" role="tablist" aria-label="请求配置">
        {(
          [
            ['params', 'Params', params.filter((row) => row.enabled).length],
            ['headers', 'Headers', headers.filter((row) => row.enabled).length],
            ['body', 'Body', null],
            ['auth', 'Auth', null],
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

        {requestTab === 'body' && (
          <div className="body-editor">
            <div className="editor-toolbar">
              <Segmented
                size="small"
                value={bodyMode}
                onChange={(value) => setBodyMode(value as BodyMode)}
                options={[
                  { label: 'JSON', value: 'json' },
                  { label: '文本', value: 'text' },
                  { label: '表单', value: 'form' },
                ]}
              />
              <span className="editor-note">
                {bodyMode === 'json'
                  ? 'application/json · 自动格式化'
                  : bodyMode === 'text'
                    ? 'text/plain'
                    : 'application/x-www-form-urlencoded'}
              </span>
              <div className="editor-toolbar-spacer" />
              {bodyMode === 'json' && (
                <Button
                  type="text"
                  size="small"
                  icon={<FormatPainterOutlined />}
                  onClick={() => setBody((current) => formatJsonBody(current))}
                >
                  格式化
                </Button>
              )}
              <Button type="text" size="small" icon={<CodeOutlined />}>
                生成代码
              </Button>
            </div>
            {bodyMode === 'form' ? (
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
              </div>
            ) : (
              <textarea
                className="code-block body-input"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                spellCheck={false}
                aria-label="请求体"
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
                    placeholder="{{PAYMENT_TOKEN}}"
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

        {requestTab === 'scripts' && (
          <div className="empty-panel">
            <CodeOutlined />
            <strong>前置 / 后置脚本</strong>
            <p>P1 将提供基于 QuickJS 的沙箱脚本，用于签名、变量提取与断言。</p>
            <Button size="small">查看路线图</Button>
          </div>
        )}
      </div>

      <div className="response-panel">
        <div className="response-head">
          <strong>响应</strong>
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
          <span className="response-meta">{formatBytes(response.sizeBytes)}</span>
          {feedback && (
            <span className="send-feedback">
              <CheckCircleFilled /> {feedback}
            </span>
          )}
          {error && <span className="response-error">{error}</span>}
          <div className="response-spacer" />
          <Tooltip title="复制响应">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label="复制响应"
              onClick={copyResponse}
            />
          </Tooltip>
          <Tooltip title="更多">
            <Button type="text" size="small" icon={<MoreOutlined />} aria-label="响应操作" />
          </Tooltip>
        </div>

        <div className="response-subtabs" role="tablist" aria-label="响应内容">
          {(
            [
              ['body', 'Body'],
              ['headers', 'Headers'],
              ['cookies', 'Cookies'],
              ['console', 'Console'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={responseTab === key}
              className={`subtab${responseTab === key ? ' active' : ''}`}
              onClick={() => setResponseTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="response-body">
          {responseTab === 'body' &&
            (error ? (
              <div className="response-error-panel">
                <CloseCircleOutlined />
                <div>
                  <strong>请求未完成</strong>
                  <p>{error}</p>
                </div>
              </div>
            ) : (
              <ResponseCode body={response.body} />
            ))}

          {responseTab === 'headers' &&
            (response.headers.length > 0 ? (
              <div className="response-kv">
                {response.headers.map((header) => (
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
            <div className="console-line">
              <span>{new Date().toLocaleTimeString()}</span>
              <span className={error ? 'console-bad' : 'console-ok'}>
                {error ? '×' : '→'} {method} {url}
              </span>
              <span>
                {error
                  ? '请求失败'
                  : `${response.durationMs}ms · ${response.status} ${response.statusText}`}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
