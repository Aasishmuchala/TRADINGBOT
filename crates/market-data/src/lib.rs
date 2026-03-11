use sthyra_domain::{MarketRegime, RegimeAssessment, Symbol};

#[derive(Debug, Clone, PartialEq)]
pub struct OrderBookSnapshot {
    pub symbol: Symbol,
    pub best_bid: f64,
    pub best_ask: f64,
    pub bid_depth: f64,
    pub ask_depth: f64,
    pub last_update_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candle {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub close_time_ms: u64,
}

impl Candle {
    /// Returns `true` if OHLC values are positive, non-NaN, and correctly ordered.
    pub fn is_valid(&self) -> bool {
        !self.open.is_nan()
            && !self.high.is_nan()
            && !self.low.is_nan()
            && !self.close.is_nan()
            && !self.volume.is_nan()
            && self.open > 0.0
            && self.high > 0.0
            && self.low > 0.0
            && self.close > 0.0
            && self.volume >= 0.0
            && self.high >= self.low
            && self.high >= self.open
            && self.high >= self.close
            && self.low <= self.open
            && self.low <= self.close
    }
}

impl OrderBookSnapshot {
    pub fn spread_bps(&self) -> f64 {
        let mid = (self.best_bid + self.best_ask) / 2.0;
        if mid <= 0.0 {
            return f64::INFINITY;
        }
        ((self.best_ask - self.best_bid) / mid) * 10_000.0
    }

    pub fn imbalance(&self) -> f64 {
        let total = self.bid_depth + self.ask_depth;
        if total <= 0.0 {
            return 0.0;
        }
        (self.bid_depth - self.ask_depth) / total
    }

