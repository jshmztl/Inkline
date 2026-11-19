use std::collections::{HashMap, HashSet};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::config::EscrowKek;
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

const ALLOWED_ALGORITHM: &str = "RSA-OAEP-256";
const MAX_PUBLIC_KEY_BYTES: usize = 8192;
const MAX_WRAPPED_KEY_BYTES: usize = 8192;
const MAX_DEVICES_PER_USER: i64 = 10;
const ENCRYPTED_VALUE_PREFIX: &str = "enc:v1:";
const ESCROW_FORMAT_VERSION: u8 = 1;
const ESCROW_NONCE_BYTES: usize = 12;
const ESCROW_TAG_BYTES: usize = 16;

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

#[derive(Debug, Deserialize)]
pub struct EscrowKeyRequest {
    pub version: i32,
    #[serde(rename = "teamKey")]
    pub team_key: String,
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

pub async fn load_server_review_enabled(pool: &PgPool, team_id: Uuid) -> Result<bool, AppError> {
    let value: Option<bool> = sqlx::query_scalar(
        "SELECT server_review_enabled FROM team_encryption WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(pool)
    .await?;
    Ok(value.unwrap_or(true))
}

fn escrow_kek<'a>(keks: &'a [EscrowKek], kid: &str) -> Option<&'a EscrowKek> {
    keks.iter().find(|kek| kek.kid == kid)
}

fn escrow_aad(team_id: Uuid, key_version: i32, kek_kid: &str) -> Vec<u8> {
    format!("inkline-escrow-v1:{team_id}:{key_version}:{kek_kid}").into_bytes()
}

/// 用服务端 KEK 包裹团队密钥。密文格式：版本字节 ‖ nonce ‖ AES-GCM 密文与 tag。
pub fn wrap_team_key(
    kek: &EscrowKek,
    team_id: Uuid,
    key_version: i32,
    team_key: &str,
) -> Result<String, AppError> {
    let key_bytes = STANDARD
        .decode(team_key.trim())
        .map_err(|_| AppError::validation("团队密钥不是合法的 Base64"))?;
    if key_bytes.len() != 32 {
        return Err(AppError::validation("团队密钥必须是 32 字节"));
    }

    let cipher = Aes256Gcm::new_from_slice(kek.key())
        .map_err(|_| AppError::internal("初始化服务端 KEK 失败"))?;
    let mut nonce = [0u8; ESCROW_NONCE_BYTES];
    rand::thread_rng().fill_bytes(&mut nonce);
    let aad = escrow_aad(team_id, key_version, &kek.kid);
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &key_bytes,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::internal("包裹团队密钥失败"))?;

    let mut combined = Vec::with_capacity(1 + ESCROW_NONCE_BYTES + sealed.len());
    combined.push(ESCROW_FORMAT_VERSION);
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&sealed);
    Ok(STANDARD.encode(combined))
}

pub fn unwrap_team_key(
    kek: &EscrowKek,
    team_id: Uuid,
    key_version: i32,
    wrapped: &str,
) -> Result<String, AppError> {
    let combined = STANDARD
        .decode(wrapped)
        .map_err(|_| AppError::internal("托管密钥不是合法 Base64"))?;
    if combined.len() < 1 + ESCROW_NONCE_BYTES + ESCROW_TAG_BYTES {
        return Err(AppError::internal("托管密钥长度不正确"));
    }
    if combined[0] != ESCROW_FORMAT_VERSION {
        return Err(AppError::internal("托管密钥格式版本不支持"));
    }
    let nonce = &combined[1..1 + ESCROW_NONCE_BYTES];
    let sealed = &combined[1 + ESCROW_NONCE_BYTES..];
    let cipher = Aes256Gcm::new_from_slice(kek.key())
        .map_err(|_| AppError::internal("初始化服务端 KEK 失败"))?;
    let aad = escrow_aad(team_id, key_version, &kek.kid);
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: sealed,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::internal("解包托管团队密钥失败"))?;
    if plain.len() != 32 {
        return Err(AppError::internal("托管团队密钥长度不正确"));
    }
    Ok(STANDARD.encode(plain))
}

