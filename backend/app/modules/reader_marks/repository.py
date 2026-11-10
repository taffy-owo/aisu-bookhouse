from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.modules.reader_marks.domain import ReaderMark
from app.modules.reader_marks.models import ReaderMarkRecord


class ReaderMarkRepository(Protocol):
    def list_all_for_book(self, book_id: str) -> list[ReaderMark]:
        ...

    def delete(self, user_id: str, mark_id: str) -> bool:
        ...

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        ...

    def get(self, user_id: str, mark_id: str) -> ReaderMark | None:
        ...

    def list_for_book(self, user_id: str, book_id: str) -> list[ReaderMark]:
        ...

    def save(self, mark: ReaderMark) -> ReaderMark:
        ...

    def rebase_position(self, previous: ReaderMark, current: ReaderMark) -> None:
        ...


class InMemoryReaderMarkRepository:
    def __init__(self) -> None:
        self._marks_by_id: dict[str, ReaderMark] = {}

    def delete(self, user_id: str, mark_id: str) -> bool:
        mark = self.get(user_id, mark_id)
        if not mark:
            return False

        self._marks_by_id.pop(mark_id, None)
        return True

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        self._marks_by_id = {
            mark_id: mark
            for mark_id, mark in self._marks_by_id.items()
            if mark.user_id != user_id or mark.book_id != book_id
        }

    def get(self, user_id: str, mark_id: str) -> ReaderMark | None:
        mark = self._marks_by_id.get(mark_id)
        if not mark or mark.user_id != user_id:
            return None
        return mark

    def list_for_book(self, user_id: str, book_id: str) -> list[ReaderMark]:
        marks = [mark for mark in self._marks_by_id.values() if mark.user_id == user_id and mark.book_id == book_id]
        return sorted(marks, key=get_reader_mark_sort_key)

    def list_all_for_book(self, book_id: str) -> list[ReaderMark]:
        return [mark for mark in self._marks_by_id.values() if mark.book_id == book_id]

    def save(self, mark: ReaderMark) -> ReaderMark:
        existing = self._marks_by_id.get(mark.id)
        if existing and existing.updated_at and mark.updated_at and mark.updated_at <= existing.updated_at:
            return existing
        self._marks_by_id[mark.id] = mark
        return mark

    def rebase_position(self, previous: ReaderMark, current: ReaderMark) -> None:
        require_same_note(previous, current)
        if self._marks_by_id.get(previous.id) == previous:
            self._marks_by_id[previous.id] = current


