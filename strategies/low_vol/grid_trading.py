"""Grid Trading — Place orders at fixed intervals in low-vol ranges."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class GridTrading(StrategyBase):
    name = "grid_trading"
    regimes = ["low_vol"]
    timeframe = "5m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 5

    def __init__(self):
        self.grid_size_pct = 0.003  # 0.3% grid spacing
        self.grid_levels = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        if price <= 0: return None

        if asset not in self.grid_levels:
            self.grid_levels[asset] = {"center": price, "last_level": 0}

        grid = self.grid_levels[asset]
        center = grid["center"]
        level = round((price - center) / (center * self.grid_size_pct))

        if level == grid["last_level"]: return None

        state = self.position_state.get(asset, "flat")
        if level < grid["last_level"]:
            grid["last_level"] = level
            if state != "long":
                self.position_state[asset] = "long"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=0.6, price=price,
                    metadata={"grid_level": level, "center": round(center, 4)})
        elif level > grid["last_level"]:
            grid["last_level"] = level
            if state != "short":
                self.position_state[asset] = "short"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=0.6, price=price,
                    metadata={"grid_level": level, "center": round(center, 4)})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "grids": len(self.grid_levels)}
