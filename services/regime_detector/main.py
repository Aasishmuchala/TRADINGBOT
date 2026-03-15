import asyncio
import time
import numpy as np
import structlog
from config.settings import Settings
from config.assets import TRACKED_PAIRS
from core.redis_client import RedisClient
from core.heartbeat import HeartbeatMixin
from services.regime_detector.ensemble import RegimeEnsemble
from services.regime_detector.health_monitor import ModelHealthMonitor

logger = structlog.get_logger()

class RegimeDetectorService(HeartbeatMixin):
    service_name = "regime-detector"
    
    def __init__(self):
        self.settings = Settings()
        self.redis = RedisClient(self.settings)
        super().__init__(self.redis)
        self.ensemble = RegimeEnsemble()
        self.health_monitor = ModelHealthMonitor()
        self._model_loaded = False
        self._detection_interval = 30  # seconds
    
    async def _load_model(self):
        """Load latest model from disk, or start with untrained state."""
        import os
        model_dir = "/app/models"
        if os.path.exists(f"{model_dir}/latest.pkl"):
            self.ensemble.load(f"{model_dir}/latest.pkl")
            self._model_loaded = True
            logger.info("model_loaded", version=self.ensemble.version)
        else:
            logger.warning("no_model_found", msg="Will wait for retrainer to produce first model")
    
    async def _collect_features(self) -> dict:
        """Collect latest features from Redis for all assets."""
        all_features = {}
        for symbol in TRACKED_PAIRS:
            features = await self.redis.get_features("1h", symbol)
            if features:
                all_features[symbol] = features
        return all_features
    
    def _build_feature_vector(self, all_features: dict) -> np.ndarray:
        """Build aggregated feature vector from all assets."""
        if not all_features:
            return np.array([])
        
        # Aggregate: take mean of indicators across all tracked assets
        indicator_keys = [
            "adx", "rsi", "atr", "bb_width", "macd_histogram",
            "roc_10", "realized_vol_20", "realized_vol_60",
            "ob_imbalance", "ema_spread_9_21"
        ]
        
        values = []
        for key in indicator_keys:
            asset_values = []
            for symbol, features in all_features.items():
                val = features.get(key)
                if val is not None:
                    try:
                        asset_values.append(float(val))
                    except (ValueError, TypeError):
                        pass
            values.append(np.mean(asset_values) if asset_values else 0.0)
        
        return np.array(values)
    
    async def _detect_regime(self):
        """Run regime detection loop every 30 seconds."""
        while True:
            try:
                if not self._model_loaded:
                    await asyncio.sleep(10)
                    await self._load_model()
                    continue
                
                features = await self._collect_features()
                if not features:
                    logger.debug("no_features_available")
                    await asyncio.sleep(self._detection_interval)
                    continue
                
                feature_vector = self._build_feature_vector(features)
                if len(feature_vector) == 0:
                    await asyncio.sleep(self._detection_interval)
                    continue
                
                # Predict regime
                result = self.ensemble.predict(feature_vector)
                
                # Record confidence for health monitoring
                self.health_monitor.record_confidence(result["confidence"])
                
                # Publish regime signal
                await self.redis.publish("regime_signal", {
                    "regime": result["regime"],
                    "confidence": result["confidence"],
                    "probabilities": result["probabilities"],
                    "model_agreement": result["model_agreement"],
                    "model_version": self.ensemble.version,
                    "timestamp": time.time(),
                })
                
                logger.info("regime_detected",
                    regime=result["regime"],
                    confidence=f"{result['confidence']:.3f}",
                    agreement=f"{result['model_agreement']:.1%}",
                )
                
            except Exception as e:
                logger.error("regime_detection_error", error=str(e))
            
            await asyncio.sleep(self._detection_interval)
    
    async def start(self):
        await self.redis.connect()
        await self.start_heartbeat()
        await self._load_model()
        logger.info("regime_detector_starting")
        await self._detect_regime()
    
    async def stop(self):
        await self.stop_heartbeat()
        await self.redis.close()

async def main():
    service = RegimeDetectorService()
    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()

if __name__ == "__main__":
    asyncio.run(main())
