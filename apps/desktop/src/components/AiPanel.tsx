import { useEffect, useMemo, useState } from 'react';
import { LockOutlined, RobotOutlined } from '@ant-design/icons';
import { App } from 'antd';
import type { ApiRequest, NetworkMode } from '../data/types';
import { kvGet, kvSet } from '../lib/kv';
import { networkModes } from '../data/types';
import type { Collection } from '../lib/api';
import {
  looksLikeApiDoc,
  parseRequestDraft,
  type RequestDraft,
} from '../lib/requestDraft';
import {
  buildDocTask,
  buildDraftDiff,
  buildFieldReview,
  docToMarkdown,
  mergeDraftFields,
  type DraftField,
  type GlossaryEntry,
  type RequestContext,
} from '../lib/docTask';
import {
  buildDescriptionPrompt,
  extractSystemPrompt,
  parseDescriptionJson,
} from '../lib/aiPrompt';
import { AiGatewayModal } from './AiGatewayModal';
import { preflightEgress } from '../lib/egress';
import { recordAudit } from '../lib/audit';
import { resolveModelRoute } from '../lib/modelRoute';
import { checkNetworkAccessResolved, type NetworkAccess } from '../lib/networkPolicy';
import {
  chatWithGateway,
  readGatewayConfig,
} from '../lib/aiGateway';
import { readGlossary, writeGlossary } from '../lib/glossary';
import { copyMarkdown, downloadDocFile } from '../lib/docExport';
import { useAiChat, type ChatMessage } from '../lib/useAiChat';
import { AiPanelHead } from './AiPanelHead';
import { AiTaskPanel } from './AiTaskPanel';
import { AiPromptList } from './AiPromptList';
import { AiChatMessages } from './AiChatMessages';
import { AiReviewCard } from './AiReviewCard';
import { AiComposer } from './AiComposer';
import { AiGlossaryModal } from './AiGlossaryModal';
import { AiDocModal } from './AiDocModal';
import { AiDiffModal } from './AiDiffModal';
import { AiPreflightModal } from './AiPreflightModal';
import { AiCreateRequestModal } from './AiCreateRequestModal';

interface AiPanelProps {
  networkMode: NetworkMode;
  activeRequest: ApiRequest;
  context: RequestContext | null;
  syncNonce: number;
  actor: string;
  collections: Collection[];
  onCreateRequestFromDoc: (draft: RequestDraft, collectionId: string) => Promise<void>;
}

type AiAction = 'task' | 'descriptions' | 'tests' | 'chat' | 'extract';

