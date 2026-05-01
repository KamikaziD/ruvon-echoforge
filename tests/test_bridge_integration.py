"""
Integration test: browser node ↔ bridge ↔ dashboard WebSocket flow.

Covers the three legs end-to-end without any mocks:
  1. Browser (simulated) → bridge /api/v1/tick
  2. Bridge → dashboard /api/v1/metrics  (event relay)
  3. PHIC config POST → bridge → PHIC WebSocket push

Uses FastAPI's built-in TestClient. Dashboard WebSocket contexts are always
kept on the main thread; background threads only read into a queue so the
main thread can poll with a timeout — this avoids the hang caused by
receive_text() blocking past the TestClient teardown.
"""

import json
import queue
import threading
import time

import pytest
from fastapi.testclient import TestClient

from ruvon_echoforge.bridge.main import create_app
from ruvon_echoforge.bridge import metrics as _metrics_mod
from ruvon_echoforge.bridge import tick as _tick_mod
from ruvon_echoforge.bridge.phic import phic_state, PHICConfig


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_bridge_state():
    """Restore all module-level bridge singletons between tests."""
    _metrics_mod._dashboard_sockets.clear()
    _metrics_mod._node_metrics.clear()
    phic_state.update(PHICConfig())
    _tick_mod._engine = None           # reset lazy singleton
    yield
    _metrics_mod._dashboard_sockets.clear()
    _metrics_mod._node_metrics.clear()
    _tick_mod._engine = None


@pytest.fixture()
def client():
    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── Helpers ────────────────────────────────────────────────────────────────

def _drain_ws(ws_session, q: queue.Queue, stop: threading.Event):
    """Background reader: receive from ws_session into a queue."""
    while not stop.is_set():
        try:
            raw = ws_session.receive_text()
            q.put(json.loads(raw))
        except Exception:
            break


def _wait_for(q: queue.Queue, predicate, timeout: float = 3.0) -> list[dict]:
    """Collect messages from queue until predicate is met or timeout."""
    found = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            msg = q.get(timeout=0.1)
            found.append(msg)
            if predicate(found):
                break
        except queue.Empty:
            continue
    return found


# ── Tests ──────────────────────────────────────────────────────────────────

