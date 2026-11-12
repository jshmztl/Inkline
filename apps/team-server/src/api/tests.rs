use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use uuid::Uuid;

use crate::auth::hash_password;
use crate::config::Config;
use crate::state::AppState;

async fn test_state() -> Option<AppState> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .ok()?;
    sqlx::migrate!("./migrations").run(&pool).await.ok()?;
    sqlx::query("TRUNCATE users, teams CASCADE")
        .execute(&pool)
        .await
        .ok()?;

    Some(AppState {
        pool,
        config: Arc::new(Config {
            database_url: url,
            jwt_secret: "inkline-test-secret-at-least-32-chars".to_string(),
            bind_addr: "127.0.0.1:0".to_string(),
            access_token_ttl_seconds: 900,
            refresh_token_ttl_days: 30,
            max_compressed_bytes: 10 * 1024 * 1024,
            max_uncompressed_bytes: 50 * 1024 * 1024,
            default_snapshot_retention_days: 90,
            default_audit_retention_days: 90,
            cleanup_interval_hours: 24,
            cors_allowed_origins: vec!["http://localhost:1420".to_string()],
            min_client_version: "0.1.20".to_string(),
            bootstrap_account: None,
            bootstrap_password: None,
        }),
        presence: Default::default(),
    })
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .expect("build request");
    let response = app.clone().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

/// 需要 TEST_DATABASE_URL 指向一个可用的 PostgreSQL；未配置时跳过。
#[tokio::test]
async fn login_push_and_rollback_flow() {
    let Some(state) = test_state().await else {
        eprintln!("跳过团队服务集成测试：未设置 TEST_DATABASE_URL");
        return;
    };
    let password_hash = hash_password("Passw0rd!2026").expect("hash password");
    sqlx::query(
        "INSERT INTO users (id, account, display_name, password_hash) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind("admin")
    .bind("管理员")
    .bind(password_hash)
    .execute(&state.pool)
    .await
    .expect("insert user");

    let app = super::router(state);

    let (status, login) = call(
        &app,
        "POST",
        "/v1/auth/login",
        None,
        Some(json!({ "account": "admin", "password": "Passw0rd!2026" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "login failed: {login}");
    let token = login["accessToken"].as_str().expect("access token").to_string();

    let (status, team) = call(
        &app,
        "POST",
        "/v1/teams",
        Some(&token),
        Some(json!({ "name": "集成测试团队" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create team failed: {team}");
    let team_id = team["team"]["id"].as_str().expect("team id").to_string();

    let snapshot = json!({
        "schemaVersion": 2,
        "baseRevision": 0,
        "collections": [{ "id": "c1", "name": "订单服务", "sort": 0, "parentId": null }],
        "requests": [{
            "id": "r1",
            "name": "创建订单",
            "method": "POST",
            "url": "https://api.internal/orders",
            "headers": [],
            "body": "{}",
            "dataLevel": "L1",
            "collectionId": "c1",
            "sort": 0
        }],
        "documents": {}
    });

    let (status, pushed) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/snapshots"),
        Some(&token),
        Some(snapshot),
        &[
            ("x-inkline-base-revision", "0"),
            ("idempotency-key", "integration-push-1"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "push failed: {pushed}");
    assert_eq!(pushed["revision"], 1);

    let (status, latest) = call(
        &app,
        "GET",
        &format!("/v1/teams/{team_id}/snapshots/latest"),
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "latest failed: {latest}");
    assert_eq!(latest["revision"], 1);

    let (status, rolled) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/snapshots/1/rollback"),
        Some(&token),
        None,
        &[("idempotency-key", "integration-rollback-1")],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "rollback failed: {rolled}");
    assert_eq!(rolled["revision"], 2);
    assert_eq!(rolled["rolledBackFrom"], 1);

    let (status, latest) = call(
        &app,
        "GET",
        &format!("/v1/teams/{team_id}/snapshots/latest"),
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(latest["revision"], 2);
}
