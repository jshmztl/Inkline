CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY,
    account       text NOT NULL,
    display_name  text NOT NULL,
    password_hash text NOT NULL,
    disabled_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_account_lower_idx ON users (lower(account));

CREATE TABLE IF NOT EXISTS teams (
    id                      uuid PRIMARY KEY,
    name                    text NOT NULL,
    current_revision        bigint NOT NULL DEFAULT 0,
    max_data_level         text NOT NULL DEFAULT 'L1'
                            CHECK (max_data_level IN ('L0', 'L1', 'L2')),
    snapshot_retention_days integer NOT NULL DEFAULT 90,
    audit_retention_days    integer NOT NULL DEFAULT 90,
    created_by              uuid NOT NULL REFERENCES users (id),
    created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
    team_id   uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role      text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
    code       text PRIMARY KEY,
    team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    created_by uuid NOT NULL REFERENCES users (id),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    used_by    uuid REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_idx ON refresh_tokens (token_hash);

CREATE TABLE IF NOT EXISTS snapshots (
    team_id         uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    revision        bigint NOT NULL,
    payload         jsonb NOT NULL,
    payload_hash    text NOT NULL,
    size_bytes      bigint NOT NULL,
    schema_version  integer NOT NULL,
    base_revision   bigint,
    created_by      uuid NOT NULL REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    idempotency_key text,
    PRIMARY KEY (team_id, revision),
    UNIQUE (team_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id       bigserial PRIMARY KEY,
    team_id  uuid REFERENCES teams (id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
    type     text NOT NULL,
    action   text NOT NULL,
    detail   jsonb NOT NULL DEFAULT '{}'::jsonb,
    at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_team_idx ON audit_logs (team_id, id DESC);
