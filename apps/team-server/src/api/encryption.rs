use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

const ALLOWED_ALGORITHM: &str = "RSA-OAEP-256";
const MAX_PUBLIC_KEY_BYTES: usize = 8192;
const MAX_WRAPPED_KEY_BYTES: usize = 8192;
const MAX_DEVICES_PER_USER: i64 = 10;

#[derive(Debug, Deserialize)]
pub struct EncryptionQuery {
    #[serde(rename = "deviceId")]
    pub device_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterDeviceRequest {
    #[serde(rename = "deviceId")]
    pub device_id: Uuid,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub algorithm: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WrappedKeyInput {
    #[serde(rename = "deviceId")]
    pub device_id: Uuid,
    #[serde(rename = "wrappedKey")]
    pub wrapped_key: String,
    pub algorithm: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateKeyRequest {
    pub version: i32,
    #[serde(rename = "wrappedKeys")]
    pub wrapped_keys: Vec<WrappedKeyInput>,
}

#[derive(Debug, Deserialize)]
pub struct AddWrappedKeysRequest {
    #[serde(rename = "wrappedKeys")]
    pub wrapped_keys: Vec<WrappedKeyInput>,
}

#[derive(Debug, sqlx::FromRow)]
struct DeviceRow {
    device_id: Uuid,
    user_id: Uuid,
    public_key: String,
    algorithm: String,
    created_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    display_name: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct WrappedKeyRow {
    version: i32,
    wrapped_key: String,
}

fn validate_secret(value: &str, max_bytes: usize, label: &str) -> Result<(), AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    let bytes = STANDARD
        .decode(trimmed)
        .map_err(|_| AppError::validation(format!("{label}不是合法的 Base64")))?;
    if bytes.len() > max_bytes {
        return Err(AppError::validation(format!(
            "{label}超过大小限制（{} 字节）",
            max_bytes
        )));
    }
    Ok(())
}

fn validate_algorithm(value: Option<&str>) -> Result<String, AppError> {
    let algorithm = value.unwrap_or(ALLOWED_ALGORITHM).trim();
    if algorithm != ALLOWED_ALGORITHM {
        return Err(AppError::validation(format!(
            "不支持的密钥包裹算法：{algorithm}"
        )));
    }
    Ok(algorithm.to_string())
}

pub async fn ensure_encryption_row(pool: &PgPool, team_id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO team_encryption (team_id, enabled, current_version)
         VALUES ($1, true, 0)
         ON CONFLICT (team_id) DO NOTHING",
    )
    .bind(team_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_encryption_state(pool: &PgPool, team_id: Uuid) -> Result<(bool, i32), AppError> {
    let row: Option<(bool, i32)> =
        sqlx::query_as("SELECT enabled, current_version FROM team_encryption WHERE team_id = $1")
            .bind(team_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.unwrap_or((true, 0)))
}

async fn current_wrapped_devices(
    pool: &PgPool,
    team_id: Uuid,
    version: i32,
) -> Result<HashSet<Uuid>, AppError> {
    if version <= 0 {
        return Ok(HashSet::new());
    }
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT device_id FROM team_encryption_wrapped_keys
         WHERE team_id = $1 AND version = $2",
    )
    .bind(team_id)
    .bind(version)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

pub async fn get_encryption(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Query(query): Query<EncryptionQuery>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    ensure_encryption_row(&state.pool, team_id).await?;
    let (enabled, current_version) = load_encryption_state(&state.pool, team_id).await?;
    let is_manager = role == "owner" || role == "admin";

    if let Some(device_id) = query.device_id {
        let owner: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM team_encryption_devices
             WHERE team_id = $1 AND device_id = $2",
        )
        .bind(team_id)
        .bind(device_id)
        .fetch_optional(&state.pool)
        .await?;
        if owner != Some(user.0) {
            return Err(AppError::forbidden("设备不属于当前账号"));
        }
    }

    let devices: Vec<DeviceRow> = sqlx::query_as(
        "SELECT d.device_id, d.user_id, d.public_key, d.algorithm,
                d.created_at, d.last_seen_at, u.display_name
         FROM team_encryption_devices d
         LEFT JOIN users u ON u.id = d.user_id
         WHERE d.team_id = $1 AND ($2::uuid IS NULL OR d.user_id = $2)
         ORDER BY d.created_at",
    )
    .bind(team_id)
    .bind(if is_manager {
        Option::<Uuid>::None
    } else {
        Some(user.0)
    })
    .fetch_all(&state.pool)
    .await?;

    let wrapped_keys: Vec<WrappedKeyRow> = match query.device_id {
        Some(device_id) => {
            sqlx::query_as(
                "SELECT version, wrapped_key FROM team_encryption_wrapped_keys
                 WHERE team_id = $1 AND device_id = $2
                 ORDER BY version",
            )
            .bind(team_id)
            .bind(device_id)
            .fetch_all(&state.pool)
            .await?
        }
        None => Vec::new(),
    };

    let wrapped_versions: HashMap<Uuid, Vec<i32>> = if is_manager {
        let rows: Vec<(Uuid, i32)> = sqlx::query_as(
            "SELECT device_id, version FROM team_encryption_wrapped_keys
             WHERE team_id = $1
             ORDER BY version",
        )
        .bind(team_id)
        .fetch_all(&state.pool)
        .await?;
        let mut map: HashMap<Uuid, Vec<i32>> = HashMap::new();
        for (device_id, version) in rows {
            map.entry(device_id).or_default().push(version);
        }
        map
    } else {
        HashMap::new()
    };

    let has_current = current_wrapped_devices(&state.pool, team_id, current_version).await?;
    let pending_devices = if is_manager && current_version > 0 {
        devices
            .iter()
            .filter(|device| !has_current.contains(&device.device_id))
            .count()
    } else {
        0
    };

    let device_json = devices
        .iter()
        .map(|device| {
            let mut value = json!({
                "deviceId": device.device_id,
                "userId": device.user_id,
                "displayName": device.display_name,
                "algorithm": device.algorithm,
                "hasCurrentKey": current_version > 0
                    && has_current.contains(&device.device_id),
                "createdAt": device.created_at,
                "lastSeenAt": device.last_seen_at,
            });
            if is_manager {
                value["publicKey"] = json!(device.public_key);
                value["wrappedVersions"] = json!(
                    wrapped_versions
                        .get(&device.device_id)
                        .cloned()
                        .unwrap_or_default()
                );
            }
            value
        })
        .collect::<Vec<_>>();

    let my_device = query.device_id.and_then(|device_id| {
        devices
            .iter()
            .find(|device| device.device_id == device_id)
            .map(|device| {
                json!({
                    "deviceId": device.device_id,
                    "userId": device.user_id,
                    "displayName": device.display_name,
                    "algorithm": device.algorithm,
                    "hasCurrentKey": current_version > 0
                        && has_current.contains(&device.device_id),
                })
            })
    });

    Ok(Json(json!({
        "enabled": enabled,
        "currentVersion": current_version,
        "device": my_device,
        "wrappedKeys": wrapped_keys.iter().map(|key| json!({
            "version": key.version,
            "wrappedKey": key.wrapped_key,
            "algorithm": ALLOWED_ALGORITHM,
        })).collect::<Vec<_>>(),
        "devices": device_json,
        "pendingDevices": pending_devices,
    })))
}

pub async fn register_device(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<RegisterDeviceRequest>,
) -> Result<Json<Value>, AppError> {
    crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    ensure_encryption_row(&state.pool, team_id).await?;
    validate_secret(&body.public_key, MAX_PUBLIC_KEY_BYTES, "设备公钥")?;
    let algorithm = validate_algorithm(body.algorithm.as_deref())?;

    let existing_owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM team_encryption_devices
         WHERE team_id = $1 AND device_id = $2",
    )
    .bind(team_id)
    .bind(body.device_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(owner) = existing_owner {
        if owner != user.0 {
            return Err(AppError::forbidden("设备已绑定其他账号"));
        }
    } else {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM team_encryption_devices
             WHERE team_id = $1 AND user_id = $2",
        )
        .bind(team_id)
        .bind(user.0)
        .fetch_one(&state.pool)
        .await?;
        if count >= MAX_DEVICES_PER_USER {
            return Err(AppError::validation(format!(
                "每个账号最多注册 {MAX_DEVICES_PER_USER} 台加密设备"
            )));
        }
    }

    sqlx::query(
        "INSERT INTO team_encryption_devices
            (team_id, device_id, user_id, public_key, algorithm)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, device_id) DO UPDATE
         SET public_key = EXCLUDED.public_key,
             algorithm = EXCLUDED.algorithm,
             last_seen_at = now()
         WHERE team_encryption_devices.user_id = EXCLUDED.user_id",
    )
    .bind(team_id)
    .bind(body.device_id)
    .bind(user.0)
    .bind(body.public_key.trim())
    .bind(&algorithm)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "encryption",
        "encryption.device.register",
        json!({ "deviceId": body.device_id, "algorithm": algorithm }),
    )
    .await;

