import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Input, Modal } from 'antd';
import { AntProvider, type Density, type ThemeMode } from '@api-workbench/ui';
import type { ApiFolder, ApiRequest, DataLevel, HttpMethod, NetworkMode } from './data/types';
import {
  clearHistory as apiClearHistory,
  deleteCollection as apiDeleteCollection,
  deleteHistory as apiDeleteHistory,
  deleteRequest as apiDeleteRequest,
  listCollections,
  listHistory,
  listRequests,
  saveCollection as apiSaveCollection,
  saveRequest,
  type Collection,
  type HistoryEntry,
  type SavedRequest,
} from './lib/api';
import type { RequestContext } from './lib/docTask';
import { listEnvironments, saveEnvironmentVariables, writeEnvironments } from './lib/envStore';
import { parseImport } from './lib/importer';
import {
  collectLocalDocuments,
  pullTeamSnapshot,
  pushTeamSnapshot,
  readTeamSnapshot,
  writeRemoteDocuments,
  type TeamSnapshot,
} from './lib/team';
import { LoginScreen } from './components/LoginScreen';
import { RequestPanel } from './components/RequestPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TestRunModal } from './components/TestRunModal';
import { TopBar } from './components/TopBar';
import { readSession, signOut, type Session } from './lib/session';
import { runCollectionTests, type TestCaseResult } from './lib/testRunner';

const AiPanel = lazy(() =>
  import('./components/AiPanel').then((module) => ({ default: module.AiPanel })),
);

const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((module) => ({
    default: module.CommandPalette,
  })),
);

function readStoredMode(): ThemeMode {
  return localStorage.getItem('aw-theme') === 'dark' ? 'dark' : 'light';
}

function readStoredDensity(): Density {
  const stored = localStorage.getItem('aw-density');
  if (stored === 'compact' || stored === 'comfortable') return stored;
  return 'default';
}

function toApiRequest(saved: SavedRequest): ApiRequest {
  const prefix = '{{host}}';
  const path = saved.url.startsWith(prefix) ? saved.url.slice(prefix.length) : saved.url;
  return {
    id: saved.id,
    name: saved.name,
    method: saved.method as HttpMethod,
    path,
    dataLevel: (saved.dataLevel as DataLevel) ?? 'L1',
    updatedAt: saved.updatedAt ?? '',
    collectionId: saved.collectionId,
  };
}

