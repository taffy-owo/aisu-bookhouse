from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import case, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.reading_activity.models import ReadingActivityEventRecord, ReadingActivityRecord


class ReadingActivityRepository(Protocol):
    def add_seconds(self, *, user_id: str, date_key: str, seconds: int, book_id: str | None = None, book_title: str | None = None, event_id: str | None = None) -> bool:
        """Record seconds and return False when the write is rejected (e.g. the book vanished)."""
        ...

    def list_for_user(self, user_id: str) -> list[ReadingActivityRecord]:
        ...

    def aggregate_for_user(
        self, user_id: str,
    ) -> tuple[list[tuple[str, int]], list[tuple[str, str | None, int]]]:
        """Return daily and per-book totals without loading every event row."""
        ...


class InMemoryReadingActivityRepository:
    def __init__(self) -> None:
        self._records: dict[tuple[str, str, str | None], ReadingActivityRecord] = {}
        self._next_id = 1
        self._event_ids: set[tuple[str, str]] = set()

    def add_seconds(self, *, user_id: str, date_key: str, seconds: int, book_id: str | None = None, book_title: str | None = None, event_id: str | None = None) -> bool:
        if event_id and (user_id, event_id) in self._event_ids:
            return True
        key = (user_id, date_key, book_id)
        now = datetime.now(timezone.utc)
        record = self._records.get(key)
        if record is None:
            record = ReadingActivityRecord(
                id=self._next_id,
                user_id=user_id,
                book_id=book_id,
                book_title=book_title,
                date_key=date_key,
                seconds=seconds,
                created_at=now,
                updated_at=now,
            )
            self._next_id += 1
            self._records[key] = record
            if event_id:
                self._event_ids.add((user_id, event_id))
            return True
        record.seconds += seconds
        if not record.book_title and book_title:
            record.book_title = book_title
        record.updated_at = now
        if event_id:
            self._event_ids.add((user_id, event_id))
        return True

    def list_for_user(self, user_id: str) -> list[ReadingActivityRecord]:
        return [record for record in self._records.values() if record.user_id == user_id]

    def aggregate_for_user(
        self, user_id: str,
    ) -> tuple[list[tuple[str, int]], list[tuple[str, str | None, int]]]:
        seconds_by_date: dict[str, int] = {}
        books: dict[str, tuple[str | None, int]] = {}
        for record in self.list_for_user(user_id):
            seconds_by_date[record.date_key] = seconds_by_date.get(record.date_key, 0) + record.seconds
            if record.book_id:
                title, seconds = books.get(record.book_id, (None, 0))
                books[record.book_id] = (title or record.book_title, seconds + record.seconds)
        return (
            [(date_key, seconds) for date_key, seconds in seconds_by_date.items()],
            [(book_id, title, seconds) for book_id, (title, seconds) in books.items()],
        )


class SqlAlchemyReadingActivityRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add_seconds(self, *, user_id: str, date_key: str, seconds: int, book_id: str | None = None, book_title: str | None = None, event_id: str | None = None) -> bool:
        now = datetime.now(timezone.utc)
        if event_id:
            existing_event = self._session.get(ReadingActivityEventRecord, event_id)
            if existing_event:
                return existing_event.user_id == user_id
        record = self._session.scalar(
            select(ReadingActivityRecord).where(
                ReadingActivityRecord.user_id == user_id,
                ReadingActivityRecord.date_key == date_key,
                ReadingActivityRecord.book_id == book_id,
            )
        )

        if record is None:
            record = ReadingActivityRecord(
                user_id=user_id,
                book_id=book_id,
                book_title=book_title,
                date_key=date_key,
                seconds=seconds,
                created_at=now,
                updated_at=now,
            )
            self._session.add(record)
        else:
            # Activity events can arrive concurrently from multiple tabs or
            # from the browser outbox retry.  Keep the increment in SQL so
            # two requests cannot both read the same old total and lose one
            # of the increments between their commits.
            values: dict[str, object] = {
                "seconds": ReadingActivityRecord.seconds + seconds,
                "updated_at": now,
            }
            if book_title:
                values["book_title"] = case(
                    (ReadingActivityRecord.book_title.is_(None), book_title),
                    else_=ReadingActivityRecord.book_title,
                )
            self._session.execute(
                update(ReadingActivityRecord)
                .where(ReadingActivityRecord.id == record.id)
                .values(**values)
                .execution_options(synchronize_session=False)
            )

        if event_id:
            self._session.add(ReadingActivityEventRecord(id=event_id, user_id=user_id, created_at=now))

        try:
            self._session.commit()
        except IntegrityError:
            # The referenced book (or user) disappeared between the service-level
            # existence check and this write. Report failure instead of a 500.
            self._session.rollback()
            return False
        # The aggregate was updated with a SQL expression while the session
        # may still hold the pre-update ORM instance used to find its id.
        # Expire it before the service builds the response summary.
        self._session.expire_all()
        return True

    def list_for_user(self, user_id: str) -> list[ReadingActivityRecord]:
        return self._session.scalars(select(ReadingActivityRecord).where(ReadingActivityRecord.user_id == user_id)).all()

    def aggregate_for_user(
        self, user_id: str,
    ) -> tuple[list[tuple[str, int]], list[tuple[str, str | None, int]]]:
        daily_rows = self._session.execute(
            select(ReadingActivityRecord.date_key, func.sum(ReadingActivityRecord.seconds))
            .where(ReadingActivityRecord.user_id == user_id)
            .group_by(ReadingActivityRecord.date_key)
        ).all()
        book_rows = self._session.execute(
            select(
                ReadingActivityRecord.book_id,
                func.max(ReadingActivityRecord.book_title),
                func.sum(ReadingActivityRecord.seconds),
            )
            .where(
                ReadingActivityRecord.user_id == user_id,
                ReadingActivityRecord.book_id.is_not(None),
            )
            .group_by(ReadingActivityRecord.book_id)
        ).all()
        return (
            [(date_key, int(seconds or 0)) for date_key, seconds in daily_rows],
            [(book_id, title, int(seconds or 0)) for book_id, title, seconds in book_rows if book_id is not None],
        )
