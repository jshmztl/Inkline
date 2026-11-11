use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;

pub async fn connect(config: &Config) -> Result<PgPool, sqlx::Error> {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}

pub async fn membership_role(
    pool: &PgPool,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT role FROM memberships WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

pub async fn write_audit(
    pool: &PgPool,
    team_id: Option<Uuid>,
    actor_id: Option<Uuid>,
    kind: &str,
    action: &str,
    detail: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_logs (team_id, actor_id, type, action, detail) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(team_id)
    .bind(actor_id)
    .bind(kind)
    .bind(action)
    .bind(detail)
    .execute(pool)
    .await
    .map(|_| ())
}
