use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{hash_password, validate_password_policy, AuthUser};
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub mode: Option<String>,
    pub account: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub password: Option<String>,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRoleRequest {
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordRequest {
    #[serde(rename = "newPassword")]
    pub new_password: String,
}

pub(crate) async fn require_manager(
    state: &AppState,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<String, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user_id).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有团队所有者或管理员可以管理成员"));
    }
    Ok(role)
}

fn validate_account(account: &str) -> Result<String, AppError> {
    let value = account.trim();
    let length = value.chars().count();
    if !(3..=32).contains(&length) {
        return Err(AppError::validation("账号长度需要在 3–32 个字符之间"));
    }
    let Some(first) = value.chars().next() else {
        return Err(AppError::validation("账号不能为空"));
    };
    if !first.is_ascii_alphanumeric() {
        return Err(AppError::validation("账号需要以字母或数字开头"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(AppError::validation(
            "账号只能包含字母、数字、点、下划线和短横线",
        ));
    }
    Ok(value.to_string())
}

fn validate_password(password: &str) -> Result<(), AppError> {
    validate_password_policy(password).map_err(AppError::validation)
}

fn parse_role(value: &str, actor_role: &str) -> Result<&'static str, AppError> {
    let role = match value.trim().to_ascii_lowercase().as_str() {
        "admin" => "admin",
        "member" => "member",
        "viewer" => "viewer",
        "owner" => {
            return Err(AppError::validation("不能通过成员接口授予所有者角色"));
        }
        _ => {
            return Err(AppError::validation(
                "角色只允许 admin / member / viewer",
            ));
        }
    };
    if role == "admin" && actor_role != "owner" {
        return Err(AppError::forbidden("只有团队所有者可以授予管理员角色"));
    }
    Ok(role)
}

async fn member_json(
    state: &AppState,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<Value, AppError> {
    let row: Option<(Uuid, String, String, String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            "SELECT u.id, u.account, u.display_name, m.role, m.joined_at
             FROM memberships m
             JOIN users u ON u.id = m.user_id
             WHERE m.team_id = $1 AND m.user_id = $2",
        )
        .bind(team_id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;

    let Some((user_id, account, display_name, role, joined_at)) = row else {
        return Err(AppError::not_found("成员不存在"));
    };

    Ok(json!({
        "userId": user_id,
        "account": account,
        "displayName": display_name,
        "role": role,
        "joinedAt": joined_at,
    }))
}

pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<AddMemberRequest>,
) -> Result<Json<Value>, AppError> {
    let actor_role = require_manager(&state, team_id, user.0).await?;
    let role = parse_role(&body.role, &actor_role)?;
    let account = validate_account(&body.account)?;
    let mode = body
        .mode
        .as_deref()
        .unwrap_or(if body.password.is_some() {
            "create"
        } else {
            "existing"
        });

    let target_user_id = match mode {
        "create" => {
            let password = body
                .password
                .as_deref()
                .ok_or_else(|| AppError::validation("创建账号需要设置初始口令"))?;
            validate_password(password)?;
            let password_hash = hash_password(password).map_err(AppError::internal)?;
            let display_name = body
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&account)
                .to_string();

            let user_id = Uuid::new_v4();
            let mut tx = state.pool.begin().await?;
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE lower(account) = lower($1))",
            )
            .bind(&account)
            .fetch_one(&mut *tx)
            .await?;
            if exists {
                return Err(AppError::conflict(
                    "account_exists",
                    "账号已存在，请改用添加已有账号",
                    json!({ "account": account }),
                ));
            }

            sqlx::query(
                "INSERT INTO users (id, account, display_name, password_hash, must_change_password)
                 VALUES ($1, $2, $3, $4, true)",
            )
            .bind(user_id)
            .bind(&account)
            .bind(&display_name)
            .bind(&password_hash)
            .execute(&mut *tx)
            .await?;

            sqlx::query("INSERT INTO memberships (team_id, user_id, role) VALUES ($1, $2, $3)")
                .bind(team_id)
                .bind(user_id)
                .bind(role)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;

            let _ = db::write_audit(
                &state.pool,
                Some(team_id),
                Some(user.0),
                "member",
                "member.create",
                json!({ "account": account, "displayName": display_name, "role": role }),
            )
            .await;

            user_id
        }
        "existing" => {
            let existing_id: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM users WHERE lower(account) = lower($1) AND disabled_at IS NULL",
            )
            .bind(&account)
            .fetch_optional(&state.pool)
            .await?;
            let Some(existing_id) = existing_id else {
                return Err(AppError::not_found("账号不存在，请改用新建账号"));
            };

            let already: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE team_id = $1 AND user_id = $2)",
            )
            .bind(team_id)
            .bind(existing_id)
            .fetch_one(&state.pool)
            .await?;
            if already {
                return Err(AppError::conflict(
                    "already_member",
                    "该账号已经在团队中",
                    json!({ "userId": existing_id }),
                ));
            }

            sqlx::query("INSERT INTO memberships (team_id, user_id, role) VALUES ($1, $2, $3)")
                .bind(team_id)
                .bind(existing_id)
                .bind(role)
                .execute(&state.pool)
                .await?;

            let _ = db::write_audit(
                &state.pool,
                Some(team_id),
                Some(user.0),
                "member",
                "member.add",
                json!({ "account": account, "userId": existing_id, "role": role }),
            )
            .await;

            existing_id
        }
        _ => return Err(AppError::validation("mode 只允许 create / existing")),
    };

    let member = member_json(&state, team_id, target_user_id).await?;
    Ok(Json(json!({ "member": member })))
}

