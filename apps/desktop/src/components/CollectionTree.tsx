import { useMemo } from 'react';
import {
  CheckCircleFilled,
  DownOutlined,
  EditOutlined,
  FolderOpenOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { App, Dropdown, Tooltip } from 'antd';
import type { ApiFolder, ApiRequest } from '../data/types';
import { buildCollectionTree } from '../lib/collectionTree';
import type { SavedRequest } from '../lib/api';
import { formatSavedAt } from '../lib/format';
import { MethodTag } from './MethodTag';

/** 集合/请求命名弹窗的编辑状态，供侧边栏统一打开。 */
export interface CollectionEditorState {
  mode: 'create' | 'create-request' | 'rename-collection' | 'rename-request';
  id?: string;
  parentId?: string;
  value: string;
}

interface CollectionTreeProps {
  folders: ApiFolder[];
  query: string;
  collapsed: Record<string, boolean>;
  savedRequests: SavedRequest[];
  activeRequestId: string;
  isCollectionReadOnly: (collectionId: string) => boolean;
  isRequestReadOnly: (requestId: string) => boolean;
  onToggleCollapse: (id: string) => void;
  onSelectRequest: (request: ApiRequest) => void;
  onCreateRequest: (collectionId: string) => Promise<void>;
  onMoveCollection: (id: string, direction: -1 | 1) => Promise<void>;
  onDuplicateCollection: (id: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
  onMoveRequest: (id: string, direction: -1 | 1) => Promise<void>;
  onDuplicateRequest: (id: string) => Promise<void>;
  onDeleteRequest: (id: string) => Promise<void>;
  onRunTests: (folder: ApiFolder) => void;
  onExport: (folder: ApiFolder) => void;
  onOpenEditor: (editor: CollectionEditorState) => void;
}

/** 集合区：搜索过滤、树形渲染、右键菜单与删除确认。 */
export function CollectionTree({
  folders,
  query,
  collapsed,
  savedRequests,
  activeRequestId,
  isCollectionReadOnly,
  isRequestReadOnly,
  onToggleCollapse,
  onSelectRequest,
  onCreateRequest,
  onMoveCollection,
  onDuplicateCollection,
  onDeleteCollection,
  onMoveRequest,
  onDuplicateRequest,
  onDeleteRequest,
  onRunTests,
  onExport,
  onOpenEditor,
}: CollectionTreeProps) {
  const { modal } = App.useApp();

  const savedMap = useMemo(
    () => new Map(savedRequests.map((request) => [request.id, request])),
    [savedRequests],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return folders;
    return folders
      .map((folder) => ({
        ...folder,
        requests: folder.requests.filter(
          (request) =>
            request.path.toLowerCase().includes(keyword) ||
            request.name.toLowerCase().includes(keyword) ||
            request.method.toLowerCase().includes(keyword),
        ),
      }))
      .filter((folder) => folder.requests.length > 0);
  }, [folders, query]);

  const visibleFolders = useMemo(() => {
    if (query.trim()) {
      return filtered.map((folder) => ({ item: folder, depth: 0 }));
    }
    return buildCollectionTree(folders, collapsed);
  }, [collapsed, filtered, folders, query]);

  function confirmDeleteRequest(request: ApiRequest) {
    modal.confirm({
      title: '删除请求',
      content: `确定删除「${request.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => onDeleteRequest(request.id),
    });
  }

  function confirmDeleteCollection(folder: ApiFolder) {
    modal.confirm({
      title: '删除集合',
      content: `将删除「${folder.name}」及其 ${folder.requests.length} 个请求。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => onDeleteCollection(folder.id),
    });
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-head">
        <span>集合</span>
        <span className="sidebar-count">{folders.length}</span>
      </div>

      {visibleFolders.map(({ item: folder, depth }) => {
        const isCollapsed = collapsed[folder.id] ?? false;
        const folderReadOnly = isCollectionReadOnly(folder.id);
        const parentKey = folder.parentId ?? '';
        const siblings = folders.filter((item) => (item.parentId ?? '') === parentKey);
        const siblingIndex = siblings.findIndex((item) => item.id === folder.id);
        return (
          <div className="folder" key={folder.id} style={{ marginLeft: depth * 12 }}>
            <div className="folder-head-wrap">
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    { key: 'new', label: '新建请求', icon: <PlusOutlined />, disabled: folderReadOnly },
                    { key: 'new-folder', label: '新建子集合', disabled: folderReadOnly },
                    { key: 'rename', label: '重命名集合', disabled: folderReadOnly },
                    {
                      key: 'move-up',
                      label: '上移',
                      disabled: folderReadOnly || siblingIndex <= 0,
                    },
                    {
                      key: 'move-down',
                      label: '下移',
                      disabled: folderReadOnly || siblingIndex === siblings.length - 1,
                    },
                    { key: 'test', label: '运行测试集' },
                    { key: 'export', label: '导出集合 / 文档' },
                    { key: 'duplicate', label: '复制集合', disabled: folderReadOnly },
                    { type: 'divider' },
                    { key: 'delete', label: '删除集合', danger: true, disabled: folderReadOnly },
                  ],
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    if (folderReadOnly && key !== 'test' && key !== 'export') return;
                    if (key === 'new') onCreateRequest(folder.id);
                    if (key === 'new-folder') {
                      onOpenEditor({ mode: 'create', value: '', parentId: folder.id });
                    }
                    if (key === 'rename') {
                      onOpenEditor({
                        mode: 'rename-collection',
                        id: folder.id,
                        value: folder.name,
                      });
                    }
                    if (key === 'export') onExport(folder);
                    if (key === 'duplicate') void onDuplicateCollection(folder.id);
                    if (key === 'move-up') void onMoveCollection(folder.id, -1);
                    if (key === 'move-down') void onMoveCollection(folder.id, 1);
                    if (key === 'test') onRunTests(folder);
                    if (key === 'delete') confirmDeleteCollection(folder);
                  },
                }}
              >
                <button
                  type="button"
                  className="folder-head"
                  aria-expanded={!isCollapsed}
                  onClick={() => onToggleCollapse(folder.id)}
                  onDoubleClick={() => {
                    if (folderReadOnly) return;
                    onOpenEditor({
                      mode: 'rename-collection',
                      id: folder.id,
                      value: folder.name,
                    });
                  }}
                  title={folderReadOnly ? '只读集合' : '双击重命名集合'}
                >
                  <DownOutlined
                    className={`folder-caret${isCollapsed ? ' collapsed' : ''}`}
                  />
                  <FolderOpenOutlined />
                  <span>{folder.name}</span>
                  {folderReadOnly && (
                    <span className="request-lock" title="只读集合">
                      只读
                    </span>
                  )}
                  <em>{folder.requests.length}</em>
                </button>
              </Dropdown>
              {!folderReadOnly && (
                <Tooltip title="重命名集合">
                  <button
                    type="button"
                    className="row-edit"
                    aria-label={`重命名集合 ${folder.name}`}
                    onClick={() =>
                      onOpenEditor({
                        mode: 'rename-collection',
                        id: folder.id,
                        value: folder.name,
                      })
                    }
                  >
                    <EditOutlined />
                  </button>
                </Tooltip>
              )}
            </div>

            {!isCollapsed && (
              <div className="folder-body">
                {folder.requests.map((request, requestIndex) => {
                  const saved = savedMap.get(request.id);
                  const readOnly = isRequestReadOnly(request.id) || folderReadOnly;
                  return (
                    <div className="request-row-wrap" key={request.id}>
                      <Dropdown
                        trigger={['contextMenu']}
                        menu={{
                          items: [
                            { key: 'new', label: '新建请求', icon: <PlusOutlined />, disabled: folderReadOnly },
                            { key: 'rename', label: '重命名请求', disabled: readOnly },
                            {
                              key: 'move-up',
                              label: '上移',
                              disabled: readOnly || requestIndex === 0,
                            },
                            {
                              key: 'move-down',
                              label: '下移',
                              disabled: readOnly || requestIndex === folder.requests.length - 1,
                            },
                            { type: 'divider' },
                            { key: 'duplicate', label: '复制请求', disabled: readOnly },
                            { key: 'delete', label: '删除请求', danger: true, disabled: readOnly },
                          ],
                          onClick: ({ key: action, domEvent }) => {
                            domEvent.stopPropagation();
                            if (readOnly && action !== 'new') return;
                            if (action === 'new') onCreateRequest(folder.id);
                            if (action === 'rename') {
                              onOpenEditor({
                                mode: 'rename-request',
                                id: request.id,
                                value: request.name,
                              });
                            }
                            if (action === 'move-up') void onMoveRequest(request.id, -1);
                            if (action === 'move-down') void onMoveRequest(request.id, 1);
                            if (action === 'duplicate') void onDuplicateRequest(request.id);
                            if (action === 'delete') confirmDeleteRequest(request);
                          },
                        }}
                      >
                        <button
                          type="button"
                          className={`request-row${
                            request.id === activeRequestId ? ' active' : ''
                          }`}
                          onClick={() => onSelectRequest(request)}
                          onDoubleClick={() => {
                            if (readOnly) return;
                            onOpenEditor({
                              mode: 'rename-request',
                              id: request.id,
                              value: request.name,
                            });
                          }}
                          title={`${request.name} · ${request.path}${readOnly ? ' · 只读' : ' · 双击重命名'}`}
                        >
                          <MethodTag method={request.method} />
                          <span className="request-path">{request.name}</span>
                          {saved && (
                            <span
                              className="saved-flag"
                              title={`已保存 · ${formatSavedAt(saved.updatedAt)}`}
                            >
                              <CheckCircleFilled />
                            </span>
                          )}
                          {readOnly && (
                            <span className="request-lock" title="只读资源">
                              只读
                            </span>
                          )}
                          {request.dataLevel === 'L3' && (
                            <span className="request-lock" title="L3 涉密">
                              L3
                            </span>
                          )}
                        </button>
                      </Dropdown>
                      {!readOnly && (
                        <Tooltip title="重命名请求">
                          <button
                            type="button"
                            className="row-edit"
                            aria-label={`重命名请求 ${request.name}`}
                            onClick={() =>
                              onOpenEditor({
                                mode: 'rename-request',
                                id: request.id,
                                value: request.name,
                              })
                            }
                          >
                            <EditOutlined />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
