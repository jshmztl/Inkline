export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type NetworkMode = 'A' | 'B' | 'C';
export type DataLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface ApiRequest {
  id: string;
  method: HttpMethod;
  path: string;
  name: string;
  dataLevel: DataLevel;
  updatedAt: string;
  collectionId?: string;
}

export interface ApiFolder {
  id: string;
  name: string;
  parentId?: string | null;
  requests: ApiRequest[];
}

export interface NetworkModeMeta {
  id: NetworkMode;
  label: string;
  shortLabel: string;
  description: string;
  modelName: string;
  modelNote: string;
  tone: 'muted' | 'info' | 'warning';
}

export const networkModes: Record<NetworkMode, NetworkModeMeta> = {
  A: {
    id: 'A',
    label: 'A · 离线本地',
    shortLabel: 'A 离线',
    description: '仅本地数据库与本地模型',
    modelName: '本地模型',
    modelNote: '仅本地推理 · 数据不出域',
    tone: 'muted',
  },
  B: {
    id: 'B',
    label: 'B · 内网 AI 网关',
    shortLabel: 'B 内网',
    description: '内网模型网关 · 数据不出域',
    modelName: '内网网关',
    modelNote: '内网模型 · 数据不出域',
    tone: 'info',
  },
  C: {
    id: 'C',
    label: 'C · 受限外网',
    shortLabel: 'C 外网',
    description: '脱敏后调用外部模型 · 需审批',
    modelName: '外部模型',
    modelNote: '已脱敏 · 需审批',
    tone: 'warning',
  },
};

export interface KvRow {
  id: string;
  key: string;
  value: string;
  description: string;
  enabled: boolean;
}
