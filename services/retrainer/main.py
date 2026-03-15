"""Retrainer Service — Scheduled model retraining pipeline."""
import asyncio
import time
from typing import Optional

import numpy as np
import structlog

from config.settings import Settings
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient
from core.db import Database
from services.retrainer.model_registry import ModelRegistry
from services.regime_detector.ensemble import RegimeEnsemble
from services.regime_detector.clustering import cluster_regimes
from services.regime_detector.health_monitor import ModelHealthMonitor

logger = structlog.get_logger()


class RetrainerService(HeartbeatMixin):
    """Periodically retrains regime detection model from accumulated data."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.db: Optional[Database] = None
        self.service_name = "retrainer"
        self.registry: Optional[ModelRegistry] = None
        self.health_monitor = ModelHealthMonitor()

        # Retraining schedule
        self.retrain_interval_hours = 24  # Daily retrain
        self.psi_check_interval_hours = 6  # Check drift every 6 hours
        self.min_training_samples = 1000

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()
        self.db = Database(self.settings.database_url)
        await self.db.connect()
        self.registry = ModelRegistry(db=self.db)

        logger.info("retrainer.started")
        await asyncio.gather(
            self._retrain_loop(),
            self._psi_check_loop(),
            self._promotion_check_loop(),
            self.run_heartbeat(self.redis),
        )

    async def _retrain_loop(self):
        """Scheduled retraining every 24 hours."""
        while True:
            await asyncio.sleep(self.retrain_interval_hours * 3600)
            await self._retrain()

    async def _retrain(self):
        """Execute full retraining pipeline."""
        logger.info("retrainer.starting_retrain")
        try:
            # 1. Fetch training data from TimescaleDB
            features, labels = await self._fetch_training_data()
            if features is None or len(features) < self.min_training_samples:
                logger.warning(
                    "retrainer.insufficient_data",
                    samples=len(features) if features is not None else 0,
                )
                return

            # 2. Generate regime labels via clustering
            regime_labels, label_map = cluster_regimes(features)
            if regime_labels is None:
                logger.error("retrainer.clustering_failed")
                return

            # 3. Train new ensemble
            ensemble = RegimeEnsemble()
            metrics = ensemble.train(features, regime_labels)

            logger.info("retrainer.training_complete", metrics=metrics)

            # 4. Register in shadow mode
            await self.registry.register(
                model_type="regime_ensemble",
                model_obj=ensemble,
                metrics=metrics,
            )

            # 5. Publish retrain event
            await self.redis.publish("alerts", {
                "type": "model_retrained",
                "model": "regime_ensemble",
                "metrics": metrics,
                "samples": len(features),
                "timestamp": time.time(),
            })

        except Exception as e:
            logger.error("retrainer.retrain_failed", error=str(e))

    async def _fetch_training_data(self):
        """Fetch feature snapshots from TimescaleDB for training."""
        try:
            rows = await self.db.fetch(
                """SELECT features
                   FROM feature_snapshots
                   WHERE timestamp > NOW() - INTERVAL '30 days'
                   ORDER BY timestamp ASC"""
            )
            if not rows:
                return None, None

            import json
            features_list = []
            for row in rows:
                try:
                    feat_dict = json.loads(row["features"]) if isinstance(row["features"], str) else row["features"]
                    # Extract numerical features
                    feature_vec = [
                        float(feat_dict.get("rsi", 50)),
                        float(feat_dict.get("atr", 0)),
                        float(feat_dict.get("adx", 0)),
                        float(feat_dict.get("realized_vol", 0)),
                        float(feat_dict.get("bb_width", 0)),
                        float(feat_dict.get("macd_histogram", 0)),
                        float(feat_dict.get("roc", 0)),
                        float(feat_dict.get("volume", 0)),
                        float(feat_dict.get("ob_imbalance", 0)),
                    ]
                    features_list.append(feature_vec)
                except (KeyError, ValueError, TypeError):
                    continue

            if not features_list:
                return None, None

            return np.array(features_list), None  # Labels generated by clustering

        except Exception as e:
            logger.error("retrainer.fetch_data_error", error=str(e))
            return None, None

    async def _psi_check_loop(self):
        """Check for distribution shift every 6 hours."""
        while True:
            await asyncio.sleep(self.psi_check_interval_hours * 3600)
            try:
                # Get recent features
                features, _ = await self._fetch_training_data()
                if features is None or len(features) < 100:
                    continue

                # Split into reference and current
                split_idx = len(features) * 2 // 3
                reference = features[:split_idx]
                current = features[split_idx:]

                # Check PSI for each feature
                alerts = []
                feature_names = ["rsi", "atr", "adx", "realized_vol", "bb_width",
                               "macd_histogram", "roc", "volume", "ob_imbalance"]

                for i, name in enumerate(feature_names):
                    psi = self.health_monitor.compute_psi(reference[:, i], current[:, i])
                    status = self.health_monitor.psi_status(psi)
                    if status != "green":
                        alerts.append({"feature": name, "psi": round(psi, 4), "status": status})

                if alerts:
                    logger.warning("retrainer.distribution_shift", alerts=alerts)

                    # If any red PSI, trigger immediate retrain
                    red_alerts = [a for a in alerts if a["status"] == "red"]
                    if red_alerts:
                        logger.warning("retrainer.emergency_retrain_triggered")
                        await self._retrain()

                    await self.redis.publish("alerts", {
                        "type": "distribution_shift",
                        "alerts": alerts,
                        "timestamp": time.time(),
                    })

            except Exception as e:
                logger.error("retrainer.psi_check_error", error=str(e))

    async def _promotion_check_loop(self):
        """Check if shadow models are ready for promotion."""
        while True:
            await asyncio.sleep(3600)  # Check hourly
            try:
                if self.registry:
                    await self.registry.check_promotions()
            except Exception as e:
                logger.error("retrainer.promotion_check_error", error=str(e))


async def main():
    settings = Settings()
    service = RetrainerService(settings)
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())
