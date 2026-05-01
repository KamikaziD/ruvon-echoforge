"""
train_signal_model.py
=====================
Trains a small MLP that predicts short-term BTC price direction from
market microstructure features, then exports to ONNX for inference
inside the browser's inference_worker.js (via onnxruntime-web).

Input features (8, all normalised to roughly [-1, 1]):
  0  momentum      — (ema_fast - ema_slow) / ema_slow
  1  z_score       — (price - mean_30) / std_30
  2  vwap_dev      — (vwap - price) / vwap  (positive = price below fair value)
  3  imbalance     — (bid_qty - ask_qty) / (bid_qty + ask_qty)
  4  vol_ratio     — (buy_vol - sell_vol) / (buy_vol + sell_vol)
  5  spread_norm   — spread / price  (log-scaled)
  6  ema_fast_dev  — (ema_fast - price) / price
  7  ema_slow_dev  — (ema_slow - price) / price

Output (1):
  P(price up in next N ticks) — sigmoid probability.
  The inference worker converts this to a signed gross_delta.

Usage:
    cd packages/ruvon-echoforge/browser/models
    python train_signal_model.py
"""

import pathlib, struct, numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
import skl2onnx
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

HERE = pathlib.Path(__file__).parent
OUT  = HERE / "signal_model.onnx"

np.random.seed(0)
N = 80_000

# ── Simulate realistic microstructure feature distributions ─────────────────
momentum     = np.random.laplace(0, 0.0015, N)          # fat-tailed momentum
z_score      = np.random.normal(0, 1.2, N)
vwap_dev     = np.random.normal(0, 0.0015, N)
imbalance    = np.random.uniform(-1, 1, N)
vol_ratio    = np.clip(np.random.normal(0, 0.3, N), -1, 1)
spread_norm  = np.random.exponential(0.00015, N)         # always positive
ema_fast_dev = np.random.normal(0, 0.001, N)
ema_slow_dev = np.random.normal(0, 0.0015, N)

X = np.column_stack([
    momentum, z_score, vwap_dev, imbalance,
    vol_ratio, spread_norm, ema_fast_dev, ema_slow_dev,
])

# ── Generate labels using known market microstructure relationships ──────────
# Each term: sign × tanh(feature × sensitivity)
signal = (
     2.5 * np.tanh(momentum   *  600) +   # strong momentum predictor
    -1.2 * np.tanh(z_score    *  0.7) +   # mean reversion (overbought → sell)
     0.8 * np.tanh(vwap_dev   *  400) +   # buy when price below VWAP
     0.7 * np.tanh(imbalance  *  3.0) +   # order book pressure
     0.6 * np.tanh(vol_ratio  *  3.0) +   # informed volume flow
    -0.3 * spread_norm         * 1000  +   # wide spread → lower confidence
     0.5 * np.tanh(ema_fast_dev * 800) +  # price vs fast EMA
     0.3 * np.tanh(ema_slow_dev * 600)    # price vs slow EMA
)
noise = np.random.normal(0, 0.9, N)       # market noise (~40% irreducible)
y = (signal + noise > 0).astype(int)

print(f"Generated {N} samples — up: {y.mean():.1%}  down: {(1-y.mean()):.1%}")

# ── Train ───────────────────────────────────────────────────────────────────
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.15, random_state=0)

pipe = Pipeline([
    ("scaler", StandardScaler()),
    ("mlp",    MLPClassifier(
        hidden_layer_sizes=(32, 16),
        activation="relu",
        solver="adam",
        max_iter=400,
        random_state=0,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=15,
    )),
])
pipe.fit(X_train, y_train)

acc = pipe.score(X_test, y_test)
print(f"Test accuracy: {acc:.3f}  (chance = 0.500)")

# ── Export to ONNX ───────────────────────────────────────────────────────────
initial_type = [("float_input", FloatTensorType([None, 8]))]
onnx_model   = convert_sklearn(pipe, initial_types=initial_type, target_opset=17,
                                options={"zipmap": False})

OUT.write_bytes(onnx_model.SerializeToString())
size_kb = OUT.stat().st_size / 1024
print(f"Exported → {OUT}  ({size_kb:.1f} KB)")
