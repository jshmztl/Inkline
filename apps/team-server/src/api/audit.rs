use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::models::AuditRow;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    pub before: Option<i64>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

pub async fn list_audit(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有团队所有者或管理员可以查看审计日志"));
    }

    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let kind = query.kind.filter(|value| !value.trim().is_empty());

    let rows: Vec<AuditRow> = sqlx::query_as(
        "SELECT a.id, a.type, a.action, a.detail, a.at,
                u.display_name AS actor_name, a.actor_id
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.team_id = $1
           AND ($2::text IS NULL OR a.type = $2)
           AND ($3::bigint IS NULL OR a.id < $3)
         ORDER BY a.id DESC
         LIMIT $4",
    )
    .bind(team_id)
    .bind(kind)
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let next_cursor = if rows.len() as i64 == limit {
        rows.last().map(|row| row.id)
    } else {
        None
    };

    Ok(Json(json!({
        "entries": rows.iter().map(|row| json!({
            "id": row.id,
            "type": row.kind,
            "action": row.action,
            "actor": {
                "userId": row.actor_id,
                "displayName": row.actor_name,
            },
            "detail": row.detail,
            "at": row.at,
        })).collect::<Vec<_>>(),
        "nextCursor": next_cursor,
    })))
}
