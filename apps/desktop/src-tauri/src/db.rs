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
"#;

const SEED_COLLECTIONS: &[(&str, &str, i64)] = &[("payment", "支付服务", 0), ("user", "用户服务", 1)];

const SEED_REQUESTS: &[(&str, &str, &str, &str, &str, &str)] = &[
    ("orders-list", "查询订单列表", "GET", "{{host}}/v1/orders", "L1", "payment"),
    ("orders-create", "创建支付订单", "POST", "{{host}}/v1/orders", "L2", "payment"),
    ("orders-detail", "查询订单详情", "GET", "{{host}}/v1/orders/{id}", "L1", "payment"),
    ("refunds-create", "创建退款", "POST", "{{host}}/v1/refunds", "L2", "payment"),
    ("users-detail", "查询用户", "GET", "{{host}}/v1/users/{id}", "L2", "user"),
    ("users-create", "创建用户", "POST", "{{host}}/v1/users", "L2", "user"),
    ("auth-token", "签发访问令牌", "POST", "{{host}}/v1/auth/token", "L3", "user"),
];

pub fn open(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;

    let connection = Connection::open(dir.join("api-workbench.db"))?;
    connection.execute_batch(SCHEMA)?;

    if !column_exists(&connection, "requests", "collection_id")? {
        connection.execute(
            "ALTER TABLE requests ADD COLUMN collection_id TEXT NOT NULL DEFAULT 'payment'",
            [],
        )?;
    }

    seed_if_needed(&connection)?;
    Ok(connection)
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

fn seed_if_needed(connection: &Connection) -> Result<(), rusqlite::Error> {
    let seeded: Option<String> = connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'seeded'",
            [],
            |row| row.get(0),
        )
        .ok();

    if seeded.is_some() {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();

    for (id, name, sort) in SEED_COLLECTIONS {
        connection.execute(
            "INSERT OR IGNORE INTO collections (id, name, sort, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, sort, &now],
        )?;
    }

    for (id, name, method, url, level, collection) in SEED_REQUESTS {
        connection.execute(
            "INSERT OR IGNORE INTO requests
             (id, name, method, url, headers, body, data_level, collection_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, '[]', NULL, ?5, ?6, ?7)",
            params![id, name, method, url, level, collection, &now],
        )?;
    }

    connection.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded', '1')",
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

    connection
        .execute(
            "INSERT INTO requests
             (id, name, method, url, headers, body, data_level, collection_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               method = excluded.method,
               url = excluded.url,
               headers = excluded.headers,
               body = excluded.body,
               data_level = excluded.data_level,
               collection_id = excluded.collection_id,
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
                &updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(SavedRequest {
        collection_id: Some(collection_id),
        updated_at: Some(updated_at),
        ..request
    })
}

#[tauri::command]
pub fn list_requests(state: State<'_, DbState>) -> Result<Vec<SavedRequest>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, method, url, headers, body, data_level, collection_id, updated_at
             FROM requests ORDER BY updated_at DESC",
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
                updated_at: Some(row.get(8)?),
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
) -> Result<Vec<HistoryEntry>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let limit = limit.unwrap_or(20).clamp(1, 100);

    let mut statement = connection
        .prepare(
            "SELECT id, request_id, method, url, status, duration_ms, size_bytes, error, created_at
             FROM history ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit], |row| {
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
