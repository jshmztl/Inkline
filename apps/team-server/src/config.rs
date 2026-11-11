use std::env;
use std::fmt::Display;
use std::str::FromStr;

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
    pub min_client_version: String,
    pub bootstrap_account: Option<String>,
    pub bootstrap_password: Option<String>,
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

        let min_client_version =
            env::var("MIN_CLIENT_VERSION").unwrap_or_else(|_| "0.1.20".to_string());
        let bootstrap_account = non_empty("BOOTSTRAP_ACCOUNT");
        let bootstrap_password = non_empty("BOOTSTRAP_PASSWORD");

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
            min_client_version,
            bootstrap_account,
            bootstrap_password,
        })
    }
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
