import {
  BookOutlined,
  DeleteOutlined,
  MoreOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Tag, Tooltip } from 'antd';
import type { ApiRequest } from '../data/types';
import type { RequestContext } from '../lib/docTask';
import { MethodTag } from './MethodTag';

interface AiPanelHeadProps {
  modelLabel: string;
  tone: string;
  messageCount: number;
  activeRequest: ApiRequest;
  context: RequestContext | null;
  onOpenGateway: () => void;
  onOpenGlossary: () => void;
  onClearMessages: () => void;
}

// AI 面板头部：标题、模型标签、设置入口与当前请求上下文。
export function AiPanelHead({
  modelLabel,
  tone,
  messageCount,
  activeRequest,
  context,
  onOpenGateway,
  onOpenGlossary,
  onClearMessages,
}: AiPanelHeadProps) {
  return (
    <>
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
        <Tag className={`model-tag tone-${tone}`}>{modelLabel}</Tag>
        <Tooltip title="AI 网关设置">
          <Button
            type="text"
            size="small"
            icon={<SettingOutlined />}
            aria-label="AI 网关设置"
            onClick={onOpenGateway}
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
                disabled: messageCount === 0,
              },
            ],
            onClick: ({ key }) => {
              if (key === 'gateway') onOpenGateway();
              if (key === 'glossary') onOpenGlossary();
              if (key === 'clear') onClearMessages();
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
    </>
  );
}
