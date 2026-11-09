import {
  ColumnHeightOutlined,
  MoonOutlined,
  SearchOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Segmented, Select, Tooltip } from 'antd';
import type { Density, ThemeMode } from '@api-workbench/ui';
import { environments, networkModes, type NetworkMode } from '../data/mock';

interface TopBarProps {
  mode: ThemeMode;
  density: Density;
  networkMode: NetworkMode;
  environment: string;
  onToggleMode: () => void;
  onDensityChange: (density: Density) => void;
  onNetworkModeChange: (mode: NetworkMode) => void;
  onEnvironmentChange: (environment: string) => void;
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
  onToggleMode,
  onDensityChange,
  onNetworkModeChange,
  onEnvironmentChange,
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
        <div className="avatar" title="林默 · 平台工程">
          L
        </div>
      </div>
    </header>
  );
}
