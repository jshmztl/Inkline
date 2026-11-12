import { useMemo, useState } from 'react';
import { ImportOutlined, PlusOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import { App, Button, Tooltip } from 'antd';
import { type ApiFolder, type ApiRequest, type NetworkMode } from '../data/types';
import { type HistoryEntry, type SavedRequest } from '../lib/api';
import type { WorkspaceEnvironment } from '../lib/envStore';
import { collectLocalDocuments, type TeamSnapshot } from '../lib/team';
import type { Session } from '../lib/session';
import type { TeamAccess } from '../lib/teamClient';
import { CollectionEditorModal } from './CollectionEditorModal';
import { CollectionTree, type CollectionEditorState } from './CollectionTree';
import { EnvironmentEditorModal, type EnvironmentEditorState } from './EnvironmentEditorModal';
import { EnvironmentSection } from './EnvironmentSection';
import { ExportModal, type ExportState } from './ExportModal';
import { HistoryPanel } from './HistoryPanel';
import { ImportModal } from './ImportModal';
import { TeamSyncPanel } from './TeamSyncPanel';

interface SidebarProps {
  activeRequestId: string;
  folders: ApiFolder[];
  history: HistoryEntry[];
  historyHasMore: boolean;
  savedRequests: SavedRequest[];
  environment: string;
  workspaceEnvironments: WorkspaceEnvironment[];
  session: Session;
  networkMode: NetworkMode;
  teamRevision: number | null;
  teamUpdatedAt: string | null;
  teamAccess: TeamAccess | null;
  onSelectRequest: (request: ApiRequest) => void;
  onReplayHistory: (entry: HistoryEntry) => void;
  onEnvironmentChange: (environment: string) => void;
  onSaveEnvironment: (environment: string, variables: Record<string, string>, label?: string) => void;
  onCreateEnvironment: (label: string, variables: Record<string, string>) => string;
  onDeleteEnvironment: (environment: string) => void;
  onPush: () => Promise<TeamSnapshot>;
  onPull: () => Promise<{ snapshot: TeamSnapshot; pulled: number } | null>;
  onMerged: () => void;
  onCreateCollection: (name: string, parentId?: string) => Promise<string>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onMoveCollection: (id: string, direction: -1 | 1) => Promise<void>;
  onDuplicateCollection: (id: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
  onCreateRequest: (collectionId: string) => Promise<void>;
  onRenameRequest: (id: string, name: string) => Promise<void>;
  onMoveRequest: (id: string, direction: -1 | 1) => Promise<void>;
  onDuplicateRequest: (id: string) => Promise<void>;
  onDeleteRequest: (id: string) => Promise<void>;
  onImport: (raw: string) => Promise<{ name: string; count: number }>;
  onRunTests: (folder: ApiFolder) => void;
  onDeleteHistory: (id: number) => Promise<void>;
  onClearHistory: () => Promise<void>;
  onLoadMoreHistory: () => void;
}

export function Sidebar({
  activeRequestId,
  folders,
  history,
  historyHasMore,
  savedRequests,
  environment,
  workspaceEnvironments,
  session,
  networkMode,
  teamRevision,
  teamUpdatedAt,
  teamAccess,
  onSelectRequest,
  onReplayHistory,
  onEnvironmentChange,
  onSaveEnvironment,
  onCreateEnvironment,
  onDeleteEnvironment,
  onPush,
  onPull,
  onMerged,
  onCreateCollection,
  onRenameCollection,
  onMoveCollection,
  onDuplicateCollection,
  onDeleteCollection,
  onCreateRequest,
  onRenameRequest,
  onMoveRequest,
  onDuplicateRequest,
  onDeleteRequest,
  onImport,
  onRunTests,
  onDeleteHistory,
  onClearHistory,
  onLoadMoreHistory,
}: SidebarProps) {
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<CollectionEditorState | null>(null);
  const [envEditor, setEnvEditor] = useState<EnvironmentEditorState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportState | null>(null);

  const savedMap = useMemo(
    () => new Map(savedRequests.map((request) => [request.id, request])),
    [savedRequests],
  );

  function openEnvEditor(value: string) {
    const target = workspaceEnvironments.find((item) => item.value === value);
    if (!target) return;
    setEnvEditor({
      isNew: false,
      value: target.value,
      label: target.label,
      rows: Object.entries(target.variables).map(([key, val], index) => ({
        id: `env-${index}`,
        key,
        value: val,
      })),
    });
  }

  function openNewEnvEditor() {
    setEnvEditor({
      isNew: true,
      value: '',
      label: `环境 ${workspaceEnvironments.length + 1}`,
      rows: [{ id: `env-${Date.now().toString(36)}`, key: 'host', value: '' }],
    });
  }

  function openExport(folder: ApiFolder) {
    const requests = folder.requests
      .map((request) => savedMap.get(request.id))
      .filter((request): request is SavedRequest => Boolean(request));
    if (requests.length === 0) {
      message.info('集合中没有可导出的已保存请求');
      return;
    }
    setExportState({
      name: folder.name,
      requests,
      documents: collectLocalDocuments(),
      format: 'markdown',
    });
  }

  const remoteTeam = session.mode === 'team';

  function requestReadOnly(requestId: string) {
    return remoteTeam && teamAccess?.requests?.[requestId] === 'view';
  }

  function collectionReadOnly(collectionId: string) {
    return remoteTeam && teamAccess?.collections?.[collectionId] === 'view';
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div>
          <span className="sidebar-eyebrow">WORKSPACE</span>
          <strong>{session.workspace}</strong>
        </div>
        <Tooltip title="导入（curl / Postman / OpenAPI / Postman 环境）">
          <Button
            type="text"
            size="small"
            icon={<ImportOutlined />}
            className="sidebar-icon-btn"
            aria-label="导入"
            onClick={() => setImportOpen(true)}
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

      <CollectionTree
        folders={folders}
        query={query}
        collapsed={collapsed}
        savedRequests={savedRequests}
        activeRequestId={activeRequestId}
        isCollectionReadOnly={collectionReadOnly}
        isRequestReadOnly={requestReadOnly}
        onToggleCollapse={(id) =>
          setCollapsed((current) => ({ ...current, [id]: !(current[id] ?? false) }))
        }
        onSelectRequest={onSelectRequest}
        onCreateRequest={onCreateRequest}
        onMoveCollection={onMoveCollection}
        onDuplicateCollection={onDuplicateCollection}
        onDeleteCollection={onDeleteCollection}
        onMoveRequest={onMoveRequest}
        onDuplicateRequest={onDuplicateRequest}
        onDeleteRequest={onDeleteRequest}
        onRunTests={onRunTests}
        onExport={openExport}
        onOpenEditor={setEditor}
      />

      <EnvironmentSection
        workspaceEnvironments={workspaceEnvironments}
        environment={environment}
        onEnvironmentChange={onEnvironmentChange}
        onEditEnvironment={openEnvEditor}
        onNewEnvironment={openNewEnvEditor}
        onDeleteEnvironment={onDeleteEnvironment}
      />

      <HistoryPanel
        history={history}
        historyHasMore={historyHasMore}
        onReplayHistory={onReplayHistory}
        onDeleteHistory={onDeleteHistory}
        onClearHistory={onClearHistory}
        onLoadMoreHistory={onLoadMoreHistory}
      />

      <div className="sidebar-spacer" />

      <TeamSyncPanel
        session={session}
        networkMode={networkMode}
        teamRevision={teamRevision}
        teamUpdatedAt={teamUpdatedAt}
        teamAccess={teamAccess}
        savedRequests={savedRequests}
        onPush={onPush}
        onPull={onPull}
        onMerged={onMerged}
      />

      <div className="sidebar-foot">
        <button
          type="button"
          className="sidebar-foot-btn ghost"
          onClick={() => setEditor({ mode: 'create', value: '' })}
        >
          <PlusOutlined />
          新建集合
        </button>
        <button
          type="button"
          className="sidebar-foot-btn"
          onClick={() => {
            const activeFolder = folders.find((folder) =>
              folder.requests.some((request) => request.id === activeRequestId),
            );
            const target = activeFolder?.id ?? folders[0]?.id;
            if (target) {
              onCreateRequest(target);
            } else {
              setEditor({ mode: 'create-request', value: '' });
            }
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
            onClick={() => (environment ? openEnvEditor(environment) : openNewEnvEditor())}
          />
        </Tooltip>
      </div>

      <CollectionEditorModal
        editor={editor}
        onChange={setEditor}
        onClose={() => setEditor(null)}
        onCreateCollection={onCreateCollection}
        onCreateRequest={onCreateRequest}
        onRenameCollection={onRenameCollection}
        onRenameRequest={onRenameRequest}
      />

      <EnvironmentEditorModal
        editor={envEditor}
        onChange={setEnvEditor}
        onClose={() => setEnvEditor(null)}
        onCreateEnvironment={onCreateEnvironment}
        onSaveEnvironment={onSaveEnvironment}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={onImport}
        onCreateEnvironment={onCreateEnvironment}
        onEnvironmentChange={onEnvironmentChange}
      />

      <ExportModal
        exportState={exportState}
        onChange={setExportState}
        onClose={() => setExportState(null)}
      />
    </aside>
  );
}
