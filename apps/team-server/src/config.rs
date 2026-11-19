use std::collections::HashMap;
use std::env;
use std::fmt::Display;
use std::str::FromStr;

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// 服务端审阅 KEK。密钥只能来自环境变量，不进入数据库。
#[derive(Clone)]
pub struct EscrowKek {
    pub kid: String,
    key: [u8; 32],
}

impl EscrowKek {
    pub fn from_base64(kid: &str, value: &str) -> Result<Self, String> {
        let bytes = STANDARD
            .decode(value.trim())
            .map_err(|_| format!("ESCROW_KEK（{kid}）不是合法的 Base64"))?;
        if bytes.len() != 32 {
            return Err(format!("ESCROW_KEK（{kid}）必须是 32 字节"));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        Ok(Self {
            kid: kid.to_string(),
            key,
        })
    }

    pub fn key(&self) -> &[u8; 32] {
        &self.key
    }
}

impl std::fmt::Debug for EscrowKek {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EscrowKek")
            .field("kid", &self.kid)
            .field("key", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub bind_addr: String,
    pub access_token_ttl_seconds: i64,
    pub refresh_token_ttl_days: i64,
    pub max_compressed_bytes: usize,
    pub max_uncompressed_bytes: usize,
    pub default_snapshot_retention_days: i32,
    pub default_audit_retention_days: i32,
    pub cleanup_interval_hours: u64,
    pub cors_allowed_origins: Vec<String>,
    pub min_client_version: String,
    pub bootstrap_account: Option<String>,
    pub bootstrap_password: Option<String>,
    /// 服务端审阅 KEK 的 active kid；未配置时管理台解密能力关闭。
    pub escrow_active_kid: Option<String>,
    pub escrow_keks: Vec<EscrowKek>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        dotenvy::dotenv().ok();

        let database_url = required("DATABASE_URL")?;
        let jwt_secret = required("JWT_SECRET")?;
        if jwt_secret.len() < 32 {
            return Err("JWT_SECRET 至少需要 32 个字符".to_string());
        }

        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let access_token_ttl_seconds = parse_or("ACCESS_TOKEN_TTL_SECONDS", 900_i64)?;
        let refresh_token_ttl_days = parse_or("REFRESH_TOKEN_TTL_DAYS", 30_i64)?;
        let compressed_mb: usize = parse_or("MAX_COMPRESSED_MB", 10_usize)?;
        let uncompressed_mb: usize = parse_or("MAX_UNCOMPRESSED_MB", 50_usize)?;
        if uncompressed_mb < compressed_mb {
            return Err("MAX_UNCOMPRESSED_MB 不能小于 MAX_COMPRESSED_MB".to_string());
        }

        let default_snapshot_retention_days = parse_or("DEFAULT_SNAPSHOT_RETENTION_DAYS", 90_i32)?;
        let default_audit_retention_days = parse_or("DEFAULT_AUDIT_RETENTION_DAYS", 90_i32)?;
        validate_retention(default_snapshot_retention_days)?;
        validate_retention(default_audit_retention_days)?;

        let cleanup_interval_hours = parse_or("CLEANUP_INTERVAL_HOURS", 24_u64)?;
        if cleanup_interval_hours == 0 {
            return Err("CLEANUP_INTERVAL_HOURS 必须大于 0".to_string());
        }

        let cors_allowed_origins = env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| {
                "http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:1420,http://127.0.0.1:1420"
                    .to_string()
            })
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if cors_allowed_origins.is_empty() {
            return Err("CORS_ALLOWED_ORIGINS 不能为空；如需放开请显式填写 *".to_string());
        }

        let min_client_version =
            env::var("MIN_CLIENT_VERSION").unwrap_or_else(|_| "0.1.20".to_string());
        let bootstrap_account = non_empty("BOOTSTRAP_ACCOUNT");
        let bootstrap_password = non_empty("BOOTSTRAP_PASSWORD");
        let (escrow_active_kid, escrow_keks) = parse_escrow_keks()?;

        Ok(Self {
            database_url,
            jwt_secret,
            bind_addr,
            access_token_ttl_seconds,
            refresh_token_ttl_days,
            max_compressed_bytes: compressed_mb * 1024 * 1024,
            max_uncompressed_bytes: uncompressed_mb * 1024 * 1024,
            default_snapshot_retention_days,
            default_audit_retention_days,
            cleanup_interval_hours,
            cors_allowed_origins,
            min_client_version,
            bootstrap_account,
            bootstrap_password,
            escrow_active_kid,
            escrow_keks,
        })
    }
}

/// 解析服务端审阅 KEK：
/// - `ESCROW_KEK`：当前 active KEK（32 字节 Base64）
/// - `ESCROW_KEK_ID`：active KEK 标识，默认 `kek-1`
/// - `ESCROW_KEK_PREVIOUS`：可选 JSON，形如 `{"kek-0":"base64..."}`，仅用于解密旧数据
fn parse_escrow_keks() -> Result<(Option<String>, Vec<EscrowKek>), String> {
    let Some(active_value) = non_empty("ESCROW_KEK") else {
        return Ok((None, Vec::new()));
    };
    let active_kid = non_empty("ESCROW_KEK_ID").unwrap_or_else(|| "kek-1".to_string());
    if active_kid.trim().is_empty() {
        return Err("ESCROW_KEK_ID 不能为空".to_string());
    }

    let mut keks = vec![EscrowKek::from_base64(&active_kid, &active_value)?];
    if let Some(raw) = non_empty("ESCROW_KEK_PREVIOUS") {
        let previous: HashMap<String, String> = serde_json::from_str(&raw)
            .map_err(|error| format!("ESCROW_KEK_PREVIOUS 解析失败：{error}"))?;
        for (kid, value) in previous {
            if kid == active_kid {
                return Err("ESCROW_KEK_PREVIOUS 不能包含当前 active KEK".to_string());
            }
            keks.push(EscrowKek::from_base64(&kid, &value)?);
        }
    }
    Ok((Some(active_kid), keks))
}

pub fn validate_retention(days: i32) -> Result<(), String> {
    if !(7..=3650).contains(&days) {
        return Err(format!("保留天数必须在 7–3650 之间，当前为 {days}"));
    }
    Ok(())
}

fn required(key: &str) -> Result<String, String> {
    match env::var(key) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(format!("缺少环境变量 {key}")),
    }
}

fn non_empty(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn parse_or<T>(key: &str, default: T) -> Result<T, String>
where
    T: FromStr,
    T::Err: Display,
{
    match env::var(key) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .parse::<T>()
            .map_err(|error| format!("环境变量 {key} 解析失败：{error}")),
        _ => Ok(default),
    }
}