pub async fn update_member_role(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<Json<Value>, AppError> {
    let actor_role = require_manager(&state, team_id, user.0).await?;
    let new_role = parse_role(&body.role, &actor_role)?;

    let target: Option<(String, String)> = sqlx::query_as(
        "SELECT m.role, u.account
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND m.user_id = $2",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((target_role, account)) = target else {
        return Err(AppError::not_found("成员不存在"));
    };

    if target_role == "owner" {
        return Err(AppError::forbidden("不能修改团队所有者的角色"));
    }
    if actor_role == "admin" && target_role == "admin" {
        return Err(AppError::forbidden("管理员不能修改其他管理员"));
    }
    if target_role == new_role {
        let member = member_json(&state, team_id, target_user_id).await?;
        return Ok(Json(json!({ "member": member })));
    }

    sqlx::query("UPDATE memberships SET role = $3 WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_user_id)
        .bind(new_role)
        .execute(&state.pool)
        .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "member",
        "member.role_update",
        json!({
            "userId": target_user_id,
            "account": account,
            "from": target_role,
            "to": new_role,
        }),
    )
    .await;

    let member = member_json(&state, team_id, target_user_id).await?;
    Ok(Json(json!({ "member": member })))
}

pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, target_user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, AppError> {
    let actor_role = require_manager(&state, team_id, user.0).await?;
    if target_user_id == user.0 {
        return Err(AppError::validation("不能将自己移出团队"));
    }

    let target: Option<(String, String)> = sqlx::query_as(
        "SELECT m.role, u.account
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND m.user_id = $2",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((target_role, account)) = target else {
        return Err(AppError::not_found("成员不存在"));
    };

    if target_role == "owner" {
        return Err(AppError::forbidden("不能移除团队所有者"));
    }
    if actor_role == "admin" && target_role == "admin" {
        return Err(AppError::forbidden("管理员不能移除其他管理员"));
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM memberships WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;
    // 成员被移出后，其在团队内的资源授权一并失效。
    sqlx::query(
        "DELETE FROM resource_grants
         WHERE team_id = $1 AND subject_type = 'user' AND subject_id = $2",
    )
    .bind(team_id)
    .bind(target_user_id.to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "member",
        "member.remove",
        json!({ "userId": target_user_id, "account": account, "role": target_role }),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset_password(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<StatusCode, AppError> {
    let actor_role = require_manager(&state, team_id, user.0).await?;
    validate_password(&body.new_password)?;

    let target: Option<(String, String)> = sqlx::query_as(
        "SELECT m.role, u.account
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND m.user_id = $2",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((target_role, account)) = target else {
        return Err(AppError::not_found("成员不存在"));
    };

    if actor_role == "admin" && matches!(target_role.as_str(), "owner" | "admin") {
        return Err(AppError::forbidden("管理员只能重置成员或只读账号的口令"));
    }

    let password_hash = hash_password(&body.new_password).map_err(AppError::internal)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1",
    )
        .bind(target_user_id)
        .bind(&password_hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(target_user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "member",
        "member.password_reset",
        json!({ "userId": target_user_id, "account": account, "role": target_role }),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
