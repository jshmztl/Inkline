import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircleFilled,
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
  headerRows as initialHeaders,
  queryParams as initialParams,
  requestBody,
} from '../data/mock';
import { MethodTag } from './MethodTag';

interface RequestPanelProps {
  activeRequest: ApiRequest;
  openTabs: ApiRequest[];
  onSelectTab: (requestId: string) => void;
  onCloseTab: (requestId: string) => void;
}

type RequestTabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts';
type ResponseTabKey = 'body' | 'headers' | 'cookies' | 'console';

const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function RequestPanel({
  activeRequest,
  openTabs,
  onSelectTab,
  onCloseTab,
}: RequestPanelProps) {
  const { message } = App.useApp();
  const [method, setMethod] = useState<HttpMethod>(activeRequest.method);
  const [url, setUrl] = useState(`https://api.internal${activeRequest.path}`);
  const [requestTab, setRequestTab] = useState<RequestTabKey>('body');
  const [responseTab, setResponseTab] = useState<ResponseTabKey>('body');
  const [params, setParams] = useState<KvRow[]>(initialParams);
  const [headers, setHeaders] = useState<KvRow[]>(initialHeaders);
  const [sending, setSending] = useState(false);
  const [responseTime, setResponseTime] = useState(128);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setMethod(activeRequest.method);
    setUrl(`https://api.internal${activeRequest.path}`);
  }, [activeRequest]);

  const activeRows = useMemo(
    () => (requestTab === 'headers' ? headers : params),
    [requestTab, headers, params],
  );

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

  function handleSend() {
    setSending(true);
    window.setTimeout(() => {
      setSending(false);
      setResponseTime(118 + Math.round(Math.random() * 32));
      setFeedback('请求完成 · 200 OK');
      message.success({ content: '请求完成 · 200 OK', duration: 2.2 });
      window.setTimeout(() => setFeedback(null), 2600);
    }, 680);
  }

  async function copyResponse() {
    try {
      await navigator.clipboard.writeText('{"code":0,"message":"ok"}');
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
            onClick={() => message.success('已保存到当前集合')}
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
        <span className="request-hint">
          <ThunderboltOutlined /> 继承集合变量 · 4 个
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
            <pre className="code-block">
              <span className="tok-punc">{'{'}</span>
              {'\n  '}
              <span className="tok-key">"amount"</span>
              <span className="tok-punc">: </span>
              <span className="tok-num">12800</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"currency"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"CNY"</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"idempotencyKey"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"ord_20261109_7f3a"</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"channel"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"wechat_pay"</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"description"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"年度订阅 · 专业版"</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"metadata"</span>
              <span className="tok-punc">: {'{'}</span>
              {'\n    '}
              <span className="tok-key">"plan"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"pro"</span>
              <span className="tok-punc">,</span>
              {'\n    '}
              <span className="tok-key">"seats"</span>
              <span className="tok-punc">: </span>
              <span className="tok-num">12</span>
              {'\n  '}
              <span className="tok-punc">{'}'}</span>
              {'\n'}
              <span className="tok-punc">{'}'}</span>
            </pre>
          </div>
        )}

        {requestTab === 'auth' && (
          <div className="auth-panel">
            <div className="auth-card">
              <span className="panel-eyebrow">BEARER TOKEN</span>
              <Input.Password value="aw_live_9f2c8b41e7" readOnly />
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
          <span className="status-pill ok">200 OK</span>
          <span className="response-meta">{responseTime} ms</span>
          <span className="response-meta">1.2 KB</span>
          {feedback && (
            <span className="send-feedback">
              <CheckCircleFilled /> {feedback}
            </span>
          )}
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
          {responseTab === 'body' && (
            <pre className="code-block response-code">
              <span className="tok-punc">{'{'}</span>
              {'\n  '}
              <span className="tok-key">"code"</span>
              <span className="tok-punc">: </span>
              <span className="tok-num">0</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"message"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"ok"</span>
              <span className="tok-punc">,</span>
              {'\n  '}
              <span className="tok-key">"data"</span>
              <span className="tok-punc">: {'{'}</span>
              {'\n    '}
              <span className="tok-key">"id"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"ord_9f2c8b41e7"</span>
              <span className="tok-punc">,</span>
              {'\n    '}
              <span className="tok-key">"status"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"paid"</span>
              <span className="tok-punc">,</span>
              {'\n    '}
              <span className="tok-key">"amount"</span>
              <span className="tok-punc">: </span>
              <span className="tok-num">12800</span>
              <span className="tok-punc">,</span>
              {'\n    '}
              <span className="tok-key">"paidAt"</span>
              <span className="tok-punc">: </span>
              <span className="tok-str">"2026-11-09T10:24:18Z"</span>
              {'\n  '}
              <span className="tok-punc">{'}'}</span>
              {'\n'}
              <span className="tok-punc">{'}'}</span>
            </pre>
          )}

          {responseTab === 'headers' && (
            <div className="response-kv">
              <div>
                <span>content-type</span>
                <code>application/json; charset=utf-8</code>
              </div>
              <div>
                <span>x-request-id</span>
                <code>req_7f3a9c21</code>
              </div>
              <div>
                <span>x-ratelimit-remaining</span>
                <code>998</code>
              </div>
              <div>
                <span>server-timing</span>
                <code>db;dur=18, app;dur=42</code>
              </div>
            </div>
          )}

          {responseTab === 'cookies' && (
            <div className="response-empty">该响应没有 Set-Cookie。</div>
          )}

          {responseTab === 'console' && (
            <div className="console-line">
              <span>10:24:18.204</span>
              <span className="console-ok">→ POST /v1/orders</span>
              <span>{responseTime}ms · 200 OK</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
