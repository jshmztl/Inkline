import { useEffect, useState } from 'react';
import {
  AuditOutlined,
  CloudDownloadOutlined,
  ColumnHeightOutlined,
  DeleteOutlined,
  LogoutOutlined,
  MoonOutlined,
  SearchOutlined,
  SunOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { App, Button, Drawer, Dropdown, Modal, Progress, Segmented, Select, Tooltip } from 'antd';
import type { Density, ThemeMode } from '@api-workbench/ui';
import { networkModes, type NetworkMode } from '../data/types';
import { clearAudit, listAudit, type AuditEntry, type AuditType } from '../lib/audit';
import type { Session } from '../lib/session';
import { checkUpdate, installUpdate, type UpdateInfo, type UpdateProgress } from '../lib/update';

interface TopBarProps {
  mode: ThemeMode;
  density: Density;
  networkMode: NetworkMode;
  environment: string;
  environments: { value: string; label: string }[];
  session: Session;
  onToggleMode: () => void;
  onDensityChange: (density: Density) => void;
  onNetworkModeChange: (mode: NetworkMode) => void;
  onEnvironmentChange: (environment: string) => void;
  onSignOut: () => void;
  onOpenPalette: () => void;
}

const densityItems = [
  { key: 'compact', label: '紧凑 · 28px' },
  { key: 'default', label: '默认 · 32px' },
  { key: 'comfortable', label: '舒适 · 36px' },
];

type AuditFilter = 'all' | AuditType;

const auditFilters: { label: string; value: AuditFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '请求', value: 'request' },
  { label: 'AI', value: 'ai-task' },
  { label: '出网', value: 'egress' },
  { label: '本机快照', value: 'sync' },
];

const auditTypeLabel: Record<AuditType, string> = {
  request: '请求',
  'ai-task': 'AI',
  egress: '出网',
  sync: '本机快照',
};

function formatAuditTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function TopBar({
  mode,
  density,
  networkMode,
  environment,
  environments,
  session,
  onToggleMode,
  onDensityChange,
  onNetworkModeChange,
  onEnvironmentChange,
  onSignOut,
  onOpenPalette,
}: TopBarProps) {
  const { message, notification } = App.useApp();
  const network = networkModes[networkMode];
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>('all');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0, total: null });

  useEffect(() => {
    if (!auditOpen) return;
    let alive = true;
    void listAudit(200).then((next) => {
      if (alive) setEntries(next);
    });
    return () => {
      alive = false;
    };
  }, [auditOpen]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const info = await checkUpdate();
        if (cancelled || !info.available) return;
        setUpdateInfo(info);
        notification.open({
          key: 'update-available',
          message: `发现新版本 v${info.latest}`,
          description: info.notes || '可在账户菜单中查看并安装。',
          placement: 'bottomRight',
          duration: 0,
          btn: (
            <Button
              size="small"
              type="primary"
              onClick={() => {
                notification.destroy('update-available');
                setUpdateOpen(true);
              }}
            >
              查看更新
            </Button>
          ),
        });
      } catch {
        // 启动检查静默失败，手动检查时再展示错误。
      }
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [notification]);

  const visibleEntries =
    auditFilter === 'all' ? entries : entries.filter((entry) => entry.type === auditFilter);

  async function handleClear() {
    await clearAudit();
    setEntries([]);
    message.success('审计日志已清空');
  }

  function handleExport() {
    if (entries.length === 0) {
      message.info('暂无可导出的审计记录');
      return;
    }
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `api-workbench-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 ${entries.length} 条审计记录`);
  }

  async function handleCheckUpdate() {
    setUpdateOpen(true);
    setChecking(true);
    setUpdateError(null);
    setUpdateInfo(null);
    try {
      setUpdateInfo(await checkUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  async function handleInstallUpdate() {
    setInstalling(true);
    setUpdateError(null);
    setProgress({ downloaded: 0, total: null });
    try {
      await installUpdate(setProgress);
      message.success('更新已安装，正在重启…');
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
      setInstalling(false);
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="brand-glyph" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="brand-text">
          <strong>API Workbench</strong>
          <span>{session.workspace} · 私有部署</span>
        </div>
      </div>

      <div className="topbar-divider" />

      <div className="topbar-controls">
        <Select
          size="small"
          variant="borderless"
          value={environment}
          options={environments}
          placeholder="未选择环境"
          onChange={onEnvironmentChange}
          popupMatchSelectWidth={false}
          className="environment-select"
        />
        <span className="topbar-divider short" />
        <span className={`mode-dot tone-${network.tone}`} />
        <Segmented
          size="small"
          value={networkMode}
          options={[
            { label: 'A 离线', value: 'A' },
            { label: 'B 内网', value: 'B' },
            { label: 'C 外网', value: 'C' },
          ]}
          onChange={(value) => onNetworkModeChange(value as NetworkMode)}
        />
        <Tooltip title={network.description}>
          <span className={`network-label tone-${network.tone}`}>{network.label}</span>
        </Tooltip>
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-actions">
        <Tooltip title="审计日志">
          <Button
            type="text"
            size="small"
            icon={<AuditOutlined />}
            aria-label="审计日志"
            onClick={() => setAuditOpen(true)}
          />
        </Tooltip>
        <Tooltip title="命令面板 · ⌘K">
          <Button
            type="text"
            size="small"
            icon={<SearchOutlined />}
            aria-label="命令面板"
            onClick={onOpenPalette}
          />
        </Tooltip>
        <Tooltip title={mode === 'light' ? '切换到暗色' : '切换到亮色'}>
          <Button
            type="text"
            size="small"
            icon={mode === 'light' ? <MoonOutlined /> : <SunOutlined />}
            onClick={onToggleMode}
          />
        </Tooltip>
        <Dropdown
          menu={{
            items: densityItems,
            selectedKeys: [density],
            onClick: ({ key }) => onDensityChange(key as Density),
          }}
          trigger={['click']}
        >
          <Tooltip title="界面密度">
            <Button type="text" size="small" icon={<ColumnHeightOutlined />} aria-label="界面密度" />
          </Tooltip>
        </Dropdown>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                key: 'account',
                label: `${session.name} · ${session.role}`,
                disabled: true,
              },
              { type: 'divider' },
              { key: 'update', label: '检查更新', icon: <CloudDownloadOutlined /> },
              { key: 'signout', label: '退出登录', icon: <LogoutOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'signout') onSignOut();
              if (key === 'update') handleCheckUpdate();
            },
          }}
        >
          <button
            type="button"
            className="avatar"
            aria-label="账户菜单"
            aria-haspopup="menu"
            title={`${session.name} · ${session.workspace}`}
          >
            {session.name.charAt(0)}
          </button>
        </Dropdown>
      </div>

      <Drawer
        open={auditOpen}
        title="审计日志"
        width={520}
        onClose={() => setAuditOpen(false)}
        extra={
          <div style={{ display: 'flex', gap: 8 }}>
            <Tooltip title={entries.length === 0 ? '暂无记录' : '导出审计日志'}>
              <Button
                size="small"
                icon={<CloudDownloadOutlined />}
                onClick={handleExport}
                disabled={entries.length === 0}
              >
                导出
              </Button>
            </Tooltip>
            <Tooltip title={entries.length === 0 ? '暂无记录' : '清空审计日志'}>
              <Button
                size="small"
                icon={<DeleteOutlined />}
                onClick={handleClear}
                disabled={entries.length === 0}
              >
                清空
              </Button>
            </Tooltip>
          </div>
        }
      >
        <div className="audit-toolbar">
          <Segmented
            size="small"
            value={auditFilter}
            options={auditFilters}
            onChange={(value) => setAuditFilter(value as AuditFilter)}
          />
          <span className="audit-count">{visibleEntries.length} 条记录</span>
        </div>

        {visibleEntries.length === 0 ? (
          <div className="audit-empty">暂无审计记录。发送请求、建立文档任务或保存本地快照后会记入这里。</div>
        ) : (
          <div className="audit-list">
            {visibleEntries.map((entry) => (
              <div className="audit-row" key={entry.id}>
                <div className="audit-row-head">
                  <span className={`audit-type type-${entry.type}`}>
                    {auditTypeLabel[entry.type]}
                  </span>
                  <code>{entry.action}</code>
                  {entry.level && <em className={`audit-level level-${entry.level.toLowerCase()}`}>{entry.level}</em>}
                  <span className="audit-time">{formatAuditTime(entry.at)}</span>
                </div>
                <div className="audit-row-body">{entry.detail}</div>
                <div className="audit-row-foot">{entry.actor}</div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Modal
        open={updateOpen}
        title="检查更新"
        width={440}
        onCancel={() => {
          if (installing) return;
          setUpdateOpen(false);
        }}
        maskClosable={!installing}
        closable={!installing}
        footer={[
          <Button
            key="close"
            size="small"
            disabled={installing}
            onClick={() => setUpdateOpen(false)}
          >
            稍后
          </Button>,
          ...(updateInfo?.available && updateInfo.runtime === 'tauri'
            ? [
                <Button
                  key="install"
                  type="primary"
                  size="small"
                  loading={installing}
                  onClick={handleInstallUpdate}
                >
                  下载并安装
                </Button>,
              ]
            : []),
        ]}
      >
        {checking ? (
          <div className="update-checking">
            <SyncOutlined spin /> 正在检查更新…
          </div>
        ) : updateError ? (
          <div className="update-error">{updateError}</div>
        ) : updateInfo ? (
          <div className="update-body">
            <div className="update-row">
              <span>当前版本</span>
              <code>v{updateInfo.current}</code>
            </div>
            <div className="update-row">
              <span>最新版本</span>
              <code>v{updateInfo.latest}</code>
            </div>
            <div className="update-row">
              <span>状态</span>
              <b className={updateInfo.available ? 'update-available' : ''}>
                {updateInfo.available ? '发现新版本' : '已是最新'}
              </b>
            </div>
            {updateInfo.date && (
              <div className="update-row">
                <span>发布时间</span>
                <code>{updateInfo.date.slice(0, 10)}</code>
              </div>
            )}
            {updateInfo.notes && <p className="update-note">{updateInfo.notes}</p>}
            {installing && (
              <div className="update-progress">
                <Progress
                  percent={
                    progress.total
                      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
                      : 0
                  }
                  size="small"
                  status="active"
                  showInfo={Boolean(progress.total)}
                />
                <span>
                  正在下载更新{' '}
                  {progress.total
                    ? `${(progress.downloaded / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB`
                    : `${(progress.downloaded / 1024).toFixed(0)} KB`}
                </span>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </header>
  );
}
