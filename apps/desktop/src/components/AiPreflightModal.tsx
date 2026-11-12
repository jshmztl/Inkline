import { Button, Modal } from 'antd';
import type { DataLevel } from '../data/types';
import type { EgressMask } from '../lib/egress';

interface AiPreflightModalProps {
  open: boolean;
  dataLevel: DataLevel;
  endpoint: string;
  masks: EgressMask[];
  onCancel: () => void;
  onApprove: () => void;
}

// 出网审批弹窗：展示分级、目标与脱敏结果。
export function AiPreflightModal({
  open,
  dataLevel,
  endpoint,
  masks,
  onCancel,
  onApprove,
}: AiPreflightModalProps) {
  return (
    <Modal
      open={open}
      title="出网预检"
      width={460}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" size="small" onClick={onCancel}>
          取消
        </Button>,
        <Button key="approve" type="primary" size="small" onClick={onApprove}>
          确认出网并生成
        </Button>,
      ]}
    >
      <div className="preflight">
        <div className="preflight-row">
          <span>数据分级</span>
          <b>{dataLevel}</b>
        </div>
        <div className="preflight-row">
          <span>出网目标</span>
          <code>{endpoint}</code>
        </div>
        <div className="preflight-row">
          <span>审批状态</span>
          <b className="warn">待人工审批</b>
        </div>
        <div className="preflight-row">
          <span>脱敏项</span>
          <b>{masks.length} 项</b>
        </div>
        <div className="preflight-masks">
          {masks.map((mask) => (
            <div className="preflight-mask" key={`${mask.location}:${mask.path}`}>
              <code>{mask.path}</code>
              <span>{mask.before}</span>
              <i>→</i>
              <span>{mask.after}</span>
            </div>
          ))}
          {masks.length === 0 && <div className="preflight-none">未发现敏感字段。</div>}
        </div>
        <p className="preflight-note">
          确认后将按脱敏结果发送到外部模型，操作会记入审计日志。
        </p>
      </div>
    </Modal>
  );
}
