from typing import Protocol, cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.comments.domain import CommentTargetType, PublicComment
from app.modules.comments.models import PublicCommentRecord


class PublicCommentRepository(Protocol):
    def get(self, comment_id: str) -> PublicComment | None:
        ...

    def list_for_target(self, book_id: str, target_type: str, target_index: int | None, *, limit: int, offset: int) -> list[PublicComment]:
        ...

    def count_for_target(self, book_id: str, target_type: str, target_index: int | None) -> int:
        ...

    def count_for_book(self, book_id: str) -> int:
        ...

    def count_by_book_ids(self, book_ids: list[str]) -> dict[str, int]:
        ...

    def save(self, comment: PublicComment) -> PublicComment:
        ...


class InMemoryPublicCommentRepository:
    def __init__(self) -> None:
        self._comments: dict[str, PublicComment] = {}

    def get(self, comment_id: str) -> PublicComment | None:
        comment = self._comments.get(comment_id)
        if not comment or comment.deleted_at:
            return None
        return comment

    def list_for_target(self, book_id: str, target_type: str, target_index: int | None, *, limit: int, offset: int) -> list[PublicComment]:
        comments = [
            comment
            for comment in self._comments.values()
            if comment.book_id == book_id
            and comment.target_type == target_type
            and comment.target_index == target_index
            and comment.deleted_at is None
        ]
        return sorted(comments, key=lambda comment: comment.created_at)[offset:offset + limit]

    def count_for_target(self, book_id: str, target_type: str, target_index: int | None) -> int:
        return sum(1 for comment in self._comments.values()
            if comment.book_id == book_id and comment.target_type == target_type
            and comment.target_index == target_index and comment.deleted_at is None)

    def count_for_book(self, book_id: str) -> int:
        return sum(1 for comment in self._comments.values() if comment.book_id == book_id and comment.deleted_at is None)

    def count_by_book_ids(self, book_ids: list[str]) -> dict[str, int]:
        return {book_id: self.count_for_book(book_id) for book_id in book_ids}

    def save(self, comment: PublicComment) -> PublicComment:
        self._comments[comment.id] = comment
        return comment


class SqlAlchemyPublicCommentRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, comment_id: str) -> PublicComment | None:
        record = self._session.get(PublicCommentRecord, comment_id)
        if not record or record.deleted_at:
            return None
        return record_to_comment(record)

    def list_for_target(self, book_id: str, target_type: str, target_index: int | None, *, limit: int, offset: int) -> list[PublicComment]:
        records = self._session.scalars(
            select(PublicCommentRecord)
            .where(
                PublicCommentRecord.book_id == book_id,
                PublicCommentRecord.target_type == target_type,
                PublicCommentRecord.target_index == target_index,
                PublicCommentRecord.deleted_at.is_(None),
            )
            .order_by(PublicCommentRecord.created_at.asc())
            .offset(offset)
            .limit(limit)
        ).all()
        return [record_to_comment(record) for record in records]

    def count_for_target(self, book_id: str, target_type: str, target_index: int | None) -> int:
        return int(self._session.scalar(
            select(func.count())
            .select_from(PublicCommentRecord)
            .where(
                PublicCommentRecord.book_id == book_id,
                PublicCommentRecord.target_type == target_type,
                PublicCommentRecord.target_index == target_index,
                PublicCommentRecord.deleted_at.is_(None),
            )
        ) or 0)

    def count_for_book(self, book_id: str) -> int:
        count = self._session.scalar(
            select(func.count())
            .select_from(PublicCommentRecord)
            .where(PublicCommentRecord.book_id == book_id, PublicCommentRecord.deleted_at.is_(None))
        )
        return int(count or 0)

    def count_by_book_ids(self, book_ids: list[str]) -> dict[str, int]:
        if not book_ids:
            return {}
        rows = self._session.execute(
            select(PublicCommentRecord.book_id, func.count(PublicCommentRecord.id))
            .where(PublicCommentRecord.book_id.in_(book_ids), PublicCommentRecord.deleted_at.is_(None))
            .group_by(PublicCommentRecord.book_id)
        ).all()
        return {book_id: int(count) for book_id, count in rows}

    def save(self, comment: PublicComment) -> PublicComment:
        record = self._session.get(PublicCommentRecord, comment.id)
        if record is None:
            record = comment_to_record(comment)
            self._session.add(record)
        else:
            update_comment_record(record, comment)

        self._session.commit()
        self._session.refresh(record)
        return record_to_comment(record)


def comment_to_record(comment: PublicComment) -> PublicCommentRecord:
    return PublicCommentRecord(
        id=comment.id,
        book_id=comment.book_id,
        user_id=comment.user_id,
        target_type=comment.target_type,
        target_index=comment.target_index,
        body=comment.body,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
        deleted_at=comment.deleted_at,
    )


def update_comment_record(record: PublicCommentRecord, comment: PublicComment) -> None:
    record.body = comment.body
    record.updated_at = comment.updated_at
    record.deleted_at = comment.deleted_at


def record_to_comment(record: PublicCommentRecord) -> PublicComment:
    return PublicComment(
        id=record.id,
        book_id=record.book_id,
        user_id=record.user_id,
        target_type=cast(CommentTargetType, record.target_type),
        target_index=record.target_index,
        body=record.body,
        created_at=record.created_at,
        updated_at=record.updated_at,
        deleted_at=record.deleted_at,
    )
