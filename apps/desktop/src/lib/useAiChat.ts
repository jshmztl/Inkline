import { useState, type Dispatch, type SetStateAction } from 'react';
import type { NetworkMode } from '../data/types';
import {
  chatWithGatewayStream,
  readEffectiveGatewayConfig,
  type AiChatResult,
} from './aiGateway';
import { buildContextPrompt } from './aiPrompt';
import type { DocTask, FieldReview } from './docTask';
import { refreshTeamGatewayToken } from './teamAi';

export interface ChatMessage {
  key: string;
  placement: 'start' | 'end';
  text: string;
}

interface UseAiChatOptions {
  messages: ChatMessage[];
  task: DocTask | null;
  review: FieldReview[];
  networkMode: NetworkMode;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

// 管理对话流式输出状态与发送逻辑。
export function useAiChat({
  messages,
  task,
  review,
  networkMode,
  setMessages,
}: UseAiChatOptions) {
  const [streaming, setStreaming] = useState(false);

  async function sendChat(text: string) {
    if (!text.trim() || streaming) return;
    const history = messages.map((item) => ({
      role: item.placement === 'end' ? ('user' as const) : ('assistant' as const),
      content: item.text,
    }));
    const contextPrompt = task ? buildContextPrompt(task, review) : '';
    const assistantKey = `reply-${Date.now()}`;
    setMessages((current) => [
      ...current,
      { key: `user-${Date.now()}`, placement: 'end', text },
      { key: assistantKey, placement: 'start', text: '思考中…' },
    ]);
    setStreaming(true);

    const updateAssistant = (updater: (current: string) => string) =>
      setMessages((current) =>
        current.map((item) =>
          item.key === assistantKey ? { ...item, text: updater(item.text) } : item,
        ),
      );

    try {
      const payload = [
        {
          role: 'system' as const,
          content: [
            '你是内网 API 文档助手，回答简洁、专业，使用中文。',
            contextPrompt ? `当前接口上下文：\n${contextPrompt}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        ...history,
        { role: 'user' as const, content: text },
      ];
      const onDelta = (delta: string) =>
        updateAssistant((current) => (current === '思考中…' ? delta : `${current}${delta}`));
      let config = readEffectiveGatewayConfig();
      let result: AiChatResult;
      try {
        result = await chatWithGatewayStream(config, payload, 120_000, networkMode, onDelta);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (
          config.source !== 'team' ||
          !reason.includes('401') ||
          !(await refreshTeamGatewayToken())
        ) {
          throw error;
        }
        updateAssistant(() => '思考中…');
        config = readEffectiveGatewayConfig();
        result = await chatWithGatewayStream(config, payload, 120_000, networkMode, onDelta);
      }
      if (!result.content.trim()) {
        updateAssistant((current) => (current === '思考中…' ? '（无输出）' : current));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateAssistant(() => `生成失败：${reason}`);
    } finally {
      setStreaming(false);
    }
  }

  return { streaming, sendChat };
}
