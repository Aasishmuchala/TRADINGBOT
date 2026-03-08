# Sthyra Quant OS

Initial implementation scope:

- Local-only runtime on macOS.
- Binance-only execution target for V1.
- Rust workspace for safety-critical engines.
- Tauri desktop shell for local operator workflows, with release packaging still being hardened.
- Fail-closed risk and mode boundaries encoded before live trading logic.
- Mode authority, market-data health, strategy selection, confluence scoring, and hard risk gate now exist as local compileable crates.
