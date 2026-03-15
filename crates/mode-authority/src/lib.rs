use sthyra_domain::RuntimeMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionReason {
    OperatorRequested,
    DegradedHealth,
    ExchangeDesync,
    FeedStale,
    RepeatedOrderFailures,
    RiskDrawdownLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionDecision {
    pub from: RuntimeMode,
    pub to: RuntimeMode,
    pub reason: TransitionReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionError {
    Forbidden(RuntimeMode, RuntimeMode),
}

pub struct ModeAuthority {
    current: RuntimeMode,
}

impl ModeAuthority {
    pub fn new(initial: RuntimeMode) -> Self {
        Self { current: initial }
    }

    pub fn current(&self) -> RuntimeMode {
        self.current
    }

    pub fn request_transition(
        &mut self,
        target: RuntimeMode,
        reason: TransitionReason,
    ) -> Result<TransitionDecision, TransitionError> {
        if !is_transition_allowed(self.current, target, reason) {
            return Err(TransitionError::Forbidden(self.current, target));
        }

        let decision = TransitionDecision {
            from: self.current,
            to: target,
            reason,
        };
        self.current = target;
        Ok(decision)
    }
}

fn is_transition_allowed(from: RuntimeMode, to: RuntimeMode, reason: TransitionReason) -> bool {
    use RuntimeMode::*;
    use TransitionReason::*;

    match (from, to, reason) {
        (current, target, OperatorRequested) if current == target => true,
        (Research, Backtest | Replay | Paper, OperatorRequested) => true,
        (Backtest | Replay, Research | Paper, OperatorRequested) => true,
        (Paper, SemiAuto, OperatorRequested) => true,
        (SemiAuto, FullAuto, OperatorRequested) => true,
        (_, Protected, OperatorRequested) => true,
        (Paper | Protected | SemiAuto | FullAuto | Halted, Research, OperatorRequested) => true,
        (SemiAuto | FullAuto, Paper, OperatorRequested) => true,
        (FullAuto, SemiAuto, OperatorRequested) => true,
        (_, Protected, DegradedHealth | FeedStale | ExchangeDesync | RepeatedOrderFailures) => true,
        (_, Paper, DegradedHealth | RepeatedOrderFailures) => true,
        (_, Halted, RiskDrawdownLimit | ExchangeDesync | RepeatedOrderFailures | DegradedHealth) => true,
        (Protected, Paper | Halted, OperatorRequested) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_protection_downgrade() {
        let mut authority = ModeAuthority::new(RuntimeMode::FullAuto);
        let decision = authority
            .request_transition(RuntimeMode::Protected, TransitionReason::DegradedHealth)
            .expect("downgrade should be allowed");

        assert_eq!(decision.to, RuntimeMode::Protected);
    }

    #[test]
    fn blocks_direct_research_to_full_auto() {
        let mut authority = ModeAuthority::new(RuntimeMode::Research);
        let decision = authority.request_transition(RuntimeMode::FullAuto, TransitionReason::OperatorRequested);

        assert!(matches!(decision, Err(TransitionError::Forbidden(_, _))));
    }

    #[test]
    fn allows_operator_downgrade_to_paper() {
        let mut authority = ModeAuthority::new(RuntimeMode::SemiAuto);
        let decision = authority.request_transition(RuntimeMode::Paper, TransitionReason::OperatorRequested);

        assert_eq!(decision.expect("downgrade should be allowed").to, RuntimeMode::Paper);
    }

    #[test]
    fn allows_operator_transition_to_protected() {
        let mut authority = ModeAuthority::new(RuntimeMode::SemiAuto);
        let decision = authority.request_transition(RuntimeMode::Protected, TransitionReason::OperatorRequested);

        assert_eq!(decision.expect("protected transition should be allowed").to, RuntimeMode::Protected);
    }
}
