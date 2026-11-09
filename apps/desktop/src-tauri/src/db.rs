use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::model::HeaderPair;

pub struct DbState(pub Mutex<Connection>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS requests (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    method      TEXT NOT NULL,
    url         TEXT NOT NULL,
    headers     TEXT NOT NULL DEFAULT '[]',
    body        TEXT,
    data_level  TEXT NOT NULL DEFAULT 'L1',
    updated_at  TEXT NOT NULL
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
"#;

pub fn open(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;

    let connection = Connection::open(dir.join("api-workbench.db"))?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
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

    connection
        .execute(
            "INSERT INTO requests (id, name, method, url, headers, body, data_level, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               method = excluded.method,
               url = excluded.url,
               headers = excluded.headers,
               body = excluded.body,
               data_level = excluded.data_level,
               updated_at = excluded.updated_at",
            params![
                &request.id,
                &request.name,
                &request.method,
                &request.url,
                headers,
                &request.body,
                &request.data_level,
                &updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(SavedRequest {
        updated_at: Some(updated_at),
        ..request
    })
}

#[tauri::command]
pub fn list_requests(state: State<'_, DbState>) -> Result<Vec<SavedRequest>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, method, url, headers, body, data_level, updated_at
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
                updated_at: Some(row.get(7)?),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
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
