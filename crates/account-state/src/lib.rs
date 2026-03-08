#[derive(Debug, Clone, PartialEq)]
pub struct AccountBalance {
    pub asset: String,
    pub wallet_balance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PositionState {
    pub symbol: String,
    pub quantity: f64,
    pub entry_price: f64,
    pub leverage: u8,
    pub unrealized_pnl: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenOrderState {
    pub symbol: String,
    pub client_order_id: String,
    pub quantity: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AccountSnapshot {
    pub balances: Vec<AccountBalance>,
    pub positions: Vec<PositionState>,
    pub open_orders: Vec<OpenOrderState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconciliationIssue {
    MissingLocalPosition(String),
    MissingExchangePosition(String),
    PositionQuantityMismatch(String),
    OpenOrderMismatch(String),
}

pub fn reconcile(local: &AccountSnapshot, exchange: &AccountSnapshot) -> Vec<ReconciliationIssue> {
    let mut issues = Vec::new();

    for position in &local.positions {
        match exchange.positions.iter().find(|candidate| candidate.symbol == position.symbol) {
            None => issues.push(ReconciliationIssue::MissingExchangePosition(position.symbol.clone())),
            Some(remote) if (remote.quantity - position.quantity).abs() > 1e-8 => {
                issues.push(ReconciliationIssue::PositionQuantityMismatch(position.symbol.clone()))
            }
            _ => {}
        }
    }

    for position in &exchange.positions {
        if !local.positions.iter().any(|candidate| candidate.symbol == position.symbol) {
            issues.push(ReconciliationIssue::MissingLocalPosition(position.symbol.clone()));
        }
    }

    for order in &local.open_orders {
        let matched = exchange
            .open_orders
            .iter()
            .any(|candidate| candidate.client_order_id == order.client_order_id && candidate.symbol == order.symbol);
        if !matched {
            issues.push(ReconciliationIssue::OpenOrderMismatch(order.client_order_id.clone()));
        }
    }

    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_position_and_order_mismatches() {
        let local = AccountSnapshot {
            balances: vec![],
            positions: vec![PositionState {
                symbol: "BTCUSDT".to_string(),
                quantity: 1.0,
                entry_price: 100000.0,
                leverage: 5,
                unrealized_pnl: 0.0,
            }],
            open_orders: vec![OpenOrderState {
                symbol: "BTCUSDT".to_string(),
                client_order_id: "abc".to_string(),
                quantity: 1.0,
            }],
        };
        let exchange = AccountSnapshot {
            balances: vec![],
            positions: vec![PositionState {
                symbol: "BTCUSDT".to_string(),
                quantity: 0.5,
                entry_price: 100000.0,
                leverage: 5,
                unrealized_pnl: 0.0,
            }],
            open_orders: vec![],
        };

        let issues = reconcile(&local, &exchange);
        assert_eq!(issues.len(), 2);
    }
}
