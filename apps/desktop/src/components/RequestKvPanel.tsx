import type { Dispatch, SetStateAction } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Checkbox, Tooltip } from 'antd';
import type { KvRow } from '../data/types';

interface RequestKvPanelProps {
  rows: KvRow[];
  onChange: Dispatch<SetStateAction<KvRow[]>>;
}

/** Params 与 Headers 共用的键值表格。 */
export function RequestKvPanel({ rows, onChange }: RequestKvPanelProps) {
  function updateRow(id: string, patch: Partial<KvRow>) {
    onChange((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    onChange((current) => [
      ...current,
      {
        id: `row-${Date.now().toString(36)}`,
        key: '',
        value: '',
        description: '',
        enabled: true,
      },
    ]);
  }

  function removeRow(id: string) {
    onChange((current) => current.filter((row) => row.id !== id));
  }

  return (
    <div className="kv-editor">
      <div className="kv-head">
        <span />
        <span>KEY</span>
        <span>VALUE</span>
        <span>说明</span>
        <span />
      </div>
      {rows.map((row) => (
        <div className={`kv-row${row.enabled ? '' : ' disabled'}`} key={row.id}>
          <Checkbox
            checked={row.enabled}
            onChange={(event) => updateRow(row.id, { enabled: event.target.checked })}
          />
          <input
            className="kv-input mono"
            value={row.key}
            onChange={(event) => updateRow(row.id, { key: event.target.value })}
            aria-label="参数名"
          />
          <input
            className="kv-input mono"
            value={row.value}
            onChange={(event) => updateRow(row.id, { value: event.target.value })}
            aria-label="参数值"
          />
          <input
            className="kv-input"
            value={row.description}
            onChange={(event) => updateRow(row.id, { description: event.target.value })}
            aria-label="参数说明"
          />
          <Tooltip title="删除">
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              aria-label="删除该行"
              onClick={() => removeRow(row.id)}
            />
          </Tooltip>
        </div>
      ))}
      <button type="button" className="kv-add" onClick={addRow}>
        <PlusOutlined /> 添加一行
      </button>
    </div>
  );
}
