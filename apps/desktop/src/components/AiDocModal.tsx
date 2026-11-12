import { Button, Modal } from 'antd';
import type { DocTask } from '../lib/docTask';
import { MethodTag } from './MethodTag';

interface AiDocModalProps {
  open: boolean;
  task: DocTask | null;
  draftCount: number;
  docMarkdown: string;
  onClose: () => void;
  onCopy: () => void;
  onDownload: (format: 'markdown' | 'openapi') => void;
}

// 接口文档预览弹窗。
export function AiDocModal({
  open,
  task,
  draftCount,
  docMarkdown,
  onClose,
  onCopy,
  onDownload,
}: AiDocModalProps) {
  return (
    <Modal
      open={open}
      title={task ? `接口文档 · ${task.request.name}` : '接口文档'}
      width={780}
      onCancel={onClose}
      footer={[
        <Button key="copy" size="small" color="cyan" variant="filled" onClick={onCopy}>
          复制 Markdown
        </Button>,
        <Button key="md" size="small" color="green" variant="filled" onClick={() => onDownload('markdown')}>
          下载 .md
        </Button>,
        <Button key="openapi" size="small" onClick={() => onDownload('openapi')}>
          下载 OpenAPI
        </Button>,
        <Button key="close" size="small" type="primary" onClick={onClose}>
          关闭
        </Button>,
      ]}
    >
      <div className="doc-meta">
        <MethodTag method={task?.request.method ?? 'GET'} />
        <code>{task?.request.url ?? '尚未选择接口'}</code>
        <span>
          {draftCount} 个已应用字段 · 识别请求空间 {task?.stats.requestFields ?? 0} / 响应{' '}
          {task?.stats.responseFields ?? 0}
        </span>
      </div>
      {draftCount === 0 && (
        <div className="doc-tip">
          当前为自动生成的文档骨架。在「字段审阅」中勾选并点击「应用到文档」后，字段说明会补进这份文档。
        </div>
      )}
      <pre className="doc-preview">{docMarkdown || '暂无文档内容'}</pre>
    </Modal>
  );
}
