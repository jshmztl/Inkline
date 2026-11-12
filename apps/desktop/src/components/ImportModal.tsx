import { useState } from 'react';
import { App, Input, Modal } from 'antd';
import { parsePostmanEnvironment } from '../lib/importer';

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  onImport: (raw: string) => Promise<{ name: string; count: number }>;
  onCreateEnvironment: (label: string, variables: Record<string, string>) => string;
  onEnvironmentChange: (environment: string) => void;
}

/** 导入弹窗：支持 curl、Postman 集合、OpenAPI 与 Postman 环境。 */
export function ImportModal({
  open,
  onClose,
  onImport,
  onCreateEnvironment,
  onEnvironmentChange,
}: ImportModalProps) {
  const { message } = App.useApp();
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);

  async function submitImport() {
    if (!importText.trim()) {
      message.warning('请粘贴或选择要导入的内容');
      return;
    }
    setImporting(true);
    try {
      const environment = parsePostmanEnvironment(importText);
      if (environment) {
        const value = onCreateEnvironment(environment.name, environment.variables);
        onEnvironmentChange(value);
        message.success(
          `已导入环境「${environment.name}」· ${Object.keys(environment.variables).length} 个变量`,
        );
        onClose();
        setImportText('');
        return;
      }

      const result = await onImport(importText);
      message.success(`已导入「${result.name}」· ${result.count} 个请求`);
      onClose();
      setImportText('');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导入失败，请检查内容格式');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="导入请求"
      width={560}
      okText="导入"
      cancelText="取消"
      confirmLoading={importing}
      onCancel={onClose}
      onOk={submitImport}
    >
      <div className="import-body">
        <p className="import-hint">
          支持 curl 命令、Postman 集合 JSON（v2.1）、OpenAPI / Swagger JSON。
          导入后会自动创建一个新集合。
        </p>
        <Input.TextArea
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          placeholder={`curl -X POST 'https://api.example.com/v1/orders' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"amount": 12800}'`}
          autoSize={{ minRows: 8, maxRows: 14 }}
          spellCheck={false}
        />
        <label className="import-file">
          <input
            type="file"
            accept=".json,.txt,.yaml,.yml"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setImportText(await file.text());
              event.target.value = '';
            }}
          />
          <span>从文件读取</span>
        </label>
      </div>
    </Modal>
  );
}
