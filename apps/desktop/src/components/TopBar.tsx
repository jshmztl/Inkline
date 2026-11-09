import { useEffect, useState } from 'react';
import {
  AuditOutlined,
  ColumnHeightOutlined,
  DeleteOutlined,
  LogoutOutlined,
  MoonOutlined,
  SearchOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { App, Button, Drawer, Dropdown, Segmented, Select, Tooltip } from 'antd';
import type { Density, ThemeMode } from '@api-workbench/ui';
import { environments, networkModes, type NetworkMode } from '../data/mock';
import { clearAudit, listAudit, type AuditEntry, type AuditType } from '../lib/audit';
import type { Session } from '../lib/session';

interface TopBarProps {
  mode: ThemeMode;
  density: Density;
  networkMode: NetworkMode;
  environment: string;
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
  { label: '同步', value: 'sync' },
];

const auditTypeLabel: Record<AuditType, string> = {
  request: '请求',
  'ai-task': 'AI',
  egress: '出网',
  sync: '同步',
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
  session,
  onToggleMode,
  onDensityChange,
  onNetworkModeChange,
  onEnvironmentChange,
  onSignOut,
  onOpenPalette,
}: TopBarProps) {
  const { message } = App.useApp();
  const network = networkModes[networkMode];
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>('all');
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    if (!auditOpen) return;
    setEntries(listAudit(200));
  }, [auditOpen]);

  const visibleEntries =
    auditFilter === 'all' ? entries : entries.filter((entry) => entry.type === auditFilter);

  function handleClear() {
    clearAudit();
    setEntries([]);
    message.success('审计日志已清空');
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
          <span>支付中台 · 私有部署</span>
        </div>
      </div>

      <div className="topbar-divider" />

      <div className="topbar-controls">
        <Select
          size="small"
          variant="borderless"
          value={environment}
          options={environments}
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
              { key: 'signout', label: '退出登录', icon: <LogoutOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'signout') onSignOut();
            },
          }}
        >
          <div className="avatar" title={`${session.name} · ${session.workspace}`}>
            {session.name.charAt(0)}
          </div>
        </Dropdown>
      </div>

      <Drawer
        open={auditOpen}
        title="审计日志"
        width={520}
        onClose={() => setAuditOpen(false)}
        extra={
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
          <div className="audit-empty">暂无审计记录。发送请求、建立文档任务或同步团队仓后会记入这里。</div>
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
    </header>
  );
}
