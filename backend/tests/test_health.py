"""Smoke test for the health endpoint used to verify deployments."""

from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok() -> None:
    """The health endpoint responds 200 with ``{"ok": true}``."""
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
