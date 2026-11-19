import { useEffect, useState } from 'react';
import { ApiOutlined, CheckCircleFilled, CloseCircleOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Select } from 'antd';
import type { NetworkMode } from '../data/types';
import { checkNetworkAccessResolved } from '../lib/networkPolicy';
import {
  aiProviders,
  chatWithGateway,
  clearGatewayConfig,
  defaultGatewayConfig,
  isLocalGatewayConfigured,
  readEffectiveGatewayConfig,
  writeGatewayConfig,
  type AiGatewayConfig,
  type AiProvider,
} from '../lib/aiGateway';
import { hasTeamGatewayConfig } from '../lib/teamAi';

interface AiGatewayModalProps {
  open: boolean;
  networkMode: NetworkMode;
  onClose: () => void;
}

export function AiGatewayModal({ open, networkMode, onClose }: AiGatewayModalProps) {
  const [config, setConfig] = useState<AiGatewayConfig>(defaultGatewayConfig);
  const [teamConfig, setTeamConfig] = useState<AiGatewayConfig | null>(null);
  const [teamAvailable, setTeamAvailable] = useState(false);
  const [localOverride, setLocalOverride] = useState(false);
  const [mode, setMode] = useState<'team' | 'local'>('local');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const effective = readEffectiveGatewayConfig();
    const team = hasTeamGatewayConfig();
    const local = isLocalGatewayConfigured();
    setTeamAvailable(team);
    setLocalOverride(local);
    setTeamConfig(team ? effective : null);
    setMode(effective.source === 'team' ? 'team' : 'local');
    setConfig(effective.source === 'team' ? { ...defaultGatewayConfig } : effective);
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

  function switchToLocal() {
    setMode('local');
    setConfig({ ...defaultGatewayConfig });
    setResult(null);
  }

  function followTeam() {
    clearGatewayConfig();
    onClose();
  }

  async function handleTest() {
    const access = await checkNetworkAccessResolved(config.baseUrl.trim(), networkMode);
    if (!access.allowed) {
      setResult({ ok: false, text: access.reason });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const reply = await chatWithGateway(
        config,
        [{ role: 'user', content: '请只回复 OK' }],
        20_000,
        networkMode,
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

  const footer =
    mode === 'team'
      ? [
          <Button key="local" size="small" onClick={switchToLocal}>
            配置个人 AI
          </Button>,
          <Button key="close" type="primary" size="small" onClick={onClose}>
            关闭
          </Button>,
        ]
      : [
          <Button
            key="test"
            size="small"
            icon={<ApiOutlined />}
            loading={testing}
            onClick={handleTest}
          >
            测试连接
          </Button>,
          teamAvailable && (
            <Button key="team" size="small" onClick={followTeam}>
              恢复跟随团队配置
            </Button>
          ),
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
        ];

  return (
    <Modal
      open={open}
      title="AI 网关设置"
      width={560}
      onCancel={onClose}
      footer={footer}
    >
      {mode === 'team' ? (
        <div className="gateway-form">
          <div className="gateway-team-banner">
            <strong>正在使用团队 AI 配置</strong>
            <p>
              由团队管理员在管理台维护，API Key 只保存在服务端，请求经团队服务代理转发，本机不可见。
            </p>
          </div>
          <label>
            <span>代理地址</span>
            <Input readOnly value={teamConfig?.baseUrl ?? ''} />
          </label>
          <label>
            <span>模型名</span>
            <Input readOnly value={teamConfig?.model ?? ''} />
          </label>
          <label>
            <span>API Key</span>
            <Input readOnly value="由服务端保管" />
          </label>
          <p className="gateway-tip">
            如需改用其他模型，可点击「配置个人 AI」保存本机配置，本机配置优先于团队配置。
          </p>
        </div>
      ) : (
        <div className="gateway-form">
          {teamAvailable && (
            <div className="gateway-team-banner">
              <strong>{localOverride ? '当前使用个人 AI 配置' : '配置个人 AI 配置'}</strong>
              <p>保存后将优先使用个人配置；点击「恢复跟随团队配置」可回到团队代理。</p>
            </div>
          )}
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
      )}
    </Modal>
  );
}
