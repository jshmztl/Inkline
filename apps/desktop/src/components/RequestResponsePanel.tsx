import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircleFilled,
  CloseCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DiffOutlined,
  DownloadOutlined,
  MoreOutlined,
  SaveOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Input, Select, Tooltip } from 'antd';
import type { HttpMethod } from '../data/types';
import type { AssertionResult } from '../lib/assertions';
import { operatorLabel } from '../lib/assertions';
import type { SendResponse } from '../lib/api';
import type { ProtocolKind, StreamEvent } from '../lib/protocol';
import {
  RESPONSE_CACHE_MAX_BODY_LABEL,
  type ResponseCacheMeta,
} from '../lib/responseCache';
import {
  buildHtmlPreview,
  decodeResponseBody,
  detectResponseFormat,
  detectedEncodingLabel,
  RESPONSE_ENCODING_OPTIONS,
  RESPONSE_FORMAT_OPTIONS,
  readContentType,
  type ResponseEncoding,
  type ResponseFormatChoice,
  type ResponseViewMode,
} from '../lib/responsePreview';
import { ResponseCode } from './ResponseCode';

export type ResponseTabKey = 'body' | 'headers' | 'cookies' | 'console' | 'assertions';

export interface ScriptLog {
  id: string;
  phase: 'pre' | 'post';
  text: string;
  bad: boolean;
}

