use std::io::Read;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db;
use crate::error::AppError;
use crate::models::SnapshotMetaRow;
use crate::policy::{self, Viewer};
use crate::state::AppState;

const BASE_REVISION_HEADER: &str = "x-inkline-base-revision";
const IDEMPOTENCY_HEADER: &str = "idempotency-key";

#[derive(Debug, Deserialize)]
pub struct SnapshotListQuery {
    pub limit: Option<i64>,
    pub before: Option<i64>,
}

#[derive(Debug, sqlx::FromRow)]
struct SnapshotHistoryRow {
    revision: i64,
    payload_hash: String,
    size_bytes: i64,
    schema_version: i32,
    base_revision: Option<i64>,
    created_at: DateTime<Utc>,
    created_by_name: Option<String>,
}

pub async fn list_snapshots(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Query(query): Query<SnapshotListQuery>,
) -> Result<Json<Value>, AppError> {
    crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;

    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let rows: Vec<SnapshotHistoryRow> = sqlx::query_as(
        "SELECT s.revision, s.payload_hash, s.size_bytes, s.schema_version,
                s.base_revision, s.created_at, u.display_name AS created_by_name
         FROM snapshots s
         LEFT JOIN users u ON u.id = s.created_by
         WHERE s.team_id = $1
           AND ($2::bigint IS NULL OR s.revision < $2)
         ORDER BY s.revision DESC
         LIMIT $3",
    )
    .bind(team_id)
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let next_cursor = if rows.len() as i64 == limit {
        rows.last().map(|row| row.revision)
    } else {
        None
    };

    Ok(Json(json!({
        "entries": rows.iter().map(|row| json!({
            "revision": row.revision,
            "hash": row.payload_hash,
            "sizeBytes": row.size_bytes,
            "schemaVersion": row.schema_version,
            "baseRevision": row.base_revision,
            "createdBy": { "displayName": row.created_by_name },
            "createdAt": row.created_at,
            "downloadUrl": format!("/v1/teams/{team_id}/snapshots/{}", row.revision),
        })).collect::<Vec<_>>(),
        "nextCursor": next_cursor,
    })))
}

pub async fn get_latest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Response, AppError> {
    crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;

    let row: Option<SnapshotMetaRow> = sqlx::query_as(
        "SELECT s.revision, s.payload_hash, s.size_bytes, s.schema_version, s.created_at,
                u.display_name AS created_by_name
         FROM snapshots s
         LEFT JOIN users u ON u.id = s.created_by
         WHERE s.team_id = $1
         ORDER BY s.revision DESC
         LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    Ok(Json(json!({
        "revision": row.revision,
        "hash": row.payload_hash,
        "sizeBytes": row.size_bytes,
        "schemaVersion": row.schema_version,
        "createdBy": { "displayName": row.created_by_name },
        "createdAt": row.created_at,
        "downloadUrl": format!("/v1/teams/{team_id}/snapshots/{}", row.revision),
    }))
    .into_response())
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, revision)): Path<(Uuid, i64)>,
) -> Result<Json<Value>, AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    let viewer = Viewer::new(user.0, &role);

    let payload: Option<Value> =
        sqlx::query_scalar("SELECT payload FROM snapshots WHERE team_id = $1 AND revision = $2")
            .bind(team_id)
            .bind(revision)
            .fetch_optional(&state.pool)
            .await?;

    let Some(payload) = payload else {
        return Err(AppError::not_found("快照版本不存在"));
    };

    if viewer.is_manager() {
        return Ok(Json(payload));
    }

    let policies = policy::load_policies(&state.pool, team_id).await?;
    Ok(Json(policy::filter_payload(&payload, &viewer, &policies)))
}

