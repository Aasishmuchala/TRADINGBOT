#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleClass {
    Critical,
    NonCritical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxProposal {
    pub module_name: String,
    pub module_class: ModuleClass,
    pub tests_passed: bool,
    pub replay_passed: bool,
    pub invariant_checks_passed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromotionDecision {
    Promote,
    RequireManualReview,
    Reject,
}

pub fn evaluate_proposal(proposal: &SandboxProposal) -> PromotionDecision {
    if !(proposal.tests_passed && proposal.replay_passed && proposal.invariant_checks_passed) {
        return PromotionDecision::Reject;
    }

    match proposal.module_class {
        ModuleClass::Critical => PromotionDecision::RequireManualReview,
        ModuleClass::NonCritical => PromotionDecision::Promote,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_failed_proposal() {
        let decision = evaluate_proposal(&SandboxProposal {
            module_name: "strategy-engine".to_string(),
            module_class: ModuleClass::NonCritical,
            tests_passed: true,
            replay_passed: false,
            invariant_checks_passed: true,
        });

        assert_eq!(decision, PromotionDecision::Reject);
    }

    #[test]
    fn requires_review_for_critical_modules() {
        let decision = evaluate_proposal(&SandboxProposal {
            module_name: "risk-engine".to_string(),
            module_class: ModuleClass::Critical,
            tests_passed: true,
            replay_passed: true,
            invariant_checks_passed: true,
        });

        assert_eq!(decision, PromotionDecision::RequireManualReview);
    }
}
