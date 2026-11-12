use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::api::members::require_manager;
use crate::auth::AuthUser;
use crate::db;
use crate::error::AppError;
use crate::policy::{self, GrantPermission, PolicyGrant, Visibility};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct GrantInput {
    #[serde(rename = "subjectType")]
    pub subject_type: String,
    #[serde(rename = "subjectId")]
    pub subject_id: String,
    pub permission: String,
}

#[derive(Debug, Deserialize)]
pub struct PolicyInput {
    pub visibility: String,
    #[serde(default)]
    pub grants: Vec<GrantInput>,
}

#[derive(Debug, Deserialize)]
pub struct PolicyItem {
    #[serde(rename = "resourceType")]
    pub resource_type: String,
    #[serde(rename = "resourceId")]
    pub resource_id: String,
    pub visibility: String,
    #[serde(default)]
    pub grants: Vec<GrantInput>,
}

#[derive(Debug, Deserialize)]
pub struct BatchRequest {
    pub items: Vec<PolicyItem>,
}

struct ValidatedPolicy {
    visibility: Visibility,
    grants: Vec<PolicyGrant>,
}

async fn latest_payload(state: &AppState, team_id: Uuid) -> Result<Value, AppError> {
    let payload: Option<Value> = sqlx::query_scalar(
        "SELECT payload FROM snapshots WHERE team_id = $1 ORDER BY revision DESC LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(&state.pool)
    .await?;

    payload.ok_or_else(|| AppError::not_found("团队还没有快照，暂时无法配置资源权限"))
}

fn payload_ids(payload: &Value, key: &str) -> HashSet<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn grants_json(policy: Option<&policy::ResourcePolicy>) -> Vec<Value> {
    policy
        .map(|policy| {
            policy
                .grants
                .iter()
                .map(|grant| {
                    json!({
                        "subjectType": grant.subject_type,
                        "subjectId": grant.subject_id,
                        "permission": grant.permission.as_str(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn access_label(access: policy::Access) -> &'static str {
    match access {
        policy::Access::Edit => "edit",
        policy::Access::View => "view",
        policy::Access::None => "none",
    }
}

/// 当前成员在当前团队的可见 / 编辑能力，用于客户端展示只读状态。
pub async fn get_access(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    let viewer = policy::Viewer::new(user.0, &role);
    let policies = policy::load_policies(&state.pool, team_id).await?;
    let payload: Option<Value> = sqlx::query_scalar(
        "SELECT payload FROM snapshots WHERE team_id = $1 ORDER BY revision DESC LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(&state.pool)
    .await?;

    let mut collections = serde_json::Map::new();
    let mut requests = serde_json::Map::new();

    if let Some(payload) = payload {
        if let Some(items) = payload.get("collections").and_then(Value::as_array) {
            for item in items {
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let access = policy::collection_access(&policies, id, &viewer);
                if access != policy::Access::None {
                    collections.insert(id.to_string(), Value::String(access_label(access).into()));
                }
            }
        }
        if let Some(items) = payload.get("requests").and_then(Value::as_array) {
            for item in items {
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let collection_id = item
                    .get("collectionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let level = if collection_id.is_empty() {
                    policy::collection_access(&policies, "", &viewer)
                } else {
                    policy::collection_access(&policies, collection_id, &viewer)
                };
                let access = policy::request_access(&policies, level, id, &viewer);
                if access != policy::Access::None {
                    requests.insert(id.to_string(), Value::String(access_label(access).into()));
                }
            }
        }
    }

    let manager = role == "owner" || role == "admin";
    Ok(Json(json!({
        "role": role,
        "canPush": role != "viewer",
        "canManageMembers": manager,
        "canManagePermissions": manager,
        "collections": collections,
        "requests": requests,
    })))
}

/// 管理台查看完整接口内容：仅所有者 / 管理员可用。
pub async fn get_workspace(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    require_manager(&state, team_id, user.0).await?;

    let row: Option<(i64, Value)> = sqlx::query_as(
        "SELECT revision, payload FROM snapshots
         WHERE team_id = $1 ORDER BY revision DESC LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(&state.pool)
    .await?;

    match row {
        Some((revision, payload)) => Ok(Json(json!({
            "revision": revision,
            "payload": payload,
        }))),
        None => Ok(Json(json!({
            "revision": 0,
            "payload": null,
        }))),
    }
}

pub async fn list_permissions(    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    require_manager(&state, team_id, user.0).await?;

    let payload = latest_payload(&state, team_id).await?;
    let policies = policy::load_policies(&state.pool, team_id).await?;
    let revision: i64 =
        sqlx::query_scalar("SELECT current_revision FROM teams WHERE id = $1")
            .bind(team_id)
            .fetch_one(&state.pool)
            .await?;

    let documents = payload
        .get("documents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut request_counts: HashMap<String, i64> = HashMap::new();
    let requests = payload
        .get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for request in &requests {
        if let Some(collection_id) = request.get("collectionId").and_then(Value::as_str) {
            *request_counts.entry(collection_id.to_string()).or_insert(0) += 1;
        }
    }

    let collections = payload
        .get("collections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|collection| {
            let id = collection.get("id").and_then(Value::as_str)?;
            let policy = policies.get(&policy::policy_key("collection", id));
            Some(json!({
                "id": id,
                "name": collection.get("name").and_then(Value::as_str).unwrap_or("未命名集合"),
                "requestCount": request_counts.get(id).copied().unwrap_or(0),
                "visibility": policy.map(|item| item.visibility.as_str()).unwrap_or("team"),
                "grants": grants_json(policy),
            }))
        })
        .collect::<Vec<_>>();

    let requests = requests
        .iter()
        .filter_map(|request| {
            let id = request.get("id").and_then(Value::as_str)?;
            let policy = policies.get(&policy::policy_key("request", id));
            Some(json!({
                "id": id,
                "name": request.get("name").and_then(Value::as_str).unwrap_or("未命名接口"),
                "method": request.get("method").and_then(Value::as_str).unwrap_or("GET"),
                "collectionId": request.get("collectionId").and_then(Value::as_str).unwrap_or(""),
                "dataLevel": request.get("dataLevel").and_then(Value::as_str).unwrap_or("L1"),
                "hasDocument": documents.contains_key(id),
                "visibility": policy.map(|item| item.visibility.as_str()).unwrap_or("inherit"),
                "grants": grants_json(policy),
            }))
        })
        .collect::<Vec<_>>();

    Ok(Json(json!({
        "revision": revision,
        "collections": collections,
        "requests": requests,
    })))
}

async fn team_member_ids(pool: &PgPool, team_id: Uuid) -> Result<HashSet<Uuid>, AppError> {
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM memberships WHERE team_id = $1")
            .bind(team_id)
            .fetch_all(pool)
            .await?;
    Ok(ids.into_iter().collect())
}

fn validate_grants(
    grants: &[GrantInput],
    member_ids: &HashSet<Uuid>,
) -> Result<Vec<PolicyGrant>, AppError> {
    let mut merged: HashMap<(String, String), PolicyGrant> = HashMap::new();

    for grant in grants {
        let subject_type = grant.subject_type.trim().to_ascii_lowercase();
        let subject_id = grant.subject_id.trim();
        if subject_id.is_empty() {
            return Err(AppError::validation("授权对象不能为空"));
        }

        let permission = GrantPermission::parse(&grant.permission)
            .ok_or_else(|| AppError::validation("权限只允许 view / edit"))?;

        match subject_type.as_str() {
            "user" => {
                let user_id = Uuid::parse_str(subject_id)
                    .map_err(|_| AppError::validation("授权成员 ID 格式非法"))?;
                if !member_ids.contains(&user_id) {
                    return Err(AppError::validation("授权对象不是当前团队成员")
                        .with_details(json!({ "subjectId": subject_id })));
                }
                if permission == GrantPermission::Edit {
                    // 保留 edit 授权；只读角色在求值时会被降级为 view。
                }
            }
            "role" => {
                if !matches!(subject_id, "member" | "viewer") {
                    return Err(AppError::validation(
                        "角色授权只支持 member / viewer；管理员与所有者默认可见",
                    ));
                }
                if subject_id == "viewer" && permission == GrantPermission::Edit {
                    return Err(AppError::validation("只读角色不能授予编辑权限"));
                }
            }
            _ => {
                return Err(AppError::validation(
                    "subjectType 只允许 user / role",
                ));
            }
        }

        merged.insert(
            (subject_type.clone(), subject_id.to_string()),
            PolicyGrant {
                subject_type,
                subject_id: subject_id.to_string(),
                permission,
            },
        );
    }

    Ok(merged.into_values().collect())
}

async fn apply_policy(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Uuid,
    actor: Uuid,
    resource_type: &str,
    resource_id: &str,
    validated: &ValidatedPolicy,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO resource_policies
            (team_id, resource_type, resource_id, visibility, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (team_id, resource_type, resource_id)
         DO UPDATE SET visibility = EXCLUDED.visibility,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = now()",
    )
    .bind(team_id)
    .bind(resource_type)
    .bind(resource_id)
    .bind(validated.visibility.as_str())
    .bind(actor)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "DELETE FROM resource_grants
         WHERE team_id = $1 AND resource_type = $2 AND resource_id = $3",
    )
    .bind(team_id)
    .bind(resource_type)
    .bind(resource_id)
    .execute(&mut **tx)
    .await?;

    for grant in &validated.grants {
        sqlx::query(
            "INSERT INTO resource_grants
                (team_id, resource_type, resource_id, subject_type, subject_id, permission)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(team_id)
        .bind(resource_type)
        .bind(resource_id)
        .bind(&grant.subject_type)
        .bind(&grant.subject_id)
        .bind(grant.permission.as_str())
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

async fn validate_target(
    state: &AppState,
    team_id: Uuid,
    resource_type: &str,
    resource_id: &str,
) -> Result<(), AppError> {
    if !matches!(resource_type, "collection" | "request") {
        return Err(AppError::validation(
            "resourceType 只允许 collection / request",
        ));
    }
    let payload = latest_payload(state, team_id).await?;
    let ids = if resource_type == "collection" {
        payload_ids(&payload, "collections")
    } else {
        payload_ids(&payload, "requests")
    };
    if !ids.contains(resource_id) {
        return Err(AppError::not_found("资源不存在，可能已被删除，请刷新后重试"));
    }
    Ok(())
}

pub async fn update_permission(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, resource_type, resource_id)): Path<(Uuid, String, String)>,
    Json(body): Json<PolicyInput>,
) -> Result<Json<Value>, AppError> {
    require_manager(&state, team_id, user.0).await?;
    validate_target(&state, team_id, &resource_type, &resource_id).await?;

    let visibility = Visibility::parse(&body.visibility)
        .ok_or_else(|| AppError::validation("visibility 只允许 team / restricted"))?;
    let member_ids = team_member_ids(&state.pool, team_id).await?;
    let grants = if visibility == Visibility::Restricted {
        validate_grants(&body.grants, &member_ids)?
    } else {
        Vec::new()
    };

    let validated = ValidatedPolicy {
        visibility,
        grants: grants.clone(),
    };

    let mut tx = state.pool.begin().await?;
    apply_policy(
        &mut tx,
        team_id,
        user.0,
        &resource_type,
        &resource_id,
        &validated,
    )
    .await?;
    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "permission",
        "permission.update",
        json!({
            "resourceType": resource_type,
            "resourceId": resource_id,
            "visibility": visibility.as_str(),
            "grantCount": grants.len(),
        }),
    )
    .await;

    Ok(Json(json!({
        "resourceType": resource_type,
        "resourceId": resource_id,
        "visibility": visibility.as_str(),
        "grants": grants.len(),
    })))
}

pub async fn reset_permission(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, resource_type, resource_id)): Path<(Uuid, String, String)>,
) -> Result<StatusCode, AppError> {
    require_manager(&state, team_id, user.0).await?;
    if !matches!(resource_type.as_str(), "collection" | "request") {
        return Err(AppError::validation(
            "resourceType 只允许 collection / request",
        ));
    }

    sqlx::query(
        "DELETE FROM resource_policies
         WHERE team_id = $1 AND resource_type = $2 AND resource_id = $3",
    )
    .bind(team_id)
    .bind(&resource_type)
    .bind(&resource_id)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "permission",
        "permission.reset",
        json!({ "resourceType": resource_type, "resourceId": resource_id }),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn batch_update_permissions(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<BatchRequest>,
) -> Result<Json<Value>, AppError> {
    require_manager(&state, team_id, user.0).await?;

    if body.items.is_empty() {
        return Err(AppError::validation("items 不能为空"));
    }
    if body.items.len() > 200 {
        return Err(AppError::validation("单次最多配置 200 个资源"));
    }

    let payload = latest_payload(&state, team_id).await?;
    let collection_ids = payload_ids(&payload, "collections");
    let request_ids = payload_ids(&payload, "requests");
    let member_ids = team_member_ids(&state.pool, team_id).await?;

    let mut validated = Vec::with_capacity(body.items.len());
    for item in &body.items {
        if !matches!(item.resource_type.as_str(), "collection" | "request") {
            return Err(AppError::validation(
                "resourceType 只允许 collection / request",
            ));
        }
        let exists = if item.resource_type == "collection" {
            collection_ids.contains(&item.resource_id)
        } else {
            request_ids.contains(&item.resource_id)
        };
        if !exists {
            return Err(AppError::not_found("部分资源不存在，请刷新后重试")
                .with_details(json!({ "resourceId": item.resource_id })));
        }

        let visibility = Visibility::parse(&item.visibility)
            .ok_or_else(|| AppError::validation("visibility 只允许 team / restricted"))?;
        let grants = if visibility == Visibility::Restricted {
            validate_grants(&item.grants, &member_ids)?
        } else {
            Vec::new()
        };
        validated.push((item, visibility, grants));
    }

    let mut tx = state.pool.begin().await?;
    for (item, visibility, grants) in &validated {
        apply_policy(
            &mut tx,
            team_id,
            user.0,
            &item.resource_type,
            &item.resource_id,
            &ValidatedPolicy {
                visibility: *visibility,
                grants: grants.clone(),
            },
        )
        .await?;
    }
    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "permission",
        "permission.batch_update",
        json!({ "count": validated.len() }),
    )
    .await;

    Ok(Json(json!({ "updated": validated.len() })))
}
