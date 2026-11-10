from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable
import logging
import json
import os
from pathlib import Path
import threading
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import or_, select, update

from app.core.config import Settings, get_settings, validate_production_settings
from app.core.database import create_database_engine, create_session_factory, import_model_modules
from app.core.storage import get_storage_root
from app.core.maintenance import ensure_no_restore_in_progress
from app.modules.uploads.models import UploadTaskRecord
from app.modules.uploads.service import process_upload_task
from app.modules.books.source_updates import process_next_due_source_update
from app.modules.translations.service import cleanup_stale_translation_storage, process_next_translation_job

SessionFactory = Callable[[], object]
DEFAULT_WORKER_INTERVAL_SECONDS = 0.5
DEFAULT_TRANSLATION_WORKER_COUNT = 2
MAX_TRANSLATION_WORKER_COUNT = 4
MAX_TRANSLATION_WORKER_BACKOFF_SECONDS = 300.0
logger = logging.getLogger(__name__)
UPLOAD_TASK_CLAIM_CODE = "worker_processing"
UPLOAD_TASK_CLAIM_TIMEOUT = timedelta(minutes=30)


def process_start_ticks(pid: int) -> str | None:
    try:
        # Linux /proc field 22 is the process start tick. It also catches a
        # stale heartbeat whose PID was reused after the worker exited.
        fields = Path(f"/proc/{pid}/stat").read_text(encoding="ascii").rsplit(") ", 1)[1].split()
        return fields[19]
    except (OSError, IndexError):
        return None


class WorkerHeartbeat:
    def __init__(self, settings: Settings, *, interval_seconds: float = 15.0) -> None:
        self.settings = settings
        self.interval_seconds = interval_seconds
        self.instance_id = str(uuid4())
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.state = "idle"
        self.task_id: str | None = None
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, name="worker-heartbeat", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stopped.set()
        self.thread.join(timeout=2)

    def _run(self) -> None:
        while not self.stopped.is_set():
            try:
                ensure_no_restore_in_progress(self.settings)
                write_worker_heartbeat(
                    self.settings, instance_id=self.instance_id, started_at=self.started_at,
                    state=self.state, task_id=self.task_id,
                )
            except Exception:
                logger.exception("Worker heartbeat failed")
            self.stopped.wait(self.interval_seconds)


def process_next_upload_task(
    *, settings: Settings | None = None, session_factory: SessionFactory | None = None,
    heartbeat: WorkerHeartbeat | None = None,
) -> bool:
    import_model_modules()
    resolved_settings = settings or get_settings()
    validate_production_settings(resolved_settings)
    ensure_no_restore_in_progress(resolved_settings)
    resolved_session_factory = session_factory or create_session_factory(create_database_engine(resolved_settings))
    task = find_next_processing_task(resolved_session_factory)
    if not task:
        return False

    if heartbeat:
        heartbeat.state = "processing-upload"
        heartbeat.task_id = task.task_id
    try:
        process_upload_task(
            book_id=task.book_id,
            owner_id=task.owner_id,
            settings=resolved_settings,
            # Reprocess tasks must not overwrite manually edited metadata with
            # whatever is embedded in the file; initial uploads still use it to
            # fill in title/author/description.
            should_update_metadata=task.kind != "reprocess",
            session_factory=resolved_session_factory,
            task_id=task.task_id,
        )
    finally:
        if heartbeat:
            heartbeat.state = "idle"
            heartbeat.task_id = None
    return True


def run_worker_loop(
    *,
    interval_seconds: float = DEFAULT_WORKER_INTERVAL_SECONDS,
    translation_worker_count: int = DEFAULT_TRANSLATION_WORKER_COUNT,
    settings: Settings | None = None,
    session_factory: SessionFactory | None = None,
) -> None:
    resolved_settings = settings or get_settings()
    validate_production_settings(resolved_settings)
    ensure_no_restore_in_progress(resolved_settings)
    resolved_session_factory = session_factory or create_session_factory(create_database_engine(resolved_settings))
    try:
        cleanup_result = cleanup_stale_translation_storage(resolved_settings, resolved_session_factory)
        if any(cleanup_result.values()):
            logger.info("Cleaned stale translation storage: %s", cleanup_result)
    except Exception:
        logger.exception("Translation storage cleanup failed; worker startup will continue")
    translation_threads = start_translation_worker_threads(
        worker_count=translation_worker_count,
        interval_seconds=max(1.0, interval_seconds),
        settings=resolved_settings,
        session_factory=resolved_session_factory,
    )
    logger.info("Started %s whole-book translation workers", len(translation_threads))
    next_source_poll_at = 0.0
    heartbeat = WorkerHeartbeat(resolved_settings)
    heartbeat.start()
    try:
        while True:
            ensure_no_restore_in_progress(resolved_settings)
            processed = process_next_upload_task(settings=resolved_settings, session_factory=resolved_session_factory, heartbeat=heartbeat)
            monotonic_now = time.monotonic()
            if not processed and monotonic_now >= next_source_poll_at:
                source_processed = asyncio.run(process_next_due_source_update(session_factory=resolved_session_factory, settings=resolved_settings))
                processed = source_processed
                next_source_poll_at = monotonic_now + (1.0 if source_processed else 60.0)
            if not processed:
                time.sleep(interval_seconds)
    finally:
        heartbeat.stop()


