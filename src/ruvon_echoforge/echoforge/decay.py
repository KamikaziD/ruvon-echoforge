"""Bayesian aliveness decay for EchoForge pattern memory."""

from dataclasses import dataclass, field
import time


@dataclass
class MarketEcho:
    pattern_id: str
    regime_tag: str = "LowVol"               # "LowVol" | "HighVol" | "Toxic"
    gross_delta_prediction: float = 0.0
    estimated_frictional_drag: float = 0.0
    net_aliveness: float = 0.5               # 0.0 (dead) – 1.0 (fully alive)
    execution_count: int = 0
    decay_rate: float = 0.1                  # α — Bayesian update velocity
    last_updated: int = field(default_factory=lambda: int(time.time() * 1000))

    # α multipliers — failed patterns decay faster
    DECAY_MULTIPLIER_WIN: float = 1.0
    DECAY_MULTIPLIER_LOSS: float = 7.0

    @property
    def net_alpha(self) -> float:
        return self.gross_delta_prediction - self.estimated_frictional_drag

    def update(self, outcome_score: float) -> "MarketEcho":
        """
        Apply one Bayesian update step.

        outcome_score: 1.0 = full win, 0.0 = neutral, -1.0 = full loss.
        Normalised to [0, 1] before blending.

        Formula: aliveness_{t+1} = aliveness_t × (1-α) + outcome_normalised × α
        Losses use α × DECAY_MULTIPLIER_LOSS so bad patterns die faster.
        """
        normalised = (outcome_score + 1.0) / 2.0  # [-1,1] → [0,1]
        effective_alpha = (
            self.decay_rate * self.DECAY_MULTIPLIER_LOSS
            if outcome_score < 0
            else self.decay_rate * self.DECAY_MULTIPLIER_WIN
        )
        effective_alpha = min(effective_alpha, 1.0)

        new_aliveness = self.net_aliveness * (1.0 - effective_alpha) + normalised * effective_alpha
        self.net_aliveness = max(0.0, min(1.0, new_aliveness))
        self.execution_count += 1
        self.last_updated = int(time.time() * 1000)
        return self

    def as_shared_dict(self, node_id: str = "") -> dict:
        """Privacy-safe gossip payload — no capital/key data."""
        return {
            "pattern_id": self.pattern_id,
            "net_aliveness": round(self.net_aliveness, 4),
            "regime_tag": self.regime_tag,
            "decay_rate": self.decay_rate,
            "timestamp": self.last_updated,
            "node_id": node_id,
        }

    def as_full_dict(self) -> dict:
        return {
            "pattern_id": self.pattern_id,
            "regime_tag": self.regime_tag,
            "gross_delta_prediction": self.gross_delta_prediction,
            "estimated_frictional_drag": self.estimated_frictional_drag,
            "net_aliveness": round(self.net_aliveness, 4),
            "net_alpha": round(self.net_alpha, 6),
            "execution_count": self.execution_count,
            "decay_rate": self.decay_rate,
            "last_updated": self.last_updated,
        }