class TestTickToDashboardRelay:
    """Browser sends ticks via /tick WS; bridge relays typed events to /metrics WS."""

    def test_node_metrics_push_appears_on_dashboard(self, client):
        """metrics_snapshot pushed from tick WS must appear on dashboard metrics WS."""
        q    = queue.Queue()
        stop = threading.Event()

        with client.websocket_connect("/api/v1/metrics") as dash_ws:
            t = threading.Thread(target=_drain_ws, args=(dash_ws, q, stop), daemon=True)
            t.start()

            with client.websocket_connect("/api/v1/tick", headers={"x-node-id": "n1"}) as tick_ws:
                tick_ws.send_text(json.dumps({
                    "type":      "metrics_snapshot",
                    "node_id":   "n1",
                    "vpin":      0.22,
                    "latency_ms": 15,
                    "timestamp": int(time.time() * 1000),
                }))
                time.sleep(0.2)

            msgs = _wait_for(q, lambda m: any(x.get("type") == "metrics_snapshot" for x in m))
            stop.set()

        assert any(m.get("type") == "metrics_snapshot" for m in msgs), (
            f"Expected metrics_snapshot on dashboard WS, got: {msgs}"
        )

    def test_sentinel_alert_relayed_to_dashboard(self, client):
        """sentinel_alert forwarded from tick WS must appear on dashboard metrics WS."""
        q    = queue.Queue()
        stop = threading.Event()

        with client.websocket_connect("/api/v1/metrics") as dash_ws:
            t = threading.Thread(target=_drain_ws, args=(dash_ws, q, stop), daemon=True)
            t.start()

            with client.websocket_connect("/api/v1/tick", headers={"x-node-id": "n2"}) as tick_ws:
                tick_ws.send_text(json.dumps({
                    "type":          "sentinel_alert",
                    "sentinel_type": "Nociceptor",
                    "action":        "CANCEL_ORDERS",
                    "vpin":          0.82,
                    "timestamp":     int(time.time() * 1000),
                }))
                time.sleep(0.2)

            msgs = _wait_for(q, lambda m: any(x.get("type") == "sentinel_alert" for x in m))
            stop.set()

        alerts = [m for m in msgs if m.get("type") == "sentinel_alert"]
        assert alerts, f"Expected sentinel_alert on dashboard WS, got: {msgs}"
        assert alerts[0]["sentinel_type"] == "Nociceptor"
        assert alerts[0]["node_id"] == "n2"

    def test_ping_pong(self, client):
        """Tick WS must respond to ping with pong."""
        with client.websocket_connect("/api/v1/tick") as tick_ws:
            tick_ws.send_text(json.dumps({"type": "ping"}))
            raw = tick_ws.receive_text()
        assert json.loads(raw)["type"] == "pong"

    def test_echo_snapshot_relayed(self, client):
        """echo_snapshot messages sent via tick WS must reach dashboard WS."""
        q    = queue.Queue()
        stop = threading.Event()

        with client.websocket_connect("/api/v1/metrics") as dash_ws:
            t = threading.Thread(target=_drain_ws, args=(dash_ws, q, stop), daemon=True)
            t.start()

            with client.websocket_connect("/api/v1/tick", headers={"x-node-id": "n3"}) as tick_ws:
                tick_ws.send_text(json.dumps({
                    "type":      "echo_snapshot",
                    "echoes":    [{"pattern_id": "abc123", "net_aliveness": 0.7, "contested": False}],
                    "timestamp": int(time.time() * 1000),
                }))
                time.sleep(0.2)

            msgs = _wait_for(q, lambda m: any(x.get("type") == "echo_snapshot" for x in m))
            stop.set()

        assert any(m.get("type") == "echo_snapshot" for m in msgs), (
            f"Expected echo_snapshot, got: {msgs}"
        )


class TestPHICFlow:
    """PHIC config changes propagate from REST → WebSocket subscribers."""

    def test_get_phic_defaults(self, client):
        r = client.get("/api/v1/phic/config")
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["autonomy_level"] == 0.5
        assert cfg["emergency_freeze"] is False

    def test_post_phic_config_applied(self, client):
        r = client.post("/api/v1/phic/config", json={
            "autonomy_level":  0.8,
            "max_drawdown_pct": 1.5,
        })
        assert r.status_code == 200
        assert "config_hash" in r.json()

        r2 = client.get("/api/v1/phic/config")
        assert r2.json()["autonomy_level"] == 0.8
        assert r2.json()["max_drawdown_pct"] == 1.5

    def test_phic_ws_receives_initial_config(self, client):
        """PHIC WS must send current config immediately on connect."""
        with client.websocket_connect("/api/v1/phic/ws") as phic_ws:
            raw = phic_ws.receive_text()
        msg = json.loads(raw)
        assert msg["type"] == "phic_update"
        assert "config" in msg
        assert "autonomy_level" in msg["config"]

    def test_phic_ws_receives_config_push(self, client):
        """Updating config via REST must push to all PHIC WS subscribers."""
        q    = queue.Queue()
        stop = threading.Event()

        with client.websocket_connect("/api/v1/phic/ws") as phic_ws:
            # consume initial snapshot
            phic_ws.receive_text()

            t = threading.Thread(target=_drain_ws, args=(phic_ws, q, stop), daemon=True)
            t.start()

            client.post("/api/v1/phic/config", json={
                "autonomy_level":  0.3,
                "vetoed_patterns": ["X_pattern"],
            })
            time.sleep(0.2)

            msgs = _wait_for(q, lambda m: any(x.get("type") == "phic_update" for x in m))
            stop.set()

        updates = [m for m in msgs if m.get("type") == "phic_update"]
        assert updates, f"Expected phic_update push, got: {msgs}"
        assert updates[0]["config"]["autonomy_level"] == 0.3
        assert "X_pattern" in updates[0]["config"]["vetoed_patterns"]

    def test_emergency_freeze_endpoint(self, client):
        r = client.post("/api/v1/phic/freeze")
        assert r.status_code == 200
        assert r.json()["status"] == "frozen"

        cfg = client.get("/api/v1/phic/config").json()
        assert cfg["emergency_freeze"] is True

    def test_phic_validation_rejects_out_of_range(self, client):
        r = client.post("/api/v1/phic/config", json={"autonomy_level": 2.0})
        assert r.status_code == 422