export function App() {
  const [session, setSession] = useState<Session | null>(readSession);
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);
  const [density, setDensity] = useState<Density>(readStoredDensity);
  const [networkMode, setNetworkMode] = useState<NetworkMode>('B');
  const [environment, setEnvironment] = useState('');
  const [workspaceEnvs, setWorkspaceEnvs] = useState(listEnvironments);
  const [activeRequestId, setActiveRequestId] = useState('');
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const autoOpenRef = useRef(true);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [requestContext, setRequestContext] = useState<RequestContext | null>(null);
  const [teamSnapshot, setTeamSnapshot] = useState<TeamSnapshot | null>(readTeamSnapshot);
  const [syncNonce, setSyncNonce] = useState(0);
  const [queueNonce, setQueueNonce] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [bootstrapName, setBootstrapName] = useState('');
  const [bootstrapping, setBootstrapping] = useState(false);
  const [testRun, setTestRun] = useState<{
    name: string;
    running: boolean;
    results: TestCaseResult[];
  } | null>(null);
  const [replay, setReplay] = useState<{
    method: HttpMethod;
    url: string;
    nonce: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    listHistory(6)
      .then((entries) => {
        if (alive) setHistory(entries);
      })
      .catch(() => {
        // 历史加载失败不阻断主流程。
      });
    listRequests()
      .then((entries) => {
        if (alive) setSavedRequests(entries);
      })
      .catch(() => {
        // 已保存请求加载失败不阻断主流程。
      });
    listCollections()
      .then((entries) => {
        if (alive) setCollections(entries);
      })
      .catch(() => {
        // 集合加载失败不阻断主流程。
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function handleHotkey(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (key === 'n') {
        event.preventDefault();
        const target = activeRequest.collectionId ?? folders[0]?.id;
        if (target) void handleCreateRequest(target);
      }
    }
    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  });

  const folders: ApiFolder[] = useMemo(
    () =>
      collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        requests: savedRequests
          .filter((request) => (request.collectionId ?? '') === collection.id)
          .map(toApiRequest),
      })),
    [collections, savedRequests],
  );

  const allRequests = useMemo(
    () => folders.flatMap((folder) => folder.requests),
    [folders],
  );

  const currentVariables = useMemo(
    () => workspaceEnvs.find((item) => item.value === environment)?.variables ?? {},
    [workspaceEnvs, environment],
  );

  useEffect(() => {
    if (workspaceEnvs.length === 0) {
      if (environment) setEnvironment('');
      return;
    }
    if (!workspaceEnvs.some((item) => item.value === environment)) {
      setEnvironment(workspaceEnvs[0].value);
    }
  }, [workspaceEnvs, environment]);

  const emptyRequest: ApiRequest = {
    id: '',
    method: 'GET',
    path: '',
    name: '暂无请求',
    dataLevel: 'L1',
    updatedAt: '',
  };

  const activeRequest =
    allRequests.find((request) => request.id === activeRequestId) ?? emptyRequest;
  const activeSaved =
    savedRequests.find((request) => request.id === activeRequest.id) ?? null;

  const openTabs = openTabIds
    .map((id) => allRequests.find((request) => request.id === id))
    .filter((request): request is ApiRequest => Boolean(request));

  useEffect(() => {
    if (allRequests.length === 0) {
      setActiveRequestId('');
      setOpenTabIds([]);
      autoOpenRef.current = true;
      return;
    }
    if (!activeRequestId) {
      if (!autoOpenRef.current) return;
      const first = allRequests[0].id;
      setActiveRequestId(first);
      setOpenTabIds([first]);
      return;
    }
    if (!allRequests.some((request) => request.id === activeRequestId)) {
      const first = allRequests[0].id;
      setActiveRequestId(first);
      setOpenTabIds([first]);
    }
  }, [allRequests, activeRequestId]);

  function toggleMode() {
    const next = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    localStorage.setItem('aw-theme', next);
  }

  function changeDensity(next: Density) {
    setDensity(next);
    localStorage.setItem('aw-density', next);
  }

  function selectRequest(request: ApiRequest) {
    autoOpenRef.current = true;
    setActiveRequestId(request.id);
    setOpenTabIds((current) =>
      current.includes(request.id) ? current : [...current, request.id],
    );
  }

  function selectTab(requestId: string) {
    setActiveRequestId(requestId);
  }

  function closeTab(requestId: string) {
    const next = openTabIds.filter((id) => id !== requestId);
    setOpenTabIds(next);
    if (next.length === 0) autoOpenRef.current = false;
    if (requestId === activeRequestId) {
      setActiveRequestId(next[next.length - 1] ?? '');
    }
  }

  function refreshHistory() {
    listHistory(6)
      .then(setHistory)
      .catch(() => {
        // 忽略历史刷新失败。
      });
  }

  function replayHistory(entry: HistoryEntry) {
    setReplay({
      method: entry.method as HttpMethod,
      url: entry.url,
      nonce: Date.now(),
    });
  }

  async function refreshWorkspace() {
    try {
      const [nextCollections, nextSaved] = await Promise.all([
        listCollections(),
        listRequests(),
      ]);
      setCollections(nextCollections);
      setSavedRequests(nextSaved);
    } catch {
      // 忽略刷新失败，保持当前视图。
    }
  }

  function refreshSaved() {
    void refreshWorkspace();
  }

  async function handleCreateCollection(name: string) {
    const id = `collection-${Date.now().toString(36)}`;
    await apiSaveCollection({
      id,
      name,
      sort: collections.length,
    });
    await refreshWorkspace();
    return id;
  }

  async function handleRenameCollection(id: string, name: string) {
    const existing = collections.find((collection) => collection.id === id);
    if (!existing) return;
    await apiSaveCollection({ ...existing, name });
    await refreshWorkspace();
  }

  async function handleDeleteCollection(id: string) {
    await apiDeleteCollection(id);
    setOpenTabIds((current) => current.filter((tabId) => tabId !== activeRequestId));
    await refreshWorkspace();
  }

  async function handleCreateRequest(collectionId: string) {
    const id = `request-${Date.now().toString(36)}`;
    const created = await saveRequest({
      id,
      name: '新建请求',
      method: 'GET',
      url: '{{host}}',
      headers: [],
      body: null,
      dataLevel: 'L1',
      collectionId,
      updatedAt: null,
    });
    await refreshWorkspace();
    autoOpenRef.current = true;
    setActiveRequestId(created.id);
    setOpenTabIds((current) =>
      current.includes(created.id) ? current : [...current, created.id],
    );
  }

  async function handleCreateFirstRequest() {
    const name = bootstrapName.trim();
    if (!name) return;
    setBootstrapping(true);
    try {
      const collectionId = await handleCreateCollection(name);
      await handleCreateRequest(collectionId);
      setBootstrapOpen(false);
      setBootstrapName('');
    } finally {
      setBootstrapping(false);
    }
  }

  async function handleRenameRequest(id: string, name: string) {
    const existing = savedRequests.find((request) => request.id === id);
    if (!existing) return;
    await saveRequest({ ...existing, name });
    await refreshWorkspace();
  }

  async function handleDeleteRequest(id: string) {
    await apiDeleteRequest(id);
    setOpenTabIds((current) => current.filter((tabId) => tabId !== id));
    await refreshWorkspace();
  }

  async function handleImport(raw: string) {
    const payload = parseImport(raw);
    const collectionId = `collection-${Date.now().toString(36)}`;
    await apiSaveCollection({
      id: collectionId,
      name: payload.name,
      sort: collections.length,
    });
    for (const [index, request] of payload.requests.entries()) {
      await saveRequest({
        id: `${collectionId}-${index}`,
        name: request.name,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        dataLevel: 'L1',
        collectionId,
        updatedAt: null,
      });
    }
    await refreshWorkspace();
    return { name: payload.name, count: payload.requests.length };
  }

  async function handleDeleteHistory(id: number) {
    await apiDeleteHistory(id);
    refreshHistory();
  }

  async function handleClearHistory() {
    await apiClearHistory();
    refreshHistory();
  }

  function handleSignOut() {
    signOut();
    setSession(null);
  }

  function handleSaveEnvironment(
    environmentValue: string,
    variables: Record<string, string>,
    label?: string,
  ) {
    if (!environmentValue) return;
    setWorkspaceEnvs(saveEnvironmentVariables(environmentValue, variables, label));
  }

  function handleCreateEnvironment(
    label: string,
    variables: Record<string, string>,
  ) {
    const created = {
      value: `env-${Date.now().toString(36)}`,
      label,
      variables,
    };
    const next = [...workspaceEnvs, created];
    writeEnvironments(next);
    setWorkspaceEnvs(next);
    setEnvironment(created.value);
    return created.value;
  }

  function handleDeleteEnvironment(value: string) {
    const next = workspaceEnvs.filter((item) => item.value !== value);
    writeEnvironments(next);
    setWorkspaceEnvs(next);
    if (environment === value) {
      setEnvironment(next[0]?.value ?? '');
    }
  }

  function handlePush() {
    const snapshot = pushTeamSnapshot(
      session?.account ?? 'local',
      savedRequests,
      collectLocalDocuments(),
    );
    setTeamSnapshot(snapshot);
    return snapshot;
  }

  async function handlePull() {
    const snapshot = await pullTeamSnapshot();
    if (!snapshot) return null;

    for (const request of snapshot.requests) {
      await saveRequest(request);
    }
    writeRemoteDocuments(snapshot.documents);
    refreshSaved();
    setTeamSnapshot(snapshot);
    setSyncNonce((current) => current + 1);

    return { snapshot, pulled: snapshot.requests.length };
  }

  function handleMerged() {
    refreshSaved();
    setSyncNonce((current) => current + 1);
  }

  async function handleRunTests(folder: ApiFolder) {
    setTestRun({ name: folder.name, running: true, results: [] });
    try {
      const results = await runCollectionTests(folder.id, currentVariables);
      setTestRun({ name: folder.name, running: false, results });
    } catch {
      setTestRun({ name: folder.name, running: false, results: [] });
    }
  }

  function createRequestHere() {
    const target =
      activeRequest.collectionId ?? allRequests[0]?.collectionId ?? folders[0]?.id;
    if (target) void handleCreateRequest(target);
  }

  if (!session) {
    return (
      <AntProvider mode={mode} density={density}>
        <AntApp className="ant-app-root">
          <LoginScreen onSignedIn={setSession} />
        </AntApp>
      </AntProvider>
    );
  }

  return (
    <AntProvider mode={mode} density={density}>
      <AntApp className="ant-app-root">
        <div className="app-shell">
          <TopBar
            mode={mode}
            density={density}
            networkMode={networkMode}
            environment={environment}
            environments={workspaceEnvs}
            session={session}
            onToggleMode={toggleMode}
            onDensityChange={changeDensity}
            onNetworkModeChange={setNetworkMode}
            onEnvironmentChange={setEnvironment}
            onSignOut={handleSignOut}
            onOpenPalette={() => setPaletteOpen(true)}
          />

          <div className="workspace">
            <Sidebar
              activeRequestId={activeRequestId}
              folders={folders}
              history={history}
              savedRequests={savedRequests}
              environment={environment}
              workspaceEnvironments={workspaceEnvs}
              session={session}
              teamRevision={teamSnapshot?.revision ?? null}
              teamUpdatedAt={teamSnapshot?.updatedAt ?? null}
              onSelectRequest={selectRequest}
              onReplayHistory={replayHistory}
              onEnvironmentChange={setEnvironment}
              onSaveEnvironment={handleSaveEnvironment}
              onCreateEnvironment={handleCreateEnvironment}
              onDeleteEnvironment={handleDeleteEnvironment}
              onPush={handlePush}
              onPull={handlePull}
              onMerged={handleMerged}
              onCreateCollection={handleCreateCollection}
              onRenameCollection={handleRenameCollection}
              onDeleteCollection={handleDeleteCollection}
              onCreateRequest={handleCreateRequest}
              onRenameRequest={handleRenameRequest}
              onDeleteRequest={handleDeleteRequest}
              onImport={handleImport}
              onRunTests={handleRunTests}
              onDeleteHistory={handleDeleteHistory}
              onClearHistory={handleClearHistory}
            />
            {allRequests.length === 0 ? (
              <section className="workspace-empty">
                <strong>还没有请求</strong>
                <p>创建一个集合与第一条请求，或从 curl / Postman / OpenAPI 导入。</p>
                <Button type="primary" onClick={() => setBootstrapOpen(true)}>
                  新建集合与请求
                </Button>
              </section>
            ) : openTabs.length === 0 ? (
              <section className="workspace-empty">
                <strong>未打开请求</strong>
                <p>从左侧集合中选择一个请求，或直接新建一条请求。</p>
                <div className="workspace-empty-actions">
                  <Button onClick={() => selectRequest(allRequests[0])}>
                    打开第一个请求
                  </Button>
                  <Button type="primary" onClick={createRequestHere}>
                    新建请求
                  </Button>
                </div>
              </section>
            ) : (
              <RequestPanel
                activeRequest={activeRequest}
                openTabs={openTabs}
                replay={replay}
                saved={activeSaved}
                variables={currentVariables}
                actor={session.account}
                collectionId={activeRequest.collectionId ?? ''}
                onSelectTab={selectTab}
                onCloseTab={closeTab}
                onCreateRequest={createRequestHere}
                onHistoryRecorded={refreshHistory}
                onSaved={refreshSaved}
                onQueued={() => setQueueNonce((current) => current + 1)}
                onContextChange={setRequestContext}
                onVariablesChange={(variables) =>
                  handleSaveEnvironment(environment, variables)
                }
              />
            )}
            <Suspense
              fallback={
                <aside className="ai-panel ai-panel-fallback">
                  <span>AI 文档助手加载中…</span>
                </aside>
              }
            >
              <AiPanel
                networkMode={networkMode}
                activeRequest={activeRequest}
                context={requestContext}
                syncNonce={syncNonce}
                actor={session.account}
              />
            </Suspense>
          </div>

          <StatusBar
            networkMode={networkMode}
            actor={session.account}
            queueNonce={queueNonce}
            onQueueChange={() => setQueueNonce((current) => current + 1)}
          />

          {paletteOpen && (
            <Suspense fallback={null}>
              <CommandPalette
                open={paletteOpen}
                requests={allRequests}
                onClose={() => setPaletteOpen(false)}
                onSelectRequest={selectRequest}
                onEnvironmentChange={setEnvironment}
                onNetworkModeChange={setNetworkMode}
              />
            </Suspense>
          )}

          <Modal
            open={bootstrapOpen}
            title="新建集合"
            width={400}
            okText="创建并新建请求"
            cancelText="取消"
            confirmLoading={bootstrapping}
            okButtonProps={{ disabled: !bootstrapName.trim() }}
            onOk={() => void handleCreateFirstRequest()}
            onCancel={() => setBootstrapOpen(false)}
          >
            <p className="bootstrap-hint">先给集合起个名字，创建后会同时新建一条请求。</p>
            <Input
              autoFocus
              value={bootstrapName}
              maxLength={40}
              onChange={(event) => setBootstrapName(event.target.value)}
              onPressEnter={() => void handleCreateFirstRequest()}
              placeholder="例如：订单服务"
              aria-label="集合名称"
            />
          </Modal>

          <TestRunModal
            open={testRun !== null}
            name={testRun?.name ?? ''}
            running={testRun?.running ?? false}
            results={testRun?.results ?? []}
            onClose={() => setTestRun(null)}
          />
        </div>
      </AntApp>
    </AntProvider>
  );
}