pub async fn push_snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let role = crate::api::teams::require_membership(&state.pool, team_id, user.0).await?;
    if role == "viewer" {
        return Err(AppError::forbidden("只读成员不能推送快照"));
    }

    let team: Option<(String, i64)> =
        sqlx::query_as("SELECT max_data_level, current_revision FROM teams WHERE id = $1")
            .bind(team_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((max_data_level, _)) = team else {
        return Err(AppError::not_found("团队不存在"));
    };

    if body.len() > state.config.max_compressed_bytes {
        return Err(AppError::payload_too_large(format!(
            "快照超过压缩后大小限制（{} MB）",
            state.config.max_compressed_bytes / 1024 / 1024
        )));
    }

    let encoding = headers
        .get(axum::http::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok());
    let decoded = decode_payload(&body, encoding, state.config.max_uncompressed_bytes)?;

    let value: Value = serde_json::from_slice(&decoded)
        .map_err(|error| AppError::validation(format!("快照 JSON 解析失败：{error}")))?;

    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    if !(1..=2).contains(&schema_version) {
        return Err(AppError::validation(format!(
            "不支持的 schemaVersion：{schema_version}"
        )));
    }

    let requests = value
        .get("requests")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("快照缺少 requests 数组"))?;
    policy::validate_snapshot_levels(requests, &max_data_level)?;

    let header_base = headers
        .get(BASE_REVISION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let body_base = value.get("baseRevision").and_then(Value::as_i64);
    let base_revision = match (header_base, body_base) {
        (Some(header), Some(body)) if header != body => {
            return Err(AppError::validation(
                "请求头 X-Inkline-Base-Revision 与请求体 baseRevision 不一致",
            ));
        }
        (Some(header), _) => header,
        (None, Some(body)) => body,
        (None, None) => {
            return Err(AppError::validation("缺少 baseRevision"));
        }
    };
    if base_revision < 0 {
        return Err(AppError::validation("baseRevision 不能为负数"));
    }

    let idempotency_key = headers
        .get(IDEMPOTENCY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("缺少 Idempotency-Key 请求头"))?;
    if idempotency_key.chars().count() > 128 {
        return Err(AppError::validation("Idempotency-Key 不能超过 128 个字符"));
    }

    let viewer = Viewer::new(user.0, &role);
    let source_hash = format!("sha256:{}", hex::encode(Sha256::digest(&decoded)));

    let existing: Option<(i64, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT revision, payload_hash, source_hash, created_at FROM snapshots
         WHERE team_id = $1 AND idempotency_key = $2",
    )
    .bind(team_id)
    .bind(idempotency_key)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((revision, hash, stored_source, created_at)) = existing {
        let stored_source = stored_source.unwrap_or_else(|| hash.clone());
        if stored_source == source_hash {
            return Ok((
                StatusCode::CREATED,
                Json(json!({
                    "revision": revision,
                    "hash": hash,
                    "createdAt": created_at,
                })),
            ));
        }
        return Err(AppError::conflict(
            "idempotency_mismatch",
            "Idempotency-Key 已用于不同的快照内容",
            json!({ "revision": revision }),
        ));
    }

    let policies = policy::load_policies(&state.pool, team_id).await?;

    let mut tx = state.pool.begin().await?;
    let revision: Option<i64> = sqlx::query_scalar(
        "UPDATE teams
         SET current_revision = current_revision + 1
         WHERE id = $1 AND current_revision = $2
         RETURNING current_revision",
    )
    .bind(team_id)
    .bind(base_revision)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(revision) = revision else {
        let latest_revision: i64 =
            sqlx::query_scalar("SELECT current_revision FROM teams WHERE id = $1")
                .bind(team_id)
                .fetch_one(&mut *tx)
                .await?;
        let latest_hash: Option<String> = sqlx::query_scalar(
            "SELECT payload_hash FROM snapshots WHERE team_id = $1 ORDER BY revision DESC LIMIT 1",
        )
        .bind(team_id)
        .fetch_optional(&mut *tx)
        .await?;

        return Err(AppError::conflict(
            "revision_conflict",
            "远端已有更新版本，请先拉取并合并",
            json!({
                "latestRevision": latest_revision,
                "latestHash": latest_hash,
            }),
        ));
    };

    let full_payload: Option<Value> = sqlx::query_scalar(
        "SELECT payload FROM snapshots WHERE team_id = $1 ORDER BY revision DESC LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(&mut *tx)
    .await?;

    let merged = policy::merge_payload(full_payload.as_ref(), &value, &viewer, &policies);
    let merged_bytes = serde_json::to_vec(&merged.payload)
        .map_err(|error| AppError::internal(format!("快照合并序列化失败：{error}")))?;
    let payload_hash = format!("sha256:{}", hex::encode(Sha256::digest(&merged_bytes)));

    let created_at = Utc::now();
    let insert_result = sqlx::query(
        "INSERT INTO snapshots
            (team_id, revision, payload, payload_hash, source_hash, size_bytes, schema_version, base_revision, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(team_id)
    .bind(revision)
    .bind(&merged.payload)
    .bind(&payload_hash)
    .bind(&source_hash)
    .bind(merged_bytes.len() as i64)
    .bind(schema_version as i32)
    .bind(base_revision)
    .bind(user.0)
    .bind(idempotency_key)
    .execute(&mut *tx)
    .await;

    if let Err(error) = insert_result {
        let is_unique = matches!(&error, sqlx::Error::Database(db) if db.is_unique_violation());
        if is_unique {
            tx.rollback().await.ok();
            let existing: Option<(i64, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
                "SELECT revision, payload_hash, source_hash, created_at FROM snapshots
                 WHERE team_id = $1 AND idempotency_key = $2",
            )
            .bind(team_id)
            .bind(idempotency_key)
            .fetch_optional(&state.pool)
            .await?;

            if let Some((revision, hash, stored_source, created_at)) = existing {
                let stored_source = stored_source.unwrap_or_else(|| hash.clone());
                if stored_source == source_hash {
                    return Ok((
                        StatusCode::CREATED,
                        Json(json!({
                            "revision": revision,
                            "hash": hash,
                            "createdAt": created_at,
                        })),
                    ));
                }
                return Err(AppError::conflict(
                    "idempotency_mismatch",
                    "Idempotency-Key 已用于不同的快照内容",
                    json!({ "revision": revision }),
                ));
            }
        }
        return Err(error.into());
    }

    if !merged.removed_requests.is_empty() {
        sqlx::query(
            "DELETE FROM resource_policies
             WHERE team_id = $1 AND resource_type = 'request' AND resource_id = ANY($2)",
        )
        .bind(team_id)
        .bind(&merged.removed_requests)
        .execute(&mut *tx)
        .await?;
    }
    if !merged.removed_collections.is_empty() {
        sqlx::query(
            "DELETE FROM resource_policies
             WHERE team_id = $1 AND resource_type = 'collection' AND resource_id = ANY($2)",
        )
        .bind(team_id)
        .bind(&merged.removed_collections)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "sync",
        "snapshot.push",
        json!({
            "revision": revision,
            "baseRevision": base_revision,
            "sizeBytes": merged_bytes.len(),
            "sourceSizeBytes": decoded.len(),
        }),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "revision": revision,
            "hash": payload_hash,
            "createdAt": created_at,
        })),
    ))
}

fn decode_payload(
    raw: &[u8],
    encoding: Option<&str>,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let is_gzip = encoding
        .map(|value| value.eq_ignore_ascii_case("gzip"))
        .unwrap_or(false);

    if !is_gzip {
        if raw.len() > max_bytes {
            return Err(AppError::payload_too_large(format!(
                "快照超过解压后大小限制（{} MB）",
                max_bytes / 1024 / 1024
            )));
        }
        return Ok(raw.to_vec());
    }

    let decoder = flate2::read::GzDecoder::new(raw);
    let mut limited = decoder.take(max_bytes as u64 + 1);
    let mut output = Vec::new();
    limited
        .read_to_end(&mut output)
        .map_err(|error| AppError::validation(format!("gzip 解压失败：{error}")))?;

    if output.len() > max_bytes {
        return Err(AppError::payload_too_large(format!(
            "快照超过解压后大小限制（{} MB）",
            max_bytes / 1024 / 1024
        )));
    }

    Ok(output)
}
