use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_FAILURES: u32 = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
const BASE_LOCK: Duration = Duration::from_secs(60);
const MAX_LOCK: Duration = Duration::from_secs(15 * 60);
const ENTRY_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Default)]
pub struct LoginGuard {
    entries: Arc<Mutex<HashMap<String, Attempt>>>,
}

#[derive(Debug)]
struct Attempt {
    failures: u32,
    first_failure: Instant,
    locked_until: Option<Instant>,
    last_seen: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LoginBlock {
    pub retry_after_seconds: u64,
}

impl LoginGuard {
    /// 登录前调用；命中锁定时返回剩余秒数。
    pub fn check(&self, key: &str) -> Result<(), LoginBlock> {
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        entries.retain(|_, attempt| now.saturating_duration_since(attempt.last_seen) < ENTRY_TTL);

        let Some(attempt) = entries.get_mut(key) else {
            return Ok(());
        };
        if let Some(until) = attempt.locked_until {
            if until > now {
                return Err(LoginBlock {
                    retry_after_seconds: ceil_seconds(until.saturating_duration_since(now)),
                });
            }
            attempt.locked_until = None;
            attempt.failures = 0;
            attempt.first_failure = now;
        }
        if now.saturating_duration_since(attempt.first_failure) >= FAILURE_WINDOW {
            attempt.failures = 0;
            attempt.first_failure = now;
        }
        Ok(())
    }

    /// 凭证错误后调用；连续失败达到阈值后按指数退避锁定。
    /// 返回 true 表示本次失败刚刚触发锁定，便于写一次审计。
    pub fn record_failure(&self, key: &str) -> bool {
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let attempt = entries
            .entry(key.to_string())
            .or_insert_with(|| Attempt {
                failures: 0,
                first_failure: now,
                locked_until: None,
                last_seen: now,
            });
        attempt.last_seen = now;

        if now.saturating_duration_since(attempt.first_failure) >= FAILURE_WINDOW {
            attempt.failures = 0;
            attempt.first_failure = now;
        }
        attempt.failures = attempt.failures.saturating_add(1);
        if attempt.failures >= MAX_FAILURES {
            let was_locked = attempt.locked_until.is_some_and(|until| until > now);
            let extra = attempt.failures - MAX_FAILURES;
            let factor = 1_u32.checked_shl(extra.min(4)).unwrap_or(16);
            let lock = (BASE_LOCK * factor).min(MAX_LOCK);
            attempt.locked_until = Some(now + lock);
            return !was_locked;
        }
        false
    }

    /// 登录成功后清空该账号的失败记录。
    pub fn record_success(&self, key: &str) {
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries.remove(key);
    }
}

fn ceil_seconds(duration: Duration) -> u64 {
    let millis = duration.as_millis();
    ((millis + 999) / 1000).max(1) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_repeated_failures() {
        let guard = LoginGuard::default();
        for _ in 0..MAX_FAILURES {
            assert!(guard.check("alice").is_ok());
            guard.record_failure("alice");
        }

        let block = guard.check("alice").expect_err("should be blocked");
        assert!(block.retry_after_seconds > 0);
    }

    #[test]
    fn success_clears_failures() {
        let guard = LoginGuard::default();
        for _ in 0..(MAX_FAILURES - 1) {
            guard.record_failure("alice");
        }
        assert!(guard.check("alice").is_ok());

        guard.record_success("alice");
        for _ in 0..MAX_FAILURES {
            assert!(guard.check("alice").is_ok());
            guard.record_failure("alice");
        }
        assert!(guard.check("alice").is_err());
    }

    #[test]
    fn accounts_are_independent() {
        let guard = LoginGuard::default();
        for _ in 0..MAX_FAILURES {
            guard.record_failure("alice");
        }
        assert!(guard.check("alice").is_err());
        assert!(guard.check("bob").is_ok());
    }

    #[test]
    fn reports_first_lock_only() {
        let guard = LoginGuard::default();
        for _ in 0..(MAX_FAILURES - 1) {
            assert!(!guard.record_failure("alice"));
        }
        assert!(guard.record_failure("alice"));
        assert!(!guard.record_failure("alice"));
    }
}
