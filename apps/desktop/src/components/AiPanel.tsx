import { useMemo, useState } from 'react';
import {
  CheckCircleFilled,
  FileTextOutlined,
  LoadingOutlined,
  LockOutlined,
  MoreOutlined,
  PaperClipOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Tag, Tooltip } from 'antd';
import { Bubble, Prompts, Sender, ThoughtChain } from '@ant-design/x';
import type { ApiRequest, NetworkMode } from '../data/mock';
import { networkModes, reviewFields, thoughtSteps } from '../data/mock';
import { buildDocTask, type RequestContext } from '../lib/docTask';
import { MethodTag } from './MethodTag';

interface AiPanelProps {
  networkMode: NetworkMode;
  activeRequest: ApiRequest;
  context: RequestContext | null;
}

interface ChatMessage {
  key: string;
  placement: 'start' | 'end';
  text: string;
}

const prompts = ['生成接口文档', '补全字段说明', '生成测试用例', '解释错误'];

const seedMessages = [
  {
    key: 'seed-user',
    placement: 'end' as const,
    text: '根据这个请求生成支付订单接口文档，字段说明要包含幂等性和金额单位。',
  },
  {
    key: 'seed-ai',
    placement: 'start' as const,
    text: '已读取请求与 3 条响应示例。发现 2 个字段缺少说明，1 个字段命名不一致；下面是我整理的字段审阅结果。',
  },
];

const thoughtItems = thoughtSteps.map((step, index) => ({
  key: `step-${index}`,
  title: step.label,
  description: step.detail,
  status: step.state === 'done' ? ('success' as const) : ('pending' as const),
  icon: step.state === 'done' ? <CheckCircleFilled /> : <LoadingOutlined spin />,
}));

export function AiPanel({ networkMode, activeRequest, context }: AiPanelProps) {
  const { message } = App.useApp();
  const network = networkModes[networkMode];
  const [composer, setComposer] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(seedMessages);
  const [accepted, setAccepted] = useState<Record<string, boolean>>(
    Object.fromEntries(reviewFields.map((field) => [field.name, true])),
  );
  const [applied, setApplied] = useState(false);

  const task = useMemo(() => (context ? buildDocTask(context) : null), [context]);

  function runTask() {
    if (!task) return;
    setMessages((current) => [
      ...current,
      {
        key: `${task.id}-${current.length}`,
        placement: 'start',
        text: `已建立文档任务：请求 ${task.stats.requestFields} 个字段，响应示例 ${task.stats.responseFields} 个字段，命中术语 ${task.stats.glossaryHits} 条。可进入字段审阅。`,
      },
    ]);
    message.success('文档任务已建立');
  }

  function applyDraft() {
    setApplied(true);
    message.success('已应用到文档草稿');
  }

  function submit() {
    if (!composer.trim()) return;
    message.success('已发送到本地模型（演示）');
    setComposer('');
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
        <Tag className={`model-tag tone-${network.tone}`}>{network.modelName}</Tag>
        <Tooltip title="更多">
          <Button type="text" size="small" icon={<MoreOutlined />} />
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

        <ThoughtChain className="ai-thought" items={thoughtItems} size="small" />

        <div className="review-card">
          <div className="review-head">
            <strong>字段审阅</strong>
            <span>3 项待确认</span>
            {applied && <Tag className="applied-tag">已应用</Tag>}
          </div>

          {reviewFields.map((field) => (
            <label className="review-row" key={field.name}>
              <Checkbox
                checked={accepted[field.name]}
                onChange={(event) =>
                  setAccepted((current) => ({
                    ...current,
                    [field.name]: event.target.checked,
                  }))
                }
              />
              <div className="review-field">
                <div>
                  <code>{field.name}</code>
                  <em>{field.type}</em>
                </div>
                <span>{field.note}</span>
              </div>
              <div className="confidence">
                <div className="confidence-bar">
                  <i style={{ width: `${field.confidence}%` }} />
                </div>
                <span>{field.confidence}%</span>
              </div>
            </label>
          ))}

          <div className="review-actions">
            <Button type="primary" size="small" onClick={applyDraft} disabled={applied}>
              {applied ? '已应用' : '应用到文档'}
            </Button>
            <Button size="small" onClick={() => message.info('Diff 视图将在下一步接入')}>
              查看 diff
            </Button>
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
                <Button type="text" size="small" icon={<PaperClipOutlined />} />
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
    </aside>
  );
}
