import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import type { ApiRequest, DataLevel } from '../data/types';
import { MethodTag } from './MethodTag';

interface RequestTabsProps {
  openTabs: ApiRequest[];
  activeRequestId: string;
  dataLevel: DataLevel;
  onSelectTab: (requestId: string) => void;
  onCloseTab: (requestId: string) => void;
  onCreateRequest: () => void;
}

export function RequestTabs({
  openTabs,
  activeRequestId,
  dataLevel,
  onSelectTab,
  onCloseTab,
  onCreateRequest,
}: RequestTabsProps) {
  return (
    <div className="request-tabs" role="tablist" aria-label="打开的请求">
      {openTabs.map((request) => (
        <button
          key={request.id}
          type="button"
          role="tab"
          aria-selected={request.id === activeRequestId}
          className={`request-tab${request.id === activeRequestId ? ' active' : ''}`}
          onClick={() => onSelectTab(request.id)}
        >
          <MethodTag method={request.method} />
          <span>{request.name || request.path || request.id}</span>
          <span
            className="tab-close"
            role="button"
            tabIndex={0}
            aria-label={`关闭 ${request.name || request.path}`}
            onClick={(event) => {
              event.stopPropagation();
              onCloseTab(request.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
                onCloseTab(request.id);
              }
            }}
          >
            <CloseOutlined />
          </span>
        </button>
      ))}
      <button
        type="button"
        className="tab-add"
        aria-label="新建请求"
        onClick={onCreateRequest}
      >
        <PlusOutlined />
      </button>
      <div className="request-tabs-spacer" />
      <Tag className={`level-tag level-${dataLevel.toLowerCase()}`}>{dataLevel}</Tag>
    </div>
  );
}