class TestPHICGovernanceFields:
    """New governance fields added in v0.1.1 are present, configurable, and validated."""

    _NEW_FIELDS = {
        "max_total_exposure_pct":   20.0,
        "max_pattern_exposure_pct": 0.30,
        "stop_loss_pct":            2.5,
        "drawdown_hysteresis_n":    3,
        "correlation_enabled":      True,
        "rvr_threshold":            1.5,
        "pearson_threshold":        0.5,
        "cross_pair_boost":         0.04,
        "vpin_crisis_threshold":    0.70,
        "vpin_highvol_threshold":   0.40,
    }

    def test_defaults_include_all_governance_fields(self, client):
        """GET /phic/config must return every governance field with correct defaults."""
        cfg = client.get("/api/v1/phic/config").json()
        for field, default in self._NEW_FIELDS.items():
            assert field in cfg, f"Missing field: {field}"
            assert cfg[field] == default, f"{field}: expected {default}, got {cfg[field]}"

    def test_regime_strain_exp_present_in_defaults(self, client):
        cfg = client.get("/api/v1/phic/config").json()
        assert "regime_strain_exp" in cfg
        rse = cfg["regime_strain_exp"]
        assert rse["LowVol"] == 0.0
        assert rse["HighVol"] == 0.5
        assert rse["Crisis"] == 1.5

    def test_stop_loss_pct_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={"stop_loss_pct": 5.0})
        assert client.get("/api/v1/phic/config").json()["stop_loss_pct"] == 5.0

    def test_stop_loss_pct_zero_disables(self, client):
        client.post("/api/v1/phic/config", json={"stop_loss_pct": 0.0})
        assert client.get("/api/v1/phic/config").json()["stop_loss_pct"] == 0.0

    def test_stop_loss_pct_out_of_range_rejected(self, client):
        r = client.post("/api/v1/phic/config", json={"stop_loss_pct": 15.0})
        assert r.status_code == 422

    def test_max_total_exposure_pct_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={"max_total_exposure_pct": 35.0})
        assert client.get("/api/v1/phic/config").json()["max_total_exposure_pct"] == 35.0

    def test_max_pattern_exposure_pct_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={"max_pattern_exposure_pct": 0.20})
        assert client.get("/api/v1/phic/config").json()["max_pattern_exposure_pct"] == 0.20

    def test_max_pattern_exposure_pct_out_of_range_rejected(self, client):
        # > 1.0 is invalid (it's a fraction, not a percentage)
        r = client.post("/api/v1/phic/config", json={"max_pattern_exposure_pct": 1.5})
        assert r.status_code == 422

    def test_drawdown_hysteresis_n_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={"drawdown_hysteresis_n": 5})
        assert client.get("/api/v1/phic/config").json()["drawdown_hysteresis_n"] == 5

    def test_drawdown_hysteresis_n_out_of_range_rejected(self, client):
        r = client.post("/api/v1/phic/config", json={"drawdown_hysteresis_n": 0})
        assert r.status_code == 422

    def test_correlation_fields_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={
            "correlation_enabled": False,
            "rvr_threshold":       2.0,
            "pearson_threshold":   0.3,
            "cross_pair_boost":    0.06,
        })
        cfg = client.get("/api/v1/phic/config").json()
        assert cfg["correlation_enabled"] is False
        assert cfg["rvr_threshold"] == 2.0
        assert cfg["pearson_threshold"] == 0.3
        assert cfg["cross_pair_boost"] == 0.06

    def test_rvr_threshold_out_of_range_rejected(self, client):
        r = client.post("/api/v1/phic/config", json={"rvr_threshold": 0.1})
        assert r.status_code == 422

    def test_pearson_threshold_out_of_range_rejected(self, client):
        r = client.post("/api/v1/phic/config", json={"pearson_threshold": 0.95})
        assert r.status_code == 422

    def test_vpin_thresholds_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={
            "vpin_crisis_threshold":  0.80,
            "vpin_highvol_threshold": 0.50,
        })
        cfg = client.get("/api/v1/phic/config").json()
        assert cfg["vpin_crisis_threshold"] == 0.80
        assert cfg["vpin_highvol_threshold"] == 0.50

    def test_regime_strain_exp_roundtrip(self, client):
        client.post("/api/v1/phic/config", json={
            "regime_strain_exp": {"LowVol": 0.1, "HighVol": 0.8, "Crisis": 2.0}
        })
        cfg = client.get("/api/v1/phic/config").json()
        assert cfg["regime_strain_exp"]["Crisis"] == 2.0

    def test_governance_fields_pushed_to_phic_ws(self, client):
        """Governance field updates must be pushed to PHIC WebSocket subscribers."""
        q    = queue.Queue()
        stop = threading.Event()

        with client.websocket_connect("/api/v1/phic/ws") as phic_ws:
            phic_ws.receive_text()  # consume initial snapshot

            t = threading.Thread(target=_drain_ws, args=(phic_ws, q, stop), daemon=True)
            t.start()

            client.post("/api/v1/phic/config", json={"stop_loss_pct": 4.0})
            time.sleep(0.2)

            msgs = _wait_for(q, lambda m: any(x.get("type") == "phic_update" for x in m))
            stop.set()

        updates = [m for m in msgs if m.get("type") == "phic_update"]
        assert updates, f"Expected phic_update push, got: {msgs}"
        assert updates[0]["config"]["stop_loss_pct"] == 4.0