fn key_fingerprint(key_bytes: &[u8]) -> String {
    let digest = Sha256::digest(key_bytes);
    hex::encode(&digest[..8])
}

fn team_key_fingerprint(team_key: &str) -> Result<String, AppError> {
    let bytes = STANDARD
        .decode(team_key.trim())
        .map_err(|_| AppError::internal("团队密钥不是合法 Base64"))?;
    Ok(key_fingerprint(&bytes))
}

/// 读取并解包指定版本的托管团队密钥；不存在、KEK 缺失或解包失败时返回 `None`。
pub async fn load_escrow_team_key(
    pool: &PgPool,
    team_id: Uuid,
    key_version: i32,
    keks: &[EscrowKek],
) -> Result<Option<String>, AppError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT wrapped_key, kek_kid FROM team_key_escrow
         WHERE team_id = $1 AND key_version = $2",
    )
    .bind(team_id)
    .bind(key_version)
    .fetch_optional(pool)
    .await?;

    let Some((wrapped, kek_kid)) = row else {
        return Ok(None);
    };
    let Some(kek) = escrow_kek(keks, &kek_kid) else {
        tracing::warn!(
            team_id = %team_id,
            key_version = key_version,
            kek_kid = %kek_kid,
            "托管团队密钥对应的 KEK 未配置"
        );
        return Ok(None);
    };
    match unwrap_team_key(kek, team_id, key_version, &wrapped) {
        Ok(team_key) => Ok(Some(team_key)),
        Err(error) => {
            tracing::warn!(
                team_id = %team_id,
                key_version = key_version,
                error = %error.message,
                "托管团队密钥无法解包，按未托管处理"
            );
            Ok(None)
        }
    }
}

