use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager, State};

use crate::db::DbState;

const SERVICE: &str = "com.inkline.desktop";
const MASTER_KEY_NAME: &str = "master-key-v1";
const MASTER_KEY_FILE: &str = "master.key";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, MASTER_KEY_NAME)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn parse_master_key(raw: &str) -> Result<[u8; 32], String> {
    let bytes = STANDARD
        .decode(raw.trim())
        .map_err(|error| format!("主密钥格式无效：{error}"))?;
    bytes
        .try_into()
        .map_err(|_| "主密钥长度无效".to_string())
}

fn generate_master_key() -> Result<([u8; 32], String), String> {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|error| format!("生成主密钥失败：{error}"))?;
    let encoded = STANDARD.encode(key);
    Ok((key, encoded))
}

fn load_key_from_keyring() -> Result<Option<[u8; 32]>, String> {
    match keyring_entry()?.get_password() {
        Ok(value) => Ok(Some(parse_master_key(&value)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取主密钥失败：{error}")),
    }
}

fn save_key_to_keyring(encoded: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(encoded)
        .map_err(|error| format!("保存主密钥失败：{error}"))
}

fn fallback_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(dir.join(MASTER_KEY_FILE))
}

fn load_key_from_file(path: &Path) -> Result<Option<[u8; 32]>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("读取本地主密钥失败：{error}"))?;
    Ok(Some(parse_master_key(&raw)?))
}

fn save_key_to_file(path: &Path, encoded: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建主密钥目录：{error}"))?;
    }
    let mut file = fs::File::create(path).map_err(|error| format!("写入本地主密钥失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        file.set_permissions(permissions)
            .map_err(|error| format!("设置主密钥文件权限失败：{error}"))?;
    }
    file.write_all(encoded.as_bytes())
        .map_err(|error| format!("写入本地主密钥失败：{error}"))?;
    Ok(())
}

/// Windows 把 32 字节主密钥放进系统凭据库；其他平台在凭据库不可用时，回退到应用数据目录中权限受限的密钥文件。
/// 业务密钥以 AES-GCM 密文写入 SQLite `secrets` 表，避免受凭据库长度限制，也避免明文出现在 settings 里。
pub fn load_or_create_master_key(app: &AppHandle) -> Result<[u8; 32], String> {
    #[cfg(windows)]
    {
        if let Some(key) = load_key_from_keyring()? {
            return Ok(key);
        }
        let (key, encoded) = generate_master_key()?;
        save_key_to_keyring(&encoded)?;
        return Ok(key);
    }

    #[cfg(not(windows))]
    {
        if let Ok(Some(key)) = load_key_from_keyring() {
            return Ok(key);
        }
        let path = fallback_key_path(app)?;
        if let Some(key) = load_key_from_file(&path)? {
            return Ok(key);
        }
        let (key, encoded) = generate_master_key()?;
        if save_key_to_keyring(&encoded).is_err() {
            save_key_to_file(&path, &encoded)?;
        }
        Ok(key)
    }
}

pub fn encrypt_value(master_key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(master_key)
        .map_err(|error| format!("初始化加密失败：{error}"))?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|error| format!("生成随机数失败：{error}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|error| format!("加密失败：{error}"))?;
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(combined))
}

