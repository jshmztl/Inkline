import { useMemo } from 'react';
import { Modal, Tag } from 'antd';
import { diffLines } from '../lib/diff';

interface ResponseDiffModalProps {
  open: boolean;
  before: string;
  after: string;
  savedAt?: string;
  onClose: () => void;
}

export function ResponseDiffModal({
  open,
  before,
  after,
  savedAt,
  onClose,
}: ResponseDiffModalProps) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);

  return (
    <Modal
      open={open}
      title="响应对比"
      width={880}
      footer={null}
      onCancel={onClose}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Tag color="green">新增 {diff.added} 行</Tag>
        <Tag color="red">删除 {diff.removed} 行</Tag>
        {savedAt && <span style={{ opacity: 0.7 }}>基线保存于 {savedAt}</span>}
        {diff.truncated && (
          <Tag color="orange">内容过长，仅比较前 1200 行</Tag>
        )}
      </div>

      <div
        style={{
          maxHeight: 520,
          overflow: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
          border: '1px solid rgba(127,127,127,0.25)',
          borderRadius: 6,
        }}
      >
        {diff.lines.map((line, index) => (
          <div
            key={index}
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              padding: '1px 6px',
              background:
                line.type === 'add'
                  ? 'rgba(0,180,80,0.12)'
                  : line.type === 'remove'
                    ? 'rgba(220,50,50,0.12)'
                    : 'transparent',
            }}
          >
            <span style={{ display: 'inline-block', width: 16, opacity: 0.6 }}>
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
            </span>
            {line.text || ' '}
          </div>
        ))}
      </div>
    </Modal>
  );
}
