import { useEffect, useMemo, useState } from 'react';
import {
  DownOutlined,
  FileTextOutlined,
  LockOutlined,
  MoreOutlined,
  PaperClipOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Dropdown, Modal, Tag, Tooltip } from 'antd';
import { Bubble, Prompts, Sender } from '@ant-design/x';
import type { ApiRequest, NetworkMode } from '../data/types';
import { networkModes } from '../data/types';
import {
  buildDocTask,
  buildDraftDiff,
  buildFieldReview,
  docToMarkdown,
  docToOpenApi,
  mergeDraftFields,
  type DraftField,
  type RequestContext,
} from '../lib/docTask';
import { MethodTag } from './MethodTag';
import { AiGatewayModal } from './AiGatewayModal';
import { preflightEgress } from '../lib/egress';
import { recordAudit } from '../lib/audit';
import { resolveModelRoute } from '../lib/modelRoute';
import { chatWithGateway, readGatewayConfig } from '../lib/aiGateway';

interface AiPanelProps {
  networkMode: NetworkMode;
  activeRequest: ApiRequest;
  context: RequestContext | null;
  syncNonce: number;
  actor: string;
}

interface ChatMessage {
  key: string;
  placement: 'start' | 'end';
  text: string;
}

const prompts = ['生成接口文档', '补全字段说明', '生成测试用例', '解释错误'];

