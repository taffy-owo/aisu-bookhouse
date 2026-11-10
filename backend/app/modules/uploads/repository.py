from datetime import datetime, timezone
from typing import Protocol, cast

from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session

from app.modules.uploads.domain import UploadStatus, UploadTask, UploadTaskKind
from app.modules.uploads.models import UploadTaskRecord


# The upload page only exposes a compact recent-history view. Keep polling and
# retry responses bounded even if an account has accumulated years of records.
UPLOAD_TASK_LIST_LIMIT = 200


class UploadTaskRepository(Protocol):
    def find_processing_for_book(self, user_id: str, book_id: str) -> UploadTask | None:
        ...

    def list_by_user(self, user_id: str) -> list[UploadTask]:
        ...

    def get_owned(self, user_id: str, task_id: str) -> UploadTask | None:
        ...

    def save(self, task: UploadTask) -> UploadTask:
        ...

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        ...

    def delete_finished_for_user(self, user_id: str) -> int:
        ...


class InMemoryUploadTaskRepository:
    def __init__(self, tasks: list[UploadTask] | None = None) -> None:
        self._tasks = {task.id: task for task in tasks or []}

    def list_by_user(self, user_id: str) -> list[UploadTask]:
        tasks = [task for task in self._tasks.values() if task.user_id == user_id]
        return sorted(tasks, key=lambda task: task.updated_at, reverse=True)[:UPLOAD_TASK_LIST_LIMIT]

    def find_processing_for_book(self, user_id: str, book_id: str) -> UploadTask | None:
        candidates = [task for task in self._tasks.values()
                      if task.user_id == user_id and task.book_id == book_id and task.status == "processing"]
        return max(candidates, key=lambda task: task.created_at, default=None)

    def get_owned(self, user_id: str, task_id: str) -> UploadTask | None:
        task = self._tasks.get(task_id)
        if not task or task.user_id != user_id:
            return None
        return task

    def save(self, task: UploadTask) -> UploadTask:
        existing = self._tasks.get(task.id)
        if existing and task.updated_at <= existing.updated_at:
            return existing
        self._tasks[task.id] = task
        return task

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        self._tasks = {task_id: task for task_id, task in self._tasks.items() if task.user_id != user_id or task.book_id != book_id}

    def delete_finished_for_user(self, user_id: str) -> int:
        finished_statuses = {"ready", "failed"}
        task_ids = [task_id for task_id, task in self._tasks.items() if task.user_id == user_id and task.status in finished_statuses]
        for task_id in task_ids:
            del self._tasks[task_id]
        return len(task_ids)


class SqlAlchemyUploadTaskRepository:
    def __init__(self, session: Session, *, autocommit: bool = True) -> None:
        self._session = session
        self._autocommit = autocommit

    def list_by_user(self, user_id: str) -> list[UploadTask]:
        records = self._session.scalars(
            select(UploadTaskRecord)
            .where(UploadTaskRecord.user_id == user_id)
            .order_by(desc(UploadTaskRecord.updated_at), desc(UploadTaskRecord.created_at))
            .limit(UPLOAD_TASK_LIST_LIMIT)
        ).all()
        return [record_to_task(record) for record in records]

    def find_processing_for_book(self, user_id: str, book_id: str) -> UploadTask | None:
        record = self._session.scalar(select(UploadTaskRecord).where(
            UploadTaskRecord.user_id == user_id, UploadTaskRecord.book_id == book_id,
            UploadTaskRecord.status == "processing").order_by(desc(UploadTaskRecord.created_at)).limit(1))
        return record_to_task(record) if record else None

    def get_owned(self, user_id: str, task_id: str) -> UploadTask | None:
        record = self._session.get(UploadTaskRecord, task_id)
        if not record or record.user_id != user_id:
            return None
        return record_to_task(record)

    def save(self, task: UploadTask) -> UploadTask:
        record = self._session.scalar(
            select(UploadTaskRecord).where(UploadTaskRecord.id == task.id).execution_options(populate_existing=True)
        )
        if record is None:
            record = task_to_record(task)
            self._session.add(record)
        else:
            existing_updated_at = normalize_datetime(record.updated_at)
            incoming_updated_at = normalize_datetime(task.updated_at)
            if existing_updated_at and incoming_updated_at and incoming_updated_at <= existing_updated_at:
                return record_to_task(record)
            update_task_record(record, task)

        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        return record_to_task(record)

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        self._session.execute(delete(UploadTaskRecord).where(UploadTaskRecord.user_id == user_id, UploadTaskRecord.book_id == book_id))
        if commit:
            self._session.commit()

    def delete_finished_for_user(self, user_id: str) -> int:
        result = self._session.execute(
            delete(UploadTaskRecord).where(
                UploadTaskRecord.user_id == user_id,
                UploadTaskRecord.status.in_(("ready", "failed")),
            )
        )
        self._session.commit()
        return int(result.rowcount or 0)


def create_seed_upload_tasks(user_id: str) -> list[UploadTask]:
    now = datetime.now(timezone.utc)
    return [
        UploadTask(
            id="u1",
            user_id=user_id,
            book_id="b1",
            file_name="樱色日记.epub",
            file_type="EPUB",
            file_size=1024 * 1024,
            status="ready",
            progress=100,
            message="已完成",
            error_code=None,
            created_at=now,
            updated_at=now,
        )
    ]


def task_to_record(task: UploadTask) -> UploadTaskRecord:
    return UploadTaskRecord(
        id=task.id,
        user_id=task.user_id,
        book_id=task.book_id,
        file_name=task.file_name,
        file_type=task.file_type,
        file_size=task.file_size,
        kind=task.kind,
        status=task.status,
        progress=task.progress,
        message=task.message,
        error_code=task.error_code,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def update_task_record(record: UploadTaskRecord, task: UploadTask) -> None:
    record.user_id = task.user_id
    record.book_id = task.book_id
    record.file_name = task.file_name
    record.file_type = task.file_type
    record.file_size = task.file_size
    record.kind = task.kind
    record.status = task.status
    record.progress = task.progress
    record.message = task.message
    record.error_code = task.error_code
    record.created_at = task.created_at
    record.updated_at = task.updated_at


def record_to_task(record: UploadTaskRecord) -> UploadTask:
    return UploadTask(
        id=record.id,
        user_id=record.user_id,
        book_id=record.book_id,
        file_name=record.file_name,
        file_type=record.file_type,
        file_size=record.file_size,
        kind=cast(UploadTaskKind, record.kind or "initial"),
        status=cast(UploadStatus, record.status),
        progress=record.progress,
        message=record.message,
        error_code=None if record.status == "processing" and record.error_code == "worker_processing" else record.error_code,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value