interface RequestResponsePanelProps {
  protocol: ProtocolKind;
  method: HttpMethod;
  url: string;
  response: SendResponse | null;
  streamMode: boolean;
  connected: boolean;
  sending: boolean;
  feedback: string | null;
  error: string | null;
  assertionResults: AssertionResult[];
  responseTab: ResponseTabKey;
  onResponseTabChange: (tab: ResponseTabKey) => void;
  responseQuery: string;
  onResponseQueryChange: (value: string) => void;
  responseMatchCount: number;
  hasResponseContent: boolean;
  hasBaseline: boolean;
  cacheMeta: ResponseCacheMeta | null;
  cacheEnabled: boolean;
  onToggleCache: () => void;
  onClearAllCache: () => void;
  streamEvents: StreamEvent[];
  draftMessage: string;
  onDraftMessageChange: (value: string) => void;
  onSendDraftMessage: () => void;
  onClearStream: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onSaveBaseline: () => void;
  onOpenDiff: () => void;
  onClear: () => void;
  scriptLogs: ScriptLog[];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCacheTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function RequestResponsePanel({
  protocol,
  method,
  url,
  response,
  streamMode,
  connected,
  sending,
  feedback,
  error,
  assertionResults,
  responseTab,
  onResponseTabChange,
  responseQuery,
  onResponseQueryChange,
  responseMatchCount,
  hasResponseContent,
  hasBaseline,
  cacheMeta,
  cacheEnabled,
  onToggleCache,
  onClearAllCache,
  streamEvents,
  draftMessage,
  onDraftMessageChange,
  onSendDraftMessage,
  onClearStream,
  onCopy,
  onDownload,
  onSaveBaseline,
  onOpenDiff,
  onClear,
  scriptLogs,
}: RequestResponsePanelProps) {
  const [viewModeChoice, setViewModeChoice] = useState<ResponseViewMode | null>(null);
  const [formatChoice, setFormatChoice] = useState<ResponseFormatChoice>('auto');
  const [encodingChoice, setEncodingChoice] = useState<ResponseEncoding>('auto');
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!sending) {
      setElapsedMs(0);
      return;
    }
    const started = performance.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => {
      setElapsedMs(performance.now() - started);
    }, 100);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    setViewModeChoice(null);
    setFormatChoice('auto');
    setEncodingChoice('auto');
  }, [response]);

  const contentType = useMemo(() => readContentType(response?.headers ?? []), [response]);
  const decodedBody = useMemo(
    () =>
      response
        ? decodeResponseBody(response.body, response.bodyBase64, contentType, encodingChoice)
        : '',
    [response, contentType, encodingChoice],
  );
  const activeFormat = useMemo(
    () =>
      formatChoice === 'auto'
        ? detectResponseFormat(contentType, decodedBody)
        : formatChoice,
    [contentType, decodedBody, formatChoice],
  );
  const viewMode: ResponseViewMode =
    viewModeChoice ?? (activeFormat === 'html' ? 'preview' : 'pretty');
  const htmlPreviewActive = viewMode === 'preview' && activeFormat === 'html';
  const detectedEncoding = useMemo(
    () => detectedEncodingLabel(contentType, response?.bodyBase64),
    [contentType, response],
  );
  const formatOptions = useMemo(
    () =>
      RESPONSE_FORMAT_OPTIONS.map((option) =>
        option.value === 'auto'
          ? { ...option, label: `自动（${activeFormat.toUpperCase()}）` }
          : option,
      ),
    [activeFormat],
  );
  const encodingOptions = useMemo(
    () =>
      RESPONSE_ENCODING_OPTIONS.map((option) =>
        option.value === 'auto' && response?.bodyBase64
          ? { ...option, label: `自动（${detectedEncoding.toUpperCase()}）` }
          : option,
      ),
    [detectedEncoding, response],
  );
  const htmlPreview = useMemo(
    () => buildHtmlPreview(decodedBody, url),
    [decodedBody, url],
  );

  return (
    <div className="response-panel">
      <div className="response-head">
        <strong>响应</strong>
        {streamMode ? (
          <span className={`status-pill ${connected ? 'ok' : 'warn'}`}>
            {connected ? '已连接' : '未连接'}
          </span>
        ) : sending ? (
          <span className="status-pill warn">请求中</span>
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
            {response.dnsMs != null && (
              <span className="response-meta" title="DNS 解析耗时（独立探测连接）">
                DNS {response.dnsMs} ms
              </span>
            )}
            {response.tcpMs != null && (
              <span className="response-meta" title="TCP 连接耗时（独立探测连接）">
                TCP {response.tcpMs} ms
              </span>
            )}
            {response.tlsMs != null && (
              <span className="response-meta" title="TLS 握手耗时（独立探测连接）">
                TLS {response.tlsMs} ms
              </span>
            )}
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
            {response.truncated && (
              <span
                className="response-meta warn"
                title="响应体超过 10 MiB 上限，仅保留开头部分。历史记录仍只保存元数据，不保存响应正文。"
              >
                已截断
              </span>
            )}
            {cacheMeta && (
              <span
                className={`response-meta cache-meta${cacheMeta.stale ? ' bad' : ''}`}
                title={`缓存于 ${formatCacheTime(cacheMeta.cachedAt)}`}
              >
                缓存 · {formatCacheTime(cacheMeta.cachedAt)}
              </span>
            )}
          </>
        ) : cacheMeta && error ? (
          <span className="status-pill bad">上次失败</span>
        ) : (
          <span className="status-pill">未发送</span>
        )}
        {!streamMode && cacheMeta && !response && (
          <span
            className={`response-meta cache-meta${cacheMeta.stale ? ' bad' : ''}`}
            title={`缓存于 ${formatCacheTime(cacheMeta.cachedAt)}`}
          >
            缓存 · {formatCacheTime(cacheMeta.cachedAt)}
          </span>
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
              onClick={onClearStream}
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
            onChange={(event) => onResponseQueryChange(event.target.value)}
            disabled={responseTab !== 'body' || htmlPreviewActive}
            aria-label="搜索响应"
          />
        )}
        {!streamMode && !htmlPreviewActive && responseQuery.trim() && (
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
            onClick={onCopy}
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
              {
                key: 'baseline',
                label: '保存响应为基线',
                icon: <SaveOutlined />,
                disabled: !response || streamMode,
              },
              {
                key: 'diff',
                label: '对比基线',
                icon: <DiffOutlined />,
                disabled: !response || streamMode || !hasBaseline,
              },
              {
                key: 'cache',
                label: cacheEnabled ? '关闭本机响应缓存' : '开启本机响应缓存',
                icon: <DatabaseOutlined />,
                disabled: streamMode,
              },
              {
                key: 'clear-cache',
                label: '清除全部响应缓存',
                icon: <DeleteOutlined />,
                danger: true,
                disabled: streamMode,
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
              if (key === 'copy') onCopy();
              if (key === 'download') onDownload();
              if (key === 'baseline') onSaveBaseline();
              if (key === 'diff') onOpenDiff();
              if (key === 'cache') onToggleCache();
              if (key === 'clear-cache') onClearAllCache();
              if (key === 'clear') onClear();
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
              onClick={() => onResponseTabChange(key)}
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
                  onChange={(event) => onDraftMessageChange(event.target.value)}
                  onPressEnter={onSendDraftMessage}
                  placeholder={connected ? '输入消息，回车发送' : '连接后可发送消息'}
                  disabled={!connected}
                  aria-label="WebSocket 消息"
                />
                <Button
                  type="primary"
                  size="small"
                  disabled={!connected || !draftMessage.trim()}
                  onClick={onSendDraftMessage}
                >
                  发送
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            {cacheMeta && (cacheMeta.stale || cacheMeta.truncated) && (
              <div className="response-cache-note">
                {[
                  cacheMeta.stale ? '请求已修改，以下为上次发送的响应。' : '',
                  cacheMeta.truncated
                    ? `响应过大，仅缓存了前 ${RESPONSE_CACHE_MAX_BODY_LABEL}。`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              </div>
            )}
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
                <div className="response-viewer">
                  <div className="response-viewbar">
                    <div className="response-viewmodes" role="tablist" aria-label="响应查看方式">
                      {(
                        [
                          ['pretty', '美化'],
                          ['raw', '原生'],
                          ['preview', '预览'],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          role="tab"
                          aria-selected={viewMode === key}
                          className={`response-viewmode${viewMode === key ? ' active' : ''}`}
                          onClick={() => setViewModeChoice(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="response-view-options">
                      <Select<ResponseFormatChoice>
                        size="small"
                        value={formatChoice}
                        onChange={(value) => setFormatChoice(value)}
                        options={formatOptions}
                        aria-label="响应内容类型"
                        popupMatchSelectWidth={false}
                      />
                      <Tooltip
                        title={
                          response.bodyBase64
                            ? '选择响应编码'
                            : '当前响应未保留原始字节，无法切换编码'
                        }
                      >
                        <span>
                          <Select<ResponseEncoding>
                            size="small"
                            value={encodingChoice}
                            onChange={(value) => setEncodingChoice(value)}
                            options={encodingOptions}
                            disabled={!response.bodyBase64}
                            aria-label="响应编码"
                            popupMatchSelectWidth={false}
                          />
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                  {viewMode === 'preview' ? (
                    activeFormat === 'html' ? (
                      <>
                        <div className="response-preview-note">
                          HTML 预览 · 脚本与同源访问已禁用
                        </div>
                        <iframe
                          className="response-html-preview"
                          sandbox=""
                          srcDoc={htmlPreview}
                          title="HTML 响应预览"
                        />
                      </>
                    ) : (
                      <>
                        <div className="response-preview-note">
                          该内容类型暂不支持渲染，已显示格式化文本。
                        </div>
                        <ResponseCode
                          body={decodedBody}
                          query={responseQuery}
                          mode="pretty"
                          format={activeFormat}
                        />
                      </>
                    )
                  ) : (
                    <ResponseCode
                      body={decodedBody}
                      query={responseQuery}
                      mode={viewMode}
                      format={activeFormat}
                    />
                  )}
                </div>
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

      {sending && (
        <div className="response-loading" role="status" aria-label="正在请求">
          <div className="response-loading-card">
            <span className="response-loading-ring" aria-hidden="true" />
            <strong>正在请求</strong>
            <span className="response-loading-time" aria-hidden="true">
              {formatElapsed(elapsedMs)}
            </span>
            <span className="response-loading-hint">按 Esc 可中断</span>
          </div>
        </div>
      )}
    </div>
  );
}
