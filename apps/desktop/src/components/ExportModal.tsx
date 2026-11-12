import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { CopyOutlined } from '@ant-design/icons';
import { App, Button, Input, Modal, Segmented } from 'antd';
import type { SavedRequest } from '../lib/api';
import type { DraftField } from '../lib/docTask';
import { exportCollection, type ExportFormat } from '../lib/importer';

export interface ExportState {
  name: string;
  requests: SavedRequest[];
  documents: Record<string, DraftField[]>;
  format: ExportFormat;
}

interface ExportModalProps {
  exportState: ExportState | null;
  onChange: Dispatch<SetStateAction<ExportState | null>>;
  onClose: () => void;
}

/** 导出弹窗：格式切换、复制与下载集合/文档。 */
export function ExportModal({ exportState, onChange, onClose }: ExportModalProps) {
  const { message } = App.useApp();

  const exportText = useMemo(
    () =>
      exportState
        ? exportCollection(
            exportState.name,
            exportState.requests,
            exportState.format,
            exportState.documents,
          )
        : '',
    [exportState],
  );

  async function copyExport() {
    if (!exportState) return;
    const text = exportCollection(
      exportState.name,
      exportState.requests,
      exportState.format,
      exportState.documents,
    );
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.error('复制失败，请手动选择文本');
    }
  }

  function downloadExport() {
    if (!exportState) return;
    const text = exportCollection(
      exportState.name,
      exportState.requests,
      exportState.format,
      exportState.documents,
    );
    const extension: Record<ExportFormat, string> = {
      json: 'json',
      markdown: 'md',
      html: 'html',
      curl: 'txt',
      fetch: 'txt',
    };
    const mime: Record<ExportFormat, string> = {
      json: 'application/json',
      markdown: 'text/markdown',
      html: 'text/html',
      curl: 'text/plain',
      fetch: 'text/plain',
    };
    const base = exportState.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'inkline-export';
    const blob = new Blob([text], { type: `${mime[exportState.format]};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${base}.${extension[exportState.format]}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    message.success('导出文件已生成');
  }

  return (
    <Modal
      open={exportState !== null}
      title={`导出集合 / 接口文档 · ${exportState?.name ?? ''}`}
      width={560}
      onCancel={onClose}
      footer={[
        <Button key="close" size="small" onClick={onClose}>
          关闭
        </Button>,
        <Button key="download" size="small" onClick={downloadExport}>
          下载文件
        </Button>,
        <Button
          key="copy"
          type="primary"
          size="small"
          icon={<CopyOutlined />}
          onClick={copyExport}
        >
          复制
        </Button>,
      ]}
    >
      <div className="import-body">
        <Segmented
          size="small"
          value={exportState?.format ?? 'markdown'}
          onChange={(value) =>
            onChange((current) =>
              current ? { ...current, format: value as ExportFormat } : current,
            )
          }
          options={[
            { label: 'Markdown', value: 'markdown' },
            { label: 'HTML', value: 'html' },
            { label: 'JSON', value: 'json' },
            { label: 'curl', value: 'curl' },
            { label: 'fetch', value: 'fetch' },
          ]}
        />
        <Input.TextArea
          value={exportText}
          readOnly
          autoSize={{ minRows: 10, maxRows: 16 }}
          spellCheck={false}
        />
      </div>
    </Modal>
  );
}
