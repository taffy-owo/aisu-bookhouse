from __future__ import annotations

from contextlib import contextmanager
import os
import subprocess
from pathlib import Path
from typing import Iterator

from app.core.config import Settings


def require_writers_stopped(settings: Settings) -> None:
    if settings.environment != "production":
        return
    if os.name != "posix":
        raise RuntimeError("Production maintenance must run on the Linux application host")
    services = ("aisu-bookhouse.service", "aisu-bookhouse-upload-worker.service",
                "aisu-ha-manager.timer", "aisu-ha-replication.timer",
                "aisu-ha-manager.service", "aisu-ha-replication.service")
    for service in services:
        result = subprocess.run(["systemctl", "is-active", "--quiet", service], check=False)
        if result.returncode == 0:
            raise RuntimeError(f"Stop {service} before creating or restoring a backup")
        if result.returncode not in (3, 4):
            raise RuntimeError(f"Could not verify that {service} is stopped (systemctl exit {result.returncode})")


def maintenance_marker(settings: Settings) -> Path:
    return Path(settings.storage_root).expanduser().resolve().parent / ".aisu-restore-maintenance"


def ensure_no_restore_in_progress(settings: Settings) -> None:
    marker = maintenance_marker(settings)
    if marker.exists():
        raise RuntimeError(f"An offline restore is incomplete: {marker}")


@contextmanager
def maintenance_lock(settings: Settings) -> Iterator[None]:
    """Serialize offline maintenance outside the storage tree being replaced."""
    path = maintenance_marker(settings).with_name(".aisu-maintenance.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    inherited_fd = os.getenv("AISU_MAINTENANCE_LOCK_FD")
    if inherited_fd and os.name == "posix":
        fd = int(inherited_fd)
        opened = os.fstat(fd)
        expected = path.stat()
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise RuntimeError("Inherited maintenance lock points to the wrong file")
        yield
        return
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            handle.write(b"\0")
            handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("Another maintenance operation is running") from exc
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("Another maintenance operation is running") from exc
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
