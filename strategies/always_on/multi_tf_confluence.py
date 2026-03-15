"""Multi-Timeframe Confluence — Trade when multiple timeframes align."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class MultiTFConfluence(StrategyBase):
    name = "multi_tf_confluence"
    regimes = ["trending", "ranging", "high_vol", "low_vol"]
    timeframe = "15m"
    min_confidence = 0.6
    latency_budget_ms = 1000
    paper_mode_days = 5

    def __init__(self):
        self.tf_signals = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        rsi = features.get("rsi")
        ema_9 = features.get("ema_9")
        ema_21 = features.get("ema_21")
        macd_hist = features.get("macd_histogram")
        adx = features.get("adx")
        if price <= 0: return None

        # Score bullish/bearish confluence
        bull_score = 0
        bear_score = 0
        if ema_9 and ema_21:
            if ema_9 > ema_21: bull_score += 1
            else: bear_score += 1
        if rsi:
            if rsi > 55: bull_score += 1
            elif rsi < 45: bear_score += 1
        if macd_hist:
            if macd_hist > 0: bull_score += 1
            else: bear_score += 1
        if adx and adx > 25:
            if ema_9 and ema_21:
                if ema_9 > ema_21: bull_score += 1
                else: bear_score += 1

        state = self.position_state.get(asset, "flat")
        max_score = 4

        if bull_score >= 3 and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.9, 0.5 + bull_score / max_score * 0.4), price=price,
                metadata={"bull_score": bull_score, "bear_score": bear_score})
        if bear_score >= 3 and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.9, 0.5 + bear_score / max_score * 0.4), price=price,
                metadata={"bull_score": bull_score, "bear_score": bear_score})
        if state == "long" and bear_score >= 2:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "confluence_exit"})
        if state == "short" and bull_score >= 2:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "confluence_exit"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}