    Ok(Json(json!({
        "device": {
            "deviceId": body.device_id,
            "algorithm": algorithm,
        }
    })))
}

async fn validate_wrapped_keys(
    pool: &PgPool,
    team_id: Uuid,
    items: &[WrappedKeyInput],
) -> Result<(), AppError> {
    if items.is_empty() {
        return Err(AppError::validation("至少需要提交一个设备的包裹密钥"));
    }

    let mut seen = HashSet::new();
    for item in items {
        if !seen.insert(item.device_id) {
            return Err(AppError::validation("包裹密钥中存在重复设备"));
        }
        validate_secret(&item.wrapped_key, MAX_WRAPPED_KEY_BYTES, "包裹密钥")?;
        validate_algorithm(item.algorithm.as_deref())?;

        let exists: Option<Uuid> = sqlx::query_scalar(
            "SELECT device_id FROM team_encryption_devices
             WHERE team_id = $1 AND device_id = $2",
        )
        .bind(team_id)
        .bind(item.device_id)
        .fetch_optional(pool)
        .await?;
        if exists.is_none() {
            return Err(AppError::validation(format!(
                "设备 {} 未在团队中注册",
                item.device_id
            )));
        }
    }

    Ok(())
}

pub async fn create_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<CreateKeyRequest>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有所有者或管理员可以创建团队密钥"));
    }
    ensure_encryption_row(&state.pool, team_id).await?;
    let (_, current_version) = load_encryption_state(&state.pool, team_id).await?;
    if body.version != current_version + 1 {
        return Err(AppError::conflict(
            "encryption_version_conflict",
            "团队密钥版本已变化，请刷新后重试",
            json!({ "currentVersion": current_version }),
        ));
    }
    validate_wrapped_keys(&state.pool, team_id, &body.wrapped_keys).await?;

    let mut tx = state.pool.begin().await?;
    let locked_version: i32 = sqlx::query_scalar(
        "SELECT current_version FROM team_encryption WHERE team_id = $1 FOR UPDATE",
    )
    .bind(team_id)
    .fetch_one(&mut *tx)
    .await?;
    if locked_version != current_version {
        tx.rollback().await.ok();
        return Err(AppError::conflict(
            "encryption_version_conflict",
            "团队密钥版本已变化，请刷新后重试",
            json!({ "currentVersion": locked_version }),
        ));
    }

    for item in &body.wrapped_keys {
        sqlx::query(
            "INSERT INTO team_encryption_wrapped_keys
                (team_id, version, device_id, wrapped_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (team_id, version, device_id)
             DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key",
        )
        .bind(team_id)
        .bind(body.version)
        .bind(item.device_id)
        .bind(item.wrapped_key.trim())
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "UPDATE team_encryption
         SET current_version = $2, updated_at = now()
         WHERE team_id = $1",
    )
    .bind(team_id)
    .bind(body.version)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "encryption",
        "encryption.key.create",
        json!({
            "version": body.version,
            "deviceCount": body.wrapped_keys.len(),
        }),
    )
    .await;

    Ok(Json(json!({
        "version": body.version,
        "distributed": body.wrapped_keys.len(),
    })))
}

