import { useState } from 'react';
import {
  CheckCircleFilled,
  LoadingOutlined,
  LockOutlined,
  MoreOutlined,
  PaperClipOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Tag, Tooltip } from 'antd';
import type { ApiRequest, NetworkMode } from '../data/mock';
import { networkModes, reviewFields, thoughtSteps } from '../data/mock';
import { MethodTag } from './MethodTag';

interface AiPanelProps {
  networkMode: NetworkMode;
  activeRequest: ApiRequest;
}

const prompts = ['生成接口文档', '补全字段说明', '生成测试用例', '解释错误'];

export function AiPanel({ networkMode, activeRequest }: AiPanelProps) {
  const { message } = App.useApp();
  const network = networkModes[networkMode];
  const [composer, setComposer] = useState('');
  const [accepted, setAccepted] = useState<Record<string, boolean>>(
    Object.fromEntries(reviewFields.map((field) => [field.name, true])),
  );
  const [applied, setApplied] = useState(false);

  function applyDraft() {
    setApplied(true);
    message.success('已应用到文档草稿');
  }

  function submit() {
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
        <div className="ai-prompts">
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="prompt-chip"
              onClick={() => setComposer(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="bubble user">
          根据这个请求生成支付订单接口文档，字段说明要包含幂等性和金额单位。
        </div>

        <div className="bubble ai">
          已读取请求与 3 条响应示例。发现 2 个字段缺少说明，1 个字段命名不一致；下面是我整理的字段审阅结果。
        </div>

        <div className="thought-chain">
          {thoughtSteps.map((step, index) => (
            <div className={`thought-step ${step.state}`} key={step.label}>
              <span className="thought-icon">
                {step.state === 'done' ? <CheckCircleFilled /> : <LoadingOutlined spin />}
              </span>
              <div>
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </div>
              {index < thoughtSteps.length - 1 && <i className="thought-line" />}
            </div>
          ))}
        </div>

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
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          placeholder="描述目标，或粘贴接口规范…"
          rows={3}
        />
        <div className="composer-actions">
          <Tooltip title="添加附件">
            <Button type="text" size="small" icon={<PaperClipOutlined />} />
          </Tooltip>
          <span className="composer-hint">⌘↵ 发送</span>
          <Button
            type="primary"
            size="small"
            icon={<SendOutlined />}
            onClick={submit}
            disabled={!composer.trim()}
          >
            发送
          </Button>
        </div>
      </div>
    </aside>
  );
}
