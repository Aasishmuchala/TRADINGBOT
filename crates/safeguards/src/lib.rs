#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeguardPolicy {
    pub live_trading_enabled: bool,
    pub allow_full_auto: bool,
    pub require_operator_approval: bool,
    pub require_exchange_sync: bool,
    pub require_healthy_feed: bool,
    pub forbid_critical_self_patch: bool,
}

impl SafeguardPolicy {
    pub fn strict_local_default() -> Self {
        Self {
            live_trading_enabled: false,
            allow_full_auto: false,
            require_operator_approval: true,
            require_exchange_sync: true,
            require_healthy_feed: true,
            forbid_critical_self_patch: true,
        }
    }

    pub fn summary_lines(&self) -> Vec<String> {
        vec![
            format!("Live trading enabled: {}", self.live_trading_enabled),
            format!("Full-auto allowed: {}", self.allow_full_auto),
            format!("Operator approval required: {}", self.require_operator_approval),
            format!("Exchange sync required: {}", self.require_exchange_sync),
            format!("Healthy feed required: {}", self.require_healthy_feed),
            format!("Critical self-patch forbidden: {}", self.forbid_critical_self_patch),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_strict_default_policy() {
        let policy = SafeguardPolicy::strict_local_default();
        assert!(!policy.live_trading_enabled);
        assert!(policy.require_operator_approval);
    }
}
