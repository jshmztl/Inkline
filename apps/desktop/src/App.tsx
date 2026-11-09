import { useEffect, useState } from 'react';
import { App as AntApp } from 'antd';
import { AntProvider, type Density, type ThemeMode } from '@api-workbench/ui';
import type { ApiRequest, HttpMethod, NetworkMode } from './data/mock';
import { allRequests } from './data/mock';
import { listHistory, listRequests, saveRequest, type HistoryEntry, type SavedRequest } from './lib/api';
import type { RequestContext } from './lib/docTask';
import {
  collectLocalDocuments,
  pullTeamSnapshot,
  pushTeamSnapshot,
  readTeamSnapshot,
  writeRemoteDocuments,
  type TeamSnapshot,
} from './lib/team';
import { AiPanel } from './components/AiPanel';
import { LoginScreen } from './components/LoginScreen';
import { RequestPanel } from './components/RequestPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { readSession, signOut, type Session } from './lib/session';

const initialOpenTabs = ['orders-create', 'orders-list', 'refunds-create'];

function readStoredMode(): ThemeMode {
  return localStorage.getItem('aw-theme') === 'dark' ? 'dark' : 'light';
}

function readStoredDensity(): Density {
  const stored = localStorage.getItem('aw-density');
  if (stored === 'compact' || stored === 'comfortable') return stored;
  return 'default';
}

export function App() {
  const [session, setSession] = useState<Session | null>(readSession);
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);
  const [density, setDensity] = useState<Density>(readStoredDensity);
  const [networkMode, setNetworkMode] = useState<NetworkMode>('B');
  const [environment, setEnvironment] = useState('local');
  const [activeRequestId, setActiveRequestId] = useState('orders-create');
  const [openTabIds, setOpenTabIds] = useState<string[]>(initialOpenTabs);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [requestContext, setRequestContext] = useState<RequestContext | null>(null);
  const [teamSnapshot, setTeamSnapshot] = useState<TeamSnapshot | null>(readTeamSnapshot);
  const [syncNonce, setSyncNonce] = useState(0);
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
    return () => {
      alive = false;
    };
  }, []);

  const activeRequest =
    allRequests.find((request) => request.id === activeRequestId) ?? allRequests[0];
  const activeSaved =
    savedRequests.find((request) => request.id === activeRequestId) ?? null;

  const openTabs = openTabIds
    .map((id) => allRequests.find((request) => request.id === id))
    .filter((request): request is ApiRequest => Boolean(request));

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
    setActiveRequestId(request.id);
    setOpenTabIds((current) =>
      current.includes(request.id) ? current : [...current, request.id],
    );
  }

  function selectTab(requestId: string) {
    setActiveRequestId(requestId);
  }

  function closeTab(requestId: string) {
    if (openTabIds.length <= 1) return;
    const next = openTabIds.filter((id) => id !== requestId);
    setOpenTabIds(next);
    if (requestId === activeRequestId) {
      setActiveRequestId(next[next.length - 1]);
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

  function refreshSaved() {
    listRequests()
      .then(setSavedRequests)
      .catch(() => {
        // 忽略已保存请求刷新失败。
      });
  }

  function handleSignOut() {
    signOut();
    setSession(null);
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
            session={session}
            onToggleMode={toggleMode}
            onDensityChange={changeDensity}
            onNetworkModeChange={setNetworkMode}
            onEnvironmentChange={setEnvironment}
            onSignOut={handleSignOut}
          />

          <div className="workspace">
            <Sidebar
              activeRequestId={activeRequestId}
              history={history}
              savedRequests={savedRequests}
              environment={environment}
              session={session}
              teamRevision={teamSnapshot?.revision ?? null}
              teamUpdatedAt={teamSnapshot?.updatedAt ?? null}
              onSelectRequest={selectRequest}
              onReplayHistory={replayHistory}
              onEnvironmentChange={setEnvironment}
              onPush={handlePush}
              onPull={handlePull}
            />
            <RequestPanel
              activeRequest={activeRequest}
              openTabs={openTabs}
              replay={replay}
              saved={activeSaved}
              environment={environment}
              onSelectTab={selectTab}
              onCloseTab={closeTab}
              onHistoryRecorded={refreshHistory}
              onSaved={refreshSaved}
              onContextChange={setRequestContext}
            />
            <AiPanel
              networkMode={networkMode}
              activeRequest={activeRequest}
              context={requestContext}
              syncNonce={syncNonce}
            />
          </div>

          <StatusBar networkMode={networkMode} />
        </div>
      </AntApp>
    </AntProvider>
  );
}
