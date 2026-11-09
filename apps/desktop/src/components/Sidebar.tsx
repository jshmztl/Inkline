import { useMemo, useState } from 'react';
import {
  CheckCircleFilled,
  CloudDownloadOutlined,
  CloudSyncOutlined,
  CloudUploadOutlined,
  DownOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { App, Button, Tooltip } from 'antd';
import { environmentVariables, environments, folders, type ApiRequest } from '../data/mock';
import type { HistoryEntry, SavedRequest } from '../lib/api';
import type { Session } from '../lib/session';
import { collectLocalDocuments, type TeamSnapshot } from '../lib/team';
import { MethodTag } from './MethodTag';

interface SidebarProps {
  activeRequestId: string;
  history: HistoryEntry[];
  savedRequests: SavedRequest[];
  environment: string;
  session: Session;
  teamRevision: number | null;
  teamUpdatedAt: string | null;
  onSelectRequest: (request: ApiRequest) => void;
  onReplayHistory: (entry: HistoryEntry) => void;
  onEnvironmentChange: (environment: string) => void;
  onPush: () => TeamSnapshot;
  onPull: () => Promise<{ snapshot: TeamSnapshot; pulled: number } | null>;
}

function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function formatSavedAt(value: string | null | undefined) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Sidebar({
  activeRequestId,
  history,
  savedRequests,
  environment,
  session,
  teamRevision,
  teamUpdatedAt,
  onSelectRequest,
  onReplayHistory,
  onEnvironmentChange,
  onPush,
  onPull,
}: SidebarProps) {
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [docCount, setDocCount] = useState(() => Object.keys(collectLocalDocuments()).length);
  const [lastSync, setLastSync] = useState<string | null>(null);

  async function handlePush() {
    setSyncing('push');
    try {
      const snapshot = onPush();
      setDocCount(Object.keys(snapshot.documents).length);
      setLastSync(`已推送 rev ${snapshot.revision}`);
      message.success(`已推送 rev ${snapshot.revision} · ${snapshot.requests.length} 个请求`);
    } catch {
      message.error('推送失败，请稍后重试');
    } finally {
      setSyncing(null);
    }
  }

  async function handlePull() {
    setSyncing('pull');
    try {
      const result = await onPull();
      if (!result) {
        setLastSync('团队仓为空');
        message.info('团队仓为空，请先推送一次');
        return;
      }
      setDocCount(Object.keys(result.snapshot.documents).length);
      setLastSync(`已拉取 rev ${result.snapshot.revision}`);
      message.success(`已拉取 rev ${result.snapshot.revision} · ${result.pulled} 个请求`);
    } catch {
      message.error('拉取失败，请稍后重试');
    } finally {
      setSyncing(null);
    }
  }

  const savedMap = useMemo(
    () => new Map(savedRequests.map((request) => [request.id, request])),
    [savedRequests],
  );

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
                  {folder.requests.map((request) => {
                    const saved = savedMap.get(request.id);
                    return (
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
                        {saved && (
                          <span
                            className="saved-flag"
                            title={`已保存 · ${formatSavedAt(saved.updatedAt)}`}
                          >
                            <CheckCircleFilled />
                          </span>
                        )}
                        {request.dataLevel === 'L3' && (
                          <span className="request-lock" title="L3 涉密">
                            L3
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>环境</span>
          <span className="sidebar-count">{environments.length}</span>
        </div>
        {environments.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`environment-row${item.value === environment ? ' active' : ''}`}
            onClick={() => onEnvironmentChange(item.value)}
            title={environmentVariables[item.value]?.host}
          >
            <i />
            <span>{item.label}</span>
            <em>{environmentVariables[item.value]?.host.replace(/^https?:\/\//, '')}</em>
          </button>
        ))}
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

      <div
        className="sidebar-sync"
        title={`${session.workspace} · ${
          teamUpdatedAt ? `更新于 ${formatSavedAt(teamUpdatedAt)}` : '尚未推送'
        }`}
      >
        <CloudSyncOutlined />
        <div className="sidebar-sync-body">
          <strong>{teamRevision != null ? `团队仓 rev ${teamRevision}` : '团队仓尚未建立'}</strong>
          <span>
            {lastSync ?? `${savedRequests.length} 个请求 · ${docCount} 份文档草稿`}
          </span>
        </div>
        <div className="sidebar-sync-actions">
          <Tooltip title="推送到团队仓">
            <Button
              type="text"
              size="small"
              icon={<CloudUploadOutlined />}
              loading={syncing === 'push'}
              disabled={syncing === 'pull'}
              onClick={handlePush}
              aria-label="推送到团队仓"
            />
          </Tooltip>
          <Tooltip title="从团队仓拉取">
            <Button
              type="text"
              size="small"
              icon={<CloudDownloadOutlined />}
              loading={syncing === 'pull'}
              disabled={syncing === 'push' || teamRevision == null}
              onClick={handlePull}
              aria-label="从团队仓拉取"
            />
          </Tooltip>
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
