import type { Dispatch, SetStateAction } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Checkbox, Select, Tooltip } from 'antd';
import {
  assertionOperators,
  type AssertionOperator,
  type AssertionRow,
} from '../lib/assertions';

interface RequestAssertionsPanelProps {
  rows: AssertionRow[];
  onChange: Dispatch<SetStateAction<AssertionRow[]>>;
}

/** 断言编辑器：路径、运算符与期望值。 */
export function RequestAssertionsPanel({ rows, onChange }: RequestAssertionsPanelProps) {
  function updateAssertionRow(id: string, patch: Partial<AssertionRow>) {
    onChange((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function addAssertionRow() {
    onChange((current) => [
      ...current,
      {
        id: `assert-${Date.now().toString(36)}`,
        path: '',
        operator: 'equals',
        expected: '',
        enabled: true,
      },
    ]);
  }

  return (
    <div className="kv-editor assertion-editor">
      <div className="kv-head assertion-head">
        <span />
        <span>PATH</span>
        <span>运算符</span>
        <span>期望值</span>
        <span />
      </div>
      {rows.map((row) => {
        const noValue = row.operator === 'exists' || row.operator === 'notExists';
        return (
          <div
            className={`kv-row assertion-row${row.enabled ? '' : ' disabled'}`}
            key={row.id}
          >
            <Checkbox
              checked={row.enabled}
              onChange={(event) =>
                updateAssertionRow(row.id, { enabled: event.target.checked })
              }
            />
            <input
              className="kv-input mono"
              value={row.path}
              placeholder="status / data.id / headers.content-type"
              onChange={(event) => updateAssertionRow(row.id, { path: event.target.value })}
              aria-label="断言路径"
            />
            <Select
              size="small"
              value={row.operator}
              options={assertionOperators}
              onChange={(value) =>
                updateAssertionRow(row.id, { operator: value as AssertionOperator })
              }
              className="assertion-op"
              popupMatchSelectWidth={false}
              aria-label="断言运算符"
            />
            <input
              className="kv-input mono"
              value={row.expected}
              placeholder={noValue ? '无需填写' : '期望值'}
              disabled={noValue}
              onChange={(event) =>
                updateAssertionRow(row.id, { expected: event.target.value })
              }
              aria-label="断言期望值"
            />
            <Tooltip title="删除">
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                aria-label="删除断言"
                onClick={() => onChange((current) => current.filter((item) => item.id !== row.id))}
              />
            </Tooltip>
          </div>
        );
      })}
      <button type="button" className="kv-add" onClick={addAssertionRow}>
        <PlusOutlined /> 添加断言
      </button>
      <p className="assertion-tip">
        路径支持 <code>status</code>、<code>headers.名称</code> 与响应 JSON 路径（如{' '}
        <code>data.items.0.id</code>），请求成功后自动校验。
      </p>
    </div>
  );
}
