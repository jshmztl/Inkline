use std::collections::BTreeMap;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::model::HeaderPair;

pub struct DbState(pub Mutex<Connection>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    method        TEXT NOT NULL,
    url           TEXT NOT NULL,
    headers       TEXT NOT NULL DEFAULT '[]',
    body          TEXT,
    data_level    TEXT NOT NULL DEFAULT 'L1',
    collection_id TEXT NOT NULL DEFAULT 'payment',
    sort          INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   TEXT,
    method       TEXT NOT NULL,
    url          TEXT NOT NULL,
    status       INTEGER,
    duration_ms  INTEGER,
    size_bytes   INTEGER,
    error        TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    type   TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    actor  TEXT NOT NULL,
    level  TEXT,
    at     TEXT NOT NULL
);
"#;

const LEGACY_SEED_REQUESTS: &[&str] = &[
    "orders-list",
    "orders-create",
    "orders-detail",
    "refunds-create",
    "users-detail",
    "users-create",
    "auth-token",
];

const LEGACY_SEED_COLLECTIONS: &[&str] = &["payment", "user"];

pub fn open(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;

    let db_path = dir.join("inkline.db");
    migrate_legacy_database(&db_path);

    let connection = Connection::open(db_path)?;
    connection.execute_batch(SCHEMA)?;

    if !column_exists(&connection, "requests", "collection_id")? {
        connection.execute(
            "ALTER TABLE requests ADD COLUMN collection_id TEXT NOT NULL DEFAULT 'payment'",
            [],
        )?;
    }

    if !column_exists(&connection, "requests", "sort")? {
        connection.execute(
            "ALTER TABLE requests ADD COLUMN sort INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    cleanup_legacy_seed(&connection)?;
    Ok(connection)
}

fn migrate_legacy_database(target: &std::path::Path) {
    if target.exists() {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        let Ok(appdata) = std::env::var("APPDATA") else {
            return;
        };
        let legacy = std::path::Path::new(&appdata)
            .join("com.apiworkbench.desktop")
            .join("api-workbench.db");
        if legacy.exists() {
            let _ = std::fs::copy(&legacy, target);
        }
    }
}

fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, rusqlite::Error> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn cleanup_legacy_seed(connection: &Connection) -> Result<(), rusqlite::Error> {
    let seeded: Option<String> = connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'seeded'",
            [],
            |row| row.get(0),
        )
        .ok();

    if seeded.is_none() {
        connection.execute(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seed_removed', '1')",
            [],
        )?;
        return Ok(());
    }

    for id in LEGACY_SEED_REQUESTS {
        connection.execute("DELETE FROM requests WHERE id = ?1", params![id])?;
    }

    let has_seed_collection: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE id IN ('payment', 'user'))",
        [],
        |row| row.get(0),
    )?;

    if has_seed_collection {
        let migrated_requests: i64 = connection.query_row(
            "SELECT COUNT(*) FROM requests WHERE collection_id IN ('payment', 'user')",
            [],
            |row| row.get(0),
        )?;

        if migrated_requests > 0 {
            connection.execute(
                "INSERT OR IGNORE INTO collections (id, name, sort, updated_at) VALUES ('migrated', '我的集合', 0, ?1)",
                params![Utc::now().to_rfc3339()],
            )?;
            connection.execute(
                "UPDATE requests SET collection_id = 'migrated' WHERE collection_id IN ('payment', 'user')",
                [],
            )?;
        }

        for id in LEGACY_SEED_COLLECTIONS {
            connection.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
        }
    }

    connection.execute("DELETE FROM app_meta WHERE key = 'seeded'", [])?;
    connection.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seed_removed', '1')",
        [],
    )?;

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub sort: Option<i64>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
    pub data_level: String,
    pub collection_id: Option<String>,
    pub sort: Option<i64>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: Option<i64>,
    pub request_id: Option<String>,
    pub method: String,
    pub url: String,
    pub status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    pub error: Option<String>,
    pub created_at: Option<String>,
}

