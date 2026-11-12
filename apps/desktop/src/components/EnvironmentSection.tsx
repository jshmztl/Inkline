import { PlusOutlined } from '@ant-design/icons';
import { App, Button, Dropdown, Tooltip } from 'antd';
import type { WorkspaceEnvironment } from '../lib/envStore';

interface EnvironmentSectionProps {
  workspaceEnvironments: WorkspaceEnvironment[];
  environment: string;
  onEnvironmentChange: (environment: string) => void;
  onEditEnvironment: (value: string) => void;
  onNewEnvironment: () => void;
  onDeleteEnvironment: (environment: string) => void;
}

/** 环境区：环境列表、右键编辑/删除与新增入口。 */
export function EnvironmentSection({
  workspaceEnvironments,
  environment,
  onEnvironmentChange,
  onEditEnvironment,
  onNewEnvironment,
  onDeleteEnvironment,
}: EnvironmentSectionProps) {
  const { modal } = App.useApp();

  function confirmDeleteEnvironment(value: string, label: string) {
    modal.confirm({
      title: '删除环境',
      content: `确定删除「${label}」及其变量？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => onDeleteEnvironment(value),
    });
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-head">
        <span>环境</span>
        <span className="sidebar-head-actions">
          <span className="sidebar-count">{workspaceEnvironments.length}</span>
          <Tooltip title="新增环境">
            <Button
              type="text"
              size="small"
              className="sidebar-icon-btn"
              icon={<PlusOutlined />}
              aria-label="新增环境"
              onClick={onNewEnvironment}
            />
          </Tooltip>
        </span>
      </div>
      {workspaceEnvironments.length === 0 && (
        <p className="sidebar-empty">暂无环境，点击 + 新增。</p>
      )}
      {workspaceEnvironments.map((item) => {
        const host = item.variables.host ?? '';
        return (
          <Dropdown
            key={item.value}
            trigger={['contextMenu']}
            menu={{
              items: [
                { key: 'edit', label: '编辑变量' },
                { key: 'delete', label: '删除环境', danger: true },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'edit') onEditEnvironment(item.value);
                if (key === 'delete') confirmDeleteEnvironment(item.value, item.label);
              },
            }}
          >
            <button
              type="button"
              className={`environment-row${item.value === environment ? ' active' : ''}`}
              onClick={() => onEnvironmentChange(item.value)}
              onDoubleClick={() => onEditEnvironment(item.value)}
              title={`${host || '未设置 host'} · 双击编辑变量`}
            >
              <i />
              <span>{item.label}</span>
              <em>{host.replace(/^https?:\/\//, '')}</em>
            </button>
          </Dropdown>
        );
      })}
    </div>
  );
}
