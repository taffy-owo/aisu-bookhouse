from dataclasses import replace
from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.orm import Session

from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.models import ReadingProgressRecord


class ReadingProgressRepository(Protocol):
    def list_all_for_book(self, book_id: str) -> list[ReadingProgress]:
        ...

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        ...

    def get(self, user_id: str, book_id: str) -> ReadingProgress | None:
        ...

    def list_for_books(self, user_id: str, book_ids: list[str]) -> list[ReadingProgress]:
        ...

    def list_for_user(self, user_id: str) -> list[ReadingProgress]:
        ...

    def save(self, progress: ReadingProgress) -> ReadingProgress:
        ...

    def rebase_percentage(self, previous: ReadingProgress, percent: int) -> None:
        ...

    def rebase_position(self, previous: ReadingProgress, current: ReadingProgress) -> None:
        ...


class InMemoryReadingProgressRepository:
    def __init__(self) -> None:
        self._progress_by_key: dict[tuple[str, str], ReadingProgress] = {}

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        self._progress_by_key.pop((user_id, book_id), None)

    def get(self, user_id: str, book_id: str) -> ReadingProgress | None:
        return self._progress_by_key.get((user_id, book_id))

    def list_all_for_book(self, book_id: str) -> list[ReadingProgress]:
        return [progress for (_, candidate_id), progress in self._progress_by_key.items() if candidate_id == book_id]

    def list_for_books(self, user_id: str, book_ids: list[str]) -> list[ReadingProgress]:
        requested_book_ids = set(book_ids)
        if not requested_book_ids:
            return []
        return [
            progress
            for (candidate_user_id, book_id), progress in self._progress_by_key.items()
            if candidate_user_id == user_id and book_id in requested_book_ids
        ]

    def list_for_user(self, user_id: str) -> list[ReadingProgress]:
        return [progress for (candidate_user_id, _book_id), progress in self._progress_by_key.items() if candidate_user_id == user_id]

    def save(self, progress: ReadingProgress) -> ReadingProgress:
        saved_progress = progress if progress.updated_at is not None else progress.touch()
        existing = self._progress_by_key.get((saved_progress.user_id, saved_progress.book_id))
        if existing and existing.updated_at and saved_progress.updated_at and saved_progress.updated_at <= existing.updated_at:
            return existing
        self._progress_by_key[(saved_progress.user_id, saved_progress.book_id)] = saved_progress
        return saved_progress


    def rebase_percentage(self, previous: ReadingProgress, percent: int) -> None:
        self.rebase_position(previous, replace(previous, progress_percent=percent))

    def rebase_position(self, previous: ReadingProgress, current: ReadingProgress) -> None:
        require_same_reading_event(previous, current)
        key = (previous.user_id, previous.book_id)
        if self._progress_by_key.get(key) == previous:
            self._progress_by_key[key] = current


