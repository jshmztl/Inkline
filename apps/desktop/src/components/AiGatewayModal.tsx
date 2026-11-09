import { useEffect, useState } from 'react';
import { ApiOutlined, CheckCircleFilled, CloseCircleOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Select } from 'antd';
import {
  aiProviders,
  chatWithGateway,
  readGatewayConfig,
  writeGatewayConfig,
  type AiGatewayConfig,
  type AiProvider,
} from '../lib/aiGateway';

interface AiGatewayModalProps {
  open: boolean;
  onClose: () => void;
}

export function AiGatewayModal({ open, onClose }: AiGatewayModalProps) {
  const [config, setConfig] = useState<AiGatewayConfig>(readGatewayConfig);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfig(readGatewayConfig());
    setResult(null);
  }, [open]);

  function selectProvider(provider: AiProvider) {
    const preset = aiProviders.find((item) => item.value === provider);
    setConfig((current) => ({
      ...current,
      provider,
      baseUrl: preset?.baseUrl ?? current.baseUrl,
      model: preset?.model ?? current.model,
    }));
    setResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const reply = await chatWithGateway(
        config,
        [{ role: 'user', content: '请只回复 OK' }],
        20_000,
      );
      setResult({
        ok: true,
        text: `连接成功 · ${reply.model} · ${reply.content.slice(0, 80)}`,
      });
    } catch (error) {
      setResult({
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }

  const activePreset = aiProviders.find((item) => item.value === config.provider);

  return (
    <Modal
      open={open}
      title="AI 网关设置"
      width={560}
      onCancel={onClose}
      footer={[
        <Button
          key="test"
          size="small"
          icon={<ApiOutlined />}
          loading={testing}
          onClick={handleTest}
        >
          测试连接
        </Button>,
        <Button key="cancel" size="small" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          size="small"
          onClick={() => {
            writeGatewayConfig(config);
            onClose();
          }}
        >
          保存
        </Button>,
      ]}
    >
      <div className="gateway-form">
        <label>
          <span>服务提供方</span>
          <Select
            value={config.provider}
            onChange={(value) => selectProvider(value as AiProvider)}
            options={aiProviders.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
          />
          {activePreset && <em className="gateway-hint">{activePreset.hint}</em>}
        </label>
        <label>
          <span>Base URL</span>
          <Input
            value={config.baseUrl}
            placeholder="http://127.0.0.1:11434/v1"
            onChange={(event) =>
              setConfig((current) => ({ ...current, baseUrl: event.target.value }))
            }
          />
        </label>
        <label>
          <span>模型名</span>
          <Input
            value={config.model}
            placeholder="qwen2.5:7b"
            onChange={(event) =>
              setConfig((current) => ({ ...current, model: event.target.value }))
            }
          />
        </label>
        <label>
          <span>API Key</span>
          <Input.Password
            value={config.apiKey}
            placeholder="本地 Ollama / vLLM 可留空"
            onChange={(event) =>
              setConfig((current) => ({ ...current, apiKey: event.target.value }))
            }
          />
        </label>
        {result && (
          <div className={`gateway-result ${result.ok ? 'ok' : 'bad'}`}>
            {result.ok ? <CheckCircleFilled /> : <CloseCircleOutlined />}
            <span>{result.text}</span>
          </div>
        )}
        <p className="gateway-tip">
          走 OpenAI 兼容协议（/chat/completions）。桌面端经 Rust 直连，可访问内网地址；云端
          Key 仅保存在本机。
        </p>
      </div>
    </Modal>
  );
}
