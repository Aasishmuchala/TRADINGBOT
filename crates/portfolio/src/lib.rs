#[derive(Debug, Clone, PartialEq)]
pub struct PositionExposure {
    pub symbol: String,
    pub notional_usd: f64,
    pub correlation_bucket: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExposureSummary {
    pub total_notional_usd: f64,
    pub max_symbol_concentration: f64,
    pub max_bucket_concentration: f64,
}

pub fn summarize_exposure(positions: &[PositionExposure]) -> ExposureSummary {
    let total_notional_usd = positions.iter().map(|position| position.notional_usd).sum::<f64>();
    if total_notional_usd <= 0.0 {
        return ExposureSummary {
            total_notional_usd: 0.0,
            max_symbol_concentration: 0.0,
            max_bucket_concentration: 0.0,
        };
    }

    let max_symbol_concentration = positions
        .iter()
        .map(|position| position.notional_usd / total_notional_usd)
        .fold(0.0, f64::max);

    let mut bucket_totals = std::collections::HashMap::<&str, f64>::new();
    for position in positions {
        *bucket_totals.entry(position.correlation_bucket.as_str()).or_insert(0.0) += position.notional_usd;
    }

    let max_bucket_concentration = bucket_totals
        .values()
        .map(|bucket_total| *bucket_total / total_notional_usd)
        .fold(0.0, f64::max);

    ExposureSummary {
        total_notional_usd,
        max_symbol_concentration,
        max_bucket_concentration,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_positions() {
        let summary = summarize_exposure(&[
            PositionExposure {
                symbol: "BTCUSDT".to_string(),
                notional_usd: 1000.0,
                correlation_bucket: "majors".to_string(),
            },
            PositionExposure {
                symbol: "ETHUSDT".to_string(),
                notional_usd: 500.0,
                correlation_bucket: "majors".to_string(),
            },
            PositionExposure {
                symbol: "SOLUSDT".to_string(),
                notional_usd: 500.0,
                correlation_bucket: "alts".to_string(),
            },
        ]);

        assert_eq!(summary.total_notional_usd, 2000.0);
        assert!(summary.max_symbol_concentration >= 0.5);
        assert!(summary.max_bucket_concentration >= 0.75);
    }
}