def write_worker_heartbeat(
    settings: Settings, *, instance_id: str | None = None, started_at: str | None = None,
    state: str = "idle", task_id: str | None = None,
) -> None:
    destination = get_storage_root(settings).parent / "worker-heartbeat.json"
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        now = datetime.now(timezone.utc).isoformat()
        temporary.write_text(json.dumps({
            "at": now,
            "pid": os.getpid(),
            "process_start_ticks": process_start_ticks(os.getpid()),
            "instance_id": instance_id or str(uuid4()),
            "started_at": started_at or now,
            "release": Path(__file__).resolve().parents[4].name,
            "state": state,
            "task_id": task_id,
        }), encoding="utf-8")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def start_translation_worker_threads(
    *,
    worker_count: int,
    interval_seconds: float,
    settings: Settings,
    session_factory: SessionFactory,
) -> tuple[threading.Thread, ...]:
    bounded_count = max(1, min(MAX_TRANSLATION_WORKER_COUNT, worker_count))
    threads: list[threading.Thread] = []
    for index in range(bounded_count):
        thread = threading.Thread(
            target=run_translation_worker_loop,
            kwargs={
                "interval_seconds": interval_seconds,
                "settings": settings,
                "session_factory": session_factory,
            },
            name=f"whole-book-translation-worker-{index + 1}",
            daemon=True,
        )
        thread.start()
        threads.append(thread)
    return tuple(threads)


def run_translation_worker_loop(*, interval_seconds: float, settings: Settings, session_factory: SessionFactory) -> None:
    # This runs on a daemon thread, so an escaping exception used to kill the
    # thread outright and silently stall every queued translation until the unit
    # was restarted. Claiming a job and recording a failure both touch SQLite and
    # can raise under write contention, so the loop keeps going and backs off.
    failure_backoff = interval_seconds
    while True:
        ensure_no_restore_in_progress(settings)
        try:
            processed = asyncio.run(process_next_translation_job(settings=settings, session_factory=session_factory))
        except Exception:
            logger.exception("Whole-book translation worker iteration failed; retrying after %.0fs", failure_backoff)
            time.sleep(failure_backoff)
            failure_backoff = min(failure_backoff * 2, MAX_TRANSLATION_WORKER_BACKOFF_SECONDS)
            continue
        failure_backoff = interval_seconds
        if not processed:
            time.sleep(interval_seconds)


def find_next_processing_task(session_factory: SessionFactory) -> QueuedUploadTask | None:
    with session_factory() as session:
        stale_before = datetime.now(timezone.utc) - UPLOAD_TASK_CLAIM_TIMEOUT
        record = session.scalars(
            select(UploadTaskRecord)
            .where(
                UploadTaskRecord.status == "processing",
                or_(
                    UploadTaskRecord.error_code.is_(None),
                    UploadTaskRecord.error_code != UPLOAD_TASK_CLAIM_CODE,
                    UploadTaskRecord.updated_at < stale_before,
                ),
            )
            .order_by(UploadTaskRecord.created_at.asc())
            .limit(1)
        ).first()
        if not record:
            return None
        claimed = session.execute(
            update(UploadTaskRecord)
            .where(
                UploadTaskRecord.id == record.id,
                UploadTaskRecord.status == "processing",
                or_(
                    UploadTaskRecord.error_code.is_(None),
                    UploadTaskRecord.error_code != UPLOAD_TASK_CLAIM_CODE,
                    UploadTaskRecord.updated_at < stale_before,
                ),
            )
            .values(error_code=UPLOAD_TASK_CLAIM_CODE, updated_at=datetime.now(timezone.utc))
            .execution_options(synchronize_session=False)
        )
        session.commit()
        if claimed.rowcount != 1:
            return None
        return QueuedUploadTask(task_id=record.id, owner_id=record.user_id, book_id=record.book_id, kind=record.kind or "initial")


class QueuedUploadTask:
    def __init__(self, *, book_id: str | None, owner_id: str, task_id: str, kind: str = "initial") -> None:
        self.book_id = book_id
        self.owner_id = owner_id
        self.task_id = task_id
        self.kind = kind


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Aisu Bookhouse upload processing worker.")
    parser.add_argument("--once", action="store_true", help="Process at most one queued upload and exit.")
    parser.add_argument("--interval", default=DEFAULT_WORKER_INTERVAL_SECONDS, type=float, help="Idle polling interval in seconds.")
    parser.add_argument(
        "--translation-workers",
        default=DEFAULT_TRANSLATION_WORKER_COUNT,
        type=int,
        help=f"Concurrent whole-book translation jobs (1-{MAX_TRANSLATION_WORKER_COUNT}).",
    )
    args = parser.parse_args()

    if args.once:
        process_next_upload_task()
        return

    run_worker_loop(interval_seconds=args.interval, translation_worker_count=args.translation_workers)


if __name__ == "__main__":
    main()
