use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

pub fn level_rank(level: &str) -> Option<u8> {
    match level.trim().to_ascii_uppercase().as_str() {
        "L0" => Some(0),
        "L1" => Some(1),
        "L2" => Some(2),
        "L3" => Some(3),
        _ => None,
    }
}

pub fn max_allowed_rank(team_max: &str) -> u8 {
    level_rank(team_max).unwrap_or(1)
}

pub fn validate_snapshot_levels(requests: &[Value], team_max: &str) -> Result<(), AppError> {
    let max_rank = max_allowed_rank(team_max);

    for request in requests {
        let request_id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let level = request
            .get("dataLevel")
            .and_then(Value::as_str)
            .unwrap_or("L1");

        let Some(rank) = level_rank(level) else {
            return Err(AppError::validation(format!(
                "请求 {request_id} 的 dataLevel 非法：{level}"
            ))
            .with_details(json!({ "requestId": request_id, "dataLevel": level })));
        };

        if rank == 3 {
            return Err(AppError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "data_level_forbidden",
                "L3 数据禁止进入团队服务",
            )
            .with_details(json!({ "requestId": request_id, "dataLevel": level })));
        }

        if rank > max_rank {
            return Err(AppError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "data_level_forbidden",
                "请求的数据分级超过团队允许上限",
            )
            .with_details(json!({
                "requestId": request_id,
                "dataLevel": level,
                "teamMaxDataLevel": team_max,
            })));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 资源级权限
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Team,
    Restricted,
}

impl Visibility {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "team" => Some(Self::Team),
            "restricted" => Some(Self::Restricted),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Team => "team",
            Self::Restricted => "restricted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantPermission {
    View,
    Edit,
}

impl GrantPermission {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "view" => Some(Self::View),
            "edit" => Some(Self::Edit),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Edit => "edit",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PolicyGrant {
    pub subject_type: String,
    pub subject_id: String,
    pub permission: GrantPermission,
}

#[derive(Debug, Clone)]
pub struct ResourcePolicy {
    pub visibility: Visibility,
    pub grants: Vec<PolicyGrant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    None,
    View,
    Edit,
}

#[derive(Debug, Clone)]
pub struct Viewer {
    pub user_id: Uuid,
    pub role: String,
}

impl Viewer {
    pub fn new(user_id: Uuid, role: &str) -> Self {
        Self {
            user_id,
            role: role.to_string(),
        }
    }