pub async fn add_wrapped_keys(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, version)): Path<(Uuid, i32)>,
    Json(body): Json<AddWrappedKeysRequest>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有所有者或管理员可以分发团队密钥"));
    }
    let (_, current_version) = load_encryption_state(&state.pool, team_id).await?;
    if version <= 0 || version > current_version {
        return Err(AppError::conflict(
            "encryption_version_conflict",
            "只能为已创建的团队密钥版本分发包裹密钥",
            json!({ "currentVersion": current_version }),
        ));
    }
    let version_exists: Option<i32> = sqlx::query_scalar(
        "SELECT version FROM team_encryption_wrapped_keys
         WHERE team_id = $1 AND version = $2
         LIMIT 1",
    )
    .bind(team_id)
    .bind(version)
    .fetch_optional(&state.pool)
    .await?;
    if version_exists.is_none() {
        return Err(AppError::conflict(
            "encryption_version_unknown",
            "团队密钥版本不存在",
            json!({ "version": version }),
        ));
    }
    validate_wrapped_keys(&state.pool, team_id, &body.wrapped_keys).await?;

    for item in &body.wrapped_keys {
        sqlx::query(
            "INSERT INTO team_encryption_wrapped_keys
                (team_id, version, device_id, wrapped_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (team_id, version, device_id)
             DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key",
        )
        .bind(team_id)
        .bind(version)
        .bind(item.device_id)
        .bind(item.wrapped_key.trim())
        .execute(&state.pool)
        .await?;
    }

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "encryption",
        "encryption.key.distribute",
        json!({
            "version": version,
            "deviceCount": body.wrapped_keys.len(),
        }),
    )
    .await;

    Ok(Json(json!({
        "version": version,
        "distributed": body.wrapped_keys.len(),
    })))
}
