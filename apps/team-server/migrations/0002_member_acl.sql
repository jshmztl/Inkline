-- 成员管理与资源级权限

-- 记录客户端原始 payload 的 hash，用于幂等判断；payload_hash 改为合并后的服务端快照 hash。
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS source_hash text;

-- 资源可见性策略：未命中的资源默认团队可见。
CREATE TABLE IF NOT EXISTS resource_policies (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('collection', 'request')),
  resource_id text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('team', 'restricted')),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, resource_type, resource_id)
);

-- 受限资源的授权对象：按成员或按角色。
CREATE TABLE IF NOT EXISTS resource_grants (
  team_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'role')),
  subject_id text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (team_id, resource_type, resource_id, subject_type, subject_id),
  FOREIGN KEY (team_id, resource_type, resource_id)
    REFERENCES resource_policies(team_id, resource_type, resource_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS resource_grants_subject_idx
  ON resource_grants (team_id, subject_type, subject_id);
