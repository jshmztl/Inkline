import { CloudSyncOutlined, DatabaseOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import { networkModes, type NetworkMode } from '../data/mock';

export function StatusBar({ networkMode }: { networkMode: NetworkMode }) {
  const network = networkModes[networkMode];

  return (
    <footer className="statusbar">
      <div className={`status-mode tone-${network.tone}`}>
        <span className={`mode-dot tone-${network.tone}`} />
        <strong>{network.label}</strong>
        <span>{network.description}</span>
      </div>
      <Tag className="level-tag level-l2">L2 敏感</Tag>

      <div className="statusbar-spacer" />

      <span className="status-item">
        <CloudSyncOutlined /> 同步正常 · 2 分钟前
      </span>
      <span className="status-sep" />
      <span className="status-item">
        <DatabaseOutlined /> SQLite 本地
      </span>
      <span className="status-sep" />
      <span className="status-item mono">v0.1.0</span>
    </footer>
  );
}
