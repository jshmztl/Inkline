use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

const JWT_HEADER: &str = r#"{"alg":"HS256","typ":"JWT"}"#;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AuthUser(pub Uuid);

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| error.to_string())
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

pub fn create_access_token(
    secret: &str,
    user_id: Uuid,
    ttl_seconds: i64,
) -> Result<String, String> {
    let now = Utc::now().timestamp();
    let claims = Claims {
        sub: user_id,
        iat: now,
        exp: now + ttl_seconds,
    };

    let header = URL_SAFE_NO_PAD.encode(JWT_HEADER.as_bytes());
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|error| error.to_string())?);
    let signing_input = format!("{header}.{payload}");
    let signature = sign(secret, &signing_input)?;

    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub fn verify_access_token(secret: &str, token: &str) -> Result<Claims, ()> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(());
    }

    let header_bytes = URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| ())?;
    let header: Value = serde_json::from_slice(&header_bytes).map_err(|_| ())?;
    if header.get("alg").and_then(Value::as_str) != Some("HS256") {
        return Err(());
    }

    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| ())?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| ())?;
    mac.verify_slice(&signature).map_err(|_| ())?;

    let payload = URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| ())?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| ())?;
    if claims.exp <= Utc::now().timestamp() {
        return Err(());
    }

    Ok(claims)
}

fn sign(secret: &str, data: &str) -> Result<Vec<u8>, String> {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(data.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

pub fn new_refresh_token() -> (String, String) {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let raw = format!("rt_{}", hex::encode(bytes));
    let hash = refresh_token_hash(&raw);
    (raw, hash)
}

pub fn refresh_token_hash(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.as_bytes()))
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| AppError::unauthorized("缺少访问令牌"))?;

        let claims = verify_access_token(&state.config.jwt_secret, token)
            .map_err(|_| AppError::unauthorized("访问令牌无效或已过期"))?;

        Ok(AuthUser(claims.sub))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "inkline-test-secret-at-least-32-chars";

    #[test]
    fn access_token_roundtrip() {
        let user_id = Uuid::new_v4();
        let token = create_access_token(SECRET, user_id, 60).expect("token");
        let claims = verify_access_token(SECRET, &token).expect("claims");
        assert_eq!(claims.sub, user_id);
    }

    #[test]
    fn rejects_tampered_token() {
        let token = create_access_token(SECRET, Uuid::new_v4(), 60).expect("token");
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(br#"{"sub":"00000000-0000-0000-0000-000000000000","iat":0,"exp":9999999999}"#);
        assert!(verify_access_token(SECRET, &parts.join(".")).is_err());
    }

    #[test]
    fn rejects_expired_token() {
        let token = create_access_token(SECRET, Uuid::new_v4(), -10).expect("token");
        assert!(verify_access_token(SECRET, &token).is_err());
    }
}
