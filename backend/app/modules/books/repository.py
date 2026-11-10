from typing import Protocol

from sqlalchemy import and_, case, func, select, update
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.exc import OperationalError
from app.core.database_revisions import datetime_revision_matches

from app.modules.books.domain import Book
from app.modules.books.factory import create_uploaded_book
from app.modules.books.mappers import book_to_record, record_to_book, update_book_record
from app.modules.books.models import BookRecord
from app.modules.books.queries import book_filters, book_ordering, owner_reading_state
from app.modules.reading_progress.models import ReadingProgressRecord


class BookRepository(Protocol):
    def list_by_owner(self, owner_id: str) -> list[Book]:
        ...

    def list_public(self) -> list[Book]:
        ...

    def list_pending_public(self) -> list[Book]:
        ...

    def get_accessible(self, user_id: str, book_id: str) -> Book | None:
        ...

    def get_by_id(self, book_id: str) -> Book | None:
        ...

    def get_owned(self, owner_id: str, book_id: str) -> Book | None:
        ...

    def get_owned_including_deleted(self, owner_id: str, book_id: str) -> Book | None:
        ...

    def lock_revision(self, book: Book) -> None:
        ...

    def save(self, book: Book) -> Book:
        ...

    def create_from_upload(
        self,
        *,
        author: str,
        book_id: str | None = None,
        file_ext: str | None = None,
        file_label: str,
        file_size: int | None = None,
        kind: str,
        mime_type: str | None = None,
        original_file_path: str | None = None,
        owner_id: str,
        reader_type: str,
        tags: tuple[str, ...],
        title: str,
    ) -> Book:
        ...


class InMemoryBookRepository:
    def __init__(self, books: list[Book] | None = None) -> None:
        self._books = {book.id: book for book in books or []}

    def list_by_owner(self, owner_id: str) -> list[Book]:
        return [book for book in self._books.values() if book.owner_id == owner_id and book.status != "deleted"]

    def list_public(self) -> list[Book]:
        return [book for book in self._books.values() if is_publicly_available(book)]

    def list_pending_public(self) -> list[Book]:
        return [book for book in self._books.values() if book.public_status == "pending" and book.status != "deleted"]

    def get_accessible(self, user_id: str, book_id: str) -> Book | None:
        book = self._books.get(book_id)
        if not book or book.status == "deleted":
            return None
        if book.owner_id == user_id or is_publicly_available(book):
            return book
        return None

    def get_by_id(self, book_id: str) -> Book | None:
        book = self._books.get(book_id)
        if not book or book.status == "deleted":
            return None
        return book

    def get_owned(self, owner_id: str, book_id: str) -> Book | None:
        book = self._books.get(book_id)
        if not book or book.owner_id != owner_id or book.status == "deleted":
            return None
        return book

    def get_owned_including_deleted(self, owner_id: str, book_id: str) -> Book | None:
        book = self._books.get(book_id)
        return book if book and book.owner_id == owner_id else None

    def lock_revision(self, book: Book) -> None:
        current = self._books.get(book.id)
        if not current or current.status == "deleted" or current.owner_id != book.owner_id or current.updated_at != book.updated_at:
            raise HTTPException(409, "书籍内容已更新，请重新打开阅读器后再保存。")

    def save(self, book: Book) -> Book:
        self._books[book.id] = book
        return book

    def create_from_upload(
        self,
        *,
        author: str,
        book_id: str | None = None,
        file_ext: str | None = None,
        file_label: str,
        file_size: int | None = None,
        kind: str,
        mime_type: str | None = None,
        original_file_path: str | None = None,
        owner_id: str,
        reader_type: str,
        tags: tuple[str, ...],
        title: str,
    ) -> Book:
        return self.save(
            build_uploaded_book(
                author=author,
                book_id=book_id,
                file_ext=file_ext,
                file_label=file_label,
                file_size=file_size,
                kind=kind,
                mime_type=mime_type,
                original_file_path=original_file_path,
                owner_id=owner_id,
                reader_type=reader_type,
                tags=tags,
                title=title,
            )
        )


