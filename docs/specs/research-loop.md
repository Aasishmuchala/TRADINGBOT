# Research Loop V0

Current research capabilities:

- Deterministic replay of a decision frame through strategy selection and confluence scoring.
- Backtest summary over one or more replay frames.
- Bounded learning proposals based on grouped trade outcomes.
- Replay frames now carry a richer confluence input set covering indicator consensus, structure, volatility fit, order flow, confirmation layers, and news sentiment.

Current limits:

- Learning only proposes bounded weight and threshold shifts.
- Learning does not touch hard risk rules, leverage limits, or mode policy.
- Replay currently operates on local synthetic frames, not imported historical datasets yet.
- News ingestion is wired through a local headline file, not an external streaming/news API yet.
- Signal-model mutation and daily promotion are not yet fully automated.
