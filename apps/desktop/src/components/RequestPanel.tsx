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
import { App, Button, Checkbox, Input, Select, Tag, Tooltip } from 'antd';
import type { ApiRequest, HttpMethod, KvRow } from '../data/mock';
import {
  environmentVariables,
  headerRows as initialHeaders,
  queryParams as initialParams,
  requestBody,
} from '../data/mock';
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

interface RequestPanelProps {
  activeRequest: ApiRequest;
  openTabs: ApiRequest[];
  replay: { method: HttpMethod; url: string; nonce: number } | null;
  saved: SavedRequest | null;
  environment: string;
  onSelectTab: (requestId: string) => void;
  onCloseTab: (requestId: string) => void;
  onHistoryRecorded: () => void;
  onSaved: () => void;
  onContextChange: (context: RequestContext) => void;
}

type RequestTabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts';
type ResponseTabKey = 'body' | 'headers' | 'cookies' | 'console';

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

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g;

function formatBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function highlightJson(text: string) {
  return text.split(JSON_TOKEN).map((part, index) => {
    if (!part) return null;
    let className = 'tok-punc';
    if (/^".*":\s*$/.test(part)) {
      className = 'tok-key';
    } else if (/^"/.test(part)) {
      className = 'tok-str';
    } else if (/^-?\d/.test(part)) {
      className = 'tok-num';
    } else if (/^(true|false|null)$/.test(part)) {
      className = 'tok-bool';
    }
    return (
      <span className={className} key={index}>
        {part}
      </span>
    );
  });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function RequestPanel({
  activeRequest,
  openTabs,
  replay,
  saved,
  environment,
  onSelectTab,
  onCloseTab,
  onHistoryRecorded,
  onSaved,
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

  async function handleSend() {
    const rawHeaders = headers
      .filter((row) => row.enabled && row.key.trim())
      .map((row) => ({ name: row.key.trim(), value: row.value }));
    const resolvedHeaders = resolveHeaders(rawHeaders, variables);
    const resolvedBody = resolveTemplate(body, variables);
    const missing = [
      ...new Set([...resolvedUrl.missing, ...resolvedHeaders.missing, ...resolvedBody.missing]),
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
        url: resolvedUrl.value,
        headers: resolvedHeaders.headers,
        body: method === 'GET' || method === 'DELETE' ? undefined : resolvedBody.value,
        timeoutMs: 30_000,
      });

      setResponse(result);
      setFeedback(`请求完成 · ${result.status} ${result.statusText}`);

      try {
        await recordHistory({
          method,
          url: resolvedUrl.value,
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
      setFeedback('请求失败');
      message.error({ content: '请求失败，请检查 URL 或网络', duration: 2.2 });

      try {
        await recordHistory({
          method,
          url: resolvedUrl.value,
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
      <div className="request-tabs">
        {openTabs.map((request) => (
          <button
            key={request.id}
            type="button"
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
          spellCheck={false}
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
      </div>

      <div className="request-subtabs">
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
                  <Button type="text" size="small" icon={<DeleteOutlined />} />
                </Tooltip>
              </div>
            ))}
            <button type="button" className="kv-add">
              <PlusOutlined /> 添加一行
            </button>
          </div>
        )}

        {requestTab === 'body' && (
          <div className="body-editor">
            <div className="editor-toolbar">
              <Tag className="format-tag">JSON</Tag>
              <span className="editor-note">application/json · 自动格式化</span>
              <div className="editor-toolbar-spacer" />
              <Button type="text" size="small" icon={<FormatPainterOutlined />}>
                格式化
              </Button>
              <Button type="text" size="small" icon={<CodeOutlined />}>
                生成代码
              </Button>
            </div>
            <textarea
              className="code-block body-input"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              spellCheck={false}
              aria-label="请求体"
            />
          </div>
        )}

        {requestTab === 'auth' && (
          <div className="auth-panel">
            <div className="auth-card">
              <span className="panel-eyebrow">BEARER TOKEN</span>
              <Input.Password value={variables.PAYMENT_TOKEN ?? ''} readOnly />
              <p>
                从环境变量 <code>PAYMENT_TOKEN</code> 读取，不写入工作区文件。当前值仅在本机内存中解密。
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
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={copyResponse} />
          </Tooltip>
          <Tooltip title="更多">
            <Button type="text" size="small" icon={<MoreOutlined />} />
          </Tooltip>
        </div>

        <div className="response-subtabs">
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
              <pre className="code-block response-code">
                {highlightJson(formatBody(response.body))}
              </pre>
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
