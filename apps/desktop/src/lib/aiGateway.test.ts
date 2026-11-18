import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultGatewayConfig,
  isGatewayConfigured,
  readGatewayConfig,
  writeGatewayConfig,
} from './aiGateway';
import { kvRemove } from './kv';
import { resetSecretStoreForTests } from './secretStore';

describe('aiGateway config', () => {
  beforeEach(() => {
    kvRemove('aw-ai-gateway');
    resetSecretStoreForTests();
  });

  it('默认未配置模型', () => {
    expect(defaultGatewayConfig.baseUrl).toBe('');
    expect(defaultGatewayConfig.model).toBe('');
    expect(isGatewayConfigured(defaultGatewayConfig)).toBe(false);
    expect(isGatewayConfigured(readGatewayConfig())).toBe(false);
  });

  it('地址和模型都填写后才视为已配置', () => {
    expect(
      isGatewayConfigured({
        ...defaultGatewayConfig,
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
      }),
    ).toBe(true);
    expect(
      isGatewayConfigured({
        ...defaultGatewayConfig,
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: '',
      }),
    ).toBe(false);
    expect(
      isGatewayConfigured({
        ...defaultGatewayConfig,
        baseUrl: ' ',
        model: 'qwen2.5:7b',
      }),
    ).toBe(false);
  });

  it('保存后可从本地读取已配置状态', () => {
    writeGatewayConfig({
      provider: 'qwen-ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      apiKey: '',
    });

    expect(isGatewayConfigured(readGatewayConfig())).toBe(true);
    expect(readGatewayConfig()).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
    });
  });
});
