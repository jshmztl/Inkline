import { useEffect, useState } from 'react';
import {
  CloudServerOutlined,
  CloudSyncOutlined,
  DatabaseOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { App, Button, Modal, Tag, Tooltip } from 'antd';
import { networkModes, type HttpMethod, type NetworkMode } from '../data/mock';
import { recordHistory } from '../lib/api';
import { recordAudit } from '../lib/audit';
import {
  listQueue,
  removeQueueTask,
  retryQueue,
  retryTask,
  type QueuedTask,
} from '../lib/queue';
import { MethodTag } from './MethodTag';

interface StatusBarProps {
  networkMode: NetworkMode;
  actor: string;
  queueNonce: number;
  onQueueChange: () => void;
}

export function StatusBar({
  networkMode,
  actor,
  queueNonce,
  onQueueChange,
}: StatusBarProps) {
  const network = networkModes[networkMode];
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<QueuedTask[]>(listQueue);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);

  useEffect(() => {
    setTasks(listQueue());
  }, [queueNonce]);

  function refresh() {
    setTasks(listQueue());
    onQueueChange();
  }

  async function handleRetry(task: QueuedTask) {
    setRetrying(task.id);
    try {
      const result = await retryTask(task);
      await recordHistory({
        method: task.method,
        url: task.url,
        status: result.status,
        durationMs: result.durationMs,
        sizeBytes: result.sizeBytes,
      }).catch(() => undefined);
      recordAudit({
        type: 'request',
        action: `重试 ${task.method} ${task.url}`,
        detail: `${result.status} ${result.statusText} · ${result.durationMs}ms`,
        actor,
        level: task.dataLevel,
      });
      message.success(`重试成功 · ${result.status} ${result.statusText}`);
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      message.error(`重试失败：${text}`);
    } finally {
      setRetrying(null);
      refresh();
    }
  }

  async function handleRetryAll() {
    setRetryingAll(true);
    try {
      const result = await retryQueue();
      if (result.success > 0) {
        recordAudit({
          type: 'request',
          action: '离线队列重试',
          detail: `成功 ${result.success} · 失败 ${result.failed} · 剩余 ${result.remaining}`,
          actor,
        });
        message.success(
          `重试完成 · 成功 ${result.success} · 失败 ${result.failed}`,
        );
      } else {
        message.error(`重试失败 · 剩余 ${result.remaining}`);
      }
    } finally {
      setRetryingAll(false);
      refresh();
    }
  }

  function handleRemove(task: QueuedTask) {
    removeQueueTask(task.id);
    refresh();
    message.success('已移出离线队列');
  }

  return (
    <footer className="statusbar">
      <div className={`status-mode tone-${network.tone}`}>
        <span className={`mode-dot tone-${network.tone}`} />
        <strong>{network.label}</strong>
        <span>{network.description}</span>
      </div>
      <Tag className="level-tag level-l2">L2 敏感</Tag>

      <div className="statusbar-spacer" />

      {tasks.length > 0 && (
        <>
          <Button
            type="text"
            size="small"
            className="status-queue"
            icon={<CloudServerOutlined />}
            onClick={() => setOpen(true)}
          >
            离线队列 {tasks.length}
          </Button>
          <span className="status-sep" />
        </>
      )}

      <span className="status-item">
        <CloudSyncOutlined /> 同步正常 · 2 分钟前
      </span>
      <span className="status-sep" />
      <span className="status-item">
        <DatabaseOutlined /> SQLite 本地
      </span>
      <span className="status-sep" />
      <span className="status-item mono">v0.1.0</span>

      <Modal
        open={open}
        title="离线队列"
        width={520}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="close" size="small" onClick={() => setOpen(false)}>
            关闭
          </Button>,
          <Button
            key="retry"
            type="primary"
            size="small"
            icon={<SyncOutlined />}
            loading={retryingAll}
            disabled={tasks.length === 0}
            onClick={handleRetryAll}
          >
            重试全部
          </Button>,
        ]}
      >
        {tasks.length === 0 ? (
          <div className="queue-empty">队列为空。请求失败时会自动加入这里，便于稍后重试。</div>
        ) : (
          <div className="queue-list">
            {tasks.map((task) => (
              <div className="queue-row" key={task.id}>
                <div className="queue-row-head">
                  <MethodTag method={task.method as HttpMethod} />
                  <code>{task.url}</code>
                  <Tooltip title="移出队列">
                    <Button
                      type="text"
                      size="small"
                      className="queue-remove"
                      onClick={() => handleRemove(task)}
                    >
                      移除
                    </Button>
                  </Tooltip>
                </div>
                <div className="queue-row-foot">
                  <span>{task.name}</span>
                  <span>{task.dataLevel}</span>
                  <span>尝试 {task.attempts} 次</span>
                  {task.lastError && <span className="queue-error">{task.lastError}</span>}
                  <Button
                    type="link"
                    size="small"
                    loading={retrying === task.id}
                    onClick={() => handleRetry(task)}
                  >
                    重试
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </footer>
  );
}