    /// Returns `true` if bid and ask prices are positive and correctly ordered.
    pub fn is_valid(&self) -> bool {
        self.best_bid > 0.0 && self.best_ask > 0.0 && self.best_bid <= self.best_ask
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FundingSnapshot {
    pub rate: f64,
    pub next_funding_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedHealth {
    Healthy,
    Degraded,
    Stale,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarketHealthAssessment {
    pub feed_health: FeedHealth,
    pub spread_penalty: f64,
    pub liquidity_penalty: f64,
    pub manipulation_suspected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolatilityRegime {
    Compressed,
    Normal,
    Expanding,
    Chaotic,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndicatorSnapshot {
    pub sma_20: f64,
    pub sma_50: f64,
    pub ema_fast: f64,
    pub ema_slow: f64,
    pub rsi: f64,
    pub atr: f64,
    pub atr_ratio: f64,
    pub realized_volatility: f64,
    pub macd_line: f64,
    pub macd_signal: f64,
    pub macd_histogram: f64,
    pub bollinger_upper: f64,
    pub bollinger_lower: f64,
    pub bollinger_position: f64,
    pub stochastic_k: f64,
    pub cci: f64,
    pub obv_slope: f64,
    pub vwap_distance: f64,
    pub rate_of_change: f64,
    pub money_flow_index: f64,
    pub momentum_score: f64,
    pub mean_reversion_score: f64,
    pub breakout_score: f64,
    pub volume_confirmation: f64,
    pub signal_consensus: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarketStructureSnapshot {
    pub trend_bias: f64,
    pub support_resistance_clarity: f64,
    pub breakout_pressure: f64,
    pub reversal_pressure: f64,
    pub structure_score: f64,
    pub volatility_regime: VolatilityRegime,
}

pub fn assess_market_health(
    book: &OrderBookSnapshot,
    now_ms: u64,
    stale_after_ms: u64,
) -> MarketHealthAssessment {
    let age_ms = now_ms.saturating_sub(book.last_update_ms);
    let spread_bps = book.spread_bps();
    let imbalance = book.imbalance().abs();
    let feed_health = if age_ms >= stale_after_ms {
        FeedHealth::Stale
    } else if spread_bps > 8.0 {
        FeedHealth::Degraded
    } else {
        FeedHealth::Healthy
    };

    MarketHealthAssessment {
        feed_health,
        spread_penalty: (spread_bps / 10.0).min(1.0),
        liquidity_penalty: if book.bid_depth + book.ask_depth < 100_000.0 { 0.4 } else { 0.0 },
        manipulation_suspected: imbalance > 0.85 && spread_bps > 5.0,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegimeFeatureVector {
    pub symbol: Symbol,
    pub trend_strength: f64,
    pub momentum_quality: f64,
    pub volatility_compression: f64,
    pub liquidity_quality: f64,
    pub order_book_pressure: f64,
    pub inferred_regime_hint: MarketRegime,
}

pub fn compute_indicator_snapshot(candles: &[Candle]) -> IndicatorSnapshot {
    let closes = candles.iter().map(|candle| candle.close).collect::<Vec<_>>();
    let volumes = candles.iter().map(|candle| candle.volume).collect::<Vec<_>>();

    let sma_20 = simple_moving_average(&closes, 20);
    let sma_50 = simple_moving_average(&closes, 50);
    let ema_fast = ema(&closes, 9);
    let ema_slow = ema(&closes, 21);
    let rsi = relative_strength_index(&closes, 14);
    let atr = average_true_range(candles, 14);
    let current_close = closes.last().copied().unwrap_or(0.0);
    let atr_ratio = if current_close.abs() <= f64::EPSILON {
        0.0
    } else {
        (atr / current_close).clamp(0.0, 1.0)
    };
    let realized_volatility = realized_volatility(&closes).clamp(0.0, 1.0);
    let macd_line = ema(&closes, 12) - ema(&closes, 26);
    let macd_signal = macd_signal(&closes);
    let macd_histogram = macd_line - macd_signal;
    let (bollinger_upper, bollinger_lower, bollinger_position) = bollinger_bands(&closes, 20);
    let stochastic_k = stochastic_oscillator(candles, 14);
    let cci = commodity_channel_index(candles, 20);
    let obv_slope = on_balance_volume_slope(candles);
    let vwap_distance = vwap_distance(candles);
    let rate_of_change = rate_of_change(&closes, 12);
    let money_flow_index = money_flow_index(candles, 14);
    let average_volume = average(&volumes);
    let latest_volume = volumes.last().copied().unwrap_or(average_volume);
    let volume_confirmation = if average_volume <= f64::EPSILON {
        0.0
    } else {
        (latest_volume / average_volume - 1.0).clamp(-1.0, 1.0)
    };
    let momentum_score = if current_close.abs() <= f64::EPSILON {
        0.0
    } else {
        ((ema_fast - ema_slow) / current_close).clamp(-1.0, 1.0)
    };
    let mean_reversion_score = (1.0 - ((rsi - 50.0).abs() / 50.0)).clamp(0.0, 1.0);

    let range_high = candles
        .iter()
        .rev()
        .take(20)
        .map(|candle| candle.high)
        .reduce(f64::max)
        .unwrap_or(current_close);
    let range_low = candles
        .iter()
        .rev()
        .take(20)
        .map(|candle| candle.low)
        .reduce(f64::min)
        .unwrap_or(current_close);
    let breakout_score = if (range_high - range_low).abs() <= f64::EPSILON {
        0.0
    } else {
        ((current_close - range_low) / (range_high - range_low)).clamp(0.0, 1.0)
    };
    let signal_consensus = ((momentum_score.abs() * 0.35)
        + (mean_reversion_score * 0.15)
        + (breakout_score * 0.25)
        + (volume_confirmation.max(0.0) * 0.1)
        + ((1.0 - atr_ratio) * 0.15))
        .clamp(0.0, 1.0);

    IndicatorSnapshot {
        sma_20,
        sma_50,
        ema_fast,
        ema_slow,
        rsi,
        atr,
        atr_ratio,
        realized_volatility,
        macd_line,
        macd_signal,
        macd_histogram,
        bollinger_upper,
        bollinger_lower,
        bollinger_position,
        stochastic_k,
        cci,
        obv_slope,
        vwap_distance,
        rate_of_change,
        money_flow_index,
        momentum_score,
        mean_reversion_score,
        breakout_score,
        volume_confirmation,
        signal_consensus,
    }
}

pub fn assess_market_structure(candles: &[Candle], book: &OrderBookSnapshot) -> MarketStructureSnapshot {
    let indicators = compute_indicator_snapshot(candles);
    let trend_bias = indicators.momentum_score.clamp(-1.0, 1.0);
    let breakout_pressure = ((book.imbalance().abs() * 0.4) + indicators.breakout_score * 0.6).clamp(0.0, 1.0);
    let reversal_pressure = (((indicators.rsi - 50.0).abs() / 50.0) * (1.0 - indicators.breakout_score)).clamp(0.0, 1.0);
    let support_resistance_clarity = (1.0 - indicators.realized_volatility).clamp(0.0, 1.0);
    let volatility_regime = if indicators.atr_ratio < 0.003 {
        VolatilityRegime::Compressed
    } else if indicators.atr_ratio < 0.01 {
        VolatilityRegime::Normal
    } else if indicators.atr_ratio < 0.02 {
        VolatilityRegime::Expanding
    } else {
        VolatilityRegime::Chaotic
    };
    let structure_score = ((trend_bias.abs() * 0.35)
        + (support_resistance_clarity * 0.2)
        + (breakout_pressure * 0.25)
        + ((1.0 - reversal_pressure) * 0.2))
        .clamp(0.0, 1.0);

    MarketStructureSnapshot {
        trend_bias,
        support_resistance_clarity,
        breakout_pressure,
        reversal_pressure,
        structure_score,
        volatility_regime,
    }
}

pub fn derive_feature_vector(
    symbol: Symbol,
    book: &OrderBookSnapshot,
    indicators: &IndicatorSnapshot,
    structure: &MarketStructureSnapshot,
) -> RegimeFeatureVector {
    RegimeFeatureVector {
        symbol,
        trend_strength: ((indicators.momentum_score.abs() * 0.6) + (structure.trend_bias.abs() * 0.4)).clamp(0.0, 1.0),
        momentum_quality: ((indicators.signal_consensus * 0.6) + indicators.volume_confirmation.max(0.0) * 0.4).clamp(0.0, 1.0),
        volatility_compression: match structure.volatility_regime {
            VolatilityRegime::Compressed => 0.9,
            VolatilityRegime::Normal => 0.45,
            VolatilityRegime::Expanding => 0.2,
            VolatilityRegime::Chaotic => 0.05,
        },
        liquidity_quality: (1.0 - (book.spread_bps() / 20.0)).clamp(0.0, 1.0),
        order_book_pressure: book.imbalance().clamp(-1.0, 1.0),
        inferred_regime_hint: infer_regime(indicators, structure, &assess_market_health(book, book.last_update_ms, 30_000)).regime,
    }
}

pub fn infer_regime(
    indicators: &IndicatorSnapshot,
    structure: &MarketStructureSnapshot,
    market_health: &MarketHealthAssessment,
) -> RegimeAssessment {
    let regime = if market_health.manipulation_suspected || matches!(market_health.feed_health, FeedHealth::Stale) {
        MarketRegime::NoTrade
    } else if matches!(structure.volatility_regime, VolatilityRegime::Chaotic) {
        MarketRegime::Disordered
    } else if indicators.breakout_score > 0.75 && structure.breakout_pressure > 0.65 {
        MarketRegime::BreakoutExpansion
    } else if matches!(structure.volatility_regime, VolatilityRegime::Compressed) {
        MarketRegime::VolatilityCompression
    } else if structure.reversal_pressure > 0.65 {
        MarketRegime::ReversalAttempt
    } else if structure.trend_bias.abs() > 0.22 {
        MarketRegime::Trending
    } else {
        MarketRegime::Ranging
    };

    let confidence = ((indicators.signal_consensus * 0.4)
        + (structure.structure_score * 0.4)
        + ((1.0 - market_health.spread_penalty) * 0.2))
        .clamp(0.0, 1.0) as f32;

    RegimeAssessment::new_clamped(regime, confidence)
}

fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    values.iter().sum::<f64>() / values.len() as f64
}

fn simple_moving_average(values: &[f64], period: usize) -> f64 {
    let window = values.iter().rev().take(period).copied().collect::<Vec<_>>();
    average(&window)
}

fn ema(values: &[f64], period: usize) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let smoothing = 2.0 / (period as f64 + 1.0);
    let mut ema_value = values[0];
    for value in values.iter().skip(1) {
        ema_value = value * smoothing + ema_value * (1.0 - smoothing);
    }
    ema_value
}

fn macd_signal(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let mut macd_values = Vec::new();
    for index in 0..values.len() {
        let slice = &values[..=index];
        macd_values.push(ema(slice, 12) - ema(slice, 26));
    }
    ema(&macd_values, 9)
}

fn relative_strength_index(closes: &[f64], period: usize) -> f64 {
    if closes.len() < 2 {
        return 50.0;
    }

    let mut gains = 0.0;
    let mut losses = 0.0;
    for window in closes.windows(2).rev().take(period) {
        let delta = window[1] - window[0];
        if delta >= 0.0 {
            gains += delta;
        } else {
            losses += delta.abs();
        }
    }

    if losses <= f64::EPSILON {
        return 100.0;
    }

    let rs = gains / losses.max(f64::EPSILON);
    100.0 - (100.0 / (1.0 + rs))
}

fn average_true_range(candles: &[Candle], period: usize) -> f64 {
    if candles.is_empty() {
        return 0.0;
    }

    let mut true_ranges = Vec::new();
    for (index, candle) in candles.iter().enumerate().skip(1).rev().take(period) {
        let previous_close = candles[index - 1].close;
        let true_range = (candle.high - candle.low)
            .max((candle.high - previous_close).abs())
            .max((candle.low - previous_close).abs());
        true_ranges.push(true_range);
    }

    average(&true_ranges)
}

fn realized_volatility(closes: &[f64]) -> f64 {
    let returns = closes
        .windows(2)
        .filter_map(|window| {
            if window[0].abs() <= f64::EPSILON {
                None
            } else {
                Some((window[1] / window[0]).ln())
            }
        })
        .collect::<Vec<_>>();

    if returns.is_empty() {
        return 0.0;
    }

    let mean = average(&returns);
    let variance = returns
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / returns.len() as f64;

    variance.sqrt().clamp(0.0, 1.0)
}

fn bollinger_bands(closes: &[f64], period: usize) -> (f64, f64, f64) {
    let window = closes.iter().rev().take(period).copied().collect::<Vec<_>>();
    if window.is_empty() {
        return (0.0, 0.0, 0.5);
    }

    let mean = average(&window);
    let variance = window.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / window.len() as f64;
    let stdev = variance.sqrt();
    let upper = mean + 2.0 * stdev;
    let lower = mean - 2.0 * stdev;
    let last = closes.last().copied().unwrap_or(mean);
    let position = if (upper - lower).abs() <= f64::EPSILON {
        0.5
    } else {
        ((last - lower) / (upper - lower)).clamp(0.0, 1.0)
    };

    (upper, lower, position)
}

fn stochastic_oscillator(candles: &[Candle], period: usize) -> f64 {
    let window = candles.iter().rev().take(period).collect::<Vec<_>>();
    if window.is_empty() {
        return 50.0;
    }

    let high = window.iter().map(|candle| candle.high).reduce(f64::max).unwrap_or(0.0);
    let low = window.iter().map(|candle| candle.low).reduce(f64::min).unwrap_or(0.0);
    let close = candles.last().map(|candle| candle.close).unwrap_or(0.0);
    if (high - low).abs() <= f64::EPSILON {
        50.0
    } else {
        ((close - low) / (high - low) * 100.0).clamp(0.0, 100.0)
    }
}

fn commodity_channel_index(candles: &[Candle], period: usize) -> f64 {
    let window = candles.iter().rev().take(period).collect::<Vec<_>>();
    if window.is_empty() {
        return 0.0;
    }

    let typical_prices = window
        .iter()
        .map(|candle| (candle.high + candle.low + candle.close) / 3.0)
        .collect::<Vec<_>>();
    let sma = average(&typical_prices);
    let mean_deviation = average(&typical_prices.iter().map(|price| (price - sma).abs()).collect::<Vec<_>>());
    let current_typical = typical_prices.first().copied().unwrap_or(sma);
    if mean_deviation.abs() <= f64::EPSILON {
        0.0
    } else {
        ((current_typical - sma) / (0.015 * mean_deviation)).clamp(-300.0, 300.0)
    }
}

fn on_balance_volume_slope(candles: &[Candle]) -> f64 {
    if candles.len() < 2 {
        return 0.0;
    }

    let mut obv = 0.0;
    let mut history = Vec::new();
    for window in candles.windows(2) {
        if window[1].close > window[0].close {
            obv += window[1].volume;
        } else if window[1].close < window[0].close {
            obv -= window[1].volume;
        }
        history.push(obv);
    }

    let first = history.first().copied().unwrap_or(0.0);
    let last = history.last().copied().unwrap_or(0.0);
    ((last - first) / history.len() as f64).clamp(-1_000_000.0, 1_000_000.0)
}

fn vwap_distance(candles: &[Candle]) -> f64 {
    let mut cumulative_price_volume = 0.0;
    let mut cumulative_volume = 0.0;
    for candle in candles.iter().rev().take(60) {
        let typical = (candle.high + candle.low + candle.close) / 3.0;
        cumulative_price_volume += typical * candle.volume;
        cumulative_volume += candle.volume;
    }

    if cumulative_volume.abs() <= f64::EPSILON {
        return 0.0;
    }

    let vwap = cumulative_price_volume / cumulative_volume;
    let last_close = candles.last().map(|candle| candle.close).unwrap_or(vwap);
    ((last_close - vwap) / vwap).clamp(-1.0, 1.0)
}

fn rate_of_change(closes: &[f64], period: usize) -> f64 {
    if closes.len() <= period {
        return 0.0;
    }

    let current = closes.last().copied().unwrap_or(0.0);
    let previous = closes[closes.len() - period - 1];
    if previous.abs() <= f64::EPSILON {
        0.0
    } else {
        ((current - previous) / previous).clamp(-1.0, 1.0)
    }
}

fn money_flow_index(candles: &[Candle], period: usize) -> f64 {
    let window = candles.iter().rev().take(period + 1).collect::<Vec<_>>();
    if window.len() < 2 {
        return 50.0;
    }

    let mut positive_flow = 0.0;
    let mut negative_flow = 0.0;

    for pair in window.windows(2) {
        let previous_typical = (pair[1].high + pair[1].low + pair[1].close) / 3.0;
        let current_typical = (pair[0].high + pair[0].low + pair[0].close) / 3.0;
        let raw_flow = current_typical * pair[0].volume;
        if current_typical > previous_typical {
            positive_flow += raw_flow;
        } else {
            negative_flow += raw_flow;
        }
    }

    if negative_flow.abs() <= f64::EPSILON {
        100.0
    } else {
        let ratio = positive_flow / negative_flow;
        (100.0 - 100.0 / (1.0 + ratio)).clamp(0.0, 100.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_spread_and_imbalance() {
        let snapshot = OrderBookSnapshot {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            best_bid: 100.0,
            best_ask: 100.1,
            bid_depth: 120_000.0,
            ask_depth: 80_000.0,
            last_update_ms: 100,
        };

        assert!(snapshot.spread_bps() > 0.0);
        assert!(snapshot.imbalance() > 0.0);
    }

    #[test]
    fn marks_stale_feed() {
        let snapshot = OrderBookSnapshot {
            symbol: Symbol::new("ETHUSDT").expect("valid symbol"),
            best_bid: 50.0,
            best_ask: 50.1,
            bid_depth: 10_000.0,
            ask_depth: 10_000.0,
            last_update_ms: 10,
        };

        let assessment = assess_market_health(&snapshot, 1000, 500);
        assert_eq!(assessment.feed_health, FeedHealth::Stale);
    }

    #[test]
    fn derives_indicator_and_regime_snapshot() {
        let candles = (1..=30)
            .map(|index| Candle {
                open: 100.0 + index as f64,
                high: 101.0 + index as f64,
                low: 99.5 + index as f64,
                close: 100.5 + index as f64,
                volume: 10_000.0 + index as f64 * 100.0,
                close_time_ms: index as u64 * 60_000,
            })
            .collect::<Vec<_>>();
        let book = OrderBookSnapshot {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            best_bid: 130.0,
            best_ask: 130.1,
            bid_depth: 150_000.0,
            ask_depth: 140_000.0,
            last_update_ms: 1_000,
        };

        let indicators = compute_indicator_snapshot(&candles);
        let structure = assess_market_structure(&candles, &book);
        let regime = infer_regime(&indicators, &structure, &assess_market_health(&book, 1_100, 5_000));

        assert!(indicators.signal_consensus > 0.0);
        assert!(structure.structure_score > 0.0);
        assert_ne!(regime.regime, MarketRegime::NoTrade);
    }

    #[test]
    fn order_book_snapshot_validates_bid_ask_order() {
        let valid = OrderBookSnapshot {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            best_bid: 100.0,
            best_ask: 100.1,
            bid_depth: 50_000.0,
            ask_depth: 50_000.0,
            last_update_ms: 1_000,
        };
        assert!(valid.is_valid());

        let inverted = OrderBookSnapshot {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            best_bid: 100.1,
            best_ask: 100.0,
            bid_depth: 50_000.0,
            ask_depth: 50_000.0,
            last_update_ms: 1_000,
        };
        assert!(!inverted.is_valid());

        let zero_bid = OrderBookSnapshot {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            best_bid: 0.0,
            best_ask: 100.0,
            bid_depth: 50_000.0,
            ask_depth: 50_000.0,
            last_update_ms: 1_000,
        };
        assert!(!zero_bid.is_valid());

        let zero_ask = OrderBookSnapshot {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            best_bid: 100.0,
            best_ask: 0.0,
            bid_depth: 50_000.0,
            ask_depth: 50_000.0,
            last_update_ms: 1_000,
        };
        assert!(!zero_ask.is_valid());
    }

    #[test]
    fn candle_validates_ohlc_integrity() {
        let valid = Candle {
            open: 100.0,
            high: 105.0,
            low: 98.0,
            close: 102.0,
            volume: 1_000.0,
            close_time_ms: 60_000,
        };
        assert!(valid.is_valid());

        let invalid_high_below_low = Candle {
            open: 100.0,
            high: 95.0,
            low: 98.0,
            close: 102.0,
            volume: 1_000.0,
            close_time_ms: 60_000,
        };
        assert!(!invalid_high_below_low.is_valid());

        let invalid_high_below_close = Candle {
            open: 100.0,
            high: 101.0,
            low: 98.0,
            close: 103.0,
            volume: 1_000.0,
            close_time_ms: 60_000,
        };
        assert!(!invalid_high_below_close.is_valid());

        let nan_close = Candle {
            open: 100.0,
            high: 105.0,
            low: 98.0,
            close: f64::NAN,
            volume: 1_000.0,
            close_time_ms: 60_000,
        };
        assert!(!nan_close.is_valid());
    }
}
