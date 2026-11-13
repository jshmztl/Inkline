mod api;
mod auth;
mod cleanup;
mod config;
mod db;
mod error;
mod login_guard;
mod models;
mod policy;
mod presence;
mod state;

use std::error::Error;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue, Method};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return run_healthcheck();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env().map_err(io_error)?;
    warn_insecure_bootstrap(&config);
    let pool = db::connect(&config).await?;
    db::migrate(&pool).await?;
    bootstrap_user(&pool, &config).await?;

    let state = AppState {
        pool,
        config: Arc::new(config),
        presence: Default::default(),
        login_guard: Default::default(),
    };

    let cors = build_cors(&state.config.cors_allowed_origins)?;
    let app = api::router(state.clone())
        .layer(TraceLayer::new_for_http())
        .layer(CompressionLayer::new())
        .layer(cors)
        .layer(DefaultBodyLimit::max(
            state.config.max_compressed_bytes + 1024 * 1024,
        ));

    cleanup::spawn(
        state.pool.clone(),
        state.config.cleanup_interval_hours,
        state.config.default_audit_retention_days,
    );

    let bind_addr = state.config.bind_addr.clone();
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("Inkline 团队服务已启动：http://{bind_addr}");
    axum::serve(listener, app).await?;

    Ok(())
}

fn build_cors(origins: &[String]) -> Result<CorsLayer, Box<dyn Error>> {
    if origins.iter().any(|origin| origin == "*") {
        tracing::warn!("CORS_ALLOWED_ORIGINS 包含 *，将允许所有来源");
        return Ok(CorsLayer::permissive());
    }

    let parsed = origins
        .iter()
        .map(|origin| {
            origin
                .parse::<HeaderValue>()
                .map_err(|error| io_error(format!("CORS 来源 {origin} 无效：{error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(CorsLayer::new()
        .allow_origin(parsed)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .allow_credentials(false)
        .expose_headers(vec![header::CONTENT_ENCODING, header::CONTENT_LENGTH])
        .max_age(Duration::from_secs(3600)))
}

fn warn_insecure_bootstrap(config: &Config) {
    if config.bootstrap_account.is_none() {
        return;
    }
    let Some(password) = &config.bootstrap_password else {
        return;
    };
    if password == "change-me-please"
        || password == "ChangeMe2026"
        || auth::validate_password_policy(password).is_err()
    {
        tracing::warn!(
            account = ?config.bootstrap_account,
            "BOOTSTRAP_PASSWORD 使用默认或不符合口令策略，请立即通过环境变量改为至少 8 位且包含字母与数字的强口令"
        );
    }
}

async fn bootstrap_user(pool: &sqlx::PgPool, config: &Config) -> Result<(), Box<dyn Error>> {
    let (Some(account), Some(password)) = (&config.bootstrap_account, &config.bootstrap_password)
    else {
        return Ok(());
    };

    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE lower(account) = lower($1))")
            .bind(account)
            .fetch_one(pool)
            .await?;
    if exists {
        return Ok(());
    }

    auth::validate_password_policy(password).map_err(io_error)?;
    let password_hash = auth::hash_password(password).map_err(io_error)?;
    sqlx::query(
        "INSERT INTO users (id, account, display_name, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, true)",
    )
    .bind(Uuid::new_v4())
    .bind(account)
    .bind(account)
    .bind(password_hash)
    .execute(pool)
    .await?;

    tracing::info!(account = %account, "已创建引导账号");
    Ok(())
}

fn io_error(message: String) -> Box<dyn Error> {
    Box::new(std::io::Error::new(ErrorKind::InvalidInput, message))
}

fn run_healthcheck() -> Result<(), Box<dyn Error>> {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};

    let mut args = std::env::args().skip(2);
    let addr = args.next().unwrap_or_else(|| "127.0.0.1:8080".to_string());
    let path = args.next().unwrap_or_else(|| "/readyz".to_string());

    let target = addr
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io_error(format!("无法解析健康检查地址：{addr}")))?;
    let mut stream = TcpStream::connect_timeout(&target, Duration::from_secs(3))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(io_error(format!("健康检查返回异常：{}", response.lines().next().unwrap_or("-"))))
    }
}
