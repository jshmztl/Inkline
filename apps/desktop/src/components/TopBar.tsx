import {
  ColumnHeightOutlined,
  LogoutOutlined,
  MoonOutlined,
  SearchOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Segmented, Select, Tooltip } from 'antd';
import type { Density, ThemeMode } from '@api-workbench/ui';
import { environments, networkModes, type NetworkMode } from '../data/mock';
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
}

const densityItems = [
  { key: 'compact', label: '紧凑 · 28px' },
  { key: 'default', label: '默认 · 32px' },
  { key: 'comfortable', label: '舒适 · 36px' },
];

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
}: TopBarProps) {
  const network = networkModes[networkMode];

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
        <Tooltip title="命令面板 · ⌘K">
          <Button type="text" size="small" icon={<SearchOutlined />} />
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
            <Button type="text" size="small" icon={<ColumnHeightOutlined />} />
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
    </header>
  );
}
