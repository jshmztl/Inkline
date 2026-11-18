CREATE TABLE IF NOT EXISTS team_encryption (
    team_id         uuid PRIMARY KEY REFERENCES teams (id) ON DELETE CASCADE,
    enabled         boolean NOT NULL DEFAULT true,
    current_version integer NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_encryption_devices (
    team_id      uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    device_id    uuid NOT NULL,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    public_key   text NOT NULL,
    algorithm    text NOT NULL DEFAULT 'RSA-OAEP-256',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, device_id)
);

CREATE INDEX IF NOT EXISTS team_encryption_devices_user_idx
    ON team_encryption_devices (team_id, user_id);

CREATE TABLE IF NOT EXISTS team_encryption_wrapped_keys (
    team_id     uuid NOT NULL,
    version     integer NOT NULL,
    device_id   uuid NOT NULL,
    wrapped_key text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, version, device_id),
    FOREIGN KEY (team_id, device_id)
        REFERENCES team_encryption_devices (team_id, device_id) ON DELETE CASCADE
);

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS encryption_version integer,
    ADD COLUMN IF NOT EXISTS encryption_key_id text;

INSERT INTO team_encryption (team_id, enabled, current_version)
SELECT id, true, 0 FROM teams
ON CONFLICT (team_id) DO NOTHING;