pub fn decrypt_value(master_key: &[u8; 32], encoded: &str) -> Result<String, String> {
    let combined = STANDARD
        .decode(encoded)
        .map_err(|error| format!("密文格式无效：{error}"))?;
    if combined.len() < 13 {
        return Err("密文长度无效".to_string());
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(master_key)
        .map_err(|error| format!("初始化解密失败：{error}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "解密失败，主密钥可能不匹配".to_string())?;
    String::from_utf8(plain).map_err(|error| format!("密文不是合法文本：{error}"))
}

pub fn put_secret_value(
    connection: &Connection,
    master_key: &[u8; 32],
    key: &str,
    value: &str,
) -> Result<(), String> {
    let ciphertext = encrypt_value(master_key, value)?;
    let updated_at = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO secrets (key, ciphertext, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
            params![key, ciphertext, updated_at],
        )
        .map_err(|error| format!("写入密钥失败：{error}"))?;
    Ok(())
}

pub fn get_secret_value(
    connection: &Connection,
    master_key: &[u8; 32],
    key: &str,
) -> Result<Option<String>, String> {
    let ciphertext = connection.query_row(
        "SELECT ciphertext FROM secrets WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    );
    match ciphertext {
        Ok(encoded) => Ok(Some(decrypt_value(master_key, &encoded)?)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("读取密钥失败：{error}")),
    }
}

pub fn delete_secret_value(connection: &Connection, key: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM secrets WHERE key = ?1", params![key])
        .map_err(|error| format!("删除密钥失败：{error}"))?;
    Ok(())
}



const LEGACY_KEYRING_KEYS: &[&str] = &["team-tokens-v1"];

/// 0.1.24 曾把团队令牌直接写入系统凭据库。升级后改为「主密钥进凭据库，业务密钥进加密表」。
pub fn migrate_legacy_keyring_secrets(
    connection: &Connection,
    master_key: &[u8; 32],
) -> Result<(), String> {
    for key in LEGACY_KEYRING_KEYS {
        let entry = match keyring::Entry::new(SERVICE, key) {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let value = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => continue,
            Err(_) => continue,
        };
        if get_secret_value(connection, master_key, key)?.is_none() {
            put_secret_value(connection, master_key, key, &value)?;
        }
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub fn list_secret_values(
    connection: &Connection,
    master_key: &[u8; 32],
) -> Result<BTreeMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT key, ciphertext FROM secrets")
        .map_err(|error| format!("读取密钥列表失败：{error}"))?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("读取密钥列表失败：{error}"))?;

    let mut secrets = BTreeMap::new();
    for row in rows {
        let (key, ciphertext) = row.map_err(|error| format!("读取密钥列表失败：{error}"))?;
        secrets.insert(key, decrypt_value(master_key, &ciphertext)?);
    }
    Ok(secrets)
}

fn with_vault<T>(
    app: &AppHandle,
    state: &State<'_, DbState>,
    action: impl FnOnce(&Connection, &[u8; 32]) -> Result<T, String>,
) -> Result<T, String> {
    let master_key = load_or_create_master_key(app)?;
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    action(&connection, &master_key)
}


#[tauri::command]
pub fn load_all_secrets(
    app: AppHandle,
    state: State<'_, DbState>,
) -> Result<BTreeMap<String, String>, String> {
    with_vault(&app, &state, |connection, master_key| {
        migrate_legacy_keyring_secrets(connection, master_key)?;
        list_secret_values(connection, master_key)
    })
}

#[tauri::command]
pub fn save_secret(
    app: AppHandle,
    state: State<'_, DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("密钥名称不能为空".to_string());
    }
    with_vault(&app, &state, |connection, master_key| {
        put_secret_value(connection, master_key, &key, &value)
    })
}

#[tauri::command]
pub fn load_secret(
    app: AppHandle,
    state: State<'_, DbState>,
    key: String,
) -> Result<Option<String>, String> {
    if key.trim().is_empty() {
        return Err("密钥名称不能为空".to_string());
    }
    with_vault(&app, &state, |connection, master_key| {
        get_secret_value(connection, master_key, &key)
    })
}

#[tauri::command]
pub fn delete_secret(state: State<'_, DbState>, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("密钥名称不能为空".to_string());
    }
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    delete_secret_value(&connection, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE secrets (
                    key TEXT PRIMARY KEY,
                    ciphertext TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .expect("create secrets table");
        connection
    }

    fn test_key() -> [u8; 32] {
        let mut key = [0u8; 32];
        key[0] = 7;
        key[31] = 9;
        key
    }

    #[test]
    fn encrypts_and_decrypts_round_trip() {
        let key = test_key();
        let encoded = encrypt_value(&key, "super-secret").expect("encrypt");
        assert_ne!(encoded, "super-secret");
        assert_eq!(
            decrypt_value(&key, &encoded).expect("decrypt"),
            "super-secret"
        );
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let key = test_key();
        let mut encoded = encrypt_value(&key, "token").expect("encrypt");
        encoded.replace_range(0..2, "AA");
        assert!(decrypt_value(&key, &encoded).is_err());
    }

    #[test]
    fn stores_and_deletes_secrets_in_sqlite() {
        let connection = test_connection();
        let key = test_key();
        put_secret_value(&connection, &key, "ai-gateway-key", "sk-test").expect("put");
        assert_eq!(
            get_secret_value(&connection, &key, "ai-gateway-key")
                .expect("get")
                .as_deref(),
            Some("sk-test")
        );

        let stored: String = connection
            .query_row(
                "SELECT ciphertext FROM secrets WHERE key = ?1",
                params!["ai-gateway-key"],
                |row| row.get(0),
            )
            .expect("ciphertext");
        assert!(
            !stored.contains("sk-test"),
            "plaintext leaked into sqlite: {stored}"
        );

        delete_secret_value(&connection, "ai-gateway-key").expect("delete");
        assert_eq!(
            get_secret_value(&connection, &key, "ai-gateway-key").expect("get after delete"),
            None
        );
    }

    #[test]
    fn upsert_overwrites_existing_secret() {
        let connection = test_connection();
        let key = test_key();
        put_secret_value(&connection, &key, "team-tokens-v1", "old").expect("put old");
        put_secret_value(&connection, &key, "team-tokens-v1", "new").expect("put new");
        assert_eq!(
            get_secret_value(&connection, &key, "team-tokens-v1")
                .expect("get")
                .as_deref(),
            Some("new")
        );
    }

    #[test]
    fn lists_all_stored_secrets() {
        let connection = test_connection();
        let key = test_key();
        put_secret_value(&connection, &key, "a", "1").expect("put a");
        put_secret_value(&connection, &key, "b", "2").expect("put b");
        let listed = list_secret_values(&connection, &key).expect("list");
        assert_eq!(listed.get("a").map(String::as_str), Some("1"));
        assert_eq!(listed.get("b").map(String::as_str), Some("2"));
        assert_eq!(listed.len(), 2);
    }
}