export function AiPanel({
  networkMode,
  activeRequest,
  context,
  syncNonce,
  actor,
  collections,
  onCreateRequestFromDoc,
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
  const [pendingAction, setPendingAction] = useState<AiAction>('task');
  const [pendingChat, setPendingChat] = useState('');
  const [draftRequest, setDraftRequest] = useState<RequestDraft | null>(null);
  const [draftCollectionId, setDraftCollectionId] = useState('');
  const [draftLoading, setDraftLoading] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);

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
  const [gatewayAccess, setGatewayAccess] = useState<NetworkAccess | null>(null);
  useEffect(() => {
    const baseUrl = gatewayConfig.baseUrl.trim();
    if (!baseUrl) {
      setGatewayAccess(null);
      return;
    }
    let cancelled = false;
    void checkNetworkAccessResolved(baseUrl, networkMode).then((access) => {
      if (!cancelled) setGatewayAccess(access);
    });
    return () => {
      cancelled = true;
    };
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
  const diff = useMemo(
    () => (task ? buildDraftDiff(draft, effectiveReview, accepted) : []),
    [task, draft, effectiveReview, accepted],
  );
  const docMarkdown = useMemo(
    () => (task ? docToMarkdown(task, draft) : ''),
    [task, draft],
  );
  const { streaming, sendChat } = useAiChat({
    messages,
    task,
    review: effectiveReview,
    networkMode,
    setMessages,
  });

  useEffect(() => {
    setAccepted({});
    setApplied(false);
    setNotes({});
  }, [activeRequest.id]);

  useEffect(() => {
    function loadDraft() {
      if (!requestId) {
        setDraft([]);
        return;
      }
      try {
        const raw = kvGet(`aw-doc-draft:${requestId}`);
        const parsed = raw ? JSON.parse(raw) : [];
        setDraft(Array.isArray(parsed) ? (parsed as DraftField[]) : []);
      } catch {
        setDraft([]);
      }
    }

    loadDraft();

    if (!requestId) return;
    function handleDraftUpdated(event: Event) {
      if ((event as CustomEvent<string>).detail === requestId) loadDraft();
    }
    window.addEventListener('aw-doc-draft-updated', handleDraftUpdated);
    return () => window.removeEventListener('aw-doc-draft-updated', handleDraftUpdated);
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
        networkMode,
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

  async function runAiAction(action: AiAction, chatText = '') {
    if (!route.allowed) {
      message.error(route.reason);
      return;
    }
    const baseUrl = readGatewayConfig().baseUrl.trim();
    if (baseUrl) {
      const access = await checkNetworkAccessResolved(baseUrl, networkMode);
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

  function executeAiAction(action: AiAction, chatText = '') {
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
    if (action === 'extract') {
      void extractRequestNow(chatText);
      return;
    }
    void sendChat(chatText);
  }

  function runTask() {
    if (!task) return;
    void runAiAction('task');
  }

  function openGlossary() {
    setGlossaryDraft(glossaryEntries.map((entry) => ({ ...entry })));
    setGlossaryOpen(true);
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
      kvSet(`aw-doc-draft:${task.request.id}`, JSON.stringify(next));
    } catch {
      // localStorage 不可用时仅保留内存草稿。
    }
    window.dispatchEvent(
      new CustomEvent('aw-doc-draft-updated', { detail: task.request.id }),
    );
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
    const prompt = buildDescriptionPrompt(task, effectiveReview);

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
        networkMode,
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

  async function extractRequestNow(text: string) {
    const source = text.trim();
    if (!source) {
      message.warning('请先粘贴接口文档内容');
      return;
    }
    setDraftLoading(true);
    setMessages((current) => [
      ...current,
      {
        key: `doc-${Date.now()}`,
        placement: 'end',
        text: source.length > 1200 ? `${source.slice(0, 1200)}…` : source,
      },
    ]);

    try {
      const reply = await chatWithGateway(
        readGatewayConfig(),
        [
          { role: 'system', content: extractSystemPrompt },
          { role: 'user', content: `接口文档如下：\n\n${source.slice(0, 6000)}` },
        ],
        120_000,
        networkMode,
      );
      const parsed = parseRequestDraft(reply.content);
      if (!parsed) throw new Error('未识别到完整的请求方法、地址或 JSON 结构');
      setDraftRequest(parsed);
      setDraftCollectionId(activeRequest.collectionId ?? collections[0]?.id ?? '');
      setMessages((current) => [
        ...current,
        {
          key: `doc-ok-${Date.now()}`,
          placement: 'start',
          text: `已识别接口：${parsed.method} ${parsed.url}（${reply.model}）。请确认名称与集合后创建。`,
        },
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      message.error(`接口解析失败：${reason}`);
      setMessages((current) => [
        ...current,
        { key: `doc-fail-${Date.now()}`, placement: 'start', text: `接口解析失败：${reason}` },
      ]);
    } finally {
      setDraftLoading(false);
    }
  }

  async function confirmCreateDraft() {
    if (!draftRequest) return;
    setCreatingDraft(true);
    try {
      await onCreateRequestFromDoc(draftRequest, draftCollectionId);
      recordAudit({
        type: 'ai-task',
        action: `文档解析 · ${draftRequest.method} ${draftRequest.url}`,
        detail: `${draftRequest.name} · 由文档片段创建接口`,
        actor,
        level: 'L1',
      });
      message.success('接口已创建并打开');
      setDraftRequest(null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      message.error(`创建接口失败：${reason}`);
    } finally {
      setCreatingDraft(false);
    }
  }

  function downloadDoc(format: 'markdown' | 'openapi') {
    if (!task) return;
    downloadDocFile(task, draft, format);
    message.success(`已导出 ${format === 'markdown' ? 'Markdown' : 'OpenAPI'}`);
  }

  async function copyDoc() {
    if (!docMarkdown) return;
    const copied = await copyMarkdown(docMarkdown);
    if (copied) {
      message.success('已复制 Markdown');
    } else {
      message.warning('当前环境无法访问剪贴板');
    }
  }

  function approvePreflight() {
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
  }

  return (
    <aside className="ai-panel">
      <AiPanelHead
        modelLabel={gatewayConfig.model || network.modelName}
        tone={network.tone}
        messageCount={messages.length}
        activeRequest={activeRequest}
        context={context}
        onOpenGateway={() => setGatewayOpen(true)}
        onOpenGlossary={openGlossary}
        onClearMessages={() => {
          setMessages([]);
          message.success('已清空对话');
        }}
      />

      <div className="ai-scroll">
        {messages.length === 0 && (
          <div className="ai-welcome">
            <span className="ai-welcome-icon">
              <RobotOutlined />
            </span>
            <strong>把接口文档交给 AI</strong>
            <p>粘贴 Word 里的接口说明，点「生成接口」即可创建请求；也可基于当前请求生成字段说明与示例。</p>
          </div>
        )}

        <AiTaskPanel
          task={task}
          route={route}
          routeBlocked={routeBlocked}
          routeReason={routeReason}
          gatewayBaseUrl={gatewayConfig.baseUrl}
          gatewayScope={gatewayAccess?.scope ?? null}
          maskCount={preflight?.masks.length ?? 0}
          onRunTask={runTask}
          onOpenDoc={() => setDocOpen(true)}
        />

        <AiPromptList
          composer={composer}
          onCompose={setComposer}
          onGenerateFromDoc={(text) => void runAiAction('extract', text)}
          onGenerateDoc={runTask}
          onFillDescriptions={() => runAiAction('descriptions')}
          onGenerateTests={() => runAiAction('tests')}
        />

        <AiChatMessages messages={messages} />

        <AiReviewCard
          task={task}
          review={review}
          pending={pending}
          accepted={accepted}
          notes={notes}
          applied={applied}
          descLoading={descLoading}
          testsLoading={testsLoading}
          onAcceptedChange={(key, checked) =>
            setAccepted((current) => ({ ...current, [key]: checked }))
          }
          onNoteChange={(key, value) =>
            setNotes((current) => ({ ...current, [key]: value }))
          }
          onOpenGlossary={openGlossary}
          onApply={applyDraft}
          onGenerateDescriptions={() => runAiAction('descriptions')}
          onGenerateTests={() => runAiAction('tests')}
          onOpenDiff={() => setDiffOpen(true)}
          onExport={downloadDoc}
          onIgnore={() => message.info('已忽略本次建议')}
        />

        <div className="ai-footnote">
          <LockOutlined /> {network.modelNote} · 输出可追溯到请求与模型版本
        </div>
      </div>

      <AiComposer
        composer={composer}
        streaming={streaming}
        draftLoading={draftLoading}
        onChange={setComposer}
        // 粘贴的接口文档直接进入解析流程，普通消息仍走对话。
        onSubmit={(text) => void runAiAction(looksLikeApiDoc(text) ? 'extract' : 'chat', text)}
        onExtract={(text) => void runAiAction('extract', text)}
      />

      <AiGlossaryModal
        open={glossaryOpen}
        draft={glossaryDraft}
        onChange={setGlossaryDraft}
        onCancel={() => setGlossaryOpen(false)}
        onSave={saveGlossaryDraft}
      />

      <AiDocModal
        open={docOpen}
        task={task}
        draftCount={draft.length}
        docMarkdown={docMarkdown}
        onClose={() => setDocOpen(false)}
        onCopy={() => void copyDoc()}
        onDownload={downloadDoc}
      />

      <AiDiffModal
        open={diffOpen}
        diff={diff}
        onClose={() => setDiffOpen(false)}
        onApply={applyDraft}
      />

      <AiPreflightModal
        open={preflightOpen}
        dataLevel={activeRequest.dataLevel}
        endpoint={route.endpoint}
        masks={preflight?.masks ?? []}
        onCancel={() => setPreflightOpen(false)}
        onApprove={approvePreflight}
      />

      <AiCreateRequestModal
        draftRequest={draftRequest}
        collections={collections}
        collectionId={draftCollectionId}
        creating={creatingDraft}
        onClose={() => setDraftRequest(null)}
        onCollectionChange={setDraftCollectionId}
        onDraftChange={setDraftRequest}
        onCreate={() => void confirmCreateDraft()}
      />

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
