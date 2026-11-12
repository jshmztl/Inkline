import { EyeOutlined, FileTextOutlined } from '@ant-design/icons';
import { Button, Tag } from 'antd';
import type { DocTask } from '../lib/docTask';
import type { ModelRoute } from '../lib/modelRoute';
import type { NetworkScope } from '../lib/networkPolicy';

interface AiTaskPanelProps {
  task: DocTask | null;
  route: ModelRoute;
  routeBlocked: boolean;
  routeReason: string;
  gatewayBaseUrl: string;
  gatewayScope: NetworkScope | null;
  maskCount: number;
  onRunTask: () => void;
  onOpenDoc: () => void;
}

// 文档任务概览：字段统计、模型路由与操作入口。
export function AiTaskPanel({
  task,
  route,
  routeBlocked,
  routeReason,
  gatewayBaseUrl,
  gatewayScope,
  maskCount,
  onRunTask,
  onOpenDoc,
}: AiTaskPanelProps) {
  return (
    <div className="ai-task">
      <div className="ai-task-head">
        <strong>文档任务</strong>
        <Tag className={`task-state${task ? ' ready' : ''}`}>
          {task ? '上下文就绪' : '等待上下文'}
        </Tag>
      </div>
      <div className="ai-task-sources">
        <span>
          <code>{task?.stats.requestFields ?? 0}</code> 请求字段
        </span>
        <span>
          <code>{task?.stats.responseFields ?? 0}</code> 响应字段
        </span>
        <span>
          <code>{task?.stats.glossaryHits ?? 0}</code> 术语命中
        </span>
      </div>
      {task && task.glossary.length > 0 && (
        <div className="ai-task-terms">
          术语：{task.glossary.map((hit) => hit.entry.term).join(' · ')}
        </div>
      )}
      <div className={`ai-route${routeBlocked ? ' blocked' : ''}`}>
        <i className="ai-route-dot" />
        <code>{gatewayBaseUrl || route.endpoint}</code>
        <span>
          {gatewayScope === 'public' ? '公网地址' : route.egress ? '出网' : '不出网'}
        </span>
        {route.approval && <span>需审批</span>}
        {route.egress && <span>脱敏 {maskCount} 项</span>}
      </div>
      {routeReason && <div className="ai-route-warn">{routeReason}</div>}
      <div className="ai-task-actions">
        <Button
          type="primary"
          size="small"
          icon={<FileTextOutlined />}
          onClick={onRunTask}
          disabled={!task}
        >
          建立文档任务
        </Button>
        <Button
          variant="text"
          size="small"
          color="cyan"
          icon={<EyeOutlined />}
          onClick={onOpenDoc}
          disabled={!task}
        >
          查看文档
        </Button>
        <span>生成后自动打开文档预览</span>
      </div>
    </div>
  );
}
