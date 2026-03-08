# Strategy and Confluence V0

Current strategy-selection behavior:

- Uses regime plus confidence to suppress or allow strategy families.
- Blocks all strategies in no-trade and disordered regimes.
- Emits candidate diagnostics and suppression reasons.

Current confluence behavior:

- Scores candidates using regime confidence, higher-timeframe alignment, recent strategy performance, indicator consensus, market-structure score, volatility fit, order-flow score, confirmation layers, system-health modifier, news sentiment, spread penalty, liquidity penalty, and correlation penalty.
- Emits confidence score, expected value score, trade quality tier, size multiplier, and approve or reject or watch decision.

Adaptive market intelligence now includes:

- Candle-derived indicators: EMA trend alignment, RSI, ATR ratio, realized volatility, breakout strength, and volume confirmation.
- Market-structure inference: trend bias, breakout pressure, reversal pressure, support/resistance clarity, and volatility regime.
- Regime inference from the live signal stack instead of a fixed default regime.
- News and sentiment overlay from local headline ingestion under `.sthyra/news-headlines.txt`.

Strict risk-gate additions:

- Rejects no-trade and disordered regimes.
- Rejects risk-off news conditions.
- Rejects weak model confidence and non-positive expected value before live execution.

Planned additions:

- Funding penalty.
- Structure clarity factor.
- Symbol-specific preferences.
- Session-specific preferences.
- Automated external news ingestion.
- Daily signal-model mutation, replay ranking, and promotion workflow.
