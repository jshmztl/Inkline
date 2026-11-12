import type { Dispatch, SetStateAction } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { App, Button, Input, Modal } from 'antd';

export interface EnvironmentEditorRow {
  id: string;
  key: string;
  value: string;
}

export interface EnvironmentEditorState {
  isNew: boolean;
  value: string;
  label: string;
  rows: EnvironmentEditorRow[];
}

interface EnvironmentEditorModalProps {
  editor: EnvironmentEditorState | null;
  onChange: Dispatch<SetStateAction<EnvironmentEditorState | null>>;
  onClose: () => void;
  onCreateEnvironment: (label: string, variables: Record<string, string>) => string;
  onSaveEnvironment: (
    environment: string,
    variables: Record<string, string>,
    label?: string,
  ) => void;
}

/** 环境变量编辑弹窗：名称与 KEY/VALUE 行维护。 */
export function EnvironmentEditorModal({
  editor,
  onChange,
  onClose,
  onCreateEnvironment,
  onSaveEnvironment,
}: EnvironmentEditorModalProps) {
  const { message } = App.useApp();

  function updateEnvRow(id: string, patch: Partial<{ key: string; value: string }>) {
    onChange((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
          }
        : current,
    );
  }

  function submitEnvEditor() {
    if (!editor) return;
    const label = editor.label.trim();
    if (!label) {
      message.warning('环境名称不能为空');
      return;
    }
    const variables: Record<string, string> = {};
    for (const row of editor.rows) {
      const key = row.key.trim();
      if (!key) continue;
      variables[key] = row.value;
    }
    if (editor.isNew) {
      onCreateEnvironment(label, variables);
      message.success(`已创建「${label}」`);
    } else {
      onSaveEnvironment(editor.value, variables, label);
      message.success(`已保存「${label}」`);
    }
    onClose();
  }

  return (
    <Modal
      open={editor !== null}
      title={editor?.isNew ? '新增环境' : `环境设置 · ${editor?.label ?? ''}`}
      width={520}
      okText="保存"
      cancelText="取消"
      onCancel={onClose}
      onOk={submitEnvEditor}
    >
      <div className="env-editor">
        <div className="env-editor-name">
          <span>名称</span>
          <Input
            size="small"
            value={editor?.label ?? ''}
            placeholder="开发环境"
            aria-label="环境名称"
            onChange={(event) =>
              onChange((current) =>
                current ? { ...current, label: event.target.value } : current,
              )
            }
          />
        </div>
        <p className="env-editor-hint">
          在 URL、Headers、Body 中使用 <code>{'{{变量名}}'}</code> 引用，例如{' '}
          <code>{'{{host}}/v1/orders'}</code>。
        </p>
        <div className="env-editor-head">
          <span>KEY</span>
          <span>VALUE</span>
          <span />
        </div>
        {editor?.rows.map((row) => (
          <div className="env-editor-row" key={row.id}>
            <Input
              size="small"
              value={row.key}
              placeholder="host"
              aria-label="变量名"
              onChange={(event) => updateEnvRow(row.id, { key: event.target.value })}
            />
            <Input
              size="small"
              value={row.value}
              placeholder="http://127.0.0.1:8080"
              aria-label="变量值"
              onChange={(event) => updateEnvRow(row.id, { value: event.target.value })}
            />
            <Button
              type="text"
              size="small"
              danger
              onClick={() =>
                onChange((current) =>
                  current
                    ? {
                        ...current,
                        rows: current.rows.filter((item) => item.id !== row.id),
                      }
                    : current,
                )
              }
            >
              移除
            </Button>
          </div>
        ))}
        <Button
          type="dashed"
          size="small"
          block
          icon={<PlusOutlined />}
          onClick={() =>
            onChange((current) =>
              current
                ? {
                    ...current,
                    rows: [
                      ...current.rows,
                      { id: `env-${Date.now().toString(36)}`, key: '', value: '' },
                    ],
                  }
                : current,
            )
          }
        >
          新增变量
        </Button>
      </div>
    </Modal>
  );
}
