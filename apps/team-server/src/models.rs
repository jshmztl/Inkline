use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub account: String,
    pub display_name: String,
    pub password_hash: String,
    pub disabled_at: Option<DateTime<Utc>>,
    pub must_change_password: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TeamRow {
    pub name: String,
    pub max_data_level: String,
    pub snapshot_retention_days: i32,
    pub audit_retention_days: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TeamWithRoleRow {
    pub id: Uuid,
    pub name: String,
    pub current_revision: i64,
    pub max_data_level: String,
    pub snapshot_retention_days: i32,
    pub audit_retention_days: i32,
    pub role: String,
    pub member_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberRow {
    pub user_id: Uuid,
    pub account: String,
    pub display_name: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotMetaRow {
    pub revision: i64,
    pub payload_hash: String,
    pub size_bytes: i64,
    pub schema_version: i32,
    pub created_at: DateTime<Utc>,
    pub created_by_name: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuditRow {
    pub id: i64,
    #[sqlx(rename = "type")]
    pub kind: String,
    pub action: String,
    pub detail: Value,
    pub at: DateTime<Utc>,
    pub actor_name: Option<String>,
    pub actor_id: Option<Uuid>,
}
