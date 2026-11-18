use std::collections::BTreeMap;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::model::HeaderPair;

pub struct DbState(pub Mutex<Connection>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    parent_id   TEXT,
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

CREATE TABLE IF NOT EXISTS response_cache (
    request_id   TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status       INTEGER,
    status_text  TEXT,
    headers      TEXT NOT NULL DEFAULT '[]',
    body         TEXT,
    truncated    INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER,
    ttfb_ms      INTEGER,
    download_ms  INTEGER,
    dns_ms       INTEGER,
    tcp_ms       INTEGER,
    tls_ms       INTEGER,
    size_bytes   INTEGER,
    error        TEXT,
    received_at  TEXT NOT NULL
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

const RESPONSE_CACHE_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

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

    if !column_exists(&connection, "collections", "parent_id")? {
        connection.execute("ALTER TABLE collections ADD COLUMN parent_id TEXT", [])?;
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
    pub parent_id: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResponseCacheEntry {
    pub request_id: String,
    pub request_hash: String,
    pub status: Option<i64>,
    pub status_text: Option<String>,
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
    pub truncated: bool,
    pub duration_ms: Option<i64>,
    pub ttfb_ms: Option<i64>,
    pub download_ms: Option<i64>,
    pub dns_ms: Option<i64>,
    pub tcp_ms: Option<i64>,
    pub tls_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    pub error: Option<String>,
    pub received_at: String,
}

fn truncate_utf8(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

#[tauri::command]
pub fn list_collections(state: State<'_, DbState>) -> Result<Vec<Collection>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, name, sort, parent_id, updated_at FROM collections ORDER BY sort, name")
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                sort: Some(row.get(2)?),
                parent_id: row.get(3)?,
                updated_at: Some(row.get(4)?),
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
            "INSERT INTO collections (id, name, sort, parent_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               sort = excluded.sort,
               parent_id = excluded.parent_id,
               updated_at = excluded.updated_at",
            params![
                &collection.id,
                &collection.name,
                collection.sort.unwrap_or(0),
                &collection.parent_id,
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
    delete_collection_recursive(&connection, &id).map_err(|error| error.to_string())
}

fn delete_collection_recursive(connection: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    connection.execute(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM collections WHERE id = ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN descendants d ON c.parent_id = d.id
         )
         DELETE FROM response_cache WHERE request_id IN (
            SELECT id FROM requests WHERE collection_id IN (SELECT id FROM descendants)
         )",
        params![id],
    )?;
    connection.execute(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM collections WHERE id = ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN descendants d ON c.parent_id = d.id
         )
         DELETE FROM requests WHERE collection_id IN (SELECT id FROM descendants)",
        params![id],
    )?;
    connection.execute(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM collections WHERE id = ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN descendants d ON c.parent_id = d.id
         )
         DELETE FROM collections WHERE id IN (SELECT id FROM descendants)",
        params![id],
    )?;
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
        .execute("DELETE FROM response_cache WHERE request_id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
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
    record_history_to(&connection, entry)
}

fn record_history_to(connection: &Connection, entry: HistoryEntry) -> Result<HistoryEntry, String> {
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
    list_history_from(&connection, limit, offset)
}

fn list_history_from(
    connection: &Connection,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
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

#[tauri::command]
pub fn save_response_cache(
    state: State<'_, DbState>,
    entry: ResponseCacheEntry,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    save_response_cache_to(&connection, entry)
}

fn save_response_cache_to(
    connection: &Connection,
    entry: ResponseCacheEntry,
) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM requests WHERE id = ?1)",
            params![&entry.request_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(());
    }

    let headers = serde_json::to_string(&entry.headers).map_err(|error| error.to_string())?;
    let (body, cut) = match entry.body.as_deref() {
        Some(text) => {
            let (slice, cut) = truncate_utf8(text, RESPONSE_CACHE_MAX_BODY_BYTES);
            (Some(slice.to_string()), cut)
        }
        None => (None, false),
    };
    let truncated = entry.truncated || cut;
    let received_at = if entry.received_at.trim().is_empty() {
        Utc::now().to_rfc3339()
    } else {
        entry.received_at.clone()
    };

    connection
        .execute(
            "INSERT INTO response_cache
             (request_id, request_hash, status, status_text, headers, body, truncated,
              duration_ms, ttfb_ms, download_ms, dns_ms, tcp_ms, tls_ms, size_bytes, error, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(request_id) DO UPDATE SET
               request_hash = excluded.request_hash,
               status = excluded.status,
               status_text = excluded.status_text,
               headers = excluded.headers,
               body = excluded.body,
               truncated = excluded.truncated,
               duration_ms = excluded.duration_ms,
               ttfb_ms = excluded.ttfb_ms,
               download_ms = excluded.download_ms,
               dns_ms = excluded.dns_ms,
               tcp_ms = excluded.tcp_ms,
               tls_ms = excluded.tls_ms,
               size_bytes = excluded.size_bytes,
               error = excluded.error,
               received_at = excluded.received_at",
            params![
                &entry.request_id,
                &entry.request_hash,
                entry.status,
                &entry.status_text,
                headers,
                &body,
                truncated,
                entry.duration_ms,
                entry.ttfb_ms,
                entry.download_ms,
                entry.dns_ms,
                entry.tcp_ms,
                entry.tls_ms,
                entry.size_bytes,
                &entry.error,
                &received_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_response_cache(
    state: State<'_, DbState>,
    request_id: String,
) -> Result<Option<ResponseCacheEntry>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    load_response_cache_from(&connection, &request_id)
}

fn load_response_cache_from(
    connection: &Connection,
    request_id: &str,
) -> Result<Option<ResponseCacheEntry>, String> {
    connection
        .query_row(
            "SELECT request_id, request_hash, status, status_text, headers, body, truncated,
                    duration_ms, ttfb_ms, download_ms, dns_ms, tcp_ms, tls_ms, size_bytes, error, received_at
             FROM response_cache WHERE request_id = ?1",
            params![request_id],
            |row| {
                let headers: String = row.get(4)?;
                Ok(ResponseCacheEntry {
                    request_id: row.get(0)?,
                    request_hash: row.get(1)?,
                    status: row.get(2)?,
                    status_text: row.get(3)?,
                    headers: serde_json::from_str(&headers).unwrap_or_default(),
                    body: row.get(5)?,
                    truncated: row.get(6)?,
                    duration_ms: row.get(7)?,
                    ttfb_ms: row.get(8)?,
                    download_ms: row.get(9)?,
                    dns_ms: row.get(10)?,
                    tcp_ms: row.get(11)?,
                    tls_ms: row.get(12)?,
                    size_bytes: row.get(13)?,
                    error: row.get(14)?,
                    received_at: row.get(15)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_response_cache(
    state: State<'_, DbState>,
    request_id: String,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    delete_response_cache_from(&connection, &request_id)
}

fn delete_response_cache_from(connection: &Connection, request_id: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM response_cache WHERE request_id = ?1",
            params![request_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_response_cache(state: State<'_, DbState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    clear_response_cache_from(&connection)
}

fn clear_response_cache_from(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM response_cache", [])
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

    #[test]
    fn deleting_collection_removes_descendants_and_requests() {
        let connection = test_connection();
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO collections (id, name, sort, parent_id, updated_at)
                 VALUES ('root', '根集合', 0, NULL, ?1)",
                params![&now],
            )
            .expect("insert root");
        connection
            .execute(
                "INSERT INTO collections (id, name, sort, parent_id, updated_at)
                 VALUES ('child', '子集合', 0, 'root', ?1)",
                params![&now],
            )
            .expect("insert child");

        for (id, collection_id) in [("r1", "root"), ("r2", "child")] {
            connection
                .execute(
                    "INSERT INTO requests (id, name, method, url, headers, body, data_level, collection_id, sort, updated_at)
                     VALUES (?1, ?1, 'GET', '/', '[]', NULL, 'L1', ?2, 0, ?3)",
                    params![id, collection_id, &now],
                )
                .expect("insert request");
            connection
                .execute(
                    "INSERT INTO response_cache (request_id, request_hash, headers, received_at)
                     VALUES (?1, 'hash', '[]', ?2)",
                    params![id, &now],
                )
                .expect("insert response cache");
        }

        delete_collection_recursive(&connection, "root").expect("delete tree");

        let collections: i64 = connection
            .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))
            .expect("count collections");
        let requests: i64 = connection
            .query_row("SELECT COUNT(*) FROM requests", [], |row| row.get(0))
            .expect("count requests");
        let cached: i64 = connection
            .query_row("SELECT COUNT(*) FROM response_cache", [], |row| row.get(0))
            .expect("count response cache");
        assert_eq!(collections, 0);
        assert_eq!(requests, 0);
        assert_eq!(cached, 0);
    }

    #[test]
    fn response_cache_round_trip_and_truncation() {
        let connection = test_connection();
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO requests (id, name, method, url, headers, body, data_level, collection_id, sort, updated_at)
                 VALUES ('r1', '请求', 'GET', '/', '[]', NULL, 'L1', 'c1', 0, ?1)",
                params![&now],
            )
            .expect("insert request");

        let big_body = "中".repeat(RESPONSE_CACHE_MAX_BODY_BYTES / 3 + 64);
        save_response_cache_to(
            &connection,
            ResponseCacheEntry {
                request_id: "r1".to_string(),
                request_hash: "hash-1".to_string(),
                status: Some(200),
                status_text: Some("OK".to_string()),
                headers: vec![crate::model::HeaderPair {
                    name: "content-type".to_string(),
                    value: "application/json".to_string(),
                }],
                body: Some(big_body),
                truncated: false,
                duration_ms: Some(12),
                ttfb_ms: Some(4),
                download_ms: Some(8),
                dns_ms: None,
                tcp_ms: None,
                tls_ms: None,
                size_bytes: Some(999),
                error: None,
                received_at: now.clone(),
            },
        )
        .expect("save response cache");

        let loaded = load_response_cache_from(&connection, "r1")
            .expect("load response cache")
            .expect("cached response");
        assert_eq!(loaded.status, Some(200));
        assert_eq!(loaded.headers.len(), 1);
        assert!(loaded.truncated);
        assert!(loaded.body.as_ref().expect("body").len() <= RESPONSE_CACHE_MAX_BODY_BYTES);

        save_response_cache_to(
            &connection,
            ResponseCacheEntry {
                request_id: "r1".to_string(),
                request_hash: "hash-2".to_string(),
                status: Some(201),
                status_text: Some("Created".to_string()),
                headers: vec![],
                body: Some("ok".to_string()),
                truncated: false,
                duration_ms: Some(5),
                ttfb_ms: None,
                download_ms: None,
                dns_ms: None,
                tcp_ms: None,
                tls_ms: None,
                size_bytes: Some(2),
                error: None,
                received_at: now,
            },
        )
        .expect("upsert response cache");

        let loaded = load_response_cache_from(&connection, "r1")
            .expect("load response cache")
            .expect("cached response");
        assert_eq!(loaded.status, Some(201));
        assert_eq!(loaded.body.as_deref(), Some("ok"));
        assert!(!loaded.truncated);

        delete_response_cache_from(&connection, "r1").expect("delete response cache");
        assert!(load_response_cache_from(&connection, "r1")
            .expect("load response cache")
            .is_none());
    }

    #[test]
    fn response_cache_is_ignored_for_missing_request() {
        let connection = test_connection();
        save_response_cache_to(
            &connection,
            ResponseCacheEntry {
                request_id: "missing".to_string(),
                request_hash: "hash".to_string(),
                status: Some(200),
                status_text: Some("OK".to_string()),
                headers: vec![],
                body: Some("ok".to_string()),
                truncated: false,
                duration_ms: None,
                ttfb_ms: None,
                download_ms: None,
                dns_ms: None,
                tcp_ms: None,
                tls_ms: None,
                size_bytes: None,
                error: None,
                received_at: Utc::now().to_rfc3339(),
            },
        )
        .expect("save response cache");
        assert!(load_response_cache_from(&connection, "missing")
            .expect("load response cache")
            .is_none());
    }

    #[test]
    fn history_entry_survives_database_reopen() {
        let path = std::env::temp_dir().join(format!(
            "inkline-history-{}-{:?}.db",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);

        {
            let connection = Connection::open(&path).expect("open database");
            connection.execute_batch(SCHEMA).expect("create schema");
            record_history_to(
                &connection,
                HistoryEntry {
                    id: None,
                    request_id: Some("req-1".to_string()),
                    method: "GET".to_string(),
                    url: "http://127.0.0.1/health".to_string(),
                    status: Some(200),
                    duration_ms: Some(12),
                    size_bytes: Some(2),
                    error: None,
                    created_at: None,
                },
            )
            .expect("record history");
        }

        {
            let connection = Connection::open(&path).expect("reopen database");
            connection.execute_batch(SCHEMA).expect("ensure schema");
            let rows = list_history_from(&connection, Some(10), Some(0)).expect("list history");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].status, Some(200));
            assert_eq!(rows[0].url, "http://127.0.0.1/health");
            assert!(rows[0].created_at.is_some());
        }

        let _ = std::fs::remove_file(&path);
    }
}