class SqlAlchemyBookRepository:
    def __init__(self, session: Session, *, autocommit: bool = True) -> None:
        self._session = session
        self._autocommit = autocommit
        self._observed_revisions = {}

    def _remember(self, record):
        self._observed_revisions.setdefault(record.id, record.updated_at)
        return record_to_book(record)

    def list_by_owner(self, owner_id: str) -> list[Book]:
        records = self._session.scalars(select(BookRecord).where(BookRecord.owner_id == owner_id, BookRecord.status != "deleted")).all()
        return [self._remember(record) for record in records]

    def owner_overview_stats(self, owner_id: str) -> tuple[int, int, int, int, int, int]:
        progress = ReadingProgressRecord
        percent, _, started = owner_reading_state()
        joined = BookRecord.__table__.outerjoin(
            progress.__table__, and_(progress.book_id == BookRecord.id, progress.user_id == owner_id)
        )
        values = self._session.execute(select(
            func.count(),
            func.sum(case((BookRecord.favorite.is_(True), 1), else_=0)),
            func.sum(case((and_(started, percent < 100), 1), else_=0)),
            func.sum(case((percent >= 100, 1), else_=0)),
            func.sum(case((BookRecord.publication_status == "ongoing", 1), else_=0)),
            func.sum(case((BookRecord.source_update_count > 0, BookRecord.source_update_count), else_=0)),
        ).select_from(joined).where(
            BookRecord.owner_id == owner_id, BookRecord.status != "deleted", BookRecord.disliked.is_(False)
        )).one()
        return tuple(int(value or 0) for value in values)

    def owner_overview_labels(self, owner_id: str) -> list[dict[str, str]]:
        rows = self._session.execute(select(BookRecord.id, BookRecord.title).where(
            BookRecord.owner_id == owner_id, BookRecord.status != "deleted", BookRecord.disliked.is_(False)
        )).all()
        return [{"id": book_id, "title": title} for book_id, title in rows]

    def list_owner_overview_books(
        self, owner_id: str, *, limit: int, updated_only: bool = False, in_progress_only: bool = False
    ) -> list[Book]:
        progress = ReadingProgressRecord
        percent, reading_time, started = owner_reading_state()
        joined = BookRecord.__table__.outerjoin(
            progress.__table__, and_(progress.book_id == BookRecord.id, progress.user_id == owner_id)
        )
        conditions = [BookRecord.owner_id == owner_id, BookRecord.status != "deleted", BookRecord.disliked.is_(False)]
        if updated_only:
            conditions.append(BookRecord.source_update_count > 0)
        if in_progress_only:
            conditions.extend((started, percent < 100))
        state = case((and_(started, percent < 100), 2), (~started, 1), else_=0)
        if not updated_only and not in_progress_only:
            state = case((started, 1), else_=0)
        records = self._session.scalars(select(BookRecord).select_from(joined).where(*conditions).order_by(
            state.desc(), reading_time.desc(),
            case((BookRecord.publication_status == "ongoing", 1), else_=0).desc(),
            BookRecord.created_at.desc(), BookRecord.id.asc(),
        ).limit(limit)).all()
        return [self._remember(record) for record in records]

    def list_owned_page(
        self, owner_id: str, *, q: str | None, kind: str | None, tag: str | None,
        language: str | None, shelf: str | None, sort: str, page: int, page_size: int,
    ) -> tuple[list[Book], int]:
        progress = ReadingProgressRecord
        percent, reading_time, started = owner_reading_state()
        conditions = [BookRecord.owner_id == owner_id, BookRecord.status != "deleted"]
        conditions.extend(book_filters(q=q, kind=kind, tag=tag, language=language,
                                       dialect=self._session.get_bind().dialect.name))
        if shelf == "disliked":
            conditions.append(BookRecord.disliked.is_(True))
        elif shelf is not None:
            conditions.append(BookRecord.disliked.is_(False))
            if shelf == "favorite":
                conditions.append(BookRecord.favorite.is_(True))
            elif shelf == "recent":
                conditions.extend((started, percent < 100))
            elif shelf == "finished":
                conditions.append(percent >= 100)
            elif shelf == "unread":
                conditions.append(~started)

        joined = BookRecord.__table__.outerjoin(
            progress.__table__, and_(progress.book_id == BookRecord.id, progress.user_id == owner_id)
        )
        filtered = select(BookRecord).select_from(joined).where(*conditions)
        total = self._session.scalar(select(func.count()).select_from(joined).where(*conditions)) or 0
        state = case((and_(started, percent < 100), 2), (~started, 1), else_=0)
        ordering = book_ordering(sort, progress=percent, recent=(
            state.desc(), reading_time.desc(),
            case((BookRecord.publication_status == "ongoing", 1), else_=0).desc(),
            BookRecord.created_at.desc(),
        ))
        records = self._session.scalars(
            filtered.order_by(*ordering, BookRecord.id.desc()).offset((page - 1) * page_size).limit(page_size)
        ).all()
        return [self._remember(record) for record in records], int(total)

    def list_public_page(
        self, *, q: str | None, kind: str | None, tag: str | None,
        language: str | None, sort: str, page: int, page_size: int,
    ) -> tuple[list[Book], int]:
        conditions = [BookRecord.public_status == "public", BookRecord.status == "ready"]
        conditions.extend(book_filters(q=q, kind=kind, tag=tag, language=language,
                                       dialect=self._session.get_bind().dialect.name))
        total = self._session.scalar(select(func.count()).select_from(BookRecord).where(*conditions)) or 0
        ordering = book_ordering(sort, progress=BookRecord.progress_percent, recent=(BookRecord.updated_at.desc(),))
        records = self._session.scalars(select(BookRecord).where(*conditions)
            .order_by(*ordering, BookRecord.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
        return [self._remember(record) for record in records], int(total)

    def list_public(self) -> list[Book]:
        records = self._session.scalars(select(BookRecord).where(BookRecord.public_status == "public", BookRecord.status == "ready")).all()
        return [self._remember(record) for record in records]

    def list_pending_public(self) -> list[Book]:
        records = self._session.scalars(select(BookRecord).where(BookRecord.public_status == "pending", BookRecord.status != "deleted")).all()
        return [self._remember(record) for record in records]

    def get_accessible(self, user_id: str, book_id: str) -> Book | None:
        record = self._session.get(BookRecord, book_id)
        if not record or record.status == "deleted":
            return None
        book = self._remember(record)
        if record.owner_id == user_id or is_publicly_available(book):
            return book
        return None

    def get_by_id(self, book_id: str) -> Book | None:
        record = self._session.get(BookRecord, book_id)
        if not record or record.status == "deleted":
            return None
        return self._remember(record)

    def get_owned(self, owner_id: str, book_id: str) -> Book | None:
        record = self._session.get(BookRecord, book_id)
        if not record or record.owner_id != owner_id or record.status == "deleted":
            return None
        return self._remember(record)

    def get_owned_including_deleted(self, owner_id: str, book_id: str) -> Book | None:
        record = self._session.get(BookRecord, book_id)
        if not record or record.owner_id != owner_id:
            return None
        return self._remember(record)

    def lock_revision(self, book: Book) -> None:
        # Hold the book's writer lock until the position/mark repository commits.
        # Validation and its dependent write must see one content revision.
        try:
            claimed = self._session.execute(update(BookRecord).where(
                BookRecord.id == book.id, BookRecord.owner_id == book.owner_id,
                BookRecord.status != "deleted",
                datetime_revision_matches(BookRecord.updated_at, book.updated_at, self._session.get_bind().dialect.name),
            ).values(updated_at=BookRecord.updated_at).execution_options(synchronize_session=False))
        except OperationalError as error:
            code = getattr(error.orig, "sqlite_errorcode", 0)
            if self._session.get_bind().dialect.name == "sqlite" and isinstance(code, int) and (code & 255) in {5, 6}:
                self._session.rollback()
                raise HTTPException(503, "书籍正在更新，请稍后重试保存。") from error
            raise
        if claimed.rowcount != 1:
            self._session.rollback()
            raise HTTPException(409, "书籍内容已更新，请重新打开阅读器后再保存。")

    def save(self, book: Book) -> Book:
        expected = self._observed_revisions.get(book.id)
        if expected is not None:
            revision_matches = datetime_revision_matches(
                BookRecord.updated_at, expected, self._session.get_bind().dialect.name)
            claimed = self._session.execute(update(BookRecord).where(BookRecord.id == book.id,
                revision_matches).values(updated_at=BookRecord.updated_at)
                .execution_options(synchronize_session=False))
            if not claimed.rowcount:
                raise HTTPException(409, "Book changed during save; reload and retry")
        record = self._session.get(BookRecord, book.id)
        if record is None:
            record = book_to_record(book)
            self._session.add(record)
        else:
            update_book_record(record, book)

        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        self._observed_revisions[book.id] = record.updated_at
        return record_to_book(record)

    def create_from_upload(
        self,
        *,
        author: str,
        book_id: str | None = None,
        file_ext: str | None = None,
        file_label: str,
        file_size: int | None = None,
        kind: str,
        mime_type: str | None = None,
        original_file_path: str | None = None,
        owner_id: str,
        reader_type: str,
        tags: tuple[str, ...],
        title: str,
    ) -> Book:
        return self.save(
            build_uploaded_book(
                author=author,
                book_id=book_id,
                file_ext=file_ext,
                file_label=file_label,
                file_size=file_size,
                kind=kind,
                mime_type=mime_type,
                original_file_path=original_file_path,
                owner_id=owner_id,
                reader_type=reader_type,
                tags=tags,
                title=title,
            )
        )


def build_uploaded_book(
    *,
    author: str,
    book_id: str | None,
    file_ext: str | None,
    file_label: str,
    file_size: int | None,
    kind: str,
    mime_type: str | None,
    original_file_path: str | None,
    owner_id: str,
    reader_type: str,
    tags: tuple[str, ...],
    title: str,
) -> Book:
    return create_uploaded_book(
        author=author,
        book_id=book_id,
        file_ext=file_ext,
        file_label=file_label,
        file_size=file_size,
        kind=kind,
        mime_type=mime_type,
        original_file_path=original_file_path,
        owner_id=owner_id,
        reader_type=reader_type,
        tags=tags,
        title=title,
    )


def is_publicly_available(book: Book) -> bool:
    return book.public_status == "public" and book.status == "ready"
