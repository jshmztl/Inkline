import { useMemo, useState } from 'react';
import {
  CheckCircleFilled,
  CloudDownloadOutlined,
  CloudSyncOutlined,
  CloudUploadOutlined,
  DownOutlined,
  FolderOpenOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { App, Button, Modal, Segmented, Tooltip } from 'antd';
import { environmentVariables, environments, folders, type ApiRequest } from '../data/mock';
import { saveRequest, type HistoryEntry, type SavedRequest } from '../lib/api';
import { recordAudit } from '../lib/audit';
import { planThreeWayMerge } from '../lib/merge';
import type { Session } from '../lib/session';
import {
  collectLocalDocuments,
  readTeamBase,
  readTeamSnapshot,
  writeTeamBase,
  type TeamSnapshot,
} from '../lib/team';
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
  onMerged: () => void;
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
  onMerged,
}: SidebarProps) {
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [docCount, setDocCount] = useState(() => Object.keys(collectLocalDocuments()).length);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'local' | 'remote'>>({});

  const plan = useMemo(() => {
    if (!mergeOpen) return null;
    const remote = readTeamSnapshot();
    if (!remote) return null;
    const base = readTeamBase();
    return planThreeWayMerge(base?.requests ?? [], savedRequests, remote.requests);
  }, [mergeOpen, savedRequests]);

  function openMerge() {
    setDecisions({});
    setMergeOpen(true);
  }

  async function applyMerge() {
    if (!plan) return;
    try {
      for (const request of plan.remoteChanges) {
        await saveRequest(request);
      }
      for (const conflict of plan.conflicts) {
        if ((decisions[conflict.id] ?? 'local') === 'remote') {
          await saveRequest(conflict.remote);
        }
      }
      const remote = readTeamSnapshot();
      if (remote) writeTeamBase(remote);
      recordAudit({
        type: 'sync',
        action: '三方合并',
        detail: `拉取 ${plan.remoteChanges.length} 条 · 冲突 ${plan.conflicts.length} 条`,
        actor: session.account,
      });
      onMerged();
      setMergeOpen(false);
      message.success(
        `合并完成 · 拉取 ${plan.remoteChanges.length} 条 · 冲突 ${plan.conflicts.length} 条`,
      );
    } catch {
      message.error('合并失败，请稍后重试');
    }
  }

  async function handlePush() {
    setSyncing('push');
    try {
      const snapshot = onPush();
      setDocCount(Object.keys(snapshot.documents).length);
      setLastSync(`已推送 rev ${snapshot.revision}`);
      recordAudit({
        type: 'sync',
        action: `推送团队仓 rev ${snapshot.revision}`,
        detail: `${snapshot.requests.length} 个请求 · ${Object.keys(snapshot.documents).length} 份文档`,
        actor: session.account,
      });
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
      recordAudit({
        type: 'sync',
        action: `拉取团队仓 rev ${result.snapshot.revision}`,
        detail: `${result.pulled} 个请求 · ${Object.keys(result.snapshot.documents).length} 份文档`,
        actor: session.account,
      });
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
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            className="sidebar-icon-btn"
            aria-label="新建集合"
          />
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
                aria-expanded={!isCollapsed}
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
          <Tooltip title="三方合并">
            <Button
              type="text"
              size="small"
              icon={<MergeCellsOutlined />}
              disabled={teamRevision == null}
              onClick={openMerge}
              aria-label="三方合并"
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
          <Button
            type="text"
            size="small"
            icon={<SettingOutlined />}
            className="sidebar-icon-btn"
            aria-label="设置"
          />
        </Tooltip>
      </div>

      <Modal
        open={mergeOpen}
        title="三方合并"
        width={520}
        onCancel={() => setMergeOpen(false)}
        footer={[
          <Button key="cancel" size="small" onClick={() => setMergeOpen(false)}>
            取消
          </Button>,
          <Button
            key="apply"
            type="primary"
            size="small"
            onClick={applyMerge}
            disabled={!plan || (plan.remoteChanges.length === 0 && plan.conflicts.length === 0)}
          >
            应用合并
          </Button>,
        ]}
      >
        {!plan ? (
          <div className="merge-empty">团队仓为空，请先推送一次。</div>
        ) : (
          <div className="merge-body">
            <div className="merge-summary">
              <span>
                本地变更 <b>{plan.localChanges.length}</b>
              </span>
              <span>
                远端变更 <b>{plan.remoteChanges.length}</b>
              </span>
              <span>
                冲突 <b className={plan.conflicts.length > 0 ? 'warn' : ''}>{plan.conflicts.length}</b>
              </span>
              <span>
                一致 <b>{plan.identical}</b>
              </span>
            </div>

            {plan.conflicts.length === 0 && (
              <div className="merge-empty">没有冲突，可直接应用远端变更。</div>
            )}

            {plan.conflicts.map((conflict) => (
              <div className="merge-conflict" key={conflict.id}>
                <div className="merge-conflict-head">
                  <code>{conflict.name}</code>
                  <span>{conflict.fields.map((field) => field.label).join(' / ')}</span>
                </div>

                {conflict.fields.map((field) => (
                  <div className="merge-field" key={field.field}>
                    <span className="merge-field-name">{field.label}</span>
                    <div className="merge-sides">
                      <div
                        className={`merge-side${
                          (decisions[conflict.id] ?? 'local') === 'local' ? ' active' : ''
                        }`}
                      >
                        <em>本地</em>
                        <code>{field.local || '（空）'}</code>
                      </div>
                      <div
                        className={`merge-side${
                          decisions[conflict.id] === 'remote' ? ' active' : ''
                        }`}
                      >
                        <em>远端</em>
                        <code>{field.remote || '（空）'}</code>
                      </div>
                    </div>
                  </div>
                ))}

                <Segmented
                  size="small"
                  value={decisions[conflict.id] ?? 'local'}
                  onChange={(value) =>
                    setDecisions((current) => ({
                      ...current,
                      [conflict.id]: value as 'local' | 'remote',
                    }))
                  }
                  options={[
                    { label: '保留本地', value: 'local' },
                    { label: '采用远端', value: 'remote' },
                  ]}
                />
              </div>
            ))}

            <p className="merge-note">本地变更会保留，可在合并后再次推送。</p>
          </div>
        )}
      </Modal>
    </aside>
  );
}
