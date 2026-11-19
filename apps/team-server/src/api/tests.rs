use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::{engine::general_purpose::STANDARD, Engine as _};
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
            escrow_active_kid: None,
            escrow_keks: Vec::new(),
        }),
        presence: Default::default(),
        login_guard: Default::default(),
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
        "INSERT INTO users (id, account, display_name, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, true)",
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
    assert_eq!(login["mustChangePassword"], true);
    let token = login["accessToken"].as_str().expect("access token").to_string();

    let (status, blocked) = call(&app, "GET", "/v1/me", Some(&token), None, &[]).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "must-change account should be blocked: {blocked}"
    );

    let (status, invalid) = call(
        &app,
        "POST",
        "/v1/auth/change-password",
        Some(&token),
        Some(json!({
            "currentPassword": "Passw0rd!2026",
            "newPassword": "onlyletters",
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "weak password should be rejected: {invalid}"
    );

    let (status, changed) = call(
        &app,
        "POST",
        "/v1/auth/change-password",
        Some(&token),
        Some(json!({
            "currentPassword": "Passw0rd!2026",
            "newPassword": "NewPassw0rd!2026",
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "change password failed: {changed}");
    assert_eq!(changed["mustChangePassword"], false);
    let token = changed["accessToken"]
        .as_str()
        .expect("new access token")
        .to_string();

    let (status, me) = call(&app, "GET", "/v1/me", Some(&token), None, &[]).await;
    assert_eq!(status, StatusCode::OK, "me after change failed: {me}");

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

    for _ in 0..5 {
        let (status, _) = call(
            &app,
            "POST",
            "/v1/auth/login",
            None,
            Some(json!({ "account": "admin", "password": "wrong-password" })),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    let (status, blocked) = call(
        &app,
        "POST",
        "/v1/auth/login",
        None,
        Some(json!({ "account": "admin", "password": "NewPassw0rd!2026" })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "login should be blocked: {blocked}"
    );

    // 端到端加密：注册设备、创建团队密钥并校验快照加密版本。
    let device_id = Uuid::new_v4();
    let public_key = STANDARD.encode(b"test-device-public-key");
    let wrapped_key = STANDARD.encode(b"wrapped-team-key");
    let (status, registered) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/encryption/devices"),
        Some(&token),
        Some(json!({
            "deviceId": device_id,
            "publicKey": public_key,
            "algorithm": "RSA-OAEP-256",
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "register encryption device failed: {registered}"
    );

    let (status, created_key) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/encryption/keys"),
        Some(&token),
        Some(json!({
            "version": 1,
            "wrappedKeys": [{
                "deviceId": device_id,
                "wrappedKey": wrapped_key,
                "algorithm": "RSA-OAEP-256",
            }],
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "create encryption key failed: {created_key}"
    );
    assert_eq!(created_key["version"], 1);

    let (status, encryption) = call(
        &app,
        "GET",
        &format!("/v1/teams/{team_id}/encryption?deviceId={device_id}"),
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "get encryption failed: {encryption}");
    assert_eq!(encryption["currentVersion"], 1);
    assert_eq!(encryption["wrappedKeys"][0]["version"], 1);
    assert_eq!(
        encryption["devices"][0]["publicKey"].as_str(),
        Some(public_key.as_str())
    );
    assert_eq!(encryption["devices"][0]["wrappedVersions"][0], 1);

    let (status, rejected) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/snapshots"),
        Some(&token),
        Some(json!({
            "schemaVersion": 2,
            "baseRevision": 2,
            "collections": [],
            "requests": [],
            "documents": {},
        })),
        &[
            ("x-inkline-base-revision", "2"),
            ("idempotency-key", "integration-encryption-plain"),
        ],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "plaintext push should be rejected: {rejected}"
    );
    assert_eq!(rejected["error"]["code"], "encryption_version_mismatch");

    let (status, encrypted) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/snapshots"),
        Some(&token),
        Some(json!({
            "schemaVersion": 2,
            "baseRevision": 2,
            "collections": [],
            "requests": [],
            "documents": {},
            "encryption": {
                "algorithm": "AES-GCM",
                "version": 1,
                "keyId": "test-key-id",
                "keyVersion": 1,
            },
        })),
        &[
            ("x-inkline-base-revision", "2"),
            ("idempotency-key", "integration-encryption-push"),
        ],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "encrypted push failed: {encrypted}"
    );
    assert_eq!(encrypted["revision"], 3);

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
    assert_eq!(latest["encryption"]["version"], 1);

    let (status, partial) = call(
        &app,
        "POST",
        &format!("/v1/teams/{team_id}/snapshots"),
        Some(&token),
        Some(json!({
            "schemaVersion": 2,
            "partial": true,
            "baseRevision": 3,
            "collections": [],
            "requests": [],
            "documents": {},
            "deletions": { "collections": [], "requests": [], "documents": [] },
            "encryption": {
                "algorithm": "AES-GCM",
                "version": 1,
                "keyId": "test-key-id",
                "keyVersion": 1,
            },
        })),
        &[
            ("x-inkline-base-revision", "3"),
            ("idempotency-key", "integration-encryption-partial"),
        ],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "encrypted partial push failed: {partial}"
    );
    assert_eq!(partial["revision"], 4);
}
