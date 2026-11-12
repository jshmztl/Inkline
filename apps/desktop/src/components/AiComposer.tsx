import {
  FileAddOutlined,
  PaperClipOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { Sender } from '@ant-design/x';

interface AiComposerProps {
  composer: string;
  streaming: boolean;
  draftLoading: boolean;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onExtract: (text: string) => void;
}

// 底部输入区：发送消息或从粘贴的文档生成接口。
export function AiComposer({
  composer,
  streaming,
  draftLoading,
  onChange,
  onSubmit,
  onExtract,
}: AiComposerProps) {
  function submit() {
    const text = composer.trim();
    if (!text || streaming || draftLoading) return;
    onChange('');
    onSubmit(text);
  }

  function extract() {
    const text = composer.trim();
    if (!text) return;
    onChange('');
    onExtract(text);
  }

  return (
    <div className="composer">
      <Sender
        className="ai-sender"
        value={composer}
        onChange={(value) => onChange(value)}
        onSubmit={submit}
        placeholder="粘贴接口文档自动生成接口，或描述目标…"
        autoSize={{ minRows: 3, maxRows: 6 }}
        footer={
          <span className="composer-hint">{streaming ? 'AI 生成中…' : '⌘↵ 发送'}</span>
        }
        actions={
          <>
            <Tooltip title="把粘贴的接口文档解析为接口">
              <Button
                type="text"
                size="small"
                icon={<FileAddOutlined />}
                loading={draftLoading}
                disabled={!composer.trim() || streaming}
                onClick={extract}
                aria-label="从文档生成接口"
              />
            </Tooltip>
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
  );
}
