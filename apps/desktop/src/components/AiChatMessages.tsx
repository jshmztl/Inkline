import { Bubble } from '@ant-design/x';
import type { ChatMessage } from '../lib/useAiChat';

interface AiChatMessagesProps {
  messages: ChatMessage[];
}

// 对话消息列表。
export function AiChatMessages({ messages }: AiChatMessagesProps) {
  return (
    <>
      {messages.map((item) => (
        <Bubble
          key={item.key}
          className={`ai-bubble ai-bubble-${item.placement}`}
          placement={item.placement}
          variant={item.placement === 'end' ? 'filled' : 'outlined'}
          content={item.text}
        />
      ))}
    </>
  );
}
