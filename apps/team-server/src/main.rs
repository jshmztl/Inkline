mod api;
mod auth;
mod cleanup;
mod config;
mod db;
mod error;
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
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env().map_err(io_error)?;
    let pool = db::connect(&config).await?;
    db::migrate(&pool).await?;
    bootstrap_user(&pool, &config).await?;

    let state = AppState {
        pool,
        config: Arc::new(config),
        presence: Default::default(),
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

    let password_hash = auth::hash_password(password).map_err(io_error)?;
    sqlx::query(
        "INSERT INTO users (id, account, display_name, password_hash) VALUES ($1, $2, $3, $4)",
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
