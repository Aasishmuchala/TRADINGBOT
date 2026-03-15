import numpy as np
from sklearn.mixture import GaussianMixture
from sklearn.metrics import silhouette_score
import structlog

logger = structlog.get_logger()

REGIME_NAMES = ["low_vol", "ranging", "trending", "high_vol"]

def cluster_regimes(features: np.ndarray, feature_names: list[str]) -> tuple[np.ndarray, dict]:
    """
    Run GMM clustering on feature matrix. Returns (labels, metadata).
    
    Forces k=4 for production stability.
    Tests k=3,4,5 and logs BIC scores.
    Maps clusters deterministically: sort by volatility, then autocorrelation.
    """
    # Test k=3,4,5 for BIC comparison
    bic_scores = {}
    for k in [3, 4, 5]:
        gmm = GaussianMixture(n_components=k, covariance_type="full", random_state=42, n_init=5)
        gmm.fit(features)
        bic_scores[k] = gmm.bic(features)
    
    optimal_k = min(bic_scores, key=bic_scores.get)
    logger.info("gmm_bic_scores", scores=bic_scores, optimal_k=optimal_k)
    
    if optimal_k != 4:
        logger.warning("gmm_optimal_k_not_4", optimal_k=optimal_k, forcing_k=4)
    
    # Force k=4 for production
    gmm = GaussianMixture(n_components=4, covariance_type="full", random_state=42, n_init=10)
    gmm.fit(features)
    labels = gmm.predict(features)
    probs = gmm.predict_proba(features)
    
    # Compute silhouette score
    sil_score = silhouette_score(features, labels) if len(set(labels)) > 1 else 0.0
    if sil_score < 0.3:
        logger.warning("low_silhouette_score", score=sil_score)
    
    # Deterministic cluster-to-regime mapping
    # 1. Find volatility feature index
    vol_idx = None
    autocorr_idx = None
    for i, name in enumerate(feature_names):
        if "realized_vol" in name:
            vol_idx = i
        if "ema_spread" in name or "autocorr" in name:
            autocorr_idx = i
    
    if vol_idx is None:
        vol_idx = 0  # fallback: use first feature
    if autocorr_idx is None:
        autocorr_idx = 1  # fallback: use second feature
    
    # 2. Sort clusters by centroid volatility
    centroids = gmm.means_
    cluster_vol = [(i, centroids[i][vol_idx]) for i in range(4)]
    cluster_vol.sort(key=lambda x: x[1])
    
    # lowest vol -> low_vol, highest vol -> high_vol
    mapping = {}
    mapping[cluster_vol[0][0]] = "low_vol"
    mapping[cluster_vol[3][0]] = "high_vol"
    
    # Of remaining 2: highest autocorrelation -> trending, other -> ranging
    remaining = [cluster_vol[1], cluster_vol[2]]
    remaining.sort(key=lambda x: centroids[x[0]][autocorr_idx], reverse=True)
    mapping[remaining[0][0]] = "trending"
    mapping[remaining[1][0]] = "ranging"
    
    # Remap labels
    mapped_labels = np.array([REGIME_NAMES.index(mapping[l]) for l in labels])
    
    metadata = {
        "bic_scores": bic_scores,
        "optimal_k": optimal_k,
        "silhouette_score": sil_score,
        "cluster_mapping": mapping,
        "centroids": centroids.tolist(),
    }
    
    return mapped_labels, metadata
