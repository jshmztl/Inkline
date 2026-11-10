import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  BookOutlined,
  DeleteOutlined,
  DownOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileTextOutlined,
  LockOutlined,
  MoreOutlined,
  PaperClipOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Dropdown, Input, Modal, Tag, Tooltip } from 'antd';
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
  type FieldReview,
  type GlossaryEntry,
  type RequestContext,
} from '../lib/docTask';
import { MethodTag } from './MethodTag';
import { AiGatewayModal } from './AiGatewayModal';
import { preflightEgress } from '../lib/egress';
import { recordAudit } from '../lib/audit';
import { resolveModelRoute } from '../lib/modelRoute';
import { checkNetworkAccess } from '../lib/networkPolicy';
import {
  chatWithGateway,
  chatWithGatewayStream,
  readGatewayConfig,
} from '../lib/aiGateway';
import {
  defaultGlossary,
  readGlossary,
  writeGlossary,
} from '../lib/glossary';

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

function parseDescriptionJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [diffOpen, setDiffOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [gatewayConfig, setGatewayConfig] = useState(readGatewayConfig);
  const [glossaryEntries, setGlossaryEntries] = useState<GlossaryEntry[]>(readGlossary);
  const [glossaryDraft, setGlossaryDraft] = useState<GlossaryEntry[]>([]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [descLoading, setDescLoading] = useState(false);
  const [testsLoading, setTestsLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    'task' | 'descriptions' | 'tests' | 'chat'
  >('task');
  const [pendingChat, setPendingChat] = useState('');

  const task = useMemo(
    () => (context ? buildDocTask(context, glossaryEntries) : null),
    [context, glossaryEntries],
  );
  const review = useMemo(
    () => (task ? buildFieldReview(task, glossaryEntries) : []),
    [task, glossaryEntries],
  );
  const route = useMemo(
    () => resolveModelRoute(networkMode, activeRequest.dataLevel),
    [networkMode, activeRequest.dataLevel],
  );
  const gatewayAccess = useMemo(() => {
    const baseUrl = gatewayConfig.baseUrl.trim();
    if (!baseUrl) return null;
    return checkNetworkAccess(baseUrl, networkMode);
  }, [gatewayConfig.baseUrl, networkMode]);
  const routeBlocked = !route.allowed || (gatewayAccess ? !gatewayAccess.allowed : false);
  const routeReason = !route.allowed
    ? route.reason
    : gatewayAccess && !gatewayAccess.allowed
      ? gatewayAccess.reason
      : '';
  const preflight = useMemo(() => (context ? preflightEgress(context) : null), [context]);
  const pending = review.filter((item) => item.confidence < 90).length;
  const requestId = task?.request.id ?? null;
  const effectiveReview = useMemo(
    () =>
      review.map((item) => {
        const draftNote = draft.find((entry) => entry.key === item.key)?.description;
        const note = notes[item.key] ?? (draftNote ? draftNote : item.note);
        return note === item.note ? item : { ...item, note };
      }),
    [review, notes, draft],
  );
  const requestReview = effectiveReview.filter((item) => item.source === '请求');
  const responseReview = effectiveReview.filter((item) => item.source === '响应');
  const diff = useMemo(
    () => (task ? buildDraftDiff(draft, effectiveReview, accepted) : []),
    [task, draft, effectiveReview, accepted],
  );
  const docMarkdown = useMemo(
    () => (task ? docToMarkdown(task, draft) : ''),
    [task, draft],
  );

  useEffect(() => {
    setAccepted({});
    setApplied(false);
    setNotes({});
  }, [activeRequest.id]);

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
    setDocOpen(true);

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

  function buildContextPrompt() {
    if (!task) return '';
    const sampleByPath = new Map(
      [...task.request.fields, ...(task.response?.fields ?? [])].map((field) => [
        field.path,
        field.sample,
      ]),
    );
    const fieldLines = effectiveReview
      .slice(0, 80)
      .map(
        (field) =>
          `- ${field.path} (${field.type}, ${field.source})${
            sampleByPath.get(field.path) ? ` 示例: ${String(sampleByPath.get(field.path)).slice(0, 80)}` : ''
          }`,
      )
      .join('\n');
    return [
      `接口名称：${task.request.name}`,
      `请求：${task.request.method} ${task.request.url}`,
      `敏感级别：${task.request.dataLevel}`,
      task.request.headers.length > 0
        ? `请求头：${task.request.headers.map((header) => header.name).join(', ')}`
        : '',
      task.request.body ? `请求体示例：\n${task.request.body.slice(0, 1500)}` : '',
      task.response
        ? `响应状态：${task.response.status} ${task.response.statusText}\n响应示例：\n${task.response.body.slice(0, 1500)}`
        : '暂无响应示例',
      fieldLines ? `字段列表：\n${fieldLines}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  function runAiAction(
    action: 'task' | 'descriptions' | 'tests' | 'chat',
    chatText = '',
  ) {
    if (!route.allowed) {
      message.error(route.reason);
      return;
    }
    const baseUrl = readGatewayConfig().baseUrl.trim();
    if (baseUrl) {
      const access = checkNetworkAccess(baseUrl, networkMode);
      if (!access.allowed) {
        message.error(access.reason);
        return;
      }
    }
    if (route.egress) {
      setPendingAction(action);
      setPendingChat(chatText);
      setPreflightOpen(true);
      return;
    }
    executeAiAction(action, chatText);
  }

  function executeAiAction(
    action: 'task' | 'descriptions' | 'tests' | 'chat',
    chatText = '',
  ) {
    if (action === 'task') {
      void startTask();
      return;
    }
    if (action === 'descriptions') {
      void generateDescriptionsNow();
      return;
    }
    if (action === 'tests') {
      void generateTestsNow();
      return;
    }
    void sendChat(chatText);
  }

  function runTask() {
    if (!task) return;
    runAiAction('task');
  }

  function openGlossary() {
    setGlossaryDraft(glossaryEntries.map((entry) => ({ ...entry })));
    setGlossaryOpen(true);
  }

  function updateGlossaryRow(index: number, patch: Partial<GlossaryEntry>) {
    setGlossaryDraft((current) =>
      current.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  }

  function removeGlossaryRow(index: number) {
    setGlossaryDraft((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  function saveGlossaryDraft() {
    const cleaned = writeGlossary(glossaryDraft);
    setGlossaryEntries(cleaned);
    setGlossaryOpen(false);
    message.success(`术语表已更新 · ${cleaned.length} 条`);
  }

  function applyDraft() {
    if (!task) return;
    const next = mergeDraftFields(draft, effectiveReview, accepted);
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

  async function generateDescriptionsNow() {
    if (!task || effectiveReview.length === 0) {
      message.warning('当前没有可生成说明的字段');
      return;
    }
    setDescLoading(true);
    const sampleByPath = new Map(
      [...task.request.fields, ...(task.response?.fields ?? [])].map((field) => [
        field.path,
        field.sample,
      ]),
    );
    const lines = effectiveReview
      .map(
        (field) =>
          `- ${field.path} | ${field.type} | ${field.source}${
            sampleByPath.get(field.path)
              ? ` | 示例: ${String(sampleByPath.get(field.path)).slice(0, 100)}`
              : ''
          }`,
      )
      .join('\n');
    const prompt = [
      '你是 API 文档助手。请为下列字段各写一句简洁、准确的中文说明，说明字段的业务含义与取值规则。',
      '只输出一个 JSON 对象，键必须是完整字段路径，值为字段说明字符串，不要输出 Markdown 或其他内容。',
      '',
      '字段列表：',
      lines,
    ].join('\n');

    try {
      const reply = await chatWithGateway(
        readGatewayConfig(),
        [
          {
            role: 'system',
            content: '你是内网 API 文档助手，只输出合法 JSON，使用中文。',
          },
          { role: 'user', content: prompt },
        ],
        120_000,
      );
      const parsed = parseDescriptionJson(reply.content);
      if (!parsed) throw new Error('AI 返回内容不是可解析的 JSON 对象');
      const next: Record<string, string> = {};
      for (const field of effectiveReview) {
        const value = parsed[field.path];
        if (typeof value === 'string' && value.trim()) {
          next[field.key] = value.trim();
        }
      }
      const count = Object.keys(next).length;
      if (count === 0) throw new Error('AI 未返回任何字段说明');
      setNotes((current) => ({ ...current, ...next }));
      message.success(`已生成 ${count} 条字段说明，请审核后应用`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      message.error(`生成字段说明失败：${reason}`);
    } finally {
      setDescLoading(false);
    }
  }

  async function generateTestsNow() {
    if (!task) return;
    setTestsLoading(true);
    try {
      await sendChat(
        '请基于当前接口上下文生成测试用例，覆盖正常、边界和异常场景，用 Markdown 表格列出：用例名、请求方法与路径、关键入参、预期状态码、预期响应要点。',
      );
    } finally {
      setTestsLoading(false);
    }
  }

  async function sendChat(text: string) {
    if (!text.trim() || streaming) return;
    const config = readGatewayConfig();
    const history = messages.map((item) => ({
      role: item.placement === 'end' ? ('user' as const) : ('assistant' as const),
      content: item.text,
    }));
    const contextPrompt = buildContextPrompt();
    const assistantKey = `reply-${Date.now()}`;
    setMessages((current) => [
      ...current,
      { key: `user-${Date.now()}`, placement: 'end', text },
      { key: assistantKey, placement: 'start', text: '思考中…' },
    ]);
    setStreaming(true);

    const updateAssistant = (updater: (current: string) => string) =>
      setMessages((current) =>
        current.map((item) =>
          item.key === assistantKey ? { ...item, text: updater(item.text) } : item,
        ),
      );

    try {
      const result = await chatWithGatewayStream(
        config,
        [
          {
            role: 'system',
            content: [
              '你是内网 API 文档助手，回答简洁、专业，使用中文。',
              contextPrompt ? `当前接口上下文：\n${contextPrompt}` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
          ...history,
          { role: 'user', content: text },
        ],
        120_000,
        (delta) =>
          updateAssistant((current) =>
            current === '思考中…' ? delta : `${current}${delta}`,
          ),
      );
      if (!result.content.trim()) {
        updateAssistant((current) => (current === '思考中…' ? '（无输出）' : current));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateAssistant(() => `生成失败：${reason}`);
    } finally {
      setStreaming(false);
    }
  }

  function submit() {
    const text = composer.trim();
    if (!text || streaming) return;
    setComposer('');
    runAiAction('chat', text);
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

  async function copyDoc() {
    if (!docMarkdown) return;
    try {
      await navigator.clipboard.writeText(docMarkdown);
      message.success('已复制 Markdown');
    } catch {
      message.warning('当前环境无法访问剪贴板');
    }
  }

  function renderReviewRow(field: FieldReview) {
    return (
      <div className="review-row" key={field.key}>
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
          <Input.TextArea
            className="review-note-input"
            value={notes[field.key] ?? field.note}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setNotes((current) => ({ ...current, [field.key]: event.target.value }))
            }
            placeholder="补充字段说明（可留空）"
            aria-label={`${field.path} 字段说明`}
            autoSize={{ minRows: 1, maxRows: 3 }}
            variant="borderless"
          />
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
      </div>
    );
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
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'gateway', label: 'AI 网关设置', icon: <SettingOutlined /> },
              { key: 'glossary', label: '字段术语表', icon: <BookOutlined /> },
              { type: 'divider' },
              {
                key: 'clear',
                label: '清空对话',
                icon: <DeleteOutlined />,
                danger: true,
                disabled: messages.length === 0,
              },
            ],
            onClick: ({ key }) => {
              if (key === 'gateway') setGatewayOpen(true);
              if (key === 'glossary') openGlossary();
              if (key === 'clear') {
                setMessages([]);
                message.success('已清空对话');
              }
            },
          }}
        >
          <Button type="text" size="small" icon={<MoreOutlined />} aria-label="更多" />
        </Dropdown>
      </div>

      <div className="ai-context">
        <div className="ai-context-request">
          <MethodTag method={activeRequest.method} />
          <code title={context?.url ?? activeRequest.path}>
            {context?.url ?? activeRequest.path}
          </code>
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
          <div className={`ai-route${routeBlocked ? ' blocked' : ''}`}>
            <i className="ai-route-dot" />
            <code>{gatewayConfig.baseUrl || route.endpoint}</code>
            <span>
              {gatewayAccess?.scope === 'public'
                ? '公网地址'
                : route.egress
                  ? '出网'
                  : '不出网'}
            </span>
            {route.approval && <span>需审批</span>}
            {route.egress && <span>脱敏 {preflight?.masks.length ?? 0} 项</span>}
          </div>
          {routeReason && <div className="ai-route-warn">{routeReason}</div>}
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
            <Button
              variant="text"
              size="small"
              color="cyan"
              icon={<EyeOutlined />}
              onClick={() => setDocOpen(true)}
              disabled={!task}
            >
              查看文档
            </Button>
            <span>生成后自动打开文档预览</span>
          </div>
        </div>

        <Prompts
          className="ai-prompts"
          items={prompts.map((label) => ({ key: label, label }))}
          wrap
          onItemClick={({ data }) => {
            const label = String(data.label ?? '');
            if (label === '生成接口文档') {
              runTask();
              return;
            }
            if (label === '补全字段说明') {
              runAiAction('descriptions');
              return;
            }
            if (label === '生成测试用例') {
              runAiAction('tests');
              return;
            }
            setComposer(
              label === '解释错误'
                ? '请结合当前接口上下文，解释最近一次请求失败的可能原因和排查步骤。'
                : label,
            );
          }}
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
            <Tooltip title="维护字段术语表">
              <Button
                className="review-glossary-btn"
                variant="text"
                size="small"
                color="geekblue"
                icon={<BookOutlined />}
                onClick={openGlossary}
                aria-label="维护字段术语表"
              />
            </Tooltip>
            {applied && <Tag className="applied-tag">已应用</Tag>}
          </div>

          {requestReview.length > 0 && (
            <>
              <div className="review-group">
                <span>请求参数</span>
                <em>{requestReview.length}</em>
              </div>
              {requestReview.map(renderReviewRow)}
            </>
          )}

          {responseReview.length > 0 && (
            <>
              <div className="review-group">
                <span>响应字段</span>
                <em>{responseReview.length}</em>
              </div>
              {responseReview.map(renderReviewRow)}
            </>
          )}

          {review.length === 0 && (
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
            <Button
              size="small"
              color="geekblue"
              variant="filled"
              icon={<ThunderboltOutlined />}
              loading={descLoading}
              onClick={() => runAiAction('descriptions')}
              disabled={review.length === 0}
            >
              AI 生成说明
            </Button>
            <Button
              size="small"
              color="orange"
              variant="filled"
              icon={<ExperimentOutlined />}
              loading={testsLoading}
              onClick={() => runAiAction('tests')}
              disabled={!task}
            >
              生成测试用例
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
          footer={
            <span className="composer-hint">{streaming ? 'AI 生成中…' : '⌘↵ 发送'}</span>
          }
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
                disabled={!composer.trim() || streaming}
              >
                {streaming ? '生成中' : '发送'}
              </Button>
            </>
          }
        />
      </div>

      <Modal
        open={glossaryOpen}
        title="字段术语表"
        width={720}
        onCancel={() => setGlossaryOpen(false)}
        footer={[
          <Button
            key="reset"
            size="small"
            onClick={() => setGlossaryDraft(defaultGlossary.map((entry) => ({ ...entry })))}
          >
            恢复默认
          </Button>,
          <Button key="cancel" size="small" onClick={() => setGlossaryOpen(false)}>
            取消
          </Button>,
          <Button key="save" size="small" type="primary" onClick={saveGlossaryDraft}>
            保存术语表
          </Button>,
        ]}
      >
        <p className="glossary-tip">
          术语表用于预填字段说明并提升置信度；未命中的字段可以直接在字段审阅里填写说明。
        </p>
        <div className="glossary-head">
          <span>字段名</span>
          <span>中文名</span>
          <span>说明</span>
          <span />
        </div>
        <div className="glossary-list">
          {glossaryDraft.map((entry, index) => (
            <div className="glossary-row" key={index}>
              <Input
                size="small"
                value={entry.term}
                onChange={(event) => updateGlossaryRow(index, { term: event.target.value })}
                placeholder="orderId"
                aria-label={`术语名 ${index + 1}`}
              />
              <Input
                size="small"
                value={entry.label}
                onChange={(event) => updateGlossaryRow(index, { label: event.target.value })}
                placeholder="订单号"
                aria-label={`术语中文名 ${index + 1}`}
              />
              <Input
                size="small"
                value={entry.description}
                onChange={(event) =>
                  updateGlossaryRow(index, { description: event.target.value })
                }
                placeholder="业务含义与取值规则"
                aria-label={`术语说明 ${index + 1}`}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeGlossaryRow(index)}
                aria-label={`删除术语 ${index + 1}`}
              />
            </div>
          ))}
        </div>
        <Button
          type="dashed"
          block
          icon={<PlusOutlined />}
          onClick={() =>
            setGlossaryDraft((current) => [
              ...current,
              { term: '', label: '', description: '' },
            ])
          }
        >
          新增术语
        </Button>
      </Modal>

      <Modal
        open={docOpen}
        title={task ? `接口文档 · ${task.request.name}` : '接口文档'}
        width={780}
        onCancel={() => setDocOpen(false)}
        footer={[
          <Button key="copy" size="small" color="cyan" variant="filled" onClick={() => void copyDoc()}>
            复制 Markdown
          </Button>,
          <Button key="md" size="small" color="green" variant="filled" onClick={() => downloadDoc('markdown')}>
            下载 .md
          </Button>,
          <Button key="openapi" size="small" onClick={() => downloadDoc('openapi')}>
            下载 OpenAPI
          </Button>,
          <Button key="close" size="small" type="primary" onClick={() => setDocOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <div className="doc-meta">
          <MethodTag method={task?.request.method ?? 'GET'} />
          <code>{task?.request.url ?? '尚未选择接口'}</code>
          <span>
            {draft.length} 个已应用字段 · 识别请求空间 {task?.stats.requestFields ?? 0} / 响应{' '}
            {task?.stats.responseFields ?? 0}
          </span>
        </div>
        {draft.length === 0 && (
          <div className="doc-tip">
            当前为自动生成的文档骨架。在「字段审阅」中勾选并点击「应用到文档」后，字段说明会补进这份文档。
          </div>
        )}
        <pre className="doc-preview">{docMarkdown || '暂无文档内容'}</pre>
      </Modal>

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
              executeAiAction(pendingAction, pendingChat);
              setPendingChat('');
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
        networkMode={networkMode}
        onClose={() => {
          setGatewayOpen(false);
          setGatewayConfig(readGatewayConfig());
        }}
      />
    </aside>
  );
}
