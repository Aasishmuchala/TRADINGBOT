use sthyra_domain::OrderIntent;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderState {
    IntentCreated,
    PendingSubmit,
    Accepted,
    PartiallyFilled,
    Filled,
    CancelPending,
    Canceled,
    Rejected,
    ReconciliationPending,
    Desynced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionEvent {
    Submit,
    Accept,
    PartialFill,
    Fill,
    Cancel,
    Reject,
    Reconcile,
    Desync,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionTicket {
    pub intent: OrderIntent,
    pub state: OrderState,
    pub exchange_order_id: Option<String>,
}

impl ExecutionTicket {
    pub fn new(intent: OrderIntent) -> Self {
        Self {
            intent,
            state: OrderState::IntentCreated,
            exchange_order_id: None,
        }
    }

    pub fn transition(&mut self, event: ExecutionEvent) -> Result<OrderState, ExecutionError> {
        self.state = match (self.state, event) {
            (OrderState::IntentCreated, ExecutionEvent::Submit) => OrderState::PendingSubmit,
            (OrderState::PendingSubmit, ExecutionEvent::Accept) => OrderState::Accepted,
            (OrderState::Accepted, ExecutionEvent::PartialFill) => OrderState::PartiallyFilled,
            (OrderState::Accepted | OrderState::PartiallyFilled, ExecutionEvent::Fill) => OrderState::Filled,
            (OrderState::Accepted | OrderState::PartiallyFilled, ExecutionEvent::Cancel) => OrderState::CancelPending,
            (OrderState::CancelPending, ExecutionEvent::Reconcile) => OrderState::Canceled,
            (OrderState::PendingSubmit | OrderState::Accepted | OrderState::PartiallyFilled, ExecutionEvent::Reject) => OrderState::Rejected,
            (OrderState::Filled | OrderState::Rejected | OrderState::Canceled, ExecutionEvent::Reconcile) => OrderState::ReconciliationPending,
            (_, ExecutionEvent::Desync) => OrderState::Desynced,
            _ => return Err(ExecutionError::InvalidTransition(self.state, event)),
        };

        Ok(self.state)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionError {
    InvalidTransition(OrderState, ExecutionEvent),
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_domain::{RuntimeMode, Symbol, TradeDecision};

    fn ticket() -> ExecutionTicket {
        ExecutionTicket::new(OrderIntent {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            mode: RuntimeMode::SemiAuto,
            decision: TradeDecision::Approve,
            size_usd: 100.0,
        })
    }

    #[test]
    fn follows_happy_path() {
        let mut ticket = ticket();
        assert_eq!(ticket.transition(ExecutionEvent::Submit), Ok(OrderState::PendingSubmit));
        assert_eq!(ticket.transition(ExecutionEvent::Accept), Ok(OrderState::Accepted));
        assert_eq!(ticket.transition(ExecutionEvent::Fill), Ok(OrderState::Filled));
        assert_eq!(ticket.transition(ExecutionEvent::Reconcile), Ok(OrderState::ReconciliationPending));
    }

    #[test]
    fn rejects_invalid_transition() {
        let mut ticket = ticket();
        let result = ticket.transition(ExecutionEvent::Fill);
        assert!(matches!(result, Err(ExecutionError::InvalidTransition(_, _))));
    }
}
