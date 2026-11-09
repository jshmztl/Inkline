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
import { App, Button, Dropdown, Input, Modal, Segmented, Tooltip } from 'antd';
import {
  environments,
  type ApiFolder,
  type ApiRequest,
} from '../data/mock';
import { saveRequest, type HistoryEntry, type SavedRequest } from '../lib/api';
import type { WorkspaceEnvironment } from '../lib/envStore';
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
  folders: ApiFolder[];
  history: HistoryEntry[];
  savedRequests: SavedRequest[];
  environment: string;
  workspaceEnvironments: WorkspaceEnvironment[];
  session: Session;
  teamRevision: number | null;
  teamUpdatedAt: string | null;
  onSelectRequest: (request: ApiRequest) => void;
  onReplayHistory: (entry: HistoryEntry) => void;
  onEnvironmentChange: (environment: string) => void;
  onSaveEnvironment: (environment: string, variables: Record<string, string>) => void;
  onPush: () => TeamSnapshot;
  onPull: () => Promise<{ snapshot: TeamSnapshot; pulled: number } | null>;
  onMerged: () => void;
  onCreateCollection: (name: string) => Promise<void>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
  onCreateRequest: (collectionId: string) => Promise<void>;
  onRenameRequest: (id: string, name: string) => Promise<void>;
  onDeleteRequest: (id: string) => Promise<void>;
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
  folders,
  history,
  savedRequests,
  environment,
  workspaceEnvironments,
  session,
  teamRevision,
  teamUpdatedAt,
  onSelectRequest,
  onReplayHistory,
  onEnvironmentChange,
  onSaveEnvironment,
  onPush,
  onPull,
  onMerged,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onCreateRequest,
  onRenameRequest,
  onDeleteRequest,
}: SidebarProps) {
  const { message, modal } = App.useApp();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [docCount, setDocCount] = useState(() => Object.keys(collectLocalDocuments()).length);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'local' | 'remote'>>({});
  const [editor, setEditor] = useState<{
    mode: 'create' | 'rename-collection' | 'rename-request';
    id?: string;
    value: string;
  } | null>(null);
  const [envEditor, setEnvEditor] = useState<{
    value: string;
    label: string;
    rows: { id: string; key: string; value: string }[];
  } | null>(null);

  function openEnvEditor(value: string) {
    const target = workspaceEnvironments.find((item) => item.value === value);
    if (!target) return;
    setEnvEditor({
      value: target.value,
      label: target.label,
      rows: Object.entries(target.variables).map(([key, val], index) => ({
        id: `env-${index}`,
        key,
        value: val,
      })),
    });
  }

  function updateEnvRow(id: string, patch: Partial<{ key: string; value: string }>) {
    setEnvEditor((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
          }
        : current,
    );
  }

  function submitEnvEditor() {
    if (!envEditor) return;
    const variables: Record<string, string> = {};
    for (const row of envEditor.rows) {
      const key = row.key.trim();
      if (!key) continue;
      variables[key] = row.value;
    }
    onSaveEnvironment(envEditor.value, variables);
    setEnvEditor(null);
    message.success(`已保存「${envEditor.label}」变量`);
  }

  async function submitEditor() {
    if (!editor) return;
    const name = editor.value.trim();
    if (!name) {
      message.warning('名称不能为空');
      return;
    }
    try {
      if (editor.mode === 'create') {
        await onCreateCollection(name);
      } else if (editor.mode === 'rename-collection' && editor.id) {
        await onRenameCollection(editor.id, name);
      } else if (editor.mode === 'rename-request' && editor.id) {
        await onRenameRequest(editor.id, name);
      }
      setEditor(null);
      message.success('已保存');
    } catch {
      message.error('保存失败，请稍后重试');
    }
  }

  function confirmDeleteRequest(request: ApiRequest) {
    modal.confirm({
      title: '删除请求',
      content: `确定删除「${request.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => onDeleteRequest(request.id),
    });
  }

  function confirmDeleteCollection(folder: ApiFolder) {
    modal.confirm({
      title: '删除集合',
      content: `将删除「${folder.name}」及其 ${folder.requests.length} 个请求。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => onDeleteCollection(folder.id),
    });
  }

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
  }, [folders, query]);

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
            onClick={() => setEditor({ mode: 'create', value: '' })}
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
          <span className="sidebar-count">{folders.length}</span>
        </div>

        {filtered.map((folder) => {
          const isCollapsed = collapsed[folder.id] ?? false;
          return (
            <div className="folder" key={folder.id}>
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    { key: 'new', label: '新建请求', icon: <PlusOutlined /> },
                    { key: 'rename', label: '重命名集合' },
                    { type: 'divider' },
                    { key: 'delete', label: '删除集合', danger: true },
                  ],
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    if (key === 'new') onCreateRequest(folder.id);
                    if (key === 'rename') {
                      setEditor({
                        mode: 'rename-collection',
                        id: folder.id,
                        value: folder.name,
                      });
                    }
                    if (key === 'delete') confirmDeleteCollection(folder);
                  },
                }}
              >
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
              </Dropdown>

              {!isCollapsed && (
                <div className="folder-body">
                  {folder.requests.map((request) => {
                    const saved = savedMap.get(request.id);
                    return (
                      <Dropdown
                        key={request.id}
                        trigger={['contextMenu']}
                        menu={{
                          items: [
                            { key: 'new', label: '新建请求', icon: <PlusOutlined /> },
                            { key: 'rename', label: '重命名请求' },
                            { type: 'divider' },
                            { key: 'delete', label: '删除请求', danger: true },
                          ],
                          onClick: ({ key: action, domEvent }) => {
                            domEvent.stopPropagation();
                            if (action === 'new') onCreateRequest(folder.id);
                            if (action === 'rename') {
                              setEditor({
                                mode: 'rename-request',
                                id: request.id,
                                value: request.name,
                              });
                            }
                            if (action === 'delete') confirmDeleteRequest(request);
                          },
                        }}
                      >
                        <button
                          type="button"
                          className={`request-row${
                            request.id === activeRequestId ? ' active' : ''
                          }`}
                          onClick={() => onSelectRequest(request)}
                          title={`${request.name} · ${request.path}`}
                        >
                          <MethodTag method={request.method} />
                          <span className="request-path">{request.name}</span>
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
                      </Dropdown>
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
        {workspaceEnvironments.map((item) => {
          const host = item.variables.host ?? '';
          return (
            <button
              key={item.value}
              type="button"
              className={`environment-row${item.value === environment ? ' active' : ''}`}
              onClick={() => onEnvironmentChange(item.value)}
              onDoubleClick={() => openEnvEditor(item.value)}
              title={`${host} · 双击编辑变量`}
            >
              <i />
              <span>{item.label}</span>
              <em>{host.replace(/^https?:\/\//, '')}</em>
            </button>
          );
        })}
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
        <button
          type="button"
          className="sidebar-foot-btn"
          onClick={() => {
            const activeFolder = folders.find((folder) =>
              folder.requests.some((request) => request.id === activeRequestId),
            );
            const target = activeFolder?.id ?? folders[0]?.id;
            if (target) onCreateRequest(target);
          }}
        >
          <PlusOutlined />
          新建请求
        </button>
        <Tooltip title="编辑当前环境变量">
          <Button
            type="text"
            size="small"
            icon={<SettingOutlined />}
            className="sidebar-icon-btn"
            aria-label="设置"
            onClick={() => openEnvEditor(environment)}
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
      <Modal
        open={editor !== null}
        title={
          editor?.mode === 'create'
            ? '新建集合'
            : editor?.mode === 'rename-collection'
              ? '重命名集合'
              : '重命名请求'
        }
        width={380}
        okText="保存"
        cancelText="取消"
        onCancel={() => setEditor(null)}
        onOk={submitEditor}
      >
        <Input
          autoFocus
          value={editor?.value ?? ''}
          onChange={(event) =>
            setEditor((current) => (current ? { ...current, value: event.target.value } : current))
          }
          onPressEnter={submitEditor}
          placeholder="名称"
          aria-label="名称"
        />
      </Modal>

      <Modal
        open={envEditor !== null}
        title={`环境变量 · ${envEditor?.label ?? ''}`}
        width={520}
        okText="保存"
        cancelText="取消"
        onCancel={() => setEnvEditor(null)}
        onOk={submitEnvEditor}
      >
        <div className="env-editor">
          <p className="env-editor-hint">
            在 URL、Headers、Body 中使用 <code>{'{{变量名}}'}</code> 引用，例如{' '}
            <code>{'{{host}}/v1/orders'}</code>。
          </p>
          <div className="env-editor-head">
            <span>KEY</span>
            <span>VALUE</span>
            <span />
          </div>
          {envEditor?.rows.map((row) => (
            <div className="env-editor-row" key={row.id}>
              <Input
                size="small"
                value={row.key}
                placeholder="host"
                aria-label="变量名"
                onChange={(event) => updateEnvRow(row.id, { key: event.target.value })}
              />
              <Input
                size="small"
                value={row.value}
                placeholder="http://127.0.0.1:8080"
                aria-label="变量值"
                onChange={(event) => updateEnvRow(row.id, { value: event.target.value })}
              />
              <Button
                type="text"
                size="small"
                danger
                onClick={() =>
                  setEnvEditor((current) =>
                    current
                      ? {
                          ...current,
                          rows: current.rows.filter((item) => item.id !== row.id),
                        }
                      : current,
                  )
                }
              >
                移除
              </Button>
            </div>
          ))}
          <Button
            type="dashed"
            size="small"
            block
            icon={<PlusOutlined />}
            onClick={() =>
              setEnvEditor((current) =>
                current
                  ? {
                      ...current,
                      rows: [
                        ...current.rows,
                        { id: `env-${Date.now().toString(36)}`, key: '', value: '' },
                      ],
                    }
                  : current,
              )
            }
          >
            新增变量
          </Button>
        </div>
      </Modal>
    </aside>
  );
}
