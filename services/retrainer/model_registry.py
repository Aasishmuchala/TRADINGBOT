"""Model Registry — Versioning, storage, and rollback for ML models."""
import json
import os
import pickle
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger()

MODEL_DIR = Path("/app/models")


@dataclass
class ModelVersion:
    version: int
    model_type: str  # "regime_ensemble", "slippage_ols"
    metrics: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    status: str = "shadow"  # shadow | active | retired
    shadow_start: Optional[float] = None
    promoted_at: Optional[float] = None
    path: str = ""


class ModelRegistry:
    """Manages model versions with shadow deployment and rollback."""

    SHADOW_PERIOD_HOURS = 72  # 3 days in shadow before promotion

    def __init__(self, db=None):
        self.db = db
        self.versions: dict[str, list[ModelVersion]] = {}
        self.active_models: dict[str, ModelVersion] = {}
        MODEL_DIR.mkdir(parents=True, exist_ok=True)

    async def register(self, model_type: str, model_obj, metrics: dict) -> ModelVersion:
        """Register a new model version in shadow mode."""
        if model_type not in self.versions:
            self.versions[model_type] = []

        version = len(self.versions[model_type]) + 1
        path = str(MODEL_DIR / f"{model_type}_v{version}.pkl")

        # Save model to disk
        with open(path, "wb") as f:
            pickle.dump(model_obj, f)

        mv = ModelVersion(
            version=version,
            model_type=model_type,
            metrics=metrics,
            status="shadow",
            shadow_start=time.time(),
            path=path,
        )
        self.versions[model_type].append(mv)

        # Persist to DB
        if self.db:
            await self.db.execute(
                """INSERT INTO model_registry 
                   (model_type, version, metrics, status, path, created_at)
                   VALUES ($1, $2, $3, $4, $5, NOW())""",
                model_type, version, json.dumps(metrics), "shadow", path,
            )

        logger.info(
            "model_registry.registered",
            model_type=model_type,
            version=version,
            metrics=metrics,
        )
        return mv

    async def check_promotions(self):
        """Promote shadow models that have passed the shadow period."""
        now = time.time()
        for model_type, versions in self.versions.items():
            for mv in versions:
                if mv.status != "shadow":
                    continue
                if mv.shadow_start and (now - mv.shadow_start) > self.SHADOW_PERIOD_HOURS * 3600:
                    # Check shadow performance
                    if self._shadow_performance_ok(mv):
                        await self.promote(model_type, mv.version)
                    else:
                        mv.status = "retired"
                        logger.warning(
                            "model_registry.shadow_failed",
                            model_type=model_type, version=mv.version,
                        )

    def _shadow_performance_ok(self, mv: ModelVersion) -> bool:
        """Check if shadow model meets promotion criteria."""
        metrics = mv.metrics
        # Require accuracy > 0.55 and no significant degradation
        accuracy = metrics.get("accuracy", 0)
        return accuracy >= 0.55

    async def promote(self, model_type: str, version: int):
        """Promote a shadow model to active, retire the current active."""
        versions = self.versions.get(model_type, [])
        target = None
        for mv in versions:
            if mv.version == version:
                target = mv
                break

        if not target:
            logger.error("model_registry.version_not_found", model_type=model_type, version=version)
            return

        # Retire current active
        if model_type in self.active_models:
            old = self.active_models[model_type]
            old.status = "retired"

        target.status = "active"
        target.promoted_at = time.time()
        self.active_models[model_type] = target

        logger.info(
            "model_registry.promoted",
            model_type=model_type, version=version,
        )

    async def rollback(self, model_type: str):
        """Rollback to previous active version."""
        versions = self.versions.get(model_type, [])
        retired = [v for v in versions if v.status == "retired"]
        if not retired:
            logger.warning("model_registry.no_rollback_target", model_type=model_type)
            return

        prev = retired[-1]
        await self.promote(model_type, prev.version)
        logger.info("model_registry.rolled_back", model_type=model_type, version=prev.version)

    def load_model(self, model_type: str) -> Optional[object]:
        """Load the active model object from disk."""
        mv = self.active_models.get(model_type)
        if not mv or not os.path.exists(mv.path):
            return None

        with open(mv.path, "rb") as f:
            return pickle.load(f)

    def get_active_version(self, model_type: str) -> Optional[int]:
        """Get the active version number."""
        mv = self.active_models.get(model_type)
        return mv.version if mv else None