/// 返回可用的托管密钥版本：KEK 存在、能解包，且与对应快照的 keyId 一致。
pub async fn escrow_versions(
    pool: &PgPool,
    team_id: Uuid,
    keks: &[EscrowKek],
) -> Result<Vec<i32>, AppError> {
    let rows: Vec<(i32, String, String)> = sqlx::query_as(
        "SELECT key_version, wrapped_key, kek_kid FROM team_key_escrow
         WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let snapshots: Vec<(i32, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT ON (encryption_version) encryption_version, encryption_key_id
         FROM snapshots
         WHERE team_id = $1 AND encryption_version IS NOT NULL
         ORDER BY encryption_version, revision DESC",
    )
    .bind(team_id)
    .fetch_all(pool)
    .await?;
    let expected_keys: std::collections::HashMap<i32, String> = snapshots
        .into_iter()
        .filter_map(|(version, key_id)| key_id.map(|key_id| (version, key_id)))
        .collect();

    let mut versions = Vec::new();
    for (version, wrapped, kek_kid) in rows {
        let Some(kek) = escrow_kek(keks, &kek_kid) else {
            continue;
        };
        let Ok(team_key) = unwrap_team_key(kek, team_id, version, &wrapped) else {
            continue;
        };
        if let Some(expected) = expected_keys.get(&version) {
            let Ok(fingerprint) = team_key_fingerprint(&team_key) else {
                continue;
            };
            if &fingerprint != expected {
                continue;
            }
        }
        versions.push(version);
    }
    versions.sort_unstable();
    Ok(versions)
}

/// 从反向代理头提取来源 IP，仅用于审计展示。
pub fn audit_source_ip(headers: &HeaderMap) -> Option<String> {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    forwarded
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

/// 写入管理台解密审计。必须在把明文返回给管理台之前调用。
#[allow(clippy::too_many_arguments)]
pub async fn write_decrypt_audit(
    pool: &PgPool,
    team_id: Uuid,
    actor_id: Uuid,
    actor_role: &str,
    scope: &str,
    snapshot_revision: Option<i64>,
    request_id: Option<&str>,
    key_version: Option<i32>,
    fields: Value,
    result: &str,
    source_ip: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO admin_decrypt_audit
            (team_id, actor_id, actor_role, scope, snapshot_revision,
             request_id, key_version, fields, result, source_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(team_id)
    .bind(actor_id)
    .bind(actor_role)
    .bind(scope)
    .bind(snapshot_revision)
    .bind(request_id)
    .bind(key_version)
    .bind(fields)
    .bind(result)
    .bind(source_ip)
    .execute(pool)
    .await?;
    Ok(())
}

fn decrypt_team_value(team_key: &str, encrypted: &str) -> Result<String, AppError> {
    let payload = encrypted
        .strip_prefix(ENCRYPTED_VALUE_PREFIX)
        .ok_or_else(|| AppError::internal("快照内容不是加密格式"))?;
    let combined = STANDARD
        .decode(payload)
        .map_err(|_| AppError::internal("快照密文不是合法 Base64"))?;
    if combined.len() <= 12 {
        return Err(AppError::internal("快照密文长度不正确"));
    }
    let (iv, sealed) = combined.split_at(12);
    let key = STANDARD
        .decode(team_key.trim())
        .map_err(|_| AppError::internal("团队密钥不是合法 Base64"))?;
    if key.len() != 32 {
        return Err(AppError::internal("团队密钥长度不正确"));
    }
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::internal("初始化团队密钥失败"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(iv), sealed)
        .map_err(|_| AppError::internal("解密快照内容失败"))?;
    String::from_utf8(plain).map_err(|_| AppError::internal("解密内容不是有效 UTF-8"))
}

/// 使用托管团队密钥就地解密快照中的请求头、请求体与字段文档。
pub fn decrypt_snapshot_payload(payload: &mut Value, team_key: &str) -> Result<bool, AppError> {
    let mut decrypted = false;

    if let Some(requests) = payload.get_mut("requests").and_then(Value::as_array_mut) {
        for request in requests {
            let Some(object) = request.as_object_mut() else {
                continue;
            };
            if let Some(Value::String(headers)) = object.get("headers") {
                if headers.starts_with(ENCRYPTED_VALUE_PREFIX) {
                    let plain = decrypt_team_value(team_key, headers)?;
                    let parsed: Value = serde_json::from_str(&plain)
                        .map_err(|_| AppError::internal("解密后的请求头不是合法 JSON"))?;
                    object.insert("headers".to_string(), parsed);
                    decrypted = true;
                }
            }
            if let Some(Value::String(body)) = object.get("body") {
                if body.starts_with(ENCRYPTED_VALUE_PREFIX) {
                    let plain = decrypt_team_value(team_key, body)?;
                    object.insert("body".to_string(), Value::String(plain));
                    decrypted = true;
                }
            }
        }
    }

    if let Some(documents) = payload.get_mut("documents").and_then(Value::as_object_mut) {
        for value in documents.values_mut() {
            let Value::String(text) = value else {
                continue;
            };
            if !text.starts_with(ENCRYPTED_VALUE_PREFIX) {
                continue;
            }
            let plain = decrypt_team_value(team_key, text)?;
            let parsed: Value = serde_json::from_str(&plain)
                .map_err(|_| AppError::internal("解密后的字段文档不是合法 JSON"))?;
            *value = parsed;
            decrypted = true;
        }
    }

    Ok(decrypted)
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
    let team_review_enabled = load_server_review_enabled(&state.pool, team_id).await?;
    let feature_enabled = state.config.escrow_active_kid.is_some();
    let review_enabled = feature_enabled && team_review_enabled;
    let escrow_versions = if review_enabled {
        escrow_versions(&state.pool, team_id, &state.config.escrow_keks).await?
    } else {
        Vec::new()
    };
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
        "serverReview": {
            "enabled": review_enabled,
            "featureEnabled": feature_enabled,
            "teamEnabled": team_review_enabled,
            "activeKekId": state.config.escrow_active_kid.clone(),
            "versions": escrow_versions,
        },
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

/// 所有者 / 管理员把当前团队密钥的受控副本托管到服务端，用于管理台审阅。
pub async fn put_escrow(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<EscrowKeyRequest>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有所有者或管理员可以托管团队密钥"));
    }

    let (enabled, current_version) = load_encryption_state(&state.pool, team_id).await?;
    if !enabled || current_version == 0 {
        return Err(AppError::conflict(
            "encryption_not_ready",
            "团队密钥尚未创建，无法托管",
            json!({ "currentVersion": current_version }),
        ));
    }
    if body.version <= 0 || body.version > current_version {
        return Err(AppError::conflict(
            "encryption_version_mismatch",
            "只能托管已创建的团队密钥版本",
            json!({ "currentVersion": current_version }),
        ));
    }
    let version_exists: Option<i32> = sqlx::query_scalar(
        "SELECT version FROM team_encryption_wrapped_keys
         WHERE team_id = $1 AND version = $2
         LIMIT 1",
    )
    .bind(team_id)
    .bind(body.version)
    .fetch_optional(&state.pool)
    .await?;
    if version_exists.is_none() {
        return Err(AppError::conflict(
            "encryption_version_unknown",
            "团队密钥版本不存在",
            json!({ "version": body.version }),
        ));
    }

    let key_bytes = STANDARD
        .decode(body.team_key.trim())
        .map_err(|_| AppError::validation("团队密钥不是合法的 Base64"))?;
    if key_bytes.len() != 32 {
        return Err(AppError::validation("团队密钥必须是 32 字节"));
    }

    let expected_key_id: Option<String> = sqlx::query_scalar(
        "SELECT encryption_key_id FROM snapshots
         WHERE team_id = $1 AND encryption_version = $2
         ORDER BY revision DESC
         LIMIT 1",
    )
    .bind(team_id)
    .bind(body.version)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(expected) = expected_key_id {
        if expected != key_fingerprint(&key_bytes) {
            return Err(AppError::conflict(
                "escrow_key_mismatch",
                "托管的团队密钥与最新快照不一致",
                json!({ "expectedKeyId": expected }),
            ));
        }
    }

    let Some(active_kid) = state.config.escrow_active_kid.clone() else {
        return Err(AppError::conflict(
            "server_review_disabled",
            "服务端未配置审阅主密钥（ESCROW_KEK）",
            json!({}),
        ));
    };
    if !load_server_review_enabled(&state.pool, team_id).await? {
        return Err(AppError::conflict(
            "server_review_disabled",
            "团队已关闭服务端审阅",
            json!({}),
        ));
    }
    let Some(kek) = state.config.escrow_keks.iter().find(|kek| kek.kid == active_kid) else {
        return Err(AppError::internal("服务端审阅 KEK 配置不一致"));
    };

    let stored = wrap_team_key(kek, team_id, body.version, body.team_key.trim())?;
    sqlx::query(
        "INSERT INTO team_key_escrow
            (team_id, key_version, wrapped_key, kek_kid, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, key_version) DO UPDATE
         SET wrapped_key = EXCLUDED.wrapped_key,
             kek_kid = EXCLUDED.kek_kid,
             created_by = EXCLUDED.created_by,
             updated_at = now()",
    )
    .bind(team_id)
    .bind(body.version)
    .bind(&stored)
    .bind(&active_kid)
    .bind(user.0)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "encryption",
        "encryption.escrow.store",
        json!({
            "version": body.version,
            "kekKid": active_kid,
        }),
    )
    .await;

    Ok(Json(json!({
        "version": body.version,
        "stored": true,
        "kekKid": active_kid,
    })))
}

/// 开启团队级服务端审阅。开启后，管理员客户端下次刷新会自动补齐托管密钥。
pub async fn enable_server_review(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有所有者或管理员可以开启服务端审阅"));
    }
    if state.config.escrow_active_kid.is_none() {
        return Err(AppError::conflict(
            "server_review_disabled",
            "服务端未配置审阅主密钥（ESCROW_KEK）",
            json!({}),
        ));
    }
    ensure_encryption_row(&state.pool, team_id).await?;
    sqlx::query(
        "UPDATE team_encryption
         SET server_review_enabled = true, updated_at = now()
         WHERE team_id = $1",
    )
    .bind(team_id)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "encryption",
        "encryption.escrow.enable",
        json!({}),
    )
    .await;

    Ok(Json(json!({ "enabled": true })))
}

