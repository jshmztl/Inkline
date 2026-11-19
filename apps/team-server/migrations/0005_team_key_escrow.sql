-- 服务端审阅：按团队密钥版本保存 KEK 包裹后的团队密钥副本。
-- KEK 不在数据库中，由服务端通过环境变量注入；本表只保存密文与 KEK 标识。
CREATE TABLE IF NOT EXISTS team_key_escrow (
    team_id      uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    key_version  integer NOT NULL,
    wrapped_key  text NOT NULL,
    kek_kid      text NOT NULL,
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, key_version)
);

-- 团队级开关：关闭后客户端不再自动托管，服务端立即删除已托管副本。
ALTER TABLE team_encryption
    ADD COLUMN IF NOT EXISTS server_review_enabled boolean NOT NULL DEFAULT true;

-- 管理台解密审计：只允许追加，禁止应用角色修改或删除。
CREATE TABLE IF NOT EXISTS admin_decrypt_audit (
    id                bigserial PRIMARY KEY,
    team_id           uuid NOT NULL,
    actor_id          uuid NOT NULL,
    actor_role        text NOT NULL,
    scope             text NOT NULL,
    snapshot_revision bigint,
    request_id        text,
    key_version       integer,
    fields            jsonb NOT NULL DEFAULT '[]'::jsonb,
    result            text NOT NULL,
    source_ip         text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_decrypt_audit_team_time_idx
    ON admin_decrypt_audit (team_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_admin_decrypt_audit_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'admin_decrypt_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_decrypt_audit_no_update ON admin_decrypt_audit;
CREATE TRIGGER admin_decrypt_audit_no_update
    BEFORE UPDATE OR DELETE ON admin_decrypt_audit
    FOR EACH ROW EXECUTE FUNCTION prevent_admin_decrypt_audit_mutation();
