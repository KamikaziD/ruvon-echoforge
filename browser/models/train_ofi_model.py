"""
train_ofi_model.py — Bootstrap OFI (Order Flow Imbalance) classifier.

Generates synthetic L2 delta sequences labelled with 200ms forward price
direction, trains a lightweight MLP, and exports ofi_model.onnx to this
directory for hot-loading by inference_worker.js.

Features (12):
  [delta_bid_L1..L5, delta_ask_L1..L5, vpin, spread_norm]

Labels:
  1 = price moved up within 200ms window, 0 = down or flat

Run:
  python train_ofi_model.py [--samples 5000] [--out ofi_model.onnx]

Requirements:
  pip install scikit-learn skl2onnx numpy
"""

import argparse
import pathlib

import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
import skl2onnx
from skl2onnx.common.data_types import FloatTensorType


N_FEATURES = 12


def _generate_synthetic(n_samples: int, seed: int = 42) -> tuple[np.ndarray, np.ndarray]:
    """
    Synthetic OFI data with a planted signal:
      - Strong positive bid delta at L1 (large buyer arriving) → price up
      - Strong negative bid delta at L1 (large seller) → price down
      - Noise on other levels

    Not a faithful market sim — just enough structure for the model to learn
    that bid-side depth additions are bullish and removals are bearish.
    """
    rng = np.random.default_rng(seed)

    X = rng.standard_normal((n_samples, N_FEATURES)).astype(np.float32)
    X *= 0.3  # scale down noise

    # Plant the directional signal in L1 bid delta (feature 0) and L1 ask delta (feature 5)
    direction = rng.choice([-1, 1], size=n_samples)
    X[:, 0] += direction * (0.8 + rng.standard_normal(n_samples) * 0.2)  # bid L1 delta
    X[:, 5] -= direction * (0.6 + rng.standard_normal(n_samples) * 0.2)  # ask L1 delta (contra)

    # vpin (feature 10): higher when informed flow is active
    X[:, 10] = np.clip(rng.uniform(0, 1, n_samples), 0, 1).astype(np.float32)

    # spread_norm (feature 11): narrow spread → cleaner signal
    X[:, 11] = np.clip(rng.uniform(0, 1, n_samples), 0, 1).astype(np.float32)

    # Label: 1 if direction positive, else 0; add small label noise
    y = (direction > 0).astype(np.int32)
    flip_mask = rng.random(n_samples) < 0.12  # 12% label noise (realistic for 200ms horizon)
    y[flip_mask] = 1 - y[flip_mask]

    return X, y


def train_and_export(n_samples: int, out_path: pathlib.Path) -> None:
    print(f"Generating {n_samples} synthetic OFI samples…")
    X, y = _generate_synthetic(n_samples)

    print(f"Training MLP (32→16) on {len(X)} samples  pos_rate={y.mean():.3f}…")
    import warnings
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("mlp", MLPClassifier(
            hidden_layer_sizes=(32, 16),
            activation="relu",
            max_iter=300,
            random_state=42,
            early_stopping=True,
            validation_fraction=0.15,
            n_iter_no_change=15,
            verbose=False,
        )),
    ])
    pipeline.fit(X, y)

    # Quick accuracy estimate on held-out slice
    X_test, y_test = _generate_synthetic(1000, seed=99)
    acc = (pipeline.predict(X_test) == y_test).mean()
    print(f"Test accuracy (synthetic): {acc:.3f}")

    print(f"Exporting to {out_path}…")
    initial_type = [("float_input", FloatTensorType([None, N_FEATURES]))]
    onx = skl2onnx.convert_sklearn(
        pipeline,
        initial_types=initial_type,
        options={"zipmap": False},
    )
    out_path.write_bytes(onx.SerializeToString())
    print(f"Saved {out_path.stat().st_size / 1024:.1f} KB → {out_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train and export OFI ONNX model")
    parser.add_argument("--samples", type=int, default=5_000,
                        help="Number of synthetic training samples (default 5000)")
    parser.add_argument("--out", type=str, default="ofi_model.onnx",
                        help="Output ONNX file path")
    args = parser.parse_args()

    out_path = pathlib.Path(__file__).parent / args.out
    train_and_export(args.samples, out_path)
