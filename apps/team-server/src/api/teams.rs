use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::config::validate_retention;
use crate::db;
use crate::error::AppError;
use crate::models::{MemberRow, TeamRow, TeamWithRoleRow};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateTeamRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTeamRequest {
    pub name: Option<String>,
    #[serde(rename = "maxDataLevel")]
    pub max_data_level: Option<String>,
    #[serde(rename = "snapshotRetentionDays")]
    pub snapshot_retention_days: Option<i32>,
    #[serde(rename = "auditRetentionDays")]
    pub audit_retention_days: Option<i32>,
}

pub fn team_with_role_json(row: &TeamWithRoleRow) -> Value {
    json!({
        "id": row.id,
        "name": row.name,
        "role": row.role,
        "revision": row.current_revision,
        "maxDataLevel": row.max_data_level,
        "snapshotRetentionDays": row.snapshot_retention_days,
        "auditRetentionDays": row.audit_retention_days,
        "memberCount": row.member_count,
    })
}

pub async fn require_membership(
    pool: &PgPool,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<String, AppError> {
    match db::membership_role(pool, team_id, user_id).await? {
        Some(role) => Ok(role),
        None => Err(AppError::not_found("团队不存在或无权访问")),
    }
}

fn validate_team_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("团队名称不能为空"));
    }
    if trimmed.chars().count() > 80 {
        return Err(AppError::validation("团队名称不能超过 80 个字符"));
    }
    Ok(trimmed.to_string())
}

pub async fn list_teams(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, AppError> {
    let teams: Vec<TeamWithRoleRow> = sqlx::query_as(
        "SELECT t.id, t.name, t.current_revision, t.max_data_level,
                t.snapshot_retention_days, t.audit_retention_days,
                m.role,
                (SELECT count(*) FROM memberships x WHERE x.team_id = t.id) AS member_count
         FROM memberships m
         JOIN teams t ON t.id = m.team_id
         WHERE m.user_id = $1
         ORDER BY t.created_at",
    )
    .bind(user.0)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "teams": teams.iter().map(team_with_role_json).collect::<Vec<_>>()
    })))
}

pub async fn create_team(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateTeamRequest>,
) -> Result<Json<Value>, AppError> {
    let name = validate_team_name(&body.name)?;
    let team_id = Uuid::new_v4();

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO teams
            (id, name, current_revision, max_data_level, snapshot_retention_days, audit_retention_days, created_by)
         VALUES ($1, $2, 0, 'L1', $3, $4, $5)",
    )
    .bind(team_id)
    .bind(&name)
    .bind(state.config.default_snapshot_retention_days)
    .bind(state.config.default_audit_retention_days)
    .bind(user.0)
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO memberships (team_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(team_id)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "team",
        "team.create",
        json!({ "name": name }),
    )
    .await;

    Ok(Json(json!({
        "team": {
            "id": team_id,
            "name": name,
            "role": "owner",
            "revision": 0,
            "maxDataLevel": "L1",
            "snapshotRetentionDays": state.config.default_snapshot_retention_days,
            "auditRetentionDays": state.config.default_audit_retention_days,
            "memberCount": 1,
        }
    })))
}

pub async fn get_team(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let role = require_membership(&state.pool, team_id, user.0).await?;
    let team = fetch_team_with_role(&state.pool, team_id, &role).await?;
    Ok(Json(json!({ "team": team_with_role_json(&team) })))
}

pub async fn update_team(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<UpdateTeamRequest>,
) -> Result<Json<Value>, AppError> {
    let role = require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" {
        return Err(AppError::forbidden("只有团队所有者可以修改团队设置"));
    }

    let current: Option<TeamRow> = sqlx::query_as(
        "SELECT name, max_data_level, snapshot_retention_days, audit_retention_days
         FROM teams WHERE id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(current) = current else {
        return Err(AppError::not_found("团队不存在"));
    };

    let name = match body.name.as_deref() {
        Some(value) => validate_team_name(value)?,
        None => current.name.clone(),
    };

    let max_data_level = match body.max_data_level.as_deref() {
        Some(value) => {
            let level = value.trim().to_ascii_uppercase();
            if !matches!(level.as_str(), "L0" | "L1" | "L2") {
                return Err(AppError::validation(
                    "团队数据分级上限只允许 L0 / L1 / L2，L3 禁止进入团队服务",
                )
                .with_details(json!({ "dataLevel": value })));
            }
            level
        }
        None => current.max_data_level.clone(),
    };

    let snapshot_retention_days = body
        .snapshot_retention_days
        .unwrap_or(current.snapshot_retention_days);
    let audit_retention_days = body
        .audit_retention_days
        .unwrap_or(current.audit_retention_days);
    validate_retention(snapshot_retention_days).map_err(AppError::validation)?;
    validate_retention(audit_retention_days).map_err(AppError::validation)?;

    sqlx::query(
        "UPDATE teams
         SET name = $2, max_data_level = $3, snapshot_retention_days = $4, audit_retention_days = $5
         WHERE id = $1",
    )
    .bind(team_id)
    .bind(&name)
    .bind(&max_data_level)
    .bind(snapshot_retention_days)
    .bind(audit_retention_days)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "team",
        "team.update",
        json!({
            "name": name,
            "maxDataLevel": max_data_level,
            "snapshotRetentionDays": snapshot_retention_days,
            "auditRetentionDays": audit_retention_days,
        }),
    )
    .await;

    let team = fetch_team_with_role(&state.pool, team_id, &role).await?;
    Ok(Json(json!({ "team": team_with_role_json(&team) })))
}

pub async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    require_membership(&state.pool, team_id, user.0).await?;

    let members: Vec<MemberRow> = sqlx::query_as(
        "SELECT u.id AS user_id, u.account, u.display_name, m.role, m.joined_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1
         ORDER BY m.joined_at",
    )
    .bind(team_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "members": members.iter().map(|member| json!({
            "userId": member.user_id,
            "account": member.account,
            "displayName": member.display_name,
            "role": member.role,
            "joinedAt": member.joined_at,
        })).collect::<Vec<_>>()
    })))
}

async fn fetch_team_with_role(
    pool: &PgPool,
    team_id: Uuid,
    role: &str,
) -> Result<TeamWithRoleRow, AppError> {
    let team: Option<TeamWithRoleRow> = sqlx::query_as(
        "SELECT t.id, t.name, t.current_revision, t.max_data_level,
                t.snapshot_retention_days, t.audit_retention_days,
                $2::text AS role,
                (SELECT count(*) FROM memberships x WHERE x.team_id = t.id) AS member_count
         FROM teams t WHERE t.id = $1",
    )
    .bind(team_id)
    .bind(role)
    .fetch_optional(pool)
    .await?;

    team.ok_or_else(|| AppError::not_found("团队不存在"))
}
