use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::validate_password_policy;
use crate::error::AppError;
use crate::state::AppState;

pub async fn healthz() -> StatusCode {
    StatusCode::OK
}

pub async fn readyz(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let _: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&state.pool).await?;
    Ok(StatusCode::OK)
}

pub async fn meta(State(state): State<AppState>) -> Json<Value> {
    let bootstrap_insecure = state.config.bootstrap_account.is_some()
        && state
            .config
            .bootstrap_password
            .as_deref()
            .is_some_and(|password| {
                password == "change-me-please"
                    || password == "ChangeMe2026"
                    || validate_password_policy(password).is_err()
            });
    Json(json!({
        "name": "inkline-team-server",
        "version": env!("CARGO_PKG_VERSION"),
        "minClientVersion": state.config.min_client_version,
        "bootstrapInsecure": bootstrap_insecure,
        "limits": {
            "maxCompressedBytes": state.config.max_compressed_bytes,
            "maxUncompressedBytes": state.config.max_uncompressed_bytes,
        },
        "retention": {
            "snapshotDays": state.config.default_snapshot_retention_days,
            "auditDays": state.config.default_audit_retention_days,
        }
    }))
}
