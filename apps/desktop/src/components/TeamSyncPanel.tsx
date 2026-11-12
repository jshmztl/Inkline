import { useMemo, useState } from 'react';
import {
  CloudDownloadOutlined,
  CloudSyncOutlined,
  CloudUploadOutlined,
  MergeCellsOutlined,
} from '@ant-design/icons';
import { App, Button, Modal, Segmented, Tooltip } from 'antd';
import type { NetworkMode } from '../data/types';
import { saveRequest, type SavedRequest } from '../lib/api';
import { recordAudit } from '../lib/audit';
import { formatSavedAt } from '../lib/format';
import { planThreeWayMerge } from '../lib/merge';
import type { Session } from '../lib/session';
import { TeamApiError, type TeamAccess } from '../lib/teamClient';
import {
  collectLocalDocuments,
  readTeamBase,
  readTeamSnapshot,
  writeTeamBase,
  type TeamSnapshot,
} from '../lib/team';

interface TeamSyncPanelProps {
  session: Session;
  networkMode: NetworkMode;
  teamRevision: number | null;
  teamUpdatedAt: string | null;
  teamAccess: TeamAccess | null;
  savedRequests: SavedRequest[];
  onPush: () => Promise<TeamSnapshot>;
  onPull: () => Promise<{ snapshot: TeamSnapshot; pulled: number } | null>;
  onMerged: () => void;
}

const roleLabels: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
};

/** 团队同步区：推送/拉取、三方合并弹窗与状态展示。 */
export function TeamSyncPanel({
  session,
  networkMode,
  teamRevision,
  teamUpdatedAt,
  teamAccess,
  savedRequests,
  onPush,
  onPull,
  onMerged,
}: TeamSyncPanelProps) {
  const { message } = App.useApp();
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [docCount, setDocCount] = useState(() => Object.keys(collectLocalDocuments()).length);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'local' | 'remote'>>({});

  const plan = useMemo(() => {
    if (!mergeOpen) return null;
    const teamId = session.team?.id;
    const remote = readTeamSnapshot(teamId);
    if (!remote) return null;
    const base = readTeamBase(teamId);
    return planThreeWayMerge(base?.requests ?? [], savedRequests, remote.requests);
  }, [mergeOpen, savedRequests, session.team?.id]);

  const remoteTeam = session.mode === 'team';
  const canPush = !remoteTeam || (teamAccess?.canPush ?? true);
  const syncAllowed = !remoteTeam || networkMode !== 'A';

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
      const remote = readTeamSnapshot(session.team?.id);
      if (remote) writeTeamBase(remote, session.team?.id);
      recordAudit({
        type: 'sync',
        action: '三方合并',
        detail: `拉取 ${plan.remoteChanges.length} 条 · 冲突 ${plan.conflicts.length} 条`,
        actor: session.name,
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
    if (!syncAllowed) {
      message.warning('当前为 A 离线模式，不会连接团队服务');
      return;
    }
    if (!canPush) {
      message.warning('当前账号为只读角色，不能推送团队快照');
      return;
    }
    setSyncing('push');
    try {
      const snapshot = await onPush();
      setDocCount(Object.keys(snapshot.documents).length);
      setLastSync(`已推送 rev ${snapshot.revision}`);
      recordAudit({
        type: 'sync',
        action: `推送团队快照 rev ${snapshot.revision}`,
        detail:
          snapshot.deltaChanges != null
            ? `增量 ${snapshot.deltaChanges} 个变更 · ${snapshot.requests.length} 个请求`
            : `${snapshot.requests.length} 个请求 · ${Object.keys(snapshot.documents).length} 份文档`,
        actor: session.name,
      });
      message.success(
        snapshot.deltaChanges != null
          ? `已推送 rev ${snapshot.revision} · ${snapshot.deltaChanges} 个变更（增量）`
          : `已推送 rev ${snapshot.revision} · ${snapshot.requests.length} 个请求`,
      );
    } catch (error) {
      if (error instanceof TeamApiError && error.code === 'no_changes') {
        message.info('没有需要推送的变更');
        return;
      }
      if (error instanceof TeamApiError && error.code === 'revision_conflict') {
        setLastSync('远端有更新，待合并');
        message.warning('团队已有更新版本，已获取远端快照，请先完成三方合并再推送');
        openMerge();
      } else {
        message.error(error instanceof Error ? error.message : '推送失败，请稍后重试');
      }
    } finally {
      setSyncing(null);
    }
  }

  async function handlePull() {
    if (!syncAllowed) {
      message.warning('当前为 A 离线模式，不会连接团队服务');
      return;
    }
    setSyncing('pull');
    try {
      const result = await onPull();
      if (!result) {
        setLastSync(remoteTeam ? '团队还没有快照' : '本地快照为空');
        message.info(remoteTeam ? '团队还没有快照，请先推送一次' : '本地快照为空，请先推送一次');
        return;
      }
      setDocCount(Object.keys(result.snapshot.documents).length);
      setLastSync(`已拉取 rev ${result.snapshot.revision}`);
      recordAudit({
        type: 'sync',
        action: `拉取团队快照 rev ${result.snapshot.revision}`,
        detail: `${result.pulled} 个请求 · ${Object.keys(result.snapshot.documents).length} 份文档`,
        actor: session.name,
      });
      message.success(`已拉取 rev ${result.snapshot.revision} · ${result.pulled} 个请求`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拉取失败，请稍后重试');
    } finally {
      setSyncing(null);
    }
  }

  return (
    <>
      <div
        className="sidebar-sync"
        title={`${remoteTeam ? session.team?.serverUrl : session.workspace} · ${
          teamUpdatedAt ? `更新于 ${formatSavedAt(teamUpdatedAt)}` : '尚未推送'
        }`}
      >
        <CloudSyncOutlined />
        <div className="sidebar-sync-body">
          <strong>
            {teamRevision != null
              ? `${remoteTeam ? '团队快照' : '本地快照'} rev ${teamRevision}`
              : `${remoteTeam ? '团队快照' : '本地快照'}尚未建立`}
          </strong>
          <span>
            {lastSync ??
              (remoteTeam && teamAccess
                ? `${roleLabels[teamAccess.role] ?? teamAccess.role} · ${savedRequests.length} 个请求 · ${docCount} 份文档`
                : `${savedRequests.length} 个请求 · ${docCount} 份文档草稿`)}
          </span>
        </div>
        <div className="sidebar-sync-actions">
          <Tooltip
            title={
              !syncAllowed
                ? 'A 离线模式下不连接团队服务'
                : canPush
                  ? remoteTeam
                    ? '推送到团队服务'
                    : '推送到本地快照'
                  : '只读角色不能推送'
            }
          >
            <Button
              variant="text"
              size="small"
              color="green"
              icon={<CloudUploadOutlined />}
              loading={syncing === 'push'}
              disabled={!canPush || !syncAllowed || syncing === 'pull'}
              onClick={handlePush}
              aria-label="推送快照"
            />
          </Tooltip>
          <Tooltip
            title={
              !syncAllowed
                ? 'A 离线模式下不连接团队服务'
                : remoteTeam
                  ? '从团队服务拉取'
                  : '从本地快照拉取'
            }
          >
            <Button
              variant="text"
              size="small"
              color="cyan"
              icon={<CloudDownloadOutlined />}
              loading={syncing === 'pull'}
              disabled={
                !syncAllowed || syncing === 'push' || (!remoteTeam && teamRevision == null)
              }
              onClick={handlePull}
              aria-label="拉取快照"
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
          <div className="merge-empty">本地快照为空，请先推送一次。</div>
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
    </>
  );
}
