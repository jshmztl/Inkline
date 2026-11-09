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
  requests: ApiRequest[];
}

export const folders: ApiFolder[] = [
  {
    id: 'payment',
    name: '支付服务',
    requests: [
      { id: 'orders-list', method: 'GET', path: '/v1/orders', name: '查询订单列表', dataLevel: 'L1', updatedAt: '2 分钟前' },
      { id: 'orders-create', method: 'POST', path: '/v1/orders', name: '创建支付订单', dataLevel: 'L2', updatedAt: '刚刚' },
      { id: 'orders-detail', method: 'GET', path: '/v1/orders/{id}', name: '查询订单详情', dataLevel: 'L1', updatedAt: '1 小时前' },
      { id: 'refunds-create', method: 'POST', path: '/v1/refunds', name: '创建退款', dataLevel: 'L2', updatedAt: '昨天' },
    ],
  },
  {
    id: 'user',
    name: '用户服务',
    requests: [
      { id: 'users-detail', method: 'GET', path: '/v1/users/{id}', name: '查询用户', dataLevel: 'L2', updatedAt: '3 天前' },
      { id: 'users-create', method: 'POST', path: '/v1/users', name: '创建用户', dataLevel: 'L2', updatedAt: '3 天前' },
      { id: 'auth-token', method: 'POST', path: '/v1/auth/token', name: '签发访问令牌', dataLevel: 'L3', updatedAt: '5 天前' },
    ],
  },
];

export const allRequests = folders.flatMap((folder) => folder.requests);

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

export const environments = [
  { value: 'local', label: '本地环境' },
  { value: 'dev', label: '开发环境' },
  { value: 'staging', label: '预发环境' },
  { value: 'prod', label: '生产环境' },
];

export const environmentVariables: Record<string, Record<string, string>> = {
  local: {
    host: 'http://127.0.0.1:8080',
    PAYMENT_TOKEN: 'local_dev_token_9f2c',
    tenantId: 'tenant_2048',
  },
  dev: {
    host: 'https://dev-api.internal',
    PAYMENT_TOKEN: 'dev_token_7f3a',
    tenantId: 'tenant_2048',
  },
  staging: {
    host: 'https://staging-api.internal',
    PAYMENT_TOKEN: 'staging_token_4b81',
    tenantId: 'tenant_1024',
  },
  prod: {
    host: 'https://api.internal',
    PAYMENT_TOKEN: 'prod_token_2c90',
    tenantId: 'tenant_1024',
  },
};

export interface KvRow {
  id: string;
  key: string;
  value: string;
  description: string;
  enabled: boolean;
}

export const queryParams: KvRow[] = [
  { id: 'page', key: 'page', value: '1', description: '页码，从 1 开始', enabled: true },
  { id: 'pageSize', key: 'pageSize', value: '20', description: '每页条数，最大 100', enabled: true },
  { id: 'status', key: 'status', value: 'paid', description: '订单状态筛选', enabled: true },
  { id: 'createdFrom', key: 'createdFrom', value: '2026-11-01T00:00:00Z', description: '创建时间下限', enabled: false },
];

export const headerRows: KvRow[] = [
  { id: 'authorization', key: 'Authorization', value: 'Bearer {{PAYMENT_TOKEN}}', description: '环境变量注入', enabled: true },
  { id: 'content-type', key: 'Content-Type', value: 'application/json', description: '请求体类型', enabled: true },
  { id: 'request-id', key: 'X-Request-Id', value: '{{$uuid}}', description: '自动生成，便于追踪', enabled: true },
  { id: 'tenant', key: 'X-Tenant-Id', value: 'tenant_2048', description: '租户标识', enabled: false },
];

export const requestBody = `{
  "amount": 12800,
  "currency": "CNY",
  "idempotencyKey": "ord_20261109_7f3a",
  "channel": "wechat_pay",
  "description": "年度订阅 · 专业版",
  "metadata": {
    "plan": "pro",
    "seats": 12,
    "tenantId": "{{tenantId}}"
  }
}`;

export const thoughtSteps = [
  { label: '读取请求与响应示例', detail: '3 个字段 · 2 条响应', state: 'done' as const },
  { label: '匹配团队字段术语表', detail: '命中 12 条术语', state: 'done' as const },
  { label: '生成文档草稿', detail: 'OpenAPI 3.1 · 8 个字段', state: 'done' as const },
  { label: '等待人工确认', detail: '3 项待审阅', state: 'running' as const },
];
