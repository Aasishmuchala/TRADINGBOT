import numpy as np
from typing import Optional

def ema(values: np.ndarray, period: int) -> np.ndarray:
    """Exponential Moving Average."""
    alpha = 2.0 / (period + 1)
    result = np.zeros_like(values)
    result[0] = values[0]
    for i in range(1, len(values)):
        result[i] = alpha * values[i] + (1 - alpha) * result[i-1]
    return result

def sma(values: np.ndarray, period: int) -> np.ndarray:
    """Simple Moving Average."""
    result = np.full_like(values, np.nan)
    for i in range(period - 1, len(values)):
        result[i] = np.mean(values[i - period + 1:i + 1])
    return result

def rsi(closes: np.ndarray, period: int = 14) -> float:
    """Relative Strength Index (latest value)."""
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes[-(period+1):])
    gains = np.where(deltas > 0, deltas, 0)
    losses = np.where(deltas < 0, -deltas, 0)
    avg_gain = np.mean(gains)
    avg_loss = np.mean(losses)
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))

def atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> float:
    """Average True Range (latest value)."""
    if len(closes) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
        trs.append(tr)
    return np.mean(trs[-period:])
def adx(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> float:
    """Average Directional Index (latest value)."""
    if len(closes) < period * 2:
        return 0.0
    
    plus_dm = np.zeros(len(highs))
    minus_dm = np.zeros(len(highs))
    tr_arr = np.zeros(len(highs))
    
    for i in range(1, len(highs)):
        up = highs[i] - highs[i-1]
        down = lows[i-1] - lows[i]
        plus_dm[i] = up if (up > down and up > 0) else 0
        minus_dm[i] = down if (down > up and down > 0) else 0
        tr_arr[i] = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
    
    atr_vals = ema(tr_arr[1:], period)
    plus_di = 100 * ema(plus_dm[1:], period) / np.where(atr_vals > 0, atr_vals, 1)
    minus_di = 100 * ema(minus_dm[1:], period) / np.where(atr_vals > 0, atr_vals, 1)
    
    dx = 100 * np.abs(plus_di - minus_di) / np.where((plus_di + minus_di) > 0, plus_di + minus_di, 1)
    adx_val = ema(dx, period)
    return float(adx_val[-1]) if len(adx_val) > 0 else 0.0

def bollinger_bands(closes: np.ndarray, period: int = 20, std_dev: float = 2.0) -> dict:
    """Bollinger Bands — returns dict with upper, middle, lower, width."""
    if len(closes) < period:
        mid = closes[-1] if len(closes) > 0 else 0
        return {"upper": mid, "middle": mid, "lower": mid, "width": 0.0}
    recent = closes[-period:]
    mid = np.mean(recent)
    std = np.std(recent)
    return {
        "upper": mid + std_dev * std,
        "middle": mid,
        "lower": mid - std_dev * std,
        "width": (2 * std_dev * std) / mid if mid > 0 else 0.0,
    }

def macd(closes: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    """MACD — returns dict with macd, signal, histogram."""
    if len(closes) < slow + signal:
        return {"macd": 0.0, "signal": 0.0, "histogram": 0.0}
    fast_ema = ema(closes, fast)
    slow_ema = ema(closes, slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, signal)
    return {
        "macd": float(macd_line[-1]),
        "signal": float(signal_line[-1]),
        "histogram": float(macd_line[-1] - signal_line[-1]),
    }
def vwap(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, volumes: np.ndarray) -> float:
    """Volume Weighted Average Price."""
    typical = (highs + lows + closes) / 3
    total_volume = np.sum(volumes)
    if total_volume == 0:
        return float(closes[-1]) if len(closes) > 0 else 0.0
    return float(np.sum(typical * volumes) / total_volume)

def rate_of_change(closes: np.ndarray, period: int = 10) -> float:
    """Rate of Change (percentage)."""
    if len(closes) < period + 1:
        return 0.0
    return (closes[-1] - closes[-period-1]) / closes[-period-1] * 100

def realized_volatility(closes: np.ndarray, period: int = 20) -> float:
    """Annualized realized volatility from log returns."""
    if len(closes) < period + 1:
        return 0.0
    log_returns = np.diff(np.log(closes[-(period+1):]))
    return float(np.std(log_returns) * np.sqrt(365 * 24 * 60))  # annualized for 1m data

def order_book_imbalance(bids: list, asks: list) -> float:
    """Bid/ask volume imbalance. Range: -1 (all asks) to +1 (all bids)."""
    bid_vol = sum(b[1] for b in bids) if bids else 0
    ask_vol = sum(a[1] for a in asks) if asks else 0
    total = bid_vol + ask_vol
    if total == 0:
        return 0.0
    return (bid_vol - ask_vol) / total
def compute_all_indicators(closes: np.ndarray, highs: np.ndarray, lows: np.ndarray, 
                           volumes: np.ndarray, ob_bids: list = None, ob_asks: list = None) -> dict:
    """Compute all indicators for a single asset/timeframe. Returns flat dict."""
    indicators = {}
    
    # Trend
    if len(closes) >= 55:
        ema9 = ema(closes, 9)
        ema21 = ema(closes, 21)
        ema55 = ema(closes, 55)
        indicators["ema_9"] = float(ema9[-1])
        indicators["ema_21"] = float(ema21[-1])
        indicators["ema_55"] = float(ema55[-1])
        indicators["ema_spread_9_21"] = float(ema9[-1] - ema21[-1])
        indicators["ema_spread_21_55"] = float(ema21[-1] - ema55[-1])
    
    indicators["adx"] = adx(highs, lows, closes)
    indicators["rsi"] = rsi(closes)
    indicators["atr"] = atr(highs, lows, closes)
    
    # Bollinger Bands
    bb = bollinger_bands(closes)
    indicators["bb_upper"] = bb["upper"]
    indicators["bb_lower"] = bb["lower"]
    indicators["bb_width"] = bb["width"]
    
    # MACD
    m = macd(closes)
    indicators["macd"] = m["macd"]
    indicators["macd_signal"] = m["signal"]
    indicators["macd_histogram"] = m["histogram"]
    
    # VWAP
    indicators["vwap"] = vwap(highs, lows, closes, volumes)
    
    # Momentum
    indicators["roc_10"] = rate_of_change(closes, 10)
    indicators["roc_20"] = rate_of_change(closes, 20)
    
    # Volatility
    indicators["realized_vol_20"] = realized_volatility(closes, 20)
    indicators["realized_vol_60"] = realized_volatility(closes, 60)
    
    # Order book
    if ob_bids and ob_asks:
        indicators["ob_imbalance"] = order_book_imbalance(ob_bids, ob_asks)
        indicators["bid_ask_spread"] = (ob_asks[0][0] - ob_bids[0][0]) / ob_bids[0][0] if ob_bids[0][0] > 0 else 0
    
    return indicators
