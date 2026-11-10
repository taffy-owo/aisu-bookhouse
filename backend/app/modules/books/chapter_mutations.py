"""Retry receipts and optimistic concurrency for manual chapter writes."""
import logging
from pathlib import Path
import re
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.modules.books.continuation import fingerprint, lock_owned_book, read_receipt, save_receipt

logger = logging.getLogger(__name__)


class ChapterCommitUncertainError(HTTPException):
    def __init__(self):
        super().__init__(503, '暂时无法确认章节操作结果，请保留正文并使用相同内容重试核对。')


def parse_chapter_revision(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
    if not re.fullmatch('[0-9a-f]{64}', value):
        raise HTTPException(422, '章节版本无效，请重新打开编辑器')
    return value


def editable_chapter_revision(asset, title: str, content: str) -> str:
    return fingerprint({'asset_id': asset.id, 'path': asset.path, 'title': title, 'content': content})


def require_chapter_revision(asset, title: str, content: str, expected_revision: str | None):
    if expected_revision is not None and editable_chapter_revision(asset, title, content) != expected_revision:
        raise HTTPException(412, '章节已被修改或重新排序，本次操作未执行。请保留草稿，重新打开章节核对。')


def cleanup_committed_paths(paths: list[Path]):
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # Cleanup failure cannot turn a committed operation into a failed
            # write. Keep its receipt usable and leave the orphan for cleanup.
            logger.warning('Unable to remove committed chapter backup: %s', path, exc_info=True)


class ChapterMutation:
    def __init__(self, *, session, owner_id, book_id, operation, request_id: UUID | None,
                 chapter_index=None, payload=None, expected_revision=None):
        self.session = session
        self.owner_id = owner_id
        self.book_id = book_id
        # Even legacy clients need a durable proof when COMMIT itself raises.
        self.request_id = request_id or uuid4()
        self.digest = fingerprint({'operation': 'manual-chapter-' + operation, 'book_id': book_id,
                                   'chapter_index': chapter_index, 'payload': payload,
                                   'expected_revision': expected_revision})
        self.previous = None
        if session is not None:
            lock_owned_book(session, owner_id, book_id)
            self.previous = read_receipt(session, owner_id, self.request_id, self.digest)

    def replay(self, result_type):
        if self.previous is None:
            return None
        self.session.rollback()
        return result_type.model_validate(self.previous)

    def commit(self, result):
        if self.session is None:
            return result
        save_receipt(self.session, self.owner_id, self.request_id, self.digest,
                     {**result.model_dump(), 'book_id': self.book_id})
        try:
            self.session.commit()
        except Exception:
            # COMMIT can succeed before a connection/callback reports failure.
            # Reconcile on a fresh connection before restoring any book files.
            bind = self.session.get_bind()
            self.session.close()
            try:
                with Session(bind) as check:
                    # Wait for the original writer to finish before treating
                    # an absent receipt as proof that its COMMIT did not land.
                    lock_owned_book(check, self.owner_id, self.book_id)
                    previous = read_receipt(check, self.owner_id, self.request_id, self.digest)
            except Exception as error:
                raise ChapterCommitUncertainError() from error
            if previous is not None:
                return type(result).model_validate(previous)
            raise
        return result
