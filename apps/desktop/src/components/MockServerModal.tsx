import { useEffect, useState } from 'react';
import { PlayCircleOutlined, StopOutlined } from '@ant-design/icons';
import { App, Button, Checkbox, Input, InputNumber, Modal, Tag } from 'antd';
import type { HttpMethod } from '../data/types';
import type { SavedRequest as SavedRequestApi } from '../lib/api';
import { kvGet, kvSet } from '../lib/kv';
import {
  listRequests,
  startMockServer,
  stopMockServer,
  type MockRoutePayload,
} from '../lib/api';
import { MethodTag } from './MethodTag';

interface MockServerModalProps {
  open: boolean;
  onClose: () => void;
}

interface MockConfig {
  enabled: boolean;
  status: number;
  body: string;
  contentType: string;
  delayMs: number;
}

const STORAGE_KEY = 'aw-mock-config';

const defaultBody = `{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "mock_1001",
    "status": "paid"
  }
}`;

const defaultConfig: MockConfig = {
  enabled: true,
  status: 200,
  body: defaultBody,
  contentType: 'application/json; charset=utf-8',
  delayMs: 0,
};

function readConfigs(): Record<string, MockConfig> {
  try {
    const raw = kvGet(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, MockConfig>) : {};
  } catch {
    return {};
  }
}

function writeConfigs(configs: Record<string, MockConfig>) {
  try {
    kvSet(STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // 本地存储不可用时仅保留内存配置。
  }
}

function routePath(url: string) {
  const raw = typeof url === 'string' ? url : '';
  let path = raw.replace(/^[a-z]+:\/\/[^/]+/i, '');
  path = path.replace(/^\{\{[^}]+\}\}/, '');
  path = path.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  return path || '/';
}

