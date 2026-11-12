import { useMemo, useState } from 'react';
import { DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { App, Button, Dropdown, Input, Tooltip } from 'antd';
import type { HistoryEntry } from '../lib/api';

interface HistoryPanelProps {
  history: HistoryEntry[];
  historyHasMore: boolean;
  onReplayHistory: (entry: HistoryEntry) => void;
  onDeleteHistory: (id: number) => Promise<void>;
  onClearHistory: () => Promise<void>;
  onLoadMoreHistory: () => void;
}

/** 最近请求区：历史搜索、重放、删除与加载更多。 */
export function HistoryPanel({
  history,
  historyHasMore,
  onReplayHistory,
  onDeleteHistory,
  onClearHistory,
  onLoadMoreHistory,
}: HistoryPanelProps) {
  const { modal } = App.useApp();
  const [historyQuery, setHistoryQuery] = useState('');

  const filteredHistory = useMemo(() => {
    const keyword = historyQuery.trim().toLowerCase();
    if (!keyword) return history;
    return history.filter(
      (entry) =>
        entry.url.toLowerCase().includes(keyword) ||
        entry.method.toLowerCase().includes(keyword),
    );
  }, [history, historyQuery]);

  function confirmClearHistory() {
    modal.confirm({
      title: '清空历史',
      content: `将删除全部 ${history.length} 条请求历史，且不可恢复。`,
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => onClearHistory(),
    });
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-head">
        <span>最近请求</span>
        <span className="sidebar-head-actions">
          <span className="sidebar-count">{filteredHistory.length}</span>
          <Tooltip title="清空历史">
            <Button
              type="text"
              size="small"
              className="sidebar-icon-btn"
              icon={<DeleteOutlined />}
              aria-label="清空历史"
              onClick={confirmClearHistory}
            />
          </Tooltip>
        </span>
      </div>
      {history.length > 4 && (
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          className="history-search"
          value={historyQuery}
          onChange={(event) => setHistoryQuery(event.target.value)}
          placeholder="搜索历史 URL / 方法"
          aria-label="搜索历史"
        />
      )}
      {history.length === 0 ? (
        <p className="sidebar-empty">发送一次请求后，这里会出现历史。</p>
      ) : filteredHistory.length === 0 ? (
        <p className="sidebar-empty">没有匹配的历史记录。</p>
      ) : (
        filteredHistory.map((entry, index) => {
          const failed = Boolean(entry.error) || (entry.status ?? 0) >= 400;
          return (
            <Dropdown
              key={entry.id ?? `${entry.method}-${entry.url}-${index}`}
              trigger={['contextMenu']}
              menu={{
                items: [{ key: 'delete', label: '删除记录', danger: true }],
                onClick: ({ domEvent }) => {
                  domEvent.stopPropagation();
                  if (entry.id != null) onDeleteHistory(entry.id);
                },
              }}
            >
              <button
                type="button"
                className="history-row"
                title={entry.url}
                onClick={() => onReplayHistory(entry)}
              >
                <span className={`history-dot ${failed ? 'bad' : 'ok'}`} />
                <span className="history-method">{entry.method}</span>
                <span className="history-path">{entry.url}</span>
                <span className="history-time">
                  {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
                </span>
              </button>
            </Dropdown>
          );
        })
      )}
      {historyHasMore && !historyQuery && (
        <Button type="link" size="small" block onClick={onLoadMoreHistory}>
          加载更多历史
        </Button>
      )}
    </div>
  );
}
