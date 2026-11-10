"""Versioned, atomic book continuation and EPUB/TXT writeback."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, update

from app.core.storage import write_bytes_file, safe_storage_segment
from app.modules.auth.models import ApiRequestRecord
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.books.models import BookRecord
from app.modules.books.original_chapter_editor import original_book_path, read_raw_editable_content
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from app.modules.reader.service import filter_readable_text_assets
from app.modules.translations.epub import append_translation_epub
from app.modules.books.translation_context import TranslationContextState, translation_context_state
from app.modules.books.source_identity import source_url_identity


class ContinuationChapter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, max_length=255)
    content: str = Field(min_length=1, max_length=1_000_000)
    source_id: str | None = Field(default=None, min_length=1, max_length=255)
    source_url: str | None = Field(default=None, min_length=1, max_length=2000)


class ContinuationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    chapters: list[ContinuationChapter] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def bounded_batch(self):
        if sum(len(chapter.content) for chapter in self.chapters) > 5_000_000:
            raise ValueError("单次续更正文不得超过 500 万字符")
        return self


class ContinuationResult(BaseModel):
    book_id: str
    revision: str
    chapter_count: int
    appended: list["AppendedChapter"]


class AppendedChapter(BaseModel):
    index: int
    title: str
    text_length: int


class CatalogChapter(BaseModel):
    index: int
    title: str
    source_id: str | None = None
    source_url: str | None = None
    content_hash: str | None = None


class ContinuationState(BaseModel):
    book_id: str
    title: str
    source_url: str | None
    revision: str
    chapter_count: int
    pending_source_indexes: list[int]
    chapters: list[CatalogChapter]
    translation_context: TranslationContextState


def fingerprint(value) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def receipt_id(owner_id: str, request_id: UUID) -> str:
    return str(uuid5(NAMESPACE_URL, f"aisu-api:{owner_id}:{request_id}"))


def read_receipt(session, owner_id, request_id, digest):
    record = session.get(ApiRequestRecord, receipt_id(owner_id, request_id), populate_existing=True)
    if record:
        if record.user_id != owner_id or record.fingerprint != digest:
            raise HTTPException(409, "request_id was already used for a different request")
        return record.response_payload
    return None


def save_receipt(session, owner_id, request_id, digest, response):
    session.add(ApiRequestRecord(id=receipt_id(owner_id, request_id), user_id=owner_id,
        fingerprint=digest, response_payload=response, created_at=datetime.now(timezone.utc)))


def lock_owned_book(session, owner_id: str, book_id: str):
    # The no-op UPDATE holds the SQLite writer lock / PostgreSQL row lock.
    claimed = session.execute(update(BookRecord).where(BookRecord.id == book_id,
        BookRecord.owner_id == owner_id, BookRecord.status != "deleted")
        .values(updated_at=BookRecord.updated_at).execution_options(synchronize_session=False))
    if not claimed.rowcount:
        raise HTTPException(404, "Book not found")
    session.expire_all()


def content_revision(book, assets) -> str:
    return fingerprint({"book_id": book.id, "original": book.original_file_path,
        "size": book.file_size, "status": book.status,
        "chapters": [{"id": asset.id, "index": asset.index, "path": asset.path, "metadata": asset.metadata} for asset in assets]})


def continuation_state(session, owner_id, book_id):
    from app.modules.books.chapter_append import get_asset_title
    book = SqlAlchemyBookRepository(session).get_owned(owner_id, book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    assets = filter_readable_text_assets(SqlAlchemyBookAssetRepository(session).list_by_book(book_id, "text_chapter"))
    return ContinuationState(book_id=book.id, title=book.title, source_url=book.source_url,
        revision=content_revision(book, assets), chapter_count=len(assets),
        pending_source_indexes=list(book.source_pending_episode_indexes),
        translation_context=translation_context_state(session, owner_id, book_id),
        chapters=[CatalogChapter(index=index, title=get_asset_title(asset, index),
            source_id=asset.metadata.get("external_source_id"),
            source_url=asset.metadata.get("source_episode_url"),
            content_hash=asset.metadata.get("content_sha256")) for index, asset in enumerate(assets, 1)])


def append_chapters(*, session, owner_id, book_id, chapters, settings, request_id=None, expected_revision=None):
    from app.modules.reading_progress.chapter_calculation import appended_progress_percent, rebase_appended_progress
    from app.modules.books.chapter_append import normalize_appended_chapter, hash_chapter_content, read_asset_content_hash, get_asset_title
    from app.modules.books.source_episode_matching import extract_episode_number
    from app.modules.processing.processors.txt_processor import CHAPTER_PATTERN, decode_text

    lock_owned_book(session, owner_id, book_id)
    book_repository = SqlAlchemyBookRepository(session, autocommit=False)
    asset_repository = SqlAlchemyBookAssetRepository(session, autocommit=False)
    progress_repository = SqlAlchemyReadingProgressRepository(session, autocommit=False)
    book = book_repository.get_owned(owner_id, book_id)
    digest = fingerprint({"operation": "append", "book_id": book_id,
        "expected_revision": expected_revision, "chapters": [c.model_dump() for c in chapters]})
    if request_id and (previous := read_receipt(session, owner_id, request_id, digest)):
        session.rollback()
        return ContinuationResult(**previous)
    from app.modules.translations.overlap import require_external_write_available
    require_external_write_available(session, owner_id, book_id, chapters)
    assets = asset_repository.list_by_book(book_id, "text_chapter")
    readable = filter_readable_text_assets(assets)
    if expected_revision is not None and content_revision(book, readable) != expected_revision:
        raise HTTPException(409, "Book revision changed; read the current continuation state")
    if book.status != "ready":
        raise HTTPException(409, "Book is not ready for chapter append")
    if not (book.reader_type == "epub" or book.reader_type == "text" and (book.file_ext or "").lower() == ".txt"):
        raise HTTPException(400, "Only EPUB and TXT support original-file chapter append")
    original = original_book_path(book, settings)
    hashes = {a.metadata.get("content_sha256") or read_asset_content_hash(a.path, settings, get_asset_title(a, i)) for i, a in enumerate(assets, 1)}
    source_ids = {a.metadata.get("external_source_id") for a in assets}
    source_urls = {source_url_identity(a.metadata.get("source_episode_url")) for a in assets}
    # Accepted source identities and full-body hashes survive TXT splitting or
    # reparsing even when the processor has replaced the original asset IDs.
    if request_id:
        history = session.scalars(select(ApiRequestRecord.response_payload).where(
            ApiRequestRecord.user_id == owner_id,
            ApiRequestRecord.response_payload["book_id"].as_string() == book_id))
        for receipt in history:
            for proof in receipt.get("_source_proofs", []):
                hashes.add(proof["hash"])
                if proof.get("source_id"):
                    source_ids.add(proof["source_id"])
                if proof.get("source_url"):
                    source_urls.add(source_url_identity(proof["source_url"]))
    normalized = []
    for offset, chapter in enumerate(chapters, 1):
        title, content = normalize_appended_chapter(chapter.title, chapter.content, len(readable) + offset)
        if book.reader_type == "text" and not CHAPTER_PATTERN.fullmatch(title):
            title = f"第{len(readable) + offset}章 {title}"
            if len(title) > 255:
                raise HTTPException(422, "TXT chapter title exceeds 255 characters after numbering")
        content_hash = hash_chapter_content(content)
        if (content_hash in hashes
            or chapter.source_id and chapter.source_id in source_ids
            or chapter.source_url and source_url_identity(chapter.source_url) in source_urls):
            raise HTTPException(409, "Chapter content or source identity already exists")
        hashes.add(content_hash)
        if chapter.source_id:
            source_ids.add(chapter.source_id)
        if chapter.source_url:
            source_urls.add(source_url_identity(chapter.source_url))
        normalized.append((title, content, content_hash, chapter))
    # Upgrade old reader-only sidecars when the original is next appended.
    legacy = [a for a in readable if a.metadata.get("source") == "manual_append"]
    documents = [{"index": a.index, "title": get_asset_title(a, i), "paragraphs": read_raw_editable_content(a, get_asset_title(a, i), settings).split("\n\n"),
                  "source_id": a.metadata.get('external_source_id'), "source_url": a.metadata.get('source_episode_url')} for i, a in enumerate(legacy, 1)]
    documents.extend({"index": len(readable) + i, "title": title, "paragraphs": content.split("\n\n"),
                      "source_id": chapter.source_id, "source_url": chapter.source_url} for i, (title, content, _, chapter) in enumerate(normalized, 1))
    appended_paths = []
    try:
        if book.reader_type == "epub":
            data = append_translation_epub(original_epub=original.read_bytes(), chapters=documents, appended_paths=appended_paths)
        else:
            text = decode_text(original.read_bytes()).rstrip()
            data = (text + "\n\n" + "\n\n".join(str(d["title"]) + "\n\n" + "\n\n".join(d["paragraphs"]) for d in documents) + "\n").encode("utf-8")
            appended_paths = ["txt_append"] * len(documents)
    except (ValueError, KeyError) as error:
        raise HTTPException(409, "Original file cannot be appended") from error
    if len(data) > settings.max_upload_size_bytes:
        raise HTTPException(413, "Updated original exceeds the file size limit")
    relative_version = Path("originals") / safe_storage_segment(owner_id) / safe_storage_segment(book_id) / "versions" / uuid4().hex / ("original" + (book.file_ext or ".epub"))
    created_files = []
    results = []
    try:
        stored_version = write_bytes_file(data=data, relative_path=relative_version, settings=settings)
        created_files.append(stored_version.absolute_path)
        for asset, source in zip(legacy, appended_paths):
            asset_repository.update_metadata(asset.id, {**asset.metadata, "source": source})
        next_asset_index = max((a.index or 0 for a in assets), default=0)
        pending = list(book.source_pending_episode_indexes)
        for offset, (title, content, content_hash, chapter) in enumerate(normalized, 1):
            stored = write_bytes_file(data=content.encode("utf-8"), settings=settings,
                relative_path=Path("originals") / safe_storage_segment(owner_id) / safe_storage_segment(book_id) / "manual-chapters" / f"chapter-{next_asset_index + offset:04d}-{uuid4().hex}.txt")
            created_files.append(stored.absolute_path)
            asset_repository.save(create_book_asset(asset_type="text_chapter", book_id=book_id,
                index=next_asset_index + offset, path=stored.relative_path,
                metadata={"title": title, "source": appended_paths[len(legacy) + offset - 1],
                    "text_length": len(content), "content_sha256": content_hash,
                    "external_source_id": chapter.source_id, "source_episode_url": chapter.source_url}))
            episode = extract_episode_number(title)
            if episode in pending:
                pending.remove(episode)
            results.append({"index": len(readable) + offset, "title": title, "text_length": len(content)})
        count = len(readable) + len(normalized)
        current = filter_readable_text_assets(asset_repository.list_by_book(book_id, "text_chapter"))
        book_repository.save(book.with_changes(original_file_path=relative_version.as_posix(), file_size=len(data), current_chapter=results[-1]["title"],
            progress_percent=appended_progress_percent(book.progress_percent, readable, current),
            source_pending_episode_indexes=tuple(pending),
            source_update_count=len(pending) if book.source_pending_episode_indexes else max(0, book.source_update_count - len(normalized))))
        rebase_appended_progress(book_id, readable, current, progress_repository)
        state = continuation_state(session, owner_id, book_id)
        result = ContinuationResult(book_id=book_id, revision=state.revision, chapter_count=count, appended=results)
        if request_id:
            receipt = {**result.model_dump(), "_source_proofs": [
                {"hash": content_hash, "source_id": chapter.source_id, "source_url": chapter.source_url}
                for _, _, content_hash, chapter in normalized]}
            save_receipt(session, owner_id, request_id, digest, receipt)
        session.flush()
        session.commit()
    except Exception:
        session.rollback()
        for path in created_files:
            path.unlink(missing_ok=True)
        raise
    return result