/// 关闭团队级服务端审阅，并删除全部托管副本。设备包裹路径不受影响。
pub async fn disable_server_review(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::forbidden("只有所有者或管理员可以关闭服务端审阅"));
    }
    ensure_encryption_row(&state.pool, team_id).await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE team_encryption
         SET server_review_enabled = false, updated_at = now()
         WHERE team_id = $1",
    )
    .bind(team_id)
    .execute(&mut *tx)
    .await?;
    let deleted = sqlx::query("DELETE FROM team_key_escrow WHERE team_id = $1")
        .bind(team_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "encryption",
        "encryption.escrow.disable",
        json!({ "deleted": deleted }),
    )
    .await;

    Ok(Json(json!({
        "enabled": false,
        "deleted": deleted,
    })))
}

#[cfg(test)]
mod tests {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use rand::RngCore;
    use serde_json::json;
    use uuid::Uuid;

    use super::{
        decrypt_snapshot_payload, unwrap_team_key, wrap_team_key, ENCRYPTED_VALUE_PREFIX,
    };
    use crate::config::EscrowKek;

    fn test_kek(kid: &str, fill: u8) -> EscrowKek {
        EscrowKek::from_base64(kid, &STANDARD.encode([fill; 32])).expect("kek")
    }

    fn encrypt_value(team_key: &str, plaintext: &str) -> String {
        let key = STANDARD.decode(team_key).expect("team key");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let sealed = cipher
            .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
            .expect("encrypt");
        let mut combined = Vec::with_capacity(iv.len() + sealed.len());
        combined.extend_from_slice(&iv);
        combined.extend_from_slice(&sealed);
        format!("{ENCRYPTED_VALUE_PREFIX}{}", STANDARD.encode(combined))
    }