#[tauri::command]
pub fn list_collections(state: State<'_, DbState>) -> Result<Vec<Collection>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, name, sort, updated_at FROM collections ORDER BY sort, name")
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                sort: Some(row.get(2)?),
                updated_at: Some(row.get(3)?),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_collection(
    state: State<'_, DbState>,
    collection: Collection,
) -> Result<Collection, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let updated_at = collection
        .updated_at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    connection
        .execute(
            "INSERT INTO collections (id, name, sort, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               sort = excluded.sort,
               updated_at = excluded.updated_at",
            params![
                &collection.id,
                &collection.name,
                collection.sort.unwrap_or(0),
                &updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(Collection {
        updated_at: Some(updated_at),
        ..collection
    })
}

#[tauri::command]
pub fn delete_collection(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM requests WHERE collection_id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM collections WHERE id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_request(
    state: State<'_, DbState>,
    request: SavedRequest,
) -> Result<SavedRequest, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let headers = serde_json::to_string(&request.headers).map_err(|error| error.to_string())?;
    let updated_at = request
        .updated_at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let collection_id = request.collection_id.clone().unwrap_or_else(|| "payment".into());
    let requested_sort = request.sort;

    connection
        .execute(
            "INSERT INTO requests
             (id, name, method, url, headers, body, data_level, collection_id, sort, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 0), ?10)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               method = excluded.method,
               url = excluded.url,
               headers = excluded.headers,
               body = excluded.body,
               data_level = excluded.data_level,
               collection_id = excluded.collection_id,
               sort = COALESCE(?9, requests.sort),
               updated_at = excluded.updated_at",
            params![
                &request.id,
                &request.name,
                &request.method,
                &request.url,
                headers,
                &request.body,
                &request.data_level,
                &collection_id,
                requested_sort,
                &updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;

    let sort: i64 = connection
        .query_row(
            "SELECT sort FROM requests WHERE id = ?1",
            params![&request.id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    Ok(SavedRequest {
        collection_id: Some(collection_id),
        sort: Some(sort),
        updated_at: Some(updated_at),
        ..request
    })
}

#[tauri::command]
pub fn list_requests(state: State<'_, DbState>) -> Result<Vec<SavedRequest>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, method, url, headers, body, data_level, collection_id, sort, updated_at
             FROM requests ORDER BY sort, updated_at DESC",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            let headers: String = row.get(4)?;
            Ok(SavedRequest {
                id: row.get(0)?,
                name: row.get(1)?,
                method: row.get(2)?,
                url: row.get(3)?,
                headers: serde_json::from_str(&headers).unwrap_or_default(),
                body: row.get(5)?,
                data_level: row.get(6)?,
                collection_id: Some(row.get(7)?),
                sort: Some(row.get(8)?),
                updated_at: Some(row.get(9)?),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_request(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM requests WHERE id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn record_history(
    state: State<'_, DbState>,
    entry: HistoryEntry,
) -> Result<HistoryEntry, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let created_at = entry
        .created_at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    connection
        .execute(
            "INSERT INTO history
             (request_id, method, url, status, duration_ms, size_bytes, error, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &entry.request_id,
                &entry.method,
                &entry.url,
                entry.status,
                entry.duration_ms,
                entry.size_bytes,
                &entry.error,
                &created_at,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(HistoryEntry {
        id: Some(connection.last_insert_rowid()),
        created_at: Some(created_at),
        ..entry
    })
}

#[tauri::command]
pub fn list_history(
    state: State<'_, DbState>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let limit = limit.unwrap_or(20).clamp(1, 500);
    let offset = offset.unwrap_or(0).max(0);

    let mut statement = connection
        .prepare(
            "SELECT id, request_id, method, url, status, duration_ms, size_bytes, error, created_at
             FROM history ORDER BY id DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit, offset], |row| {
            Ok(HistoryEntry {
                id: Some(row.get(0)?),
                request_id: row.get(1)?,
                method: row.get(2)?,
                url: row.get(3)?,
                status: row.get(4)?,
                duration_ms: row.get(5)?,
                size_bytes: row.get(6)?,
                error: row.get(7)?,
                created_at: Some(row.get(8)?),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_history(state: State<'_, DbState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM history", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_history(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM history WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: Option<i64>,
    #[serde(rename = "type")]
    pub kind: String,
    pub action: String,
    pub detail: String,
    pub actor: String,
    pub level: Option<String>,
    pub at: Option<String>,
}

#[tauri::command]
pub fn record_audit(
    state: State<'_, DbState>,
    entry: AuditEntry,
) -> Result<AuditEntry, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let at = entry
        .at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    connection
        .execute(
            "INSERT INTO audit_logs (type, action, detail, actor, level, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &entry.kind,
                &entry.action,
                &entry.detail,
                &entry.actor,
                &entry.level,
                &at,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(AuditEntry {
        id: Some(connection.last_insert_rowid()),
        at: Some(at),
        ..entry
    })
}

#[tauri::command]
pub fn list_audit(
    state: State<'_, DbState>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<AuditEntry>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let limit = limit.unwrap_or(200).clamp(1, 2000);
    let offset = offset.unwrap_or(0).max(0);

    let mut statement = connection
        .prepare(
            "SELECT id, type, action, detail, actor, level, at
             FROM audit_logs ORDER BY id DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit, offset], |row| {
            Ok(AuditEntry {
                id: Some(row.get(0)?),
                kind: row.get(1)?,
                action: row.get(2)?,
                detail: row.get(3)?,
                actor: row.get(4)?,
                level: row.get(5)?,
                at: Some(row.get(6)?),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_audit(state: State<'_, DbState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM audit_logs", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_settings_from(connection: &Connection) -> Result<BTreeMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT key, value FROM settings")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;

    let mut settings = BTreeMap::new();
    for row in rows {
        let (key, value) = row.map_err(|error| error.to_string())?;
        settings.insert(key, value);
    }
    Ok(settings)
}

fn save_settings_to(
    connection: &mut Connection,
    entries: &BTreeMap<String, String>,
) -> Result<(), String> {
    let updated_at = Utc::now().to_rfc3339();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    for (key, value) in entries {
        transaction
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                   value = excluded.value,
                   updated_at = excluded.updated_at",
                params![key, value, &updated_at],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())
}

fn delete_settings_from(connection: &Connection, keys: &[String]) -> Result<(), String> {
    for key in keys {
        connection
            .execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn load_settings(state: State<'_, DbState>) -> Result<BTreeMap<String, String>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    load_settings_from(&connection)
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, DbState>,
    entries: BTreeMap<String, String>,
) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|error| error.to_string())?;
    save_settings_to(&mut connection, &entries)
}

#[tauri::command]
pub fn delete_settings(state: State<'_, DbState>, keys: Vec<String>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    delete_settings_from(&connection, &keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection.execute_batch(SCHEMA).expect("create schema");
        connection
    }

    #[test]
    fn settings_round_trip_and_delete() {
        let mut connection = test_connection();
        let mut entries = BTreeMap::new();
        entries.insert("aw-theme".to_string(), "dark".to_string());
        entries.insert("aw-network-options".to_string(), "{}".to_string());

        save_settings_to(&mut connection, &entries).expect("save settings");
        let loaded = load_settings_from(&connection).expect("load settings");
        assert_eq!(loaded.get("aw-theme").map(String::as_str), Some("dark"));
        assert_eq!(loaded.len(), 2);

        delete_settings_from(&connection, &["aw-theme".to_string()]).expect("delete setting");
        let loaded = load_settings_from(&connection).expect("load settings after delete");
        assert!(!loaded.contains_key("aw-theme"));
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn settings_upsert_overwrites_value() {
        let mut connection = test_connection();
        let mut first = BTreeMap::new();
        first.insert("aw-density".to_string(), "default".to_string());
        save_settings_to(&mut connection, &first).expect("save settings");

        let mut second = BTreeMap::new();
        second.insert("aw-density".to_string(), "compact".to_string());
        save_settings_to(&mut connection, &second).expect("save settings again");

        let loaded = load_settings_from(&connection).expect("load settings");
        assert_eq!(loaded.get("aw-density").map(String::as_str), Some("compact"));
    }
}