    pub fn is_manager(&self) -> bool {
        matches!(self.role.as_str(), "owner" | "admin")
    }
}

pub type PolicyMap = HashMap<(String, String), ResourcePolicy>;

pub fn policy_key(resource_type: &str, resource_id: &str) -> (String, String) {
    (resource_type.to_string(), resource_id.to_string())
}

pub async fn load_policies(pool: &PgPool, team_id: Uuid) -> Result<PolicyMap, AppError> {
    let policy_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT resource_type, resource_id, visibility
         FROM resource_policies WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_all(pool)
    .await?;

    let grant_rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT resource_type, resource_id, subject_type, subject_id, permission
         FROM resource_grants WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_all(pool)
    .await?;

    let mut policies: PolicyMap = HashMap::new();
    for (resource_type, resource_id, visibility) in policy_rows {
        let Some(visibility) = Visibility::parse(&visibility) else {
            continue;
        };
        policies.insert(
            policy_key(&resource_type, &resource_id),
            ResourcePolicy {
                visibility,
                grants: Vec::new(),
            },
        );
    }

    for (resource_type, resource_id, subject_type, subject_id, permission) in grant_rows {
        let Some(permission) = GrantPermission::parse(&permission) else {
            continue;
        };
        if let Some(policy) = policies.get_mut(&policy_key(&resource_type, &resource_id)) {
            policy.grants.push(PolicyGrant {
                subject_type,
                subject_id,
                permission,
            });
        }
    }

    Ok(policies)
}

fn default_access(viewer: &Viewer) -> Access {
    if viewer.is_manager() {
        Access::Edit
    } else if viewer.role == "viewer" {
        Access::View
    } else {
        Access::Edit
    }
}

fn grant_access(policy: &ResourcePolicy, viewer: &Viewer) -> Access {
    if viewer.is_manager() {
        return Access::Edit;
    }
    if policy.visibility == Visibility::Team {
        return default_access(viewer);
    }

    let user_id = viewer.user_id.to_string();
    let mut access = Access::None;
    for grant in &policy.grants {
        let hit = match grant.subject_type.as_str() {
            "user" => grant.subject_id.eq_ignore_ascii_case(&user_id),
            "role" => grant.subject_id == viewer.role,
            _ => false,
        };
        if hit {
            access = match (access, grant.permission) {
                (_, GrantPermission::Edit) => Access::Edit,
                (Access::None, GrantPermission::View) => Access::View,
                (existing, GrantPermission::View) => existing,
            };
        }
    }

    if viewer.role == "viewer" && access == Access::Edit {
        Access::View
    } else {
        access
    }
}

pub fn collection_access(policies: &PolicyMap, collection_id: &str, viewer: &Viewer) -> Access {
    if viewer.is_manager() {
        return Access::Edit;
    }
    match policies.get(&policy_key("collection", collection_id)) {
        Some(policy) => grant_access(policy, viewer),
        None => default_access(viewer),
    }
}

pub fn request_access(
    policies: &PolicyMap,
    collection_access: Access,
    request_id: &str,
    viewer: &Viewer,
) -> Access {
    if collection_access == Access::None {
        return Access::None;
    }
    match policies.get(&policy_key("request", request_id)) {
        Some(policy) => grant_access(policy, viewer),
        None => collection_access,
    }
}

fn value_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

fn collection_id_of(request: &Value) -> &str {
    request
        .get("collectionId")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn is_empty_array(value: &Value) -> bool {
    value.as_array().map(|items| items.is_empty()).unwrap_or(true)
}

fn resolve_collection_access(
    policies: &PolicyMap,
    known: &HashMap<String, Access>,
    collection_id: &str,
    viewer: &Viewer,
) -> Access {
    known.get(collection_id).copied().unwrap_or_else(|| {
        if collection_id.is_empty() {
            default_access(viewer)
        } else {
            collection_access(policies, collection_id, viewer)
        }
    })
}

fn ids_of(payload: Option<&Value>, key: &str) -> HashSet<String> {
    payload
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(value_id)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 按查看者权限裁剪快照；所有者与管理员始终拿到完整内容。
pub fn filter_payload(payload: &Value, viewer: &Viewer, policies: &PolicyMap) -> Value {
    if viewer.is_manager() {
        return payload.clone();
    }

    let collections = payload
        .get("collections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requests = payload
        .get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let documents = payload
        .get("documents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut visible_collections = Vec::new();
    for collection in &collections {
        let Some(id) = value_id(collection) else {
            continue;
        };
        if collection_access(policies, id, viewer) != Access::None {
            visible_collections.push(collection.clone());
        }
    }

    let mut visible_request_ids = HashSet::new();
    let mut visible_requests = Vec::new();
    for request in &requests {
        let Some(id) = value_id(request) else {
            continue;
        };
        let collection_id = collection_id_of(request);
        let collection_level = if collection_id.is_empty() {
            default_access(viewer)
        } else {
            collection_access(policies, collection_id, viewer)
        };
        if request_access(policies, collection_level, id, viewer) != Access::None {
            visible_request_ids.insert(id.to_string());
            visible_requests.push(request.clone());
        }
    }

    let mut visible_documents = Map::new();
    for (request_id, fields) in documents {
        if visible_request_ids.contains(&request_id) {
            visible_documents.insert(request_id, fields);
        }
    }

    let mut output = payload.clone();
    if let Some(object) = output.as_object_mut() {
        object.insert("collections".into(), Value::Array(visible_collections));
        object.insert("requests".into(), Value::Array(visible_requests));
        object.insert("documents".into(), Value::Object(visible_documents));
    }
    output
}

#[derive(Debug)]
pub struct MergeResult {
    pub payload: Value,
    pub removed_collections: Vec<String>,
    pub removed_requests: Vec<String>,
}

fn id_map(items: &[Value]) -> HashMap<String, Value> {
    items
        .iter()
        .filter_map(|item| value_id(item).map(|id| (id.to_string(), item.clone())))
        .collect()
}

/// 把客户端提交的可见子集合并进服务端完整快照：
/// - 只应用查看者有编辑权的资源；
/// - 保留查看者看不到或只读的资源，避免整包覆盖误删。
pub fn merge_payload(
    full: Option<&Value>,
    incoming: &Value,
    viewer: &Viewer,
    policies: &PolicyMap,
) -> MergeResult {
    if viewer.is_manager() {
        let removed_collections = ids_of(full, "collections")
            .difference(&ids_of(Some(incoming), "collections"))
            .cloned()
            .collect();
        let removed_requests = ids_of(full, "requests")
            .difference(&ids_of(Some(incoming), "requests"))
            .cloned()
            .collect();
        return MergeResult {
            payload: incoming.clone(),
            removed_collections,
            removed_requests,
        };
    }

    let empty = Value::Array(Vec::new());
    let full_value = full.unwrap_or(&empty);
    let full_collections = full_value
        .get("collections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let full_requests = full_value
        .get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let full_documents = full_value
        .get("documents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let incoming_collections = incoming
        .get("collections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_requests = incoming
        .get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_documents = incoming
        .get("documents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let full_collection_map = id_map(&full_collections);
    let full_request_map = id_map(&full_requests);
    let incoming_collection_map = id_map(&incoming_collections);
    let incoming_request_map = id_map(&incoming_requests);

    let mut collection_accesses: HashMap<String, Access> = HashMap::new();
    for collection in &full_collections {
        if let Some(id) = value_id(collection) {
            collection_accesses.insert(id.to_string(), collection_access(policies, id, viewer));
        }
    }

    let mut requests_by_collection: HashMap<String, Vec<String>> = HashMap::new();
    for request in &full_requests {
        if let Some(id) = value_id(request) {
            requests_by_collection
                .entry(collection_id_of(request).to_string())
                .or_default()
                .push(id.to_string());
        }
    }

    let mut incoming_collection_ids: HashSet<&str> = HashSet::new();
    for request in &incoming_requests {
        incoming_collection_ids.insert(collection_id_of(request));
    }

    let mut merged_collections = Vec::new();
    let mut removed_collections = Vec::new();
    for collection in &full_collections {
        let Some(id) = value_id(collection) else {
            continue;
        };
        let access = collection_accesses
            .get(id)
            .copied()
            .unwrap_or_else(|| default_access(viewer));

        if let Some(updated) = incoming_collection_map.get(id) {
            if access == Access::Edit {
                merged_collections.push(updated.clone());
            } else {
                merged_collections.push(collection.clone());
            }
            continue;
        }

        let all_requests_editable = requests_by_collection
            .get(id)
            .map(|request_ids| {
                request_ids.iter().all(|request_id| {
                    let collection_id = full_request_map
                        .get(request_id)
                        .map(collection_id_of)
                        .unwrap_or("");
                    let level = resolve_collection_access(
                        policies,
                        &collection_accesses,
                        collection_id,
                        viewer,
                    );
                    request_access(policies, level, request_id, viewer) == Access::Edit
                })
            })
            .unwrap_or(true);

        if access == Access::Edit
            && all_requests_editable
            && !incoming_collection_ids.contains(id)
        {
            removed_collections.push(id.to_string());
        } else {
            merged_collections.push(collection.clone());
        }
    }

    for collection in &incoming_collections {
        let Some(id) = value_id(collection) else {
            continue;
        };
        if full_collection_map.contains_key(id) {
            continue;
        }
        if collection_access(policies, id, viewer) == Access::Edit {
            merged_collections.push(collection.clone());
        }
    }

    let mut merged_requests = Vec::new();
    let mut removed_requests = Vec::new();
    for request in &full_requests {
        let Some(id) = value_id(request) else {
            continue;
        };
        let collection_id = collection_id_of(request);
        let level = resolve_collection_access(policies, &collection_accesses, collection_id, viewer);
        let access = request_access(policies, level, id, viewer);

        if let Some(updated) = incoming_request_map.get(id) {
            if access == Access::Edit {
                merged_requests.push(updated.clone());
            } else {
                merged_requests.push(request.clone());
            }
        } else if access == Access::Edit {
            removed_requests.push(id.to_string());
        } else {
            merged_requests.push(request.clone());
        }
    }

    for request in &incoming_requests {
        let Some(id) = value_id(request) else {
            continue;
        };
        if full_request_map.contains_key(id) {
            continue;
        }
        let collection_id = collection_id_of(request);
        let level = resolve_collection_access(policies, &collection_accesses, collection_id, viewer);
        if request_access(policies, level, id, viewer) == Access::Edit {
            merged_requests.push(request.clone());
        }
    }

    let merged_request_map = id_map(&merged_requests);
    let mut merged_documents = Map::new();
    for (request_id, fields) in &full_documents {
        let Some(request) = merged_request_map.get(request_id) else {
            continue;
        };
        let collection_id = collection_id_of(request);
        let level = resolve_collection_access(policies, &collection_accesses, collection_id, viewer);
        let access = request_access(policies, level, request_id, viewer);

        if access != Access::Edit {
            merged_documents.insert(request_id.clone(), fields.clone());
            continue;
        }
        if let Some(updated) = incoming_documents.get(request_id) {
            if !is_empty_array(updated) {
                merged_documents.insert(request_id.clone(), updated.clone());
            }
        }
    }

    for (request_id, fields) in &incoming_documents {
        if full_documents.contains_key(request_id) || merged_documents.contains_key(request_id) {
            continue;
        }
        let Some(request) = merged_request_map.get(request_id) else {
            continue;
        };
        let collection_id = collection_id_of(request);
        let level = resolve_collection_access(policies, &collection_accesses, collection_id, viewer);
        if request_access(policies, level, request_id, viewer) == Access::Edit
            && !is_empty_array(fields)
        {
            merged_documents.insert(request_id.clone(), fields.clone());
        }
    }

    let mut merged = incoming.clone();
    if let Some(object) = merged.as_object_mut() {
        object.insert("collections".into(), Value::Array(merged_collections));
        object.insert("requests".into(), Value::Array(merged_requests));
        object.insert("documents".into(), Value::Object(merged_documents));
    }

    MergeResult {
        payload: merged,
        removed_collections,
        removed_requests,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, level: &str) -> Value {
        json!({ "id": id, "dataLevel": level })
    }

    #[test]
    fn allows_levels_within_team_limit() {
        assert!(validate_snapshot_levels(&[request("a", "L0"), request("b", "L1")], "L1").is_ok());
        assert!(validate_snapshot_levels(&[request("a", "L2")], "L2").is_ok());
    }

    #[test]
    fn rejects_levels_above_team_limit() {
        let error = validate_snapshot_levels(&[request("a", "L2")], "L1").unwrap_err();
        assert_eq!(error.code, "data_level_forbidden");
    }

    #[test]
    fn always_rejects_l3() {
        let error = validate_snapshot_levels(&[request("a", "L3")], "L2").unwrap_err();
        assert_eq!(error.code, "data_level_forbidden");
    }

    #[test]
    fn rejects_unknown_level() {
        let error = validate_snapshot_levels(&[request("a", "L9")], "L2").unwrap_err();
        assert_eq!(error.code, "validation_failed");
    }

    #[test]
    fn defaults_missing_level_to_l1() {
        assert!(validate_snapshot_levels(&[json!({ "id": "a" })], "L1").is_ok());
        assert!(validate_snapshot_levels(&[json!({ "id": "a" })], "L0").is_err());
    }

    fn viewer(role: &str) -> Viewer {
        Viewer::new(Uuid::new_v4(), role)
    }

    fn restricted_policies(user_id: Uuid) -> PolicyMap {
        let mut policies = PolicyMap::new();
        policies.insert(
            policy_key("request", "secret"),
            ResourcePolicy {
                visibility: Visibility::Restricted,
                grants: vec![PolicyGrant {
                    subject_type: "user".into(),
                    subject_id: user_id.to_string(),
                    permission: GrantPermission::View,
                }],
            },
        );
        policies
    }

    fn payload() -> Value {
        json!({
            "schemaVersion": 2,
            "baseRevision": 0,
            "collections": [
                { "id": "c1", "name": "订单" },
                { "id": "c2", "name": "风控" }
            ],
            "requests": [
                { "id": "r1", "name": "公开接口", "collectionId": "c1" },
                { "id": "secret", "name": "受限接口", "collectionId": "c1" },
                { "id": "r3", "name": "受限集合接口", "collectionId": "c2" }
            ],
            "documents": {
                "r1": [{ "key": "a" }],
                "secret": [{ "key": "b" }],
                "r3": [{ "key": "c" }]
            }
        })
    }

    #[test]
    fn filter_hides_restricted_resources_for_member() {
        let member = viewer("member");
        let policies = restricted_policies(member.user_id);
        let filtered = filter_payload(&payload(), &member, &policies);
        let ids: Vec<&str> = filtered["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["r1", "secret", "r3"]);
        assert!(filtered["documents"].get("secret").is_some());

        let other = viewer("member");
        let filtered = filter_payload(&payload(), &other, &policies);
        let ids: Vec<&str> = filtered["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["r1", "r3"]);
        assert!(filtered["documents"].get("secret").is_none());
    }

    #[test]
    fn filter_keeps_full_payload_for_manager() {
        let manager = viewer("admin");
        let filtered = filter_payload(&payload(), &manager, &PolicyMap::new());
        assert_eq!(filtered, payload());
    }

    #[test]
    fn viewer_cannot_edit_even_with_edit_grant() {
        let mut policies = PolicyMap::new();
        policies.insert(
            policy_key("collection", "c1"),
            ResourcePolicy {
                visibility: Visibility::Restricted,
                grants: vec![PolicyGrant {
                    subject_type: "role".into(),
                    subject_id: "viewer".into(),
                    permission: GrantPermission::Edit,
                }],
            },
        );
        let readonly = viewer("viewer");
        assert_eq!(
            collection_access(&policies, "c1", &readonly),
            Access::View
        );
    }

    #[test]
    fn merge_preserves_hidden_resources() {
        let member = viewer("member");
        let policies = restricted_policies(member.user_id);
        let full = payload();
        let incoming = json!({
            "schemaVersion": 2,
            "baseRevision": 1,
            "collections": [{ "id": "c1", "name": "订单（改名）" }],
            "requests": [{ "id": "r1", "name": "公开接口（改名）", "collectionId": "c1" }],
            "documents": { "r1": [{ "key": "a2" }] }
        });

        let result = merge_payload(Some(&full), &incoming, &member, &policies);
        let ids: Vec<&str> = result.payload["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect();
        assert!(ids.contains(&"secret"));
        assert!(!ids.contains(&"r3"));
        assert!(result.payload["documents"].get("secret").is_some());
        assert_eq!(result.payload["documents"]["r1"][0]["key"], "a2");
        assert!(result.removed_requests.iter().any(|id| id == "r3"));
        assert!(result.removed_collections.iter().any(|id| id == "c2"));
    }

    #[test]
    fn merge_applies_member_deletion_and_preserves_restricted() {
        let member = viewer("member");
        let policies = restricted_policies(member.user_id);
        let full = payload();
        let incoming = json!({
            "schemaVersion": 2,
            "baseRevision": 1,
            "collections": [{ "id": "c1", "name": "订单" }],
            "requests": [{ "id": "r1", "name": "公开接口", "collectionId": "c1" }],
            "documents": { "r1": [{ "key": "a" }] }
        });

        let result = merge_payload(Some(&full), &incoming, &member, &policies);
        let ids: Vec<&str> = result.payload["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect();
        assert!(ids.contains(&"secret"));
        assert!(!ids.contains(&"r3"));
        assert!(result.removed_requests.iter().any(|id| id == "r3"));
    }

    #[test]
    fn merge_drops_document_for_editable_request() {
        let member = viewer("member");
        let mut policies = PolicyMap::new();
        policies.insert(
            policy_key("request", "secret"),
            ResourcePolicy {
                visibility: Visibility::Restricted,
                grants: vec![],
            },
        );
        let full = payload();
        let incoming = json!({
            "schemaVersion": 2,
            "baseRevision": 1,
            "collections": [{ "id": "c1", "name": "订单" }],
            "requests": [{ "id": "r1", "name": "公开接口", "collectionId": "c1" }],
            "documents": {}
        });

        let result = merge_payload(Some(&full), &incoming, &member, &policies);
        assert!(result.payload["documents"].get("r1").is_none());
        assert!(result.payload["documents"].get("secret").is_some());
    }

    #[test]
    fn merge_ignores_new_request_in_hidden_collection() {
        let member = viewer("member");
        let mut policies = PolicyMap::new();
        policies.insert(
            policy_key("collection", "c2"),
            ResourcePolicy {
                visibility: Visibility::Restricted,
                grants: vec![],
            },
        );
        let incoming = json!({
            "schemaVersion": 2,
            "baseRevision": 0,
            "collections": [{ "id": "c2", "name": "风控" }],
            "requests": [{ "id": "new", "name": "偷偷新增", "collectionId": "c2" }],
            "documents": {}
        });

        let result = merge_payload(None, &incoming, &member, &policies);
        assert!(result.payload["requests"].as_array().unwrap().is_empty());
    }

    #[test]
    fn merge_blocked_when_collection_has_hidden_requests() {
        let member = viewer("member");
        let mut policies = restricted_policies(member.user_id);
        policies.insert(
            policy_key("request", "secret"),
            ResourcePolicy {
                visibility: Visibility::Restricted,
                grants: vec![],
            },
        );
        let full = json!({
            "schemaVersion": 2,
            "collections": [{ "id": "c1", "name": "订单" }],
            "requests": [
                { "id": "r1", "name": "公开接口", "collectionId": "c1" },
                { "id": "secret", "name": "受限接口", "collectionId": "c1" }
            ],
            "documents": {}
        });
        let incoming = json!({
            "schemaVersion": 2,
            "baseRevision": 1,
            "collections": [],
            "requests": [],
            "documents": {}
        });

        let result = merge_payload(Some(&full), &incoming, &member, &policies);
        assert_eq!(result.removed_collections.len(), 0);
        assert_eq!(result.payload["collections"].as_array().unwrap().len(), 1);
        assert!(result.removed_requests.iter().any(|id| id == "r1"));
    }
}
