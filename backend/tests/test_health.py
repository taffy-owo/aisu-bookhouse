from pathlib import Path
import json
import time

from fastapi.testclient import TestClient

from app.core.dependencies import get_db_session
from app.modules.uploads.worker import WorkerHeartbeat, write_worker_heartbeat


def test_health_and_readiness_are_distinct(client: TestClient) -> None:
    assert client.get("/api/v1/health").json() == {"status": "ok"}
    ready = client.get("/api/v1/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"database": "ok", "storage": "ok"}
    assert ready.json()["release"]


def test_readiness_fails_when_database_is_unavailable(client: TestClient) -> None:
    class FailedSession:
        def execute(self, *_args, **_kwargs):
            raise OSError("database unavailable")

    def unavailable_session():
        yield FailedSession()

    client.app.dependency_overrides[get_db_session] = unavailable_session
    try:
        assert client.get("/api/v1/health").status_code == 200
        ready = client.get("/api/v1/ready")
        assert ready.status_code == 503
        assert ready.json()["checks"]["database"] == "unavailable"
    finally:
        client.app.dependency_overrides.clear()


def test_worker_heartbeat_has_own_status(client: TestClient) -> None:
    assert client.get("/api/v1/worker-status").status_code == 503
    write_worker_heartbeat(client.app.state.settings)
    response = client.get("/api/v1/worker-status")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["release"] == client.get("/api/v1/ready").json()["release"]
    assert response.json()["instance_id"]


def test_worker_status_rejects_previous_release_and_exited_process(client: TestClient) -> None:
    settings = client.app.state.settings
    heartbeat = Path(settings.storage_root).parent / "worker-heartbeat.json"
    write_worker_heartbeat(settings)
    data = json.loads(heartbeat.read_text(encoding="utf-8"))
    data["release"] = "previous-release"
    heartbeat.write_text(json.dumps(data), encoding="utf-8")
    assert client.get("/api/v1/worker-status").status_code == 503
    data["release"] = client.get("/api/v1/ready").json()["release"]
    data["pid"] = 99999999
    heartbeat.write_text(json.dumps(data), encoding="utf-8")
    assert client.get("/api/v1/worker-status").status_code == 503


def test_worker_heartbeat_continues_while_upload_thread_is_busy(client: TestClient) -> None:
    heartbeat = WorkerHeartbeat(client.app.state.settings, interval_seconds=0.02)
    heartbeat.state = "processing-upload"
    heartbeat.task_id = "long-upload"
    path = Path(client.app.state.settings.storage_root).parent / "worker-heartbeat.json"
    heartbeat.start()
    try:
        for _ in range(50):
            if path.exists():
                break
            time.sleep(0.01)
        first = json.loads(path.read_text(encoding="utf-8"))
        time.sleep(0.08)
        second = json.loads(path.read_text(encoding="utf-8"))
        assert first["at"] != second["at"]
        assert second["state"] == "processing-upload"
        assert second["task_id"] == "long-upload"
        assert first["instance_id"] == second["instance_id"]
        assert client.get("/api/v1/worker-status").status_code == 200
    finally:
        heartbeat.stop()
