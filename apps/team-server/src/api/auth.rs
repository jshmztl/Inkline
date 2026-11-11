use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{
    create_access_token, new_refresh_token, refresh_token_hash, verify_password, AuthUser,
};
use crate::db;
use crate::error::AppError;
use crate::models::{TeamWithRoleRow, UserRow};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub account: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<Value>, AppError> {
    let account = body.account.trim();
    if account.is_empty() || body.password.is_empty() {
        return Err(AppError::validation("请输入账号与口令"));
    }

    let user: Option<UserRow> = sqlx::query_as(
        "SELECT id, account, display_name, password_hash, disabled_at
         FROM users WHERE lower(account) = lower($1)",
    )
    .bind(account)
    .fetch_optional(&state.pool)
    .await?;

    let Some(user) = user else {
        return Err(AppError::unauthorized("账号或口令错误"));
    };
    if user.disabled_at.is_some() {
        return Err(AppError::forbidden("账号已停用"));
    }
    if !verify_password(&user.password_hash, &body.password) {
        return Err(AppError::unauthorized("账号或口令错误"));
    }

    let access_token = create_access_token(
        &state.config.jwt_secret,
        user.id,
        state.config.access_token_ttl_seconds,
    )
    .map_err(AppError::internal)?;
    let (refresh_token, refresh_hash) = new_refresh_token();
    let expires_at = Utc::now() + Duration::days(state.config.refresh_token_ttl_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(refresh_hash)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        None,
        Some(user.id),
        "auth",
        "auth.login",
        json!({ "account": user.account }),
    )
    .await;

    Ok(Json(json!({
        "accessToken": access_token,
        "expiresIn": state.config.access_token_ttl_seconds,
        "refreshToken": refresh_token,
        "user": {
            "id": user.id,
            "account": user.account,
            "displayName": user.display_name,
        }
    })))
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<Json<Value>, AppError> {
    if body.refresh_token.trim().is_empty() {
        return Err(AppError::validation("缺少 refreshToken"));
    }

    let token_hash = refresh_token_hash(body.refresh_token.trim());
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT rt.id, u.id
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1
           AND rt.revoked_at IS NULL
           AND rt.expires_at > now()
           AND u.disabled_at IS NULL",
    )
    .bind(&token_hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some((token_id, user_id)) = row else {
        return Err(AppError::unauthorized("刷新令牌无效或已过期"));
    };

    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1")
        .bind(token_id)
        .execute(&state.pool)
        .await?;

    let access_token = create_access_token(
        &state.config.jwt_secret,
        user_id,
        state.config.access_token_ttl_seconds,
    )
    .map_err(AppError::internal)?;
    let (refresh_token, refresh_hash) = new_refresh_token();
    let expires_at = Utc::now() + Duration::days(state.config.refresh_token_ttl_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(refresh_hash)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "accessToken": access_token,
        "expiresIn": state.config.access_token_ttl_seconds,
        "refreshToken": refresh_token,
    })))
}

pub async fn logout(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<StatusCode, AppError> {
    let token_hash = refresh_token_hash(body.refresh_token.trim());
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(token_hash)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, AppError> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT id, account, display_name, password_hash, disabled_at FROM users WHERE id = $1",
    )
    .bind(user.0)
    .fetch_optional(&state.pool)
    .await?;

    let Some(user) = row else {
        return Err(AppError::unauthorized("账号不存在"));
    };
    if user.disabled_at.is_some() {
        return Err(AppError::forbidden("账号已停用"));
    }

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
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "user": {
            "id": user.id,
            "account": user.account,
            "displayName": user.display_name,
        },
        "teams": teams.iter().map(crate::api::teams::team_with_role_json).collect::<Vec<_>>(),
    })))
}
