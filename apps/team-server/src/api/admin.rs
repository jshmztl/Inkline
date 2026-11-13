use axum::extract::Path;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};

const ADMIN_HTML: &str = include_str!("../../admin/index.html");
const STYLES_CSS: &str = include_str!("../../admin/assets/styles.css");
const APP_JS: &str = include_str!("../../admin/assets/app.js");
const CORE_JS: &str = include_str!("../../admin/assets/core.js");
const WORKSPACE_JS: &str = include_str!("../../admin/assets/workspace.js");
const EXPORT_JS: &str = include_str!("../../admin/assets/export.js");
const DIFF_JS: &str = include_str!("../../admin/assets/diff.js");
const OVERVIEW_JS: &str = include_str!("../../admin/assets/overview.js");
const MEMBERS_JS: &str = include_str!("../../admin/assets/members.js");
const PERMISSIONS_JS: &str = include_str!("../../admin/assets/permissions.js");
const CONTENT_JS: &str = include_str!("../../admin/assets/content.js");
const SNAPSHOTS_JS: &str = include_str!("../../admin/assets/snapshots.js");
const AUDIT_JS: &str = include_str!("../../admin/assets/audit.js");

pub async fn root() -> Redirect {
    Redirect::temporary("/admin/")
}

pub async fn page() -> Response {
    (
        security_headers("text/html; charset=utf-8"),
        ADMIN_HTML,
    )
        .into_response()
}

pub async fn asset(Path(path): Path<String>) -> Response {
    let asset = match path.as_str() {
        "styles.css" => Some((STYLES_CSS, "text/css; charset=utf-8")),
        "app.js" => Some((APP_JS, "text/javascript; charset=utf-8")),
        "core.js" => Some((CORE_JS, "text/javascript; charset=utf-8")),
        "workspace.js" => Some((WORKSPACE_JS, "text/javascript; charset=utf-8")),
        "export.js" => Some((EXPORT_JS, "text/javascript; charset=utf-8")),
        "diff.js" => Some((DIFF_JS, "text/javascript; charset=utf-8")),
        "overview.js" => Some((OVERVIEW_JS, "text/javascript; charset=utf-8")),
        "members.js" => Some((MEMBERS_JS, "text/javascript; charset=utf-8")),
        "permissions.js" => Some((PERMISSIONS_JS, "text/javascript; charset=utf-8")),
        "content.js" => Some((CONTENT_JS, "text/javascript; charset=utf-8")),
        "snapshots.js" => Some((SNAPSHOTS_JS, "text/javascript; charset=utf-8")),
        "audit.js" => Some((AUDIT_JS, "text/javascript; charset=utf-8")),
        _ => None,
    };

    match asset {
        Some((body, content_type)) => (security_headers(content_type), body).into_response(),
        None => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

fn security_headers(content_type: &'static str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers
}
