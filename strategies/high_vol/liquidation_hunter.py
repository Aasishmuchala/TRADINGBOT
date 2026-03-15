"""Liquidation Hunter — Profit from cascading liquidations in volatile markets."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class LiquidationHunter(StrategyBase):
    name = "liquidation_hunter"
    regimes = ["high_vol"]
    timeframe = "1m"
    min_confidence = 0.6
    latency_budget_ms = 200
    paper_mode_days = 5

    def __init__(self):
        self.price_velocity = {}
        self.position_state = {}
        self.prev_prices = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        volume = features.get("volume", 0)
        ob_imbalance = features.get("ob_imbalance")
        if price <= 0: return None

        prev = self.prev_prices.get(asset)
        self.prev_prices[asset] = price
        if prev is None or prev <= 0: return None

        velocity = (price - prev) / prev
        if asset not in self.price_velocity: self.price_velocity[asset] = []
        self.price_velocity[asset].append(velocity)
        if len(self.price_velocity[asset]) > 10:
            self.price_velocity[asset] = self.price_velocity[asset][-10:]
        if len(self.price_velocity[asset]) < 3: return None

        recent_vel = sum(self.price_velocity[asset][-3:])
        state = self.position_state.get(asset, "flat")

        # Detect potential liquidation cascade (sharp move + volume spike)
        if recent_vel < -0.02 and (ob_imbalance is None or ob_imbalance < -0.2) and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.7, price=price,
                metadata={"velocity": round(recent_vel, 4), "trigger": "long_liquidation_bounce"})
        if recent_vel > 0.02 and (ob_imbalance is None or ob_imbalance > 0.2) and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.7, price=price,
                metadata={"velocity": round(recent_vel, 4), "trigger": "short_liquidation_fade"})

        # Quick exit
        if state == "long" and recent_vel > 0.005:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "bounce_captured"})
        if state == "short" and recent_vel < -0.005:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "fade_captured"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.price_velocity)}
