import { Channel, invoke } from '@tauri-apps/api/core';
import type { HeaderPair } from './api';
import { readNetworkOptions } from './network';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type ProtocolKind = 'http' | 'graphql' | 'websocket' | 'sse';

export type StreamEventKind = 'open' | 'message' | 'error' | 'close' | 'info';

export interface StreamEvent {
  id: string;
  kind: StreamEventKind;
  at: number;
  payload: string;
}

export interface WebSocketHandle {
  send: (message: string) => void;
  close: () => void;
}

let sequence = 0;

export function nextEventId() {
  sequence += 1;
  return `evt-${Date.now().toString(36)}-${sequence}`;
}

export function openWebSocket(
  url: string,
  onEvent: (event: StreamEvent) => void,
): WebSocketHandle {
  const socket = new WebSocket(url);

  socket.onopen = () => {
    onEvent({ id: nextEventId(), kind: 'open', at: Date.now(), payload: '连接已建立' });
  };

  socket.onmessage = (event) => {
    onEvent({
      id: nextEventId(),
      kind: 'message',
      at: Date.now(),
      payload: typeof event.data === 'string' ? event.data : '[二进制消息]',
    });
  };

  socket.onerror = () => {
    onEvent({ id: nextEventId(), kind: 'error', at: Date.now(), payload: '连接出错' });
  };

  socket.onclose = (event) => {
    onEvent({
      id: nextEventId(),
      kind: 'close',
      at: Date.now(),
      payload: `连接已关闭 ${event.code}${event.reason ? ` · ${event.reason}` : ''}`,
    });
  };

  return {
    send: (message: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        onEvent({ id: nextEventId(), kind: 'info', at: Date.now(), payload: `已发送：${message}` });
      } else {
        onEvent({ id: nextEventId(), kind: 'error', at: Date.now(), payload: '连接未就绪' });
      }
    },
    close: () => socket.close(),
  };
}

export async function streamSse(
  url: string,
  headers: HeaderPair[],
  body: string | null,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (isTauri) {
    const id = `sse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const channel = new Channel<StreamEvent>();
    channel.onmessage = (event) => onEvent(event);

    const handleAbort = () => {
      void invoke('cancel_sse', { id }).catch(() => undefined);
    };
    signal.addEventListener('abort', handleAbort, { once: true });

    try {
      await invoke('start_sse_stream', {
        payload: {
          id,
          url,
          headers,
          body,
          network: readNetworkOptions(),
        },
        onEvent: channel,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new DOMException('SSE 已断开', 'AbortError');
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      signal.removeEventListener('abort', handleAbort);
    }

    if (signal.aborted) {
      throw new DOMException('SSE 已断开', 'AbortError');
    }
    return;
  }

  onEvent({ id: nextEventId(), kind: 'info', at: Date.now(), payload: `连接 ${url}` });
  const init: RequestInit = { method: body ? 'POST' : 'GET', headers: {}, signal };
  const headerMap: Record<string, string> = {};
  for (const header of headers) {
    if (header.name.trim()) headerMap[header.name.trim()] = header.value;
  }
  init.headers = headerMap;
  if (body) init.body = body;

  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`SSE 连接失败：${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error('当前环境不支持流式响应');
  }

  onEvent({ id: nextEventId(), kind: 'open', at: Date.now(), payload: '流已建立' });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        onEvent({ id: nextEventId(), kind: 'message', at: Date.now(), payload: data });
      }
    }
  }

  onEvent({ id: nextEventId(), kind: 'close', at: Date.now(), payload: '流已结束' });
}
