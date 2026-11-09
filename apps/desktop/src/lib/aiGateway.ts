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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultGatewayConfig };
    const parsed = JSON.parse(raw) as Partial<AiGatewayConfig>;
    return { ...defaultGatewayConfig, ...parsed };
  } catch {
    return { ...defaultGatewayConfig };
  }
}

export function writeGatewayConfig(config: AiGatewayConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
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
