import type { NetworkMode } from '../data/types';
import { kvGet, kvSet } from './kv';
import { AI_GATEWAY_SECRET_KEY } from './secretMigration';
import { secretGet, secretSet } from './secretStore';
import { backendNetworkOptions } from './network';

export type AiProvider = 'deepseek' | 'qwen-cloud' | 'qwen-ollama' | 'qwen-vllm' | 'custom';

export interface AiGatewayConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatResult {
  content: string;
  model: string;
}

export const aiProviders: {
  value: AiProvider;
  label: string;
  baseUrl: string;
  model: string;
  hint: string;
}[] = [
  {
    value: 'deepseek',
    label: 'DeepSeek 云端',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '需要 API Key，数据出网',
  },
  {
    value: 'qwen-cloud',
    label: 'Qwen 云端（DashScope）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '需要 DashScope API Key，数据出网',
  },
  {
    value: 'qwen-ollama',
    label: 'Qwen 本地（Ollama）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    hint: '本地推理，数据不出域，无需 Key',
  },
  {
    value: 'qwen-vllm',
    label: 'Qwen 本地（vLLM）',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'Qwen2.5-7B-Instruct',
    hint: '内网 vLLM OpenAI 兼容服务，无需 Key',
  },
  {
    value: 'custom',
    label: '自定义 OpenAI 兼容网关',
    baseUrl: '',
    model: '',
    hint: '填写内网网关地址与模型名',
  },
];

const STORAGE_KEY = 'aw-ai-gateway';

export const defaultGatewayConfig: AiGatewayConfig = {
  provider: 'qwen-ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:7b',
  apiKey: '',
};

export function readGatewayConfig(): AiGatewayConfig {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) {
      return { ...defaultGatewayConfig, apiKey: secretGet(AI_GATEWAY_SECRET_KEY) ?? '' };
    }
    const parsed = JSON.parse(raw) as Partial<AiGatewayConfig>;
    const apiKey = secretGet(AI_GATEWAY_SECRET_KEY) ?? parsed.apiKey ?? '';
    return { ...defaultGatewayConfig, ...parsed, apiKey };
  } catch {
    return { ...defaultGatewayConfig };
  }
}

export function writeGatewayConfig(config: AiGatewayConfig) {
  try {
    secretSet(AI_GATEWAY_SECRET_KEY, config.apiKey ?? '');
    kvSet(STORAGE_KEY, JSON.stringify({ ...config, apiKey: '' }));
  } catch {
    // 本地存储不可用时仅保留内存配置。
  }
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function chatWithGateway(
  config: AiGatewayConfig,
  messages: AiChatMessage[],
  timeoutMs = 60_000,
  networkMode: NetworkMode,
): Promise<AiChatResult> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('AI 网关地址为空');

  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AiChatResult>('ai_chat', {
      payload: {
        baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        timeoutMs,
        network: backendNetworkOptions(networkMode),
      },
    });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI 网关返回 ${response.status}：${text}`);
    }
    const parsed = JSON.parse(text) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };
    const content = parsed.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) throw new Error('AI 网关响应缺少 choices[0].message.content');
    return { content, model: parsed.model ?? config.model };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`AI 网关请求超时（>${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

interface StreamChunk {
  delta: string;
  done: boolean;
}

export async function chatWithGatewayStream(
  config: AiGatewayConfig,
  messages: AiChatMessage[],
  timeoutMs = 120_000,
  networkMode: NetworkMode,
  onDelta?: (delta: string) => void,
): Promise<AiChatResult> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('AI 网关地址为空');

  if (isTauri()) {
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const channel = new Channel<StreamChunk>();
    let streamed = '';
    channel.onmessage = (chunk) => {
      if (chunk.delta) {
        streamed += chunk.delta;
        onDelta?.(chunk.delta);
      }
    };
    const result = await invoke<AiChatResult>('ai_chat_stream', {
      payload: {
        baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        timeoutMs,
        network: backendNetworkOptions(networkMode),
      },
      onEvent: channel,
    });
    if (!result.content && streamed) result.content = streamed;
    return result;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI 网关返回 ${response.status}：${text}`);
    }
    if (!response.body) {
      const text = await response.text();
      const parsed = JSON.parse(text) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
      };
      const content = parsed.choices?.[0]?.message?.content?.trim() ?? '';
      if (!content) throw new Error('AI 网关响应缺少内容');
      onDelta?.(content);
      return { content, model: parsed.model ?? config.model };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = config.model;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf('\n');
        const data = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            model?: string;
            choices?: { delta?: { content?: string } }[];
          };
          if (parsed.model) model = parsed.model;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onDelta?.(delta);
          }
        } catch {
          // 忽略非 JSON 的 SSE 行。
        }
      }
    }

    if (!content.trim()) throw new Error('AI 网关流式响应为空');
    return { content, model };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`AI 网关请求超时（>${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
