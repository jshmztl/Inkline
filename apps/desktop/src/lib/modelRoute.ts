import type { DataLevel, NetworkMode } from '../data/mock';

export interface ModelRoute {
  mode: NetworkMode;
  model: string;
  endpoint: string;
  egress: boolean;
  approval: boolean;
  allowed: boolean;
  reason: string;
}

export function resolveModelRoute(mode: NetworkMode, dataLevel: DataLevel): ModelRoute {
  if (mode === 'A') {
    return {
      mode,
      model: '本地模型',
      endpoint: 'local://qwen2.5-7b-instruct',
      egress: false,
      approval: false,
      allowed: true,
      reason: '本地推理，数据不出域',
    };
  }

  if (mode === 'B') {
    return {
      mode,
      model: '内网网关',
      endpoint: 'intranet://ai-gateway/v1/doc',
      egress: false,
      approval: false,
      allowed: true,
      reason: '内网模型网关，数据不出域',
    };
  }

  const allowed = dataLevel === 'L0' || dataLevel === 'L1';

  return {
    mode,
    model: '外部模型',
    endpoint: 'https://ai-gateway.example.com/v1/doc',
    egress: true,
    approval: true,
    allowed,
    reason: allowed
      ? '脱敏后出网，需人工审批'
      : `${dataLevel} 数据禁止出网，请切换到 A / B 模式`,
  };
}
