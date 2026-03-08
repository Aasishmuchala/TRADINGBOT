# Genetic Indicators

The daily research cycle now evolves a second layer of indicator-specific genomes in addition to the existing signal models.

Each day the supervisor:

1. Loads the prior research report from `.sthyra/model-registry.json` when available.
2. Seeds a fresh indicator population from the top retained genomes or from the built-in baseline genomes.
3. Mutates that population into a new generation.
4. Scores each genome against replay frames built from live and optional historical candles.
5. Prunes weak genomes automatically by dropping low-fitness candidates from the retained leaderboard.
6. Promotes the best surviving genome into runtime confluence scoring for the day.

Pruning logic is intentionally conservative:

- Unprofitable genomes lose fitness quickly.
- Unstable genomes are penalized through robustness scoring.
- Overly complex genomes are penalized through a latency proxy so slow or noisy indicator stacks are less likely to survive.

Runtime effect:

- The promoted signal model still adjusts confluence.
- The promoted indicator genome now adds a second overlay using normalized indicator inputs such as RSI bias, MACD bias, breakout bias, momentum bias, VWAP reversion bias, and EMA trend bias.

Operator rule of thumb:

- If a genome stops helping, the next daily cycle will naturally demote it because it falls out of the retained leaderboard.
- If a genome keeps scoring well, it remains promotable and continues influencing runtime decisions.