class SqlAlchemyReaderMarkRepository:
    def __init__(self, session: Session, *, autocommit: bool = True) -> None:
        self._session = session
        self._autocommit = autocommit

    def delete(self, user_id: str, mark_id: str) -> bool:
        mark = self.get(user_id, mark_id)
        if not mark:
            return False

        self._session.execute(delete(ReaderMarkRecord).where(ReaderMarkRecord.id == mark_id, ReaderMarkRecord.user_id == user_id))
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        return True

    def delete_for_book(self, user_id: str, book_id: str, *, commit: bool = True) -> None:
        self._session.execute(delete(ReaderMarkRecord).where(ReaderMarkRecord.user_id == user_id, ReaderMarkRecord.book_id == book_id))
        if commit:
            self._session.commit()

    def get(self, user_id: str, mark_id: str) -> ReaderMark | None:
        record = self._session.get(ReaderMarkRecord, mark_id, populate_existing=True)
        if not record or record.user_id != user_id:
            return None
        return record_to_mark(record)

    def list_for_book(self, user_id: str, book_id: str) -> list[ReaderMark]:
        records = self._session.scalars(
            select(ReaderMarkRecord)
            .where(ReaderMarkRecord.user_id == user_id, ReaderMarkRecord.book_id == book_id)
            .order_by(
                ReaderMarkRecord.chapter_index.asc().nulls_last(),
                ReaderMarkRecord.image_index.asc().nulls_last(),
                ReaderMarkRecord.page_number.asc().nulls_last(),
                ReaderMarkRecord.created_at.asc(),
            )
        ).all()
        return [record_to_mark(record) for record in records]

    def list_all_for_book(self, book_id: str) -> list[ReaderMark]:
        records = self._session.scalars(select(ReaderMarkRecord).where(ReaderMarkRecord.book_id == book_id)).all()
        return [record_to_mark(record) for record in records]

    def save(self, mark: ReaderMark) -> ReaderMark:
        record = self._session.scalar(
            select(ReaderMarkRecord).where(ReaderMarkRecord.id == mark.id).execution_options(populate_existing=True)
        )
        if record is None:
            record = mark_to_record(mark)
            self._session.add(record)
        else:
            existing_updated_at = normalize_datetime(record.updated_at)
            incoming_updated_at = normalize_datetime(mark.updated_at)
            if existing_updated_at and incoming_updated_at and incoming_updated_at <= existing_updated_at:
                return record_to_mark(record)
            update_mark_record(record, mark)

        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        return record_to_mark(record)


    def rebase_position(self, previous: ReaderMark, current: ReaderMark) -> None:
        require_same_note(previous, current)
        # Moving a chapter is not an edit to the reader's note. A conditional
        # update also lets a newer note, relocation or deletion win.
        conditions = [getattr(ReaderMarkRecord, name) == getattr(previous, name)
                      for name in previous.__dataclass_fields__]
        self._session.execute(update(ReaderMarkRecord).where(*conditions).values(
            chapter_index=current.chapter_index, image_index=current.image_index,
            page_number=current.page_number, epub_cfi=current.epub_cfi,
            position_key=current.position_key, position_valid=current.position_valid,
            progress_percent=current.progress_percent).execution_options(synchronize_session=False))
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        for record in list(self._session.identity_map.values()):
            if isinstance(record, ReaderMarkRecord) and record.id == previous.id:
                self._session.expire(record)


def require_same_note(previous: ReaderMark, current: ReaderMark) -> None:
    fields = ("id", "user_id", "book_id", "reader_type", "kind", "note", "label", "created_at", "updated_at")
    if any(getattr(previous, name) != getattr(current, name) for name in fields):
        raise ValueError("A catalog rebase must preserve note content and edit timestamps")


def get_reader_mark_sort_key(mark: ReaderMark) -> tuple[int, int, int, str]:
    return (
        mark.chapter_index or 0,
        mark.image_index or 0,
        mark.page_number or 0,
        mark.created_at.isoformat() if mark.created_at else "",
    )


def mark_to_record(mark: ReaderMark) -> ReaderMarkRecord:
    return ReaderMarkRecord(
        id=mark.id,
        user_id=mark.user_id,
        book_id=mark.book_id,
        reader_type=mark.reader_type,
        kind=mark.kind,
        note=mark.note,
        label=mark.label,
        position_key=mark.position_key,
        position_valid=mark.position_valid,
        chapter_index=mark.chapter_index,
        image_index=mark.image_index,
        page_number=mark.page_number,
        epub_cfi=mark.epub_cfi,
        progress_percent=mark.progress_percent,
        created_at=mark.created_at,
        updated_at=mark.updated_at,
    )


def update_mark_record(record: ReaderMarkRecord, mark: ReaderMark) -> None:
    record.reader_type = mark.reader_type
    record.kind = mark.kind
    record.note = mark.note
    record.label = mark.label
    record.position_key = mark.position_key
    record.position_valid = mark.position_valid
    record.chapter_index = mark.chapter_index
    record.image_index = mark.image_index
    record.page_number = mark.page_number
    record.epub_cfi = mark.epub_cfi
    record.progress_percent = mark.progress_percent
    record.updated_at = mark.updated_at


def record_to_mark(record: ReaderMarkRecord) -> ReaderMark:
    return ReaderMark(
        id=record.id,
        user_id=record.user_id,
        book_id=record.book_id,
        reader_type=record.reader_type,
        kind=record.kind,
        note=record.note,
        label=record.label,
        position_key=record.position_key,
        position_valid=record.position_valid,
        chapter_index=record.chapter_index,
        image_index=record.image_index,
        page_number=record.page_number,
        epub_cfi=record.epub_cfi,
        progress_percent=record.progress_percent,
        created_at=normalize_datetime(record.created_at),
        updated_at=normalize_datetime(record.updated_at),
    )


def normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value
