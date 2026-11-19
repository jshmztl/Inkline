-- 团队级 AI 网关配置：API Key 仅保存在服务端，由团队服务代理转发请求。
CREATE TABLE IF NOT EXISTS team_ai_configs (
    team_id    uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    enabled    boolean NOT NULL DEFAULT false,
    provider   text NOT NULL DEFAULT 'custom',
    base_url   text NOT NULL DEFAULT '',
    model      text NOT NULL DEFAULT '',
    api_key    text NOT NULL DEFAULT '',
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