class TestMetricsWebSocket:
    """Dashboard /metrics WS baseline behaviour."""

    def test_node_metrics_recorded_via_ws(self, client):
        """Sending node_metrics through the dashboard WS updates the in-memory store."""
        with client.websocket_connect("/api/v1/metrics") as dash_ws:
            dash_ws.send_text(json.dumps({
                "type":                "node_metrics",
                "node_id":             "dash-n1",
                "tick_latency_p99_ms": 18.5,
                "vpin":                0.15,
            }))
            time.sleep(0.1)

        assert "dash-n1" in _metrics_mod._node_metrics
        assert _metrics_mod._node_metrics["dash-n1"]["tick_latency_p99_ms"] == 18.5

    def test_multiple_dashboard_clients_receive_relay(self, client):
        """Both dashboard clients must receive the same relayed sentinel alert."""
        qa   = queue.Queue()
        qb   = queue.Queue()
        stop = threading.Event()

        with client.websocket_connect("/api/v1/metrics") as dash_a:
            with client.websocket_connect("/api/v1/metrics") as dash_b:
                ta = threading.Thread(target=_drain_ws, args=(dash_a, qa, stop), daemon=True)
                tb = threading.Thread(target=_drain_ws, args=(dash_b, qb, stop), daemon=True)
                ta.start(); tb.start()

                with client.websocket_connect("/api/v1/tick", headers={"x-node-id": "multi"}) as tick_ws:
                    tick_ws.send_text(json.dumps({
                        "type":          "sentinel_alert",
                        "sentinel_type": "Metabolic",
                        "action":        "REDUCE_SIZE",
                        "timestamp":     int(time.time() * 1000),
                    }))
                    time.sleep(0.3)

                def has_metabolic(bucket):
                    return any(m.get("sentinel_type") == "Metabolic" for m in bucket)

                msgs_a = _wait_for(qa, has_metabolic)
                msgs_b = _wait_for(qb, has_metabolic)
                stop.set()

        assert has_metabolic(msgs_a), f"Client A missed alert: {msgs_a}"
        assert has_metabolic(msgs_b), f"Client B missed alert: {msgs_b}"