export function AiPanel({
  networkMode,
  activeRequest,
  context,
  syncNonce,
  actor,
}: AiPanelProps) {
  const { message } = App.useApp();
  const network = networkModes[networkMode];
  const [composer, setComposer] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [applied, setApplied] = useState(false);
  const [draft, setDraft] = useState<DraftField[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [gatewayConfig, setGatewayConfig] = useState(readGatewayConfig);

  const task = useMemo(() => (context ? buildDocTask(context) : null), [context]);
  const review = useMemo(() => (task ? buildFieldReview(task) : []), [task]);
  const route = useMemo(
    () => resolveModelRoute(networkMode, activeRequest.dataLevel),
    [networkMode, activeRequest.dataLevel],
  );
  const preflight = useMemo(() => (context ? preflightEgress(context) : null), [context]);
  const pending = review.filter((item) => item.confidence < 90).length;
  const visibleReview = review.slice(0, 5);
  const requestId = task?.request.id ?? null;
  const diff = useMemo(
    () => (task ? buildDraftDiff(draft, review, accepted) : []),
    [task, draft, review, accepted],
  );

  useEffect(() => {
    setAccepted({});
    setApplied(false);
  }, [task?.id]);

  useEffect(() => {
    if (!requestId) {
      setDraft([]);
      return;
    }
    try {
      const raw = localStorage.getItem(`aw-doc-draft:${requestId}`);
      const parsed = raw ? JSON.parse(raw) : [];
      setDraft(Array.isArray(parsed) ? (parsed as DraftField[]) : []);
    } catch {
      setDraft([]);
    }
  }, [requestId, syncNonce]);

  async function startTask() {
    if (!task) return;
    const modelLabel = gatewayConfig.model || route.model;
    const masked = route.egress ? `；出网前脱敏 ${preflight?.masks.length ?? 0} 项` : '';
    setMessages((current) => [
      ...current,
      {
        key: `${task.id}-${current.length}`,
        placement: 'start',
        text: `已建立文档任务（${modelLabel}）：请求 ${task.stats.requestFields} 个字段，响应示例 ${task.stats.responseFields} 个字段，命中术语 ${task.stats.glossaryHits} 条${masked}。可进入字段审阅。`,
      },
    ]);
    recordAudit({
      type: 'ai-task',
      action: `文档任务 · ${task.request.method} ${task.request.url}`,
      detail: `${modelLabel} · ${task.stats.requestFields} 请求字段 / ${task.stats.responseFields} 响应字段 / ${task.stats.glossaryHits} 术语`,
      actor,
      level: task.request.dataLevel,
    });
    message.success(route.egress ? '已审批并建立文档任务' : '文档任务已建立');

    const config = readGatewayConfig();
    const prompt = [
      `接口：${task.request.method} ${task.request.url}`,
      `数据级别：${task.request.dataLevel}`,
      `请求字段 ${task.stats.requestFields} 个，响应字段 ${task.stats.responseFields} 个`,
      '请用 2-3 句话概括接口用途、关键字段与文档注意事项。',
    ].join('\n');

    try {
      const reply = await chatWithGateway(
        config,
        [
          {
            role: 'system',
            content: '你是内网 API 文档助手，回答简洁、专业，使用中文。',
          },
          { role: 'user', content: prompt },
        ],
        20_000,
      );
      setMessages((current) => [
        ...current,
        {
          key: `${task.id}-gateway-${current.length}`,
          placement: 'start',
          text: `【${reply.model}】${reply.content}`,
        },
      ]);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages((current) => [
        ...current,
        {
          key: `${task.id}-gateway-${current.length}`,
          placement: 'start',
          text: `AI 网关调用失败：${text}（已保留本地模板结果）`,
        },
      ]);
    }
  }

  function runTask() {
    if (!task) return;
    if (!route.allowed) {
      message.error(route.reason);
      return;
    }
    if (route.egress) {
      setPreflightOpen(true);
      return;
    }
    void startTask();
  }

  function applyDraft() {
    if (!task) return;
    const next = mergeDraftFields(draft, review, accepted);
    setDraft(next);
    try {
      localStorage.setItem(`aw-doc-draft:${task.request.id}`, JSON.stringify(next));
    } catch {
      // localStorage 不可用时仅保留内存草稿。
    }
    setApplied(true);
    setDiffOpen(false);
    message.success(`已应用到文档草稿 · ${next.length} 个字段`);
  }

  async function submit() {
    const text = composer.trim();
    if (!text) return;
    setComposer('');
    setMessages((current) => [
      ...current,
      { key: `user-${Date.now()}`, placement: 'end', text },
    ]);

    try {
      const reply = await chatWithGateway(
        readGatewayConfig(),
        [
          {
            role: 'system',
            content: '你是内网 API 文档助手，回答简洁、专业，使用中文。',
          },
          ...messages.map((item) => ({
            role: item.placement === 'end' ? ('user' as const) : ('assistant' as const),
            content: item.text,
          })),
          { role: 'user', content: text },
        ],
        30_000,
      );
      setMessages((current) => [
        ...current,
        { key: `reply-${Date.now()}`, placement: 'start', text: reply.content },
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      message.error(`AI 网关调用失败：${reason}`);
    }
  }

  function downloadDoc(format: 'markdown' | 'openapi') {
    if (!task) return;
    const content =
      format === 'markdown' ? docToMarkdown(task, draft) : docToOpenApi(task, draft);
    const extension = format === 'markdown' ? 'md' : 'openapi.json';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${task.request.name}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 ${format === 'markdown' ? 'Markdown' : 'OpenAPI'}`);
  }

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <div className="ai-title">
          <span className="ai-spark">
            <RobotOutlined />
          </span>
          <div>
            <strong>AI 文档助手</strong>
            <span>文档专用 · 可审计</span>
          </div>
        </div>
        <Tag className={`model-tag tone-${network.tone}`}>
          {gatewayConfig.model || network.modelName}
        </Tag>
        <Tooltip title="AI 网关设置">
          <Button
            type="text"
            size="small"
            icon={<SettingOutlined />}
            aria-label="AI 网关设置"
            onClick={() => setGatewayOpen(true)}
          />
        </Tooltip>
        <Tooltip title="更多">
          <Button type="text" size="small" icon={<MoreOutlined />} aria-label="更多" />
        </Tooltip>
      </div>

      <div className="ai-context">
        <div className="ai-context-request">
          <MethodTag method={activeRequest.method} />
          <code>{activeRequest.path}</code>
        </div>
        <Tag className={`level-tag level-${activeRequest.dataLevel.toLowerCase()}`}>
          {activeRequest.dataLevel} 敏感
        </Tag>
      </div>

      <div className="ai-scroll">
        {messages.length === 0 && (
          <div className="ai-welcome">
            <span className="ai-welcome-icon">
              <RobotOutlined />
            </span>
            <strong>把接口文档交给 AI</strong>
            <p>基于当前请求与响应生成字段说明、示例与术语，过程可追溯、可审计。</p>
          </div>
        )}

        <div className="ai-task">
          <div className="ai-task-head">
            <strong>文档任务</strong>
            <Tag className={`task-state${task ? ' ready' : ''}`}>
              {task ? '上下文就绪' : '等待上下文'}
            </Tag>
          </div>
          <div className="ai-task-sources">
            <span>
              <code>{task?.stats.requestFields ?? 0}</code> 请求字段
            </span>
            <span>
              <code>{task?.stats.responseFields ?? 0}</code> 响应字段
            </span>
            <span>
              <code>{task?.stats.glossaryHits ?? 0}</code> 术语命中
            </span>
          </div>
          {task && task.glossary.length > 0 && (
            <div className="ai-task-terms">
              术语：{task.glossary.map((hit) => hit.entry.term).join(' · ')}
            </div>
          )}
          <div className={`ai-route${route.allowed ? '' : ' blocked'}`}>
            <i className="ai-route-dot" />
            <code>{gatewayConfig.baseUrl || route.endpoint}</code>
            <span>{route.egress ? '出网' : '不出网'}</span>
            {route.approval && <span>需审批</span>}
            {route.egress && <span>脱敏 {preflight?.masks.length ?? 0} 项</span>}
          </div>
          {!route.allowed && <div className="ai-route-warn">{route.reason}</div>}
          <div className="ai-task-actions">
            <Button
              type="primary"
              size="small"
              icon={<FileTextOutlined />}
              onClick={runTask}
              disabled={!task}
            >
              建立文档任务
            </Button>
            <span>请求 + 响应示例 + 术语表</span>
          </div>
        </div>

        <Prompts
          className="ai-prompts"
          items={prompts.map((label) => ({ key: label, label }))}
          wrap
          onItemClick={({ data }) => setComposer(String(data.label ?? ''))}
        />

        {messages.map((item) => (
          <Bubble
            key={item.key}
            className={`ai-bubble ai-bubble-${item.placement}`}
            placement={item.placement}
            variant={item.placement === 'end' ? 'filled' : 'outlined'}
            content={item.text}
          />
        ))}

        <div className="review-card">
          <div className="review-head">
            <strong>字段审阅</strong>
            <span>
              {task ? `${pending} 项待确认 · 共 ${review.length} 字段` : '等待文档任务'}
            </span>
            {applied && <Tag className="applied-tag">已应用</Tag>}
          </div>

          {visibleReview.map((field) => (
            <label className="review-row" key={field.key}>
              <Checkbox
                checked={accepted[field.key] ?? true}
                onChange={(event) =>
                  setAccepted((current) => ({
                    ...current,
                    [field.key]: event.target.checked,
                  }))
                }
              />
              <div className="review-field">
                <div>
                  <code>{field.path}</code>
                  <em>{field.type}</em>
                  <b className={`review-source${field.source === '请求' ? ' req' : ' res'}`}>
                    {field.source}
                  </b>
                </div>
                <span>{field.note}</span>
              </div>
              <div className="confidence">
                <div className="confidence-bar">
                  <i
                    className={field.confidence < 90 ? 'low' : undefined}
                    style={{ width: `${field.confidence}%` }}
                  />
                </div>
                <span>{field.confidence}%</span>
              </div>
            </label>
          ))}

          {visibleReview.length === 0 && (
            <div className="review-empty">等待请求上下文后生成字段审阅。</div>
          )}

          <div className="review-actions">
            <Button
              color="green"
              variant="solid"
              size="small"
              onClick={applyDraft}
              disabled={applied || review.length === 0}
            >
              {applied ? '已应用' : '应用到文档'}
            </Button>
            <Button size="small" onClick={() => setDiffOpen(true)}>
              查看 diff
            </Button>
            <Dropdown
              trigger={['click']}
              disabled={!task}
              menu={{
                items: [
                  { key: 'markdown', label: '导出 Markdown' },
                  { key: 'openapi', label: '导出 OpenAPI' },
                ],
                onClick: ({ key }) => downloadDoc(key as 'markdown' | 'openapi'),
              }}
            >
              <Button size="small" disabled={!task}>
                导出 <DownOutlined />
              </Button>
            </Dropdown>
            <Button type="text" size="small" onClick={() => message.info('已忽略本次建议')}>
              忽略
            </Button>
          </div>
        </div>

        <div className="ai-footnote">
          <LockOutlined /> {network.modelNote} · 输出可追溯到请求与模型版本
        </div>
      </div>

      <div className="composer">
        <Sender
          className="ai-sender"
          value={composer}
          onChange={(value) => setComposer(value)}
          onSubmit={submit}
          placeholder="描述目标，或粘贴接口规范…"
          autoSize={{ minRows: 3, maxRows: 6 }}
          footer={<span className="composer-hint">⌘↵ 发送</span>}
          actions={
            <>
              <Tooltip title="添加附件">
                <Button
                  type="text"
                  size="small"
                  icon={<PaperClipOutlined />}
                  aria-label="添加附件"
                />
              </Tooltip>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                onClick={submit}
                disabled={!composer.trim()}
              >
                发送
              </Button>
            </>
          }
        />
      </div>

      <Modal
        open={diffOpen}
        title="文档草稿 Diff"
        width={480}
        onCancel={() => setDiffOpen(false)}
        footer={[
          <Button key="close" size="small" onClick={() => setDiffOpen(false)}>
            关闭
          </Button>,
          <Button
            key="apply"
            type="primary"
            size="small"
            onClick={applyDraft}
            disabled={diff.length === 0}
          >
            应用到草稿
          </Button>,
        ]}
      >
        {diff.length === 0 ? (
          <div className="diff-empty">当前草稿已包含所有选中字段。</div>
        ) : (
          <div className="diff-list">
            {diff.map((row) => (
              <div className={`diff-row ${row.kind}`} key={row.key}>
                <span className="diff-sign">{row.kind === 'add' ? '+' : '~'}</span>
                <div className="diff-body">
                  <div className="diff-path">
                    <code>{row.path}</code>
                    <em>{row.type}</em>
                  </div>
                  {row.before !== null && <div className="diff-before">- {row.before}</div>}
                  <div className="diff-after">+ {row.after}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="diff-summary">
          新增 {diff.filter((row) => row.kind === 'add').length} · 修改{' '}
          {diff.filter((row) => row.kind === 'update').length}
        </div>
      </Modal>

      <Modal
        open={preflightOpen}
        title="出网预检"
        width={460}
        onCancel={() => setPreflightOpen(false)}
        footer={[
          <Button key="cancel" size="small" onClick={() => setPreflightOpen(false)}>
            取消
          </Button>,
          <Button
            key="approve"
            type="primary"
            size="small"
            onClick={() => {
              setPreflightOpen(false);
              recordAudit({
                type: 'egress',
                action: `出网审批 · ${activeRequest.method} ${activeRequest.path}`,
                detail: `${route.endpoint} · 脱敏 ${preflight?.masks.length ?? 0} 项 · 人工审批通过`,
                actor,
                level: activeRequest.dataLevel,
              });
              void startTask();
            }}
          >
            确认出网并生成
          </Button>,
        ]}
      >
        <div className="preflight">
          <div className="preflight-row">
            <span>数据分级</span>
            <b>{activeRequest.dataLevel}</b>
          </div>
          <div className="preflight-row">
            <span>出网目标</span>
            <code>{route.endpoint}</code>
          </div>
          <div className="preflight-row">
            <span>审批状态</span>
            <b className="warn">待人工审批</b>
          </div>
          <div className="preflight-row">
            <span>脱敏项</span>
            <b>{preflight?.masks.length ?? 0} 项</b>
          </div>
          <div className="preflight-masks">
            {preflight?.masks.map((mask) => (
              <div className="preflight-mask" key={`${mask.location}:${mask.path}`}>
                <code>{mask.path}</code>
                <span>{mask.before}</span>
                <i>→</i>
                <span>{mask.after}</span>
              </div>
            ))}
            {preflight?.masks.length === 0 && (
              <div className="preflight-none">未发现敏感字段。</div>
            )}
          </div>
          <p className="preflight-note">
            确认后将按脱敏结果发送到外部模型，操作会记入审计日志。
          </p>
        </div>
      </Modal>

      <AiGatewayModal
        open={gatewayOpen}
        onClose={() => {
          setGatewayOpen(false);
          setGatewayConfig(readGatewayConfig());
        }}
      />
    </aside>
  );
}