    #[test]
    fn wrapped_team_key_roundtrip_and_aad_binding() {
        let kek = test_kek("kek-test", 7);
        let team_id = Uuid::new_v4();
        let team_key = STANDARD.encode([9u8; 32]);
        let wrapped = wrap_team_key(&kek, team_id, 1, &team_key).expect("wrap");

        assert_eq!(
            unwrap_team_key(&kek, team_id, 1, &wrapped).expect("unwrap"),
            team_key
        );
        assert!(unwrap_team_key(&kek, Uuid::new_v4(), 1, &wrapped).is_err());
        assert!(unwrap_team_key(&kek, team_id, 2, &wrapped).is_err());
        assert!(unwrap_team_key(&test_kek("kek-other", 8), team_id, 1, &wrapped).is_err());
    }

    #[test]
    fn decrypts_encrypted_snapshot_fields() {
        let team_key = STANDARD.encode([9u8; 32]);
        let mut payload = json!({
            "requests": [{
                "id": "r1",
                "headers": encrypt_value(
                    &team_key,
                    r#"[{"name":"Authorization","value":"Bearer token"}]"#,
                ),
                "body": encrypt_value(&team_key, r#"{"amount":12800}"#),
            }],
            "documents": {
                "r1": encrypt_value(&team_key, r#"[{"key":"amount","path":"amount"}]"#),
            },
            "encryption": { "algorithm": "AES-GCM", "version": 1, "keyVersion": 1 },
        });

        assert!(decrypt_snapshot_payload(&mut payload, &team_key).expect("decrypt payload"));
        assert_eq!(payload["requests"][0]["headers"][0]["name"], "Authorization");
        assert_eq!(payload["requests"][0]["body"], r#"{"amount":12800}"#);
        assert_eq!(payload["documents"]["r1"][0]["key"], "amount");
    }
}
