use sthyra_mode_authority::TransitionReason;
use sthyra_watchdog::{HealthStatus, WatchdogDecision};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryAction {
    RestartNonCriticalService(&'static str),
    ReconnectMarketStreams,
    ResyncAccountState,
    RotateLogs,
    DowngradeToProtected,
    DowngradeToPaper,
    HaltTrading,
    NoAction,
}

pub fn plan_recovery(decision: WatchdogDecision) -> Vec<RecoveryAction> {
    match (decision.status, decision.suggested_reason) {
        (HealthStatus::Healthy, _) => vec![RecoveryAction::NoAction],
        (HealthStatus::Degraded, Some(TransitionReason::DegradedHealth)) => vec![
            RecoveryAction::RestartNonCriticalService("analytics"),
            RecoveryAction::RotateLogs,
        ],
        (HealthStatus::ProtectedOnly, Some(TransitionReason::FeedStale)) => vec![
            RecoveryAction::ReconnectMarketStreams,
            RecoveryAction::DowngradeToProtected,
        ],
        (HealthStatus::ProtectedOnly, Some(TransitionReason::RepeatedOrderFailures)) => vec![
            RecoveryAction::ResyncAccountState,
            RecoveryAction::DowngradeToPaper,
        ],
        (HealthStatus::Halted, _) => vec![
            RecoveryAction::ResyncAccountState,
            RecoveryAction::HaltTrading,
        ],
        _ => vec![RecoveryAction::DowngradeToProtected],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_feed_recovery_actions() {
        let actions = plan_recovery(WatchdogDecision {
            status: HealthStatus::ProtectedOnly,
            suggested_reason: Some(TransitionReason::FeedStale),
        });

        assert_eq!(actions[0], RecoveryAction::ReconnectMarketStreams);
    }

    #[test]
    fn halts_on_critical_failure() {
        let actions = plan_recovery(WatchdogDecision {
            status: HealthStatus::Halted,
            suggested_reason: Some(TransitionReason::ExchangeDesync),
        });

        assert!(actions.contains(&RecoveryAction::HaltTrading));
    }
}
