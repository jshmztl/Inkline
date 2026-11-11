use axum::http::StatusCode;
use serde_json::{json, Value};

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
}
