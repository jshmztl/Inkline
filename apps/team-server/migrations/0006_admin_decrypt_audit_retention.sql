-- admin_decrypt_audit 保留期：保留自动清理通道，但应用路径仍禁止 UPDATE/DELETE。
CREATE OR REPLACE FUNCTION prevent_admin_decrypt_audit_mutation()
RETURNS trigger AS $$
BEGIN
    -- 仅允许保留期清理任务在显式会话标记下删除旧记录。
    IF TG_OP = 'DELETE'
       AND current_setting('inkline.audit_retention', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'admin_decrypt_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS admin_decrypt_audit_created_idx
    ON admin_decrypt_audit (created_at);
