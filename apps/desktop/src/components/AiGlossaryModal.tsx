import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Modal } from 'antd';
import type { GlossaryEntry } from '../lib/docTask';
import { defaultGlossary } from '../lib/glossary';

interface AiGlossaryModalProps {
  open: boolean;
  draft: GlossaryEntry[];
  onChange: (draft: GlossaryEntry[]) => void;
  onCancel: () => void;
  onSave: () => void;
}

// 字段术语表编辑弹窗。
export function AiGlossaryModal({
  open,
  draft,
  onChange,
  onCancel,
  onSave,
}: AiGlossaryModalProps) {
  function updateRow(index: number, patch: Partial<GlossaryEntry>) {
    onChange(
      draft.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  }

  function removeRow(index: number) {
    onChange(draft.filter((_, entryIndex) => entryIndex !== index));
  }

  return (
    <Modal
      open={open}
      title="字段术语表"
      width={720}
      onCancel={onCancel}
      footer={[
        <Button
          key="reset"
          size="small"
          onClick={() => onChange(defaultGlossary.map((entry) => ({ ...entry })))}
        >
          恢复默认
        </Button>,
        <Button key="cancel" size="small" onClick={onCancel}>
          取消
        </Button>,
        <Button key="save" size="small" type="primary" onClick={onSave}>
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
        {draft.map((entry, index) => (
          <div className="glossary-row" key={index}>
            <Input
              size="small"
              value={entry.term}
              onChange={(event) => updateRow(index, { term: event.target.value })}
              placeholder="orderId"
              aria-label={`术语名 ${index + 1}`}
            />
            <Input
              size="small"
              value={entry.label}
              onChange={(event) => updateRow(index, { label: event.target.value })}
              placeholder="订单号"
              aria-label={`术语中文名 ${index + 1}`}
            />
            <Input
              size="small"
              value={entry.description}
              onChange={(event) =>
                updateRow(index, { description: event.target.value })
              }
              placeholder="业务含义与取值规则"
              aria-label={`术语说明 ${index + 1}`}
            />
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeRow(index)}
              aria-label={`删除术语 ${index + 1}`}
            />
          </div>
        ))}
      </div>
      <Button
        type="dashed"
        block
        icon={<PlusOutlined />}
        onClick={() => onChange([...draft, { term: '', label: '', description: '' }])}
      >
        新增术语
      </Button>
    </Modal>
  );
}
