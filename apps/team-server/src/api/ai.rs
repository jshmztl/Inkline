use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

use super::teams::require_membership;

const AI_PROVIDERS: [&str; 5] = [
    "deepseek",
    "qwen-cloud",
    "qwen-ollama",
    "qwen-vllm",
    "custom",
];

#[derive(Debug, sqlx::FromRow)]
struct AiConfigRow {
    enabled: bool,
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

fn config_json(row: Option<&AiConfigRow>) -> Value {
    match row {
        Some(row) => json!({
            "enabled": row.enabled,
            "provider": row.provider,
            "baseUrl": row.base_url,
            "model": row.model,
            "hasApiKey": !row.api_key.trim().is_empty(),
            "updatedAt": row.updated_at,
        }),
        None => Value::Null,
    }
}

async fn fetch_config(
    pool: &sqlx::PgPool,
    team_id: Uuid,
) -> Result<Option<AiConfigRow>, AppError> {
    let row = sqlx::query_as::<_, AiConfigRow>(
        "SELECT enabled, provider, base_url, model, api_key, updated_at
         FROM team_ai_configs WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

fn require_manager(role: &str) -> Result<(), AppError> {
    if role == "owner" || role == "admin" {
        Ok(())
    } else {
        Err(AppError::forbidden("只有团队所有者或管理员可以修改 AI 配置"))
    }
}

fn normalize_base_url(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Ok(trimmed);
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(AppError::validation(
            "AI 网关地址必须以 http:// 或 https:// 开头",
        ));
    }
    if trimmed.chars().count() > 500 {
        return Err(AppError::validation("AI 网关地址过长"));
    }
    Ok(trimmed)
}

pub async fn get_config(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    require_membership(&state.pool, team_id, user.0).await?;
    let row = fetch_config(&state.pool, team_id).await?;
    Ok(Json(json!({ "config": config_json(row.as_ref()) })))
}

#[derive(Debug, Deserialize)]
pub struct UpdateAiConfigRequest {
    pub enabled: Option<bool>,
    pub provider: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "clearApiKey")]
    pub clear_api_key: Option<bool>,
}

pub async fn update_config(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<UpdateAiConfigRequest>,
) -> Result<Json<Value>, AppError> {
    let role = require_membership(&state.pool, team_id, user.0).await?;
    require_manager(&role)?;

    let current = fetch_config(&state.pool, team_id).await?;

    let provider = body
        .provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .or_else(|| current.as_ref().map(|row| row.provider.clone()))
        .unwrap_or_else(|| "custom".to_string());
    if !AI_PROVIDERS.contains(&provider.as_str()) {
        return Err(AppError::validation("不支持的 AI 服务提供方"));
    }

    let base_url = match body.base_url.as_deref() {
        Some(value) => normalize_base_url(value)?,
        None => current
            .as_ref()
            .map(|row| row.base_url.clone())
            .unwrap_or_default(),
    };
    let model = body
        .model
        .as_deref()
        .map(|value| value.trim().to_string())
        .or_else(|| current.as_ref().map(|row| row.model.clone()))
        .unwrap_or_default();
    let enabled = body
        .enabled
        .or_else(|| current.as_ref().map(|row| row.enabled))
        .unwrap_or(false);

    if model.chars().count() > 120 {
        return Err(AppError::validation("模型名过长"));
    }
    if enabled && (base_url.is_empty() || model.is_empty()) {
        return Err(AppError::validation(
            "启用团队 AI 前必须填写网关地址与模型名",
        ));
    }

    let api_key = if body.clear_api_key.unwrap_or(false) {
        String::new()
    } else {
        match body.api_key.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => current
                .as_ref()
                .map(|row| row.api_key.clone())
                .unwrap_or_default(),
        }
    };

    sqlx::query(
        "INSERT INTO team_ai_configs
            (team_id, enabled, provider, base_url, model, api_key, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (team_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            provider = EXCLUDED.provider,
            base_url = EXCLUDED.base_url,
            model = EXCLUDED.model,
            api_key = EXCLUDED.api_key,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()",
    )
    .bind(team_id)
    .bind(enabled)
    .bind(&provider)
    .bind(&base_url)
    .bind(&model)
    .bind(&api_key)
    .bind(user.0)
    .execute(&state.pool)
    .await?;

    let _ = db::write_audit(
        &state.pool,
        Some(team_id),
        Some(user.0),
        "ai",
        "team.ai_config.update",
        json!({
            "enabled": enabled,
            "provider": provider,
            "baseUrl": base_url,
            "model": model,
            "hasApiKey": !api_key.trim().is_empty(),
        }),
    )
    .await;

    let row = fetch_config(&state.pool, team_id).await?;
    Ok(Json(json!({ "config": config_json(row.as_ref()) })))
}

pub async fn chat_proxy(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response, AppError> {
    require_membership(&state.pool, team_id, user.0).await?;

    let row = fetch_config(&state.pool, team_id).await?;
    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "ai_not_configured",
            "团队尚未配置 AI 服务，请联系团队管理员",
        ));
    };
    if !row.enabled {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "ai_disabled",
            "团队 AI 服务已关闭，请联系团队管理员",
        ));
    }
    if row.base_url.trim().is_empty() || row.model.trim().is_empty() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "ai_not_configured",
            "团队 AI 配置不完整，请联系团队管理员",
        ));
    }

    let messages = body
        .get("messages")
        .filter(|value| value.is_array())
        .cloned()
        .ok_or_else(|| AppError::validation("请求缺少 messages 数组"))?;
    let message_count = messages.as_array().map(|items| items.len()).unwrap_or(0);
    let stream = body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let temperature = body
        .get("temperature")
        .and_then(Value::as_f64)
        .unwrap_or(0.2);

    let payload = json!({
        "model": row.model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    });

    let url = format!(
        "{}/chat/completions",
        row.base_url.trim_end_matches('/')
    );
    let mut request = state.http.post(&url).json(&payload);
    if !row.api_key.trim().is_empty() {
        request = request.bearer_auth(row.api_key.trim());
    }

    let upstream = request.send().await.map_err(|error| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            "ai_upstream_unreachable",
            format!("无法连接团队 AI 网关：{error}"),
        )
    })?;

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    let pool = state.pool.clone();
    let user_id = user.0;
    let model = row.model.clone();
    tokio::spawn(async move {
        let _ = db::write_audit(
            &pool,
            Some(team_id),
            Some(user_id),
            "ai",
            "ai.chat",
            json!({
                "model": model,
                "stream": stream,
                "messages": message_count,
            }),
        )
        .await;
    });

    let stream_body = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let mut response = Response::new(Body::from_stream(stream_body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/json")),
    );
    Ok(response)
}