class SqlAlchemyReadingProgressRepository:
    def __init__(self, session: Session, *, autocommit: bool = True) -> None:
        self._session = session
        self._autocommit = autocommit

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        self._session.execute(delete(ReadingProgressRecord).where(ReadingProgressRecord.user_id == user_id, ReadingProgressRecord.book_id == book_id))
        if commit:
            self._session.commit()

    def get(self, user_id: str, book_id: str) -> ReadingProgress | None:
        record = self._session.scalar(
            select(ReadingProgressRecord).where(ReadingProgressRecord.user_id == user_id, ReadingProgressRecord.book_id == book_id)
        )
        return record_to_progress(record) if record else None

    def list_all_for_book(self, book_id: str) -> list[ReadingProgress]:
        records = self._session.scalars(select(ReadingProgressRecord).where(ReadingProgressRecord.book_id == book_id)).all()
        return [record_to_progress(record) for record in records]

    def list_for_books(self, user_id: str, book_ids: list[str]) -> list[ReadingProgress]:
        requested_book_ids = set(book_ids)
        if not requested_book_ids:
            return []
        records = self._session.scalars(
            select(ReadingProgressRecord).where(
                ReadingProgressRecord.user_id == user_id,
                ReadingProgressRecord.book_id.in_(requested_book_ids),
            )
        ).all()
        return [record_to_progress(record) for record in records]

    def list_for_user(self, user_id: str) -> list[ReadingProgress]:
        records = self._session.scalars(select(ReadingProgressRecord).where(ReadingProgressRecord.user_id == user_id)).all()
        return [record_to_progress(record) for record in records]

    def save(self, progress: ReadingProgress) -> ReadingProgress:
        saved_progress = progress if progress.updated_at is not None else progress.touch()
        dialect = self._session.get_bind().dialect.name
        if dialect in {"sqlite", "postgresql"}:
            incoming = progress_to_record(saved_progress)
            values = {column.name: getattr(incoming, column.name) for column in ReadingProgressRecord.__table__.columns if column.name != "id"}
            insert = sqlite_insert if dialect == "sqlite" else postgres_insert
            statement = insert(ReadingProgressRecord).values(values)
            statement = statement.on_conflict_do_update(
                index_elements=[ReadingProgressRecord.user_id, ReadingProgressRecord.book_id],
                set_={name: getattr(statement.excluded, name) for name in values if name not in {"user_id", "book_id"}},
                where=ReadingProgressRecord.updated_at < statement.excluded.updated_at,
            )
            self._session.execute(statement)
            if self._autocommit:
                self._session.commit()
            else:
                self._session.flush()
            # The identity map can still contain a position read before another
            # request committed. Return the actual database winner.
            record = self._session.scalar(select(ReadingProgressRecord).where(
                ReadingProgressRecord.user_id == saved_progress.user_id,
                ReadingProgressRecord.book_id == saved_progress.book_id,
            ).execution_options(populate_existing=True))
            return record_to_progress(record)
        record = self._session.scalar(
            select(ReadingProgressRecord).where(
                ReadingProgressRecord.user_id == saved_progress.user_id,
                ReadingProgressRecord.book_id == saved_progress.book_id,
            )
        )

        if record is None:
            record = progress_to_record(saved_progress)
            self._session.add(record)
        else:
            existing_updated_at = normalize_datetime(record.updated_at)
            incoming_updated_at = normalize_datetime(saved_progress.updated_at)
            if existing_updated_at and incoming_updated_at and incoming_updated_at <= existing_updated_at:
                return record_to_progress(record)
            update_progress_record(record, saved_progress)

        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        return record_to_progress(record)

    def rebase_percentage(self, previous: ReadingProgress, percent: int) -> None:
        self.rebase_position(previous, replace(previous, progress_percent=percent))

    def rebase_position(self, previous: ReadingProgress, current: ReadingProgress) -> None:
        require_same_reading_event(previous, current)
        # A catalog publication is not a reading event. Preserve its timestamp,
        # and let a newer read, reset, or deletion win over this snapshot.
        columns = ("reader_type", "progress_percent", "updated_at", "chapter_index", "epub_cfi",
                   "chapter_href", "image_index", "page_number")
        conditions = [ReadingProgressRecord.user_id == previous.user_id,
                      ReadingProgressRecord.book_id == previous.book_id]
        for name in columns:
            value = getattr(previous, name)
            conditions.append(getattr(ReadingProgressRecord, name) == value)
        self._session.execute(update(ReadingProgressRecord).where(*conditions).values(
            progress_percent=current.progress_percent, chapter_index=current.chapter_index,
            epub_cfi=current.epub_cfi, chapter_href=current.chapter_href,
            image_index=current.image_index, page_number=current.page_number).execution_options(synchronize_session=False))
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        # Reads in the same publication transaction must observe the new value.
        for record in tuple(self._session.identity_map.values()):
            if isinstance(record, ReadingProgressRecord) and record.user_id == previous.user_id and record.book_id == previous.book_id:
                self._session.expire(record)


def require_same_reading_event(previous: ReadingProgress, current: ReadingProgress) -> None:
    if (previous.user_id, previous.book_id, previous.reader_type, previous.updated_at) != (
            current.user_id, current.book_id, current.reader_type, current.updated_at):
        raise ValueError("A catalog rebase must preserve the reader and reading event")


def progress_to_record(progress: ReadingProgress) -> ReadingProgressRecord:
    touched_progress = progress if progress.updated_at is not None else progress.touch()
    return ReadingProgressRecord(
        user_id=touched_progress.user_id,
        book_id=touched_progress.book_id,
        reader_type=touched_progress.reader_type,
        progress_percent=touched_progress.progress_percent,
        chapter_index=touched_progress.chapter_index,
        page_number=touched_progress.page_number,
        image_index=touched_progress.image_index,
        chapter_href=touched_progress.chapter_href,
        epub_cfi=touched_progress.epub_cfi,
        updated_at=touched_progress.updated_at,
    )


def update_progress_record(record: ReadingProgressRecord, progress: ReadingProgress) -> None:
    record.reader_type = progress.reader_type
    record.progress_percent = progress.progress_percent
    record.chapter_index = progress.chapter_index
    record.page_number = progress.page_number
    record.image_index = progress.image_index
    record.chapter_href = progress.chapter_href
    record.epub_cfi = progress.epub_cfi
    record.updated_at = progress.updated_at


def record_to_progress(record: ReadingProgressRecord) -> ReadingProgress:
    return ReadingProgress(
        user_id=record.user_id,
        book_id=record.book_id,
        reader_type=record.reader_type,
        progress_percent=record.progress_percent,
        chapter_index=record.chapter_index,
        page_number=record.page_number,
        image_index=record.image_index,
        chapter_href=record.chapter_href,
        epub_cfi=record.epub_cfi,
        # SQLite drops tzinfo even for DateTime(timezone=True). Stored times
        # are UTC; keep API responses round-trippable through strict validation.
        updated_at=normalize_datetime(record.updated_at),
    )


def normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value