export function MockServerModal({ open, onClose }: MockServerModalProps) {
  const { message } = App.useApp();
  const [requests, setRequests] = useState<SavedRequestApi[]>([]);
  const [configs, setConfigs] = useState<Record<string, MockConfig>>(readConfigs);
  const [selected, setSelected] = useState<string | null>(null);
  const [port, setPort] = useState(8787);
  const [lanAccess, setLanAccess] = useState(() => kvGet('aw-mock-lan') === '1');
  const [runningPort, setRunningPort] = useState<number | null>(null);
  const [runningHost, setRunningHost] = useState('127.0.0.1');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad' | ''; text: string }>({
    tone: '',
    text: '',
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listRequests().then((list) => {
      if (cancelled) return;
      setRequests(list);
      setSelected((current) => current ?? list[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function updateConfig(id: string, patch: Partial<MockConfig>) {
    setConfigs((current) => {
      const next = {
        ...current,
        [id]: { ...defaultConfig, ...current[id], ...patch },
      };
      writeConfigs(next);
      return next;
    });
  }

  function configFor(id: string): MockConfig {
    return { ...defaultConfig, ...configs[id] };
  }

  async function handleStart() {
    setBusy(true);
    setStatus({ tone: '', text: '' });
    try {
      const routes: MockRoutePayload[] = requests
        .filter((request) => configFor(request.id).enabled)
        .map((request) => {
          const config = configFor(request.id);
          return {
            method: request.method,
            path: routePath(request.url),
            status: config.status,
            body: config.body,
            contentType: config.contentType,
            delayMs: config.delayMs,
          };
        });

      if (routes.length === 0) {
        setStatus({ tone: 'bad', text: '请先勾选至少一个要 Mock 的请求' });
        return;
      }

      const actual = await startMockServer(
        port,
        routes,
        lanAccess ? '0.0.0.0' : '127.0.0.1',
      );
      setRunningPort(actual);
      setRunningHost(lanAccess ? '0.0.0.0' : '127.0.0.1');
      setStatus({
        tone: 'ok',
        text: lanAccess
          ? `运行中 · http://0.0.0.0:${actual} · 局域网设备可用本机 IP:${actual} 访问`
          : `运行中 · http://127.0.0.1:${actual} · ${routes.length} 条路由`,
      });
      message.success(`Mock Server 已启动 · ${routes.length} 条路由`);
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      setStatus({ tone: 'bad', text: `启动失败：${text}` });
      message.error(text);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      await stopMockServer();
      setRunningPort(null);
      setStatus({ tone: '', text: '已停止' });
      message.success('Mock Server 已停止');
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      setStatus({ tone: 'bad', text: `停止失败：${text}` });
      message.error(text);
    } finally {
      setBusy(false);
    }
  }

  const active = requests.find((request) => request.id === selected) ?? null;
  const activeConfig = active ? configFor(active.id) : null;

  return (
    <Modal
      open={open}
      title="Mock Server"
      width={860}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="mock-toolbar">
        <span className="mock-label">端口</span>
        <InputNumber
          min={1024}
          max={65535}
          value={port}
          onChange={(value) => setPort(value ?? 8787)}
          style={{ width: 96 }}
        />
        <Checkbox
          checked={lanAccess}
          onChange={(event) => {
            const next = event.target.checked;
            setLanAccess(next);
            kvSet('aw-mock-lan', next ? '1' : '0');
          }}
        >
          允许局域网访问
        </Checkbox>
        {runningPort ? (
          <Button
            danger
            icon={<StopOutlined />}
            loading={busy}
            onClick={handleStop}
          >
            停止
          </Button>
        ) : (
          <Button
            color="green"
            variant="solid"
            icon={<PlayCircleOutlined />}
            loading={busy}
            onClick={handleStart}
          >
            启动
          </Button>
        )}
        {runningPort ? (
          <Tag color="green" className="mono">
            运行中 · http://{runningHost}:{runningPort}
          </Tag>
        ) : (
          <span className="mock-hint">根据已保存请求生成路由，未匹配路径返回 404。</span>
        )}
        {status.text && (
          <span className={`mock-status ${status.tone}`}>{status.text}</span>
        )}
      </div>

      <div className="mock-body">
        <div className="mock-list">
          {requests.length === 0 && (
            <div className="mock-empty">暂无已保存请求，请先在侧边栏保存请求。</div>
          )}
          {requests.map((request) => {
            const config = configFor(request.id);
            return (
              <div
                key={request.id}
                className={`mock-item${selected === request.id ? ' active' : ''}`}
                onClick={() => setSelected(request.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setSelected(request.id);
                }}
              >
                <Checkbox
                  checked={config.enabled}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    updateConfig(request.id, { enabled: event.target.checked })
                  }
                />
                <MethodTag method={request.method as HttpMethod} />
                <span className="mock-path mono">{routePath(request.url)}</span>
                <span className="mock-name">{request.name}</span>
              </div>
            );
          })}
        </div>

        <div className="mock-editor">
          {active && activeConfig ? (
            <>
              <div className="mock-editor-head">
                <strong>{active.name}</strong>
                <span className="mono">
                  {active.method} {routePath(active.url)}
                </span>
              </div>
              <div className="mock-fields">
                <label>
                  <span>状态码</span>
                  <InputNumber
                    min={100}
                    max={599}
                    value={activeConfig.status}
                    onChange={(value) =>
                      updateConfig(active.id, { status: value ?? 200 })
                    }
                  />
                </label>
                <label>
                  <span>延迟 (ms)</span>
                  <InputNumber
                    min={0}
                    max={10000}
                    step={100}
                    value={activeConfig.delayMs}
                    onChange={(value) =>
                      updateConfig(active.id, { delayMs: value ?? 0 })
                    }
                  />
                </label>
                <label className="mock-field-wide">
                  <span>Content-Type</span>
                  <Input
                    value={activeConfig.contentType}
                    onChange={(event) =>
                      updateConfig(active.id, {
                        contentType: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <textarea
                className="code-block mock-body-input"
                value={activeConfig.body}
                onChange={(event) =>
                  updateConfig(active.id, { body: event.target.value })
                }
                spellCheck={false}
                aria-label="Mock 响应体"
              />
            </>
          ) : (
            <div className="mock-empty">选择左侧请求以编辑 Mock 响应。</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
