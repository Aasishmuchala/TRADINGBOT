from abc import ABC, abstractmethod
from enum import Enum
from typing import Optional
from core.models import Signal, StrategySignal, FeatureSnapshot, FillReport, Regime

class StrategyBase(ABC):
    """Base class for all trading strategies."""
    
    name: str = "unnamed"
    regimes: list[str] = []  # which regimes this strategy activates in
    latency_budget_ms: int = 5000  # max acceptable latency
    min_confidence: float = 0.50  # minimum regime confidence to activate
    paper_mode_days: int = 14  # days in paper mode before going live
    timeframe: str = "1h"  # primary timeframe
    
    def __init__(self):
        self._trade_count = 0
        self._wins = 0
        self._losses = 0
        self._total_profit = 0.0
        self._total_loss = 0.0
        self._is_enabled = True
        self._is_paper = True
        self._sharpe_7d = 0.0
        self._sharpe_30d = 0.0
        self._pnl_history: list[float] = []
    
    @abstractmethod
    def on_features(self, features: dict, regime: str, confidence: float) -> Optional[StrategySignal]:
        """
        Process a feature snapshot and return a signal, or None.
        Called on every feature update matching this strategy's timeframe.
        """
        pass
    
    def on_fill(self, fill: FillReport):
        """Called when an order from this strategy is filled. Update stats."""
        self._trade_count += 1
        pnl = (fill.fill_price - fill.fill_price) * fill.size  # simplified, real P&L computed by ledger
        self._pnl_history.append(pnl)
    
    def health(self) -> dict:
        """Return strategy health metrics."""
        return {
            "name": self.name,
            "sharpe_7d": self._sharpe_7d,
            "sharpe_30d": self._sharpe_30d,
            "win_rate": self._wins / max(self._trade_count, 1),
            "total_trades": self._trade_count,
            "avg_profit": self._total_profit / max(self._wins, 1),
            "avg_loss": self._total_loss / max(self._losses, 1),
            "is_enabled": self._is_enabled,
            "is_paper": self._is_paper,
        }
    
    @property
    def is_active(self) -> bool:
        return self._is_enabled
    
    def disable(self):
        self._is_enabled = False
    
    def enable(self):
        self._is_enabled = True
