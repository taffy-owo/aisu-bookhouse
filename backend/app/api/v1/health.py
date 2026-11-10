from datetime import datetime, timezone
from functools import lru_cache
import json
import os
from pathlib import Path
import tempfile

from alembic.script import ScriptDirectory
from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_db_session
from app.core.storage import get_storage_root

router = APIRouter(tags=["health"])


@router.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@lru_cache(maxsize=1)
def release_info() -> tuple[str, str | None]:
    backend_root = Path(__file__).resolve().parents[3]
    expected_revision = ScriptDirectory(str(backend_root / "alembic")).get_current_head()
    return backend_root.parent.name, expected_revision


@router.get("/ready")
def readiness_check(
    settings: Settings = Depends(get_app_settings),
    session: Session = Depends(get_db_session),
) -> JSONResponse:
    release, expected_revision = release_info()
    checks: dict[str, str] = {}
    try:
        session.execute(text("SELECT 1")).scalar_one()
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "unavailable"
    if checks["database"] == "ok" and settings.environment == "production":
        try:
            installed = session.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            checks["migration"] = "ok" if installed == expected_revision else "mismatch"
        except Exception:
            checks["migration"] = "unavailable"
    try:
        with tempfile.TemporaryFile(dir=get_storage_root(settings)) as probe:
            probe.write(b"ready")
            probe.flush()
        checks["storage"] = "ok"
    except OSError:
        checks["storage"] = "unavailable"
    ready = all(value == "ok" for value in checks.values())
    return JSONResponse(
        status_code=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"status": "ready" if ready else "unavailable", "checks": checks, "release": release, "migration": expected_revision},
    )


@router.get("/worker-status")
def worker_status(settings: Settings = Depends(get_app_settings)) -> JSONResponse:
    heartbeat = get_storage_root(settings).parent / "worker-heartbeat.json"
    try:
        data = json.loads(heartbeat.read_text(encoding="utf-8"))
        last_seen = datetime.fromisoformat(data["at"])
        started_at = datetime.fromisoformat(data["started_at"])
        age_seconds = max(0, (datetime.now(timezone.utc) - last_seen).total_seconds())
        pid = int(data["pid"])
        process_alive = worker_process_is_alive(pid)
        expected_ticks = data.get("process_start_ticks")
        if process_alive and expected_ticks is not None and Path("/proc").is_dir():
            try:
                fields = Path(f"/proc/{pid}/stat").read_text(encoding="ascii").rsplit(") ", 1)[1].split()
                process_alive = fields[19] == expected_ticks
            except (OSError, IndexError):
                process_alive = False
        release, _ = release_info()
        matched_release = data.get("release") == release
        identified = isinstance(data.get("instance_id"), str) and bool(data["instance_id"])
        fresh = age_seconds < 45 and last_seen >= started_at and process_alive and matched_release and identified
        return JSONResponse({
            "status": "ok" if fresh else "stale", "age_seconds": round(age_seconds),
            "pid": pid, "instance_id": data.get("instance_id"), "release": data.get("release"),
            "state": data.get("state"), "task_id": data.get("task_id"),
        }, status_code=200 if fresh else 503)
    except (OSError, ValueError, KeyError, TypeError):
        return JSONResponse({"status": "unavailable"}, status_code=status.HTTP_503_SERVICE_UNAVAILABLE)


def worker_process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

