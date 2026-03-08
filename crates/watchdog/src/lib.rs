use sthyra_market_data::FeedHealth;
use sthyra_mode_authority::TransitionReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogSnapshot {
    pub feed_health: FeedHealth,
    pub exchange_desynced: bool,
    pub repeated_order_failures: u8,
    pub engine_heartbeat_missed: bool,
    pub cpu_pressure_high: bool,
    pub disk_pressure_high: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    Degraded,
    ProtectedOnly,
    Halted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogDecision {
    pub status: HealthStatus,
    pub suggested_reason: Option<TransitionReason>,
}

pub fn evaluate(snapshot: WatchdogSnapshot) -> WatchdogDecision {
    if snapshot.exchange_desynced {
        return WatchdogDecision {
            status: HealthStatus::Halted,
            suggested_reason: Some(TransitionReason::ExchangeDesync),
        };
    }

    if snapshot.repeated_order_failures >= 3 || snapshot.engine_heartbeat_missed || matches!(snapshot.feed_health, FeedHealth::Stale) {
        return WatchdogDecision {
            status: HealthStatus::ProtectedOnly,
            suggested_reason: Some(if matches!(snapshot.feed_health, FeedHealth::Stale) {
                TransitionReason::FeedStale
            } else {
                TransitionReason::RepeatedOrderFailures
            }),
        };
    }

    if snapshot.cpu_pressure_high || snapshot.disk_pressure_high || matches!(snapshot.feed_health, FeedHealth::Degraded) {
        return WatchdogDecision {
            status: HealthStatus::Degraded,
            suggested_reason: Some(TransitionReason::DegradedHealth),
        };
    }

    WatchdogDecision {
        status: HealthStatus::Healthy,
        suggested_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halts_on_desync() {
        let decision = evaluate(WatchdogSnapshot {
            feed_health: FeedHealth::Healthy,
            exchange_desynced: true,
            repeated_order_failures: 0,
            engine_heartbeat_missed: false,
            cpu_pressure_high: false,
            disk_pressure_high: false,
        });

        assert_eq!(decision.status, HealthStatus::Halted);
    }

    #[test]
    fn protects_on_stale_feed() {
        let decision = evaluate(WatchdogSnapshot {
            feed_health: FeedHealth::Stale,
            exchange_desynced: false,
            repeated_order_failures: 0,
            engine_heartbeat_missed: false,
            cpu_pressure_high: false,
            disk_pressure_high: false,
        });

        assert_eq!(decision.status, HealthStatus::ProtectedOnly);
    }
}
