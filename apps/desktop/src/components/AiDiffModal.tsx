import { Button, Modal } from 'antd';
import type { DocDiffRow } from '../lib/docTask';

interface AiDiffModalProps {
  open: boolean;
  diff: DocDiffRow[];
  onClose: () => void;
  onApply: () => void;
}

// 文档草稿差异预览弹窗。
export function AiDiffModal({ open, diff, onClose, onApply }: AiDiffModalProps) {
  return (
    <Modal
      open={open}
      title="文档草稿 Diff"
      width={480}
      onCancel={onClose}
      footer={[
        <Button key="close" size="small" onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="apply"
          type="primary"
          size="small"
          onClick={onApply}
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
  );
}
