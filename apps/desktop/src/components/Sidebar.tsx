import { useMemo, useState } from 'react';
import {
  CloudSyncOutlined,
  DownOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { folders, type ApiRequest } from '../data/mock';
import type { HistoryEntry } from '../lib/api';
import { MethodTag } from './MethodTag';

interface SidebarProps {
  activeRequestId: string;
  history: HistoryEntry[];
  onSelectRequest: (request: ApiRequest) => void;
  onReplayHistory: (entry: HistoryEntry) => void;
}

function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function Sidebar({
  activeRequestId,
  history,
  onSelectRequest,
  onReplayHistory,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return folders;
    return folders
      .map((folder) => ({
        ...folder,
        requests: folder.requests.filter(
          (request) =>
            request.path.toLowerCase().includes(keyword) ||
            request.name.toLowerCase().includes(keyword) ||
            request.method.toLowerCase().includes(keyword),
        ),
      }))
      .filter((folder) => folder.requests.length > 0);
  }, [query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div>
          <span className="sidebar-eyebrow">WORKSPACE</span>
          <strong>支付中台</strong>
        </div>
        <Tooltip title="新建集合">
          <Button type="text" size="small" icon={<PlusOutlined />} className="sidebar-icon-btn" />
        </Tooltip>
      </div>

      <label className="sidebar-search">
        <SearchOutlined />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索接口、集合…"
          aria-label="搜索接口"
        />
        <kbd>⌘K</kbd>
      </label>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>集合</span>
          <span className="sidebar-count">7</span>
        </div>

        {filtered.map((folder) => {
          const isCollapsed = collapsed[folder.id] ?? false;
          return (
            <div className="folder" key={folder.id}>
              <button
                type="button"
                className="folder-head"
                onClick={() =>
                  setCollapsed((current) => ({ ...current, [folder.id]: !isCollapsed }))
                }
              >
                <DownOutlined
                  className={`folder-caret${isCollapsed ? ' collapsed' : ''}`}
                />
                <FolderOpenOutlined />
                <span>{folder.name}</span>
                <em>{folder.requests.length}</em>
              </button>

              {!isCollapsed && (
                <div className="folder-body">
                  {folder.requests.map((request) => (
                    <button
                      key={request.id}
                      type="button"
                      className={`request-row${
                        request.id === activeRequestId ? ' active' : ''
                      }`}
                      onClick={() => onSelectRequest(request)}
                      title={request.name}
                    >
                      <MethodTag method={request.method} />
                      <span className="request-path">{request.path}</span>
                      {request.dataLevel === 'L3' && (
                        <span className="request-lock" title="L3 涉密">
                          L3
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>环境</span>
          <span className="sidebar-count">2</span>
        </div>
        <div className="environment-row active">
          <i />
          <span>本地环境</span>
          <em>SQLite</em>
        </div>
        <div className="environment-row">
          <i />
          <span>开发环境</span>
          <em>team-api</em>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>最近请求</span>
          <span className="sidebar-count">{history.length}</span>
        </div>
        {history.length === 0 ? (
          <p className="sidebar-empty">发送一次请求后，这里会出现历史。</p>
        ) : (
          history.map((entry, index) => {
            const failed = Boolean(entry.error) || (entry.status ?? 0) >= 400;
            return (
              <button
                key={entry.id ?? `${entry.method}-${entry.url}-${index}`}
                type="button"
                className="history-row"
                title={entry.url}
                onClick={() => onReplayHistory(entry)}
              >
                <span className={`history-dot ${failed ? 'bad' : 'ok'}`} />
                <span className="history-method">{entry.method}</span>
                <span className="history-path">{shortUrl(entry.url)}</span>
                <span className="history-time">
                  {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="sidebar-spacer" />

      <div className="sidebar-sync">
        <CloudSyncOutlined />
        <div>
          <strong>已同步 · 2 分钟前</strong>
          <span>本地 SQLite · 待推送 3 条</span>
        </div>
      </div>

      <div className="sidebar-foot">
        <button type="button" className="sidebar-foot-btn">
          <PlusOutlined />
          新建请求
        </button>
        <Tooltip title="工作区设置">
          <Button type="text" size="small" icon={<SettingOutlined />} className="sidebar-icon-btn" />
        </Tooltip>
      </div>
    </aside>
  );
}
