"""Commit file operations and their retry receipts in one transaction."""
from hashlib import sha256
import shutil
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.storage import get_storage_root, safe_storage_segment
from app.modules.books.continuation import fingerprint, read_receipt, save_receipt
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.uploads.repository import SqlAlchemyUploadTaskRepository
from app.modules.uploads.schemas import UploadBookResponse
from app.modules.uploads.service import (cleanup_replacement_task, create_replace_task_for_book,
    create_reprocess_task_for_book, create_upload_task_from_file)
from app.modules.users.models import UserRecord


class UploadCommitUncertainError(HTTPException):
    def __init__(self):
        super().__init__(503, "暂时无法确认文件处理任务是否已保存，请稍后使用同一文件重试。")


async def file_fingerprint(file, settings):
    digest = sha256()
    size = 0
    await file.seek(0)
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > settings.max_upload_size_bytes:
            raise HTTPException(413, "File exceeds the upload size limit")
        digest.update(chunk)
    await file.seek(0)
    return {"file_hash": digest.hexdigest(), "file_name": file.filename, "content_type": file.content_type}


def replay_response(session, owner_id, request_id, payload_hash):
    session.execute(update(UserRecord).where(UserRecord.id == owner_id).values(id=UserRecord.id))
    previous = read_receipt(session, owner_id, request_id, payload_hash)
    if previous:
        session.rollback()
        return UploadBookResponse(**previous)
    return None


def commit_response(session, owner_id, request_id, payload_hash, result):
    save_receipt(session, owner_id, request_id, payload_hash, result.model_dump())
    try:
        session.commit()
    except Exception:
        # A callback/connection failure after COMMIT must not delete files that
        # the committed task now references. Close the uncertain transaction,
        # then reconcile its durable receipt using a fresh connection.
        bind = session.get_bind()
        session.close()
        try:
            with Session(bind) as check:
                previous = read_receipt(check, owner_id, request_id, payload_hash)
        except Exception as error:
            raise UploadCommitUncertainError() from error
        if previous:
            return UploadBookResponse(**previous)
        raise
    return result


async def create_idempotent_upload(*, session, request_id, owner_id, file, settings, **metadata):
    payload_hash = fingerprint({"operation": "upload", **await file_fingerprint(file, settings), "metadata": metadata})
    book_id = str(uuid4())
    try:
        if previous := replay_response(session, owner_id, request_id, payload_hash):
            return previous, True
        result = await create_upload_task_from_file(owner_id=owner_id, book_id=book_id, file=file,
            settings=settings, book_repository=SqlAlchemyBookRepository(session, autocommit=False),
            upload_task_repository=SqlAlchemyUploadTaskRepository(session, autocommit=False), **metadata)
        return commit_response(session, owner_id, request_id, payload_hash, result), False
    except UploadCommitUncertainError:
        raise
    except Exception:
        session.rollback()
        root = get_storage_root(settings).resolve()
        directory = (root / "originals" / safe_storage_segment(owner_id) / safe_storage_segment(book_id)).resolve()
        if root in directory.parents and directory.is_dir():
            shutil.rmtree(directory)
        raise


async def create_idempotent_replacement(*, session, request_id, owner_id, book_id, file, keep_progress, settings):
    payload_hash = fingerprint({"operation": "replace", "book_id": book_id, "keep_progress": keep_progress,
        **await file_fingerprint(file, settings)})
    task_id = str(uuid4())
    try:
        if previous := replay_response(session, owner_id, request_id, payload_hash):
            return previous, True
        result = await create_replace_task_for_book(owner_id=owner_id, book_id=book_id, task_id=task_id,
            file=file, keep_progress=keep_progress, settings=settings,
            book_repository=SqlAlchemyBookRepository(session, autocommit=False),
            upload_task_repository=SqlAlchemyUploadTaskRepository(session, autocommit=False))
        if result is None:
            raise HTTPException(404, "Book not found")
        return commit_response(session, owner_id, request_id, payload_hash, result), False
    except UploadCommitUncertainError:
        raise
    except Exception:
        session.rollback()
        cleanup_replacement_task(owner_id=owner_id, book_id=book_id, task_id=task_id, settings=settings)
        raise


def create_idempotent_reprocess(*, session, request_id, owner_id, book_id):
    payload_hash = fingerprint({"operation": "reprocess", "book_id": book_id})
    try:
        if previous := replay_response(session, owner_id, request_id, payload_hash):
            return previous, True
        result = create_reprocess_task_for_book(owner_id=owner_id, book_id=book_id,
            book_repository=SqlAlchemyBookRepository(session, autocommit=False),
            upload_task_repository=SqlAlchemyUploadTaskRepository(session, autocommit=False))
        if result is None:
            raise HTTPException(404, "Book not found")
        return commit_response(session, owner_id, request_id, payload_hash, result), False
    except UploadCommitUncertainError:
        raise
    except Exception:
        session.rollback()
        raise
