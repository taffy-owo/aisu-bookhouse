from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import os
from pathlib import Path
import re
from uuid import UUID, uuid4

from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment, write_bytes_file
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import BookAssetRepository, SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.books.original_chapter_editor import (
    CHAPTER_IMAGE_MARKER_RE,
    is_original_writeback_supported,
    original_book_path,
    read_raw_editable_content,
    require_original_writeback_supported,
    stage_original_book_delete,
    stage_original_book_rewrite,
)
from app.modules.books.repository import BookRepository, SqlAlchemyBookRepository
from app.modules.books.chapter_mutations import ChapterCommitUncertainError, ChapterMutation, cleanup_committed_paths, editable_chapter_revision, require_chapter_revision
from app.modules.books.schemas import BookChapterAppend, BookChapterAppendResult, BookChapterDeleteResult, BookEditableChapter, BookEditableChapterContent
from app.modules.books.source_episode_matching import extract_episode_number
from app.modules.processing.chapter_headings import CHAPTER_PATTERN
from app.modules.reader.service import filter_readable_text_assets, strip_leading_chapter_title
from app.modules.reader_marks.repository import ReaderMarkRepository, SqlAlchemyReaderMarkRepository
from app.modules.reading_progress.chapter_calculation import appended_progress_percent, rebase_appended_progress, rebase_edited_progress, progress_after_chapter_delete
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import ReadingProgressRepository, SqlAlchemyReadingProgressRepository


def append_book_chapter(
    *,
    owner_id: str,
    book_id: str,
    payload: BookChapterAppend,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    progress_repository: ReadingProgressRepository,
    settings: Settings,
    request_id: UUID | None = None,
) -> BookChapterAppendResult | None:
    session = getattr(book_repository, '_session', None)
    mutation = ChapterMutation(session=session, owner_id=owner_id, book_id=book_id,
                               operation='append', request_id=request_id, payload=payload.model_dump())
    if previous := mutation.replay(BookChapterAppendResult):
        return previous
    if session is not None:
        from app.modules.translations.overlap import require_external_write_available
        require_external_write_available(session, owner_id, book_id, allow_stopped_file_operation=True)
        book_repository = SqlAlchemyBookRepository(session, autocommit=False)
        asset_repository = SqlAlchemyBookAssetRepository(session, autocommit=False)
        progress_repository = SqlAlchemyReadingProgressRepository(session, autocommit=False)
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if book.reader_type not in {"epub", "text"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only text novels support chapter append")
    if book.status != "ready":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Book is not ready for chapter append")

    chapters = asset_repository.list_by_book(book.id, "text_chapter")
    next_asset_index = max((asset.index or 0 for asset in chapters), default=0) + 1
    next_reader_index = len(filter_readable_text_assets(chapters)) + 1
    title, content = normalize_appended_chapter(payload.title, payload.content, next_reader_index, content_is_body=payload.content_is_body)
    content_hash = hash_chapter_content(content)

    for asset in chapters:
        stored_hash = asset.metadata.get("content_sha256")
        asset_title = asset.metadata.get("title")
        if stored_hash == content_hash or (
            stored_hash is None
            and read_asset_content_hash(asset.path, settings, asset_title if isinstance(asset_title, str) else None) == content_hash
        ):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="这段正文已经存在，请勿重复追加")

    readable = filter_readable_text_assets(chapters)
    stored_text = write_bytes_file(
        data=content.encode("utf-8"),
        relative_path=Path("originals") / safe_storage_segment(book.owner_id) / safe_storage_segment(book.id) / "manual-chapters" / f"chapter-{next_asset_index:04d}-{uuid4().hex}.txt",
        settings=settings,
    )
    asset = create_book_asset(
        asset_type="text_chapter",
        book_id=book.id,
        index=next_asset_index,
        metadata={
            "content_sha256": content_hash,
            "content_is_body": True,
            "source": "manual_append",
            "text_length": len(content),
            "title": title,
        },
        path=stored_text.relative_path,
    )
    current = [*readable, asset]
    next_book_progress = appended_progress_percent(book.progress_percent, readable, current)
    episode_number = extract_episode_number(title)
    pending_indexes = tuple(
        index
        for index in book.source_pending_episode_indexes
        if episode_number is None or index != episode_number
    )
    next_update_count = (
        len(pending_indexes)
        if book.source_pending_episode_indexes
        else max(0, book.source_update_count - 1)
    )
    try:
        asset_repository.save(asset)
        book_repository.save(
            book.with_changes(
                current_chapter=title,
                progress_percent=next_book_progress,
                source_pending_episode_indexes=pending_indexes,
                source_update_count=next_update_count,
            )
        )
        rebase_appended_progress(book.id, readable, current, progress_repository)
        return mutation.commit(BookChapterAppendResult(chapter_count=next_reader_index, index=next_reader_index, text_length=len(content), title=title))
    except ChapterCommitUncertainError:
        raise
    except Exception:
        if session is not None:
            session.rollback()
        stored_text.absolute_path.unlink(missing_ok=True)
        raise


def list_editable_book_chapters(
    *,
    owner_id: str,
    book_id: str,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    settings: Settings,
) -> list[BookEditableChapter] | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    editable_chapters = [
        BookEditableChapter(index=index, title=get_asset_title(asset, index))
        for index, asset in enumerate(filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter")), start=1)
        if is_original_writeback_supported(book, asset)
    ]
    if editable_chapters:
        original_book_path(book, settings)
    return editable_chapters


def get_editable_book_chapter(
    *,
    owner_id: str,
    book_id: str,
    chapter_index: int,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    settings: Settings,
) -> BookEditableChapterContent | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if book.status != "ready":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="图书尚未处理完成")

    readable_chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    if chapter_index < 1 or chapter_index > len(readable_chapters):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
    asset = readable_chapters[chapter_index - 1]
    require_original_writeback_supported(book, asset)
    original_book_path(book, settings)
    title = get_asset_title(asset, chapter_index)
    content = read_raw_editable_content(asset, title, settings)
    return BookEditableChapterContent(
        content=content,
        revision=editable_chapter_revision(asset, title, content),
        format="epub" if book.reader_type == "epub" else "text",
        has_images=bool(CHAPTER_IMAGE_MARKER_RE.search(content)),
        index=chapter_index,
        title=title,
    )


def update_book_chapter(
    *,
    owner_id: str,
    book_id: str,
    chapter_index: int,
    payload: BookChapterAppend,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    settings: Settings,
    request_id: UUID | None = None,
    expected_revision: str | None = None,
    progress_repository: ReadingProgressRepository | None = None,
    mark_repository: ReaderMarkRepository | None = None,
) -> BookChapterAppendResult | None:
    session = getattr(book_repository, "_session", None)
    mutation = ChapterMutation(session=session, owner_id=owner_id, book_id=book_id, operation='update',
                               request_id=request_id, chapter_index=chapter_index, payload=payload.model_dump(), expected_revision=expected_revision)
    if previous := mutation.replay(BookChapterAppendResult):
        return previous
    if session is not None:
        from app.modules.translations.overlap import require_external_write_available
        require_external_write_available(session, owner_id, book_id, allow_stopped_file_operation=True)
        book_repository = SqlAlchemyBookRepository(session, autocommit=False)
        asset_repository = SqlAlchemyBookAssetRepository(session, autocommit=False)
        progress_repository = SqlAlchemyReadingProgressRepository(session, autocommit=False)
        mark_repository = SqlAlchemyReaderMarkRepository(session, autocommit=False)
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if book.reader_type not in {"epub", "text"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only text novels support chapter editing")
    if book.status != "ready":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Book is not ready for chapter editing")

    chapters = asset_repository.list_by_book(book.id, "text_chapter")
    readable_chapters = filter_readable_text_assets(chapters)
    if chapter_index < 1 or chapter_index > len(readable_chapters):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")

    asset = readable_chapters[chapter_index - 1]
    require_original_writeback_supported(book, asset)
    require_chapter_revision(asset, get_asset_title(asset, chapter_index),
                             read_raw_editable_content(asset, get_asset_title(asset, chapter_index), settings), expected_revision)

    title, content = normalize_edited_chapter(payload.title or get_asset_title(asset, chapter_index), payload.content, chapter_index)
    content_hash = hash_chapter_content(content)
    for candidate in chapters:
        if candidate.id == asset.id:
            continue
        stored_hash = candidate.metadata.get("content_sha256")
        candidate_title = candidate.metadata.get("title")
        if stored_hash == content_hash or (
            stored_hash is None
            and read_asset_content_hash(candidate.path, settings, candidate_title if isinstance(candidate_title, str) else None) == content_hash
        ):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="这段正文已经存在，请勿保存重复章节")

    path = resolve_storage_path(get_storage_root(settings), asset.path)
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter file not found")

    previous_content = path.read_bytes()
    old_body = strip_leading_chapter_title(previous_content.decode("utf-8"), get_asset_title(asset, chapter_index), content_is_body=asset.metadata.get("content_is_body") is True)
    if sorted(CHAPTER_IMAGE_MARKER_RE.findall(old_body)) != sorted(CHAPTER_IMAGE_MARKER_RE.findall(content)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请保留正文中的全部插画占位符，不能删除、增加或修改编号")

    original_path, staged_original = stage_original_book_rewrite(
        all_assets=readable_chapters,
        book=book,
        chapter_asset=asset,
        chapter_images=asset_repository.list_by_book(book.id, "chapter_image"),
        content=content,
        settings=settings,
        title=title,
    )
    saved_progresses = progress_repository.list_all_for_book(book.id) if progress_repository else []
    # A chapter id survives in-place edits, but its old scroll ratios no longer
    # identify the same prose. Retire just those coordinates, never the note.
    saved_marks = [mark for mark in mark_repository.list_all_for_book(book.id)
                   if mark.position_valid and mark.reader_type == book.reader_type
                   and (mark.position_key == asset.id if mark.position_key is not None else mark.chapter_index == chapter_index)] \
        if mark_repository and old_body.strip() != content.strip() else []
    created_paths: list[Path] = []
    blocks_path_value = asset.metadata.get("blocks_path")
    blocks_path = resolve_storage_path(get_storage_root(settings), blocks_path_value) if isinstance(blocks_path_value, str) else None
    metadata = {
        **asset.metadata,
        "content_is_body": True,
        "content_sha256": content_hash,
        "text_length": len(content),
        "title": title,
    }
    result = BookChapterAppendResult(chapter_count=len(readable_chapters), index=chapter_index, text_length=len(content), title=title)
    try:
        original_relative, version_path = publish_original_version(book, staged_original, settings, created_paths)
        chapter_relative = Path(original_relative).with_name('chapter.txt')
        chapter_path = resolve_storage_path(get_storage_root(settings), chapter_relative)
        created_paths.append(chapter_path)
        write_bytes_file(data=content.encode('utf-8'), relative_path=chapter_relative, settings=settings)
        if blocks_path:
            blocks_relative = Path(original_relative).with_name('chapter-blocks.json')
            created_paths.append(resolve_storage_path(get_storage_root(settings), blocks_relative))
            write_bytes_file(data=build_plain_blocks_sidecar(content), relative_path=blocks_relative, settings=settings)
            metadata['blocks_path'] = blocks_relative.as_posix()
        asset_repository.update_metadata(asset.id, metadata, path=chapter_relative.as_posix())
        if progress_repository:
            current_chapters = [replace(chapter, metadata=metadata) if chapter.id == asset.id else chapter for chapter in readable_chapters]
            rebase_edited_progress(book.id, book.reader_type, current_chapters, progress_repository)
        for mark in saved_marks:
            mark_repository.rebase_position(mark, replace(mark, position_valid=False))
        next_current_chapter = title if chapter_index == len(readable_chapters) else book.current_chapter
        book_repository.save(book.with_changes(current_chapter=next_current_chapter, file_size=version_path.stat().st_size,
                                               original_file_path=original_relative))
        result = mutation.commit(result)
    except ChapterCommitUncertainError:
        raise
    except Exception:
        if session is not None:
            session.rollback()
        else:
            try:
                asset_repository.update_metadata(asset.id, asset.metadata, path=asset.path)
                book_repository.save(book)
                if progress_repository:
                    for previous in saved_progresses:
                        current = progress_repository.get(previous.user_id, book.id)
                        if current and current.updated_at == previous.updated_at:
                            progress_repository.rebase_position(current, previous)
                for mark in saved_marks:
                    mark_repository.rebase_position(replace(mark, position_valid=False), mark)
            except Exception:
                pass
        cleanup_committed_paths(created_paths)
        raise
    finally:
        staged_original.unlink(missing_ok=True)
    return result


def delete_book_chapter(
    *,
    owner_id: str,
    book_id: str,
    chapter_index: int,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    mark_repository: ReaderMarkRepository,
    progress_repository: ReadingProgressRepository,
    settings: Settings,
    request_id: UUID | None = None,
    expected_revision: str | None = None,
) -> BookChapterDeleteResult | None:
    session = getattr(book_repository, "_session", None)
    mutation = ChapterMutation(session=session, owner_id=owner_id, book_id=book_id, operation='delete',
                               request_id=request_id, chapter_index=chapter_index, expected_revision=expected_revision)
    if previous := mutation.replay(BookChapterDeleteResult):
        return previous
    if session is not None:
        from app.modules.translations.overlap import require_external_write_available
        require_external_write_available(session, owner_id, book_id, allow_stopped_file_operation=True)
        book_repository = SqlAlchemyBookRepository(session, autocommit=False)
        asset_repository = SqlAlchemyBookAssetRepository(session, autocommit=False)
        progress_repository = SqlAlchemyReadingProgressRepository(session, autocommit=False)
        mark_repository = SqlAlchemyReaderMarkRepository(session, autocommit=False)
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if book.reader_type not in {"epub", "text"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="当前格式不支持删除章节")
    if book.status != "ready":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="图书尚未处理完成")

    chapters = asset_repository.list_by_book(book.id, "text_chapter")
    readable_chapters = filter_readable_text_assets(chapters)
    if chapter_index < 1 or chapter_index > len(readable_chapters):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
    if len(readable_chapters) <= 1:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="一本书至少需要保留一话；如不需要这本书，请删除整本书")

    asset = readable_chapters[chapter_index - 1]
    require_original_writeback_supported(book, asset)
    require_chapter_revision(asset, get_asset_title(asset, chapter_index),
                             read_raw_editable_content(asset, get_asset_title(asset, chapter_index), settings), expected_revision)
    original_path, staged_original = stage_original_book_delete(
        all_assets=readable_chapters,
        book=book,
        chapter_asset=asset,
        settings=settings,
    )
    remaining_chapters = [candidate for candidate in readable_chapters if candidate.id != asset.id]
    # Asset order includes hidden front matter. Reader positions are a separate
    # coordinate system and must never be written back as raw asset indexes.
    remaining_assets = [candidate for candidate in chapters if candidate.id != asset.id]
    source = asset.metadata.get("source")
    related_images = [
        image
        for image in asset_repository.list_by_book(book.id, "chapter_image")
        if isinstance(source, str) and image.metadata.get("document") == source
    ]
    saved_progresses = progress_repository.list_all_for_book(book.id)
    saved_marks = mark_repository.list_all_for_book(book.id)
    removed_paths = _asset_storage_paths([asset, *related_images], settings)
    created_paths: list[Path] = []
    result = BookChapterDeleteResult(chapter_count=len(remaining_chapters), deleted_index=chapter_index,
                                     next_index=min(chapter_index, len(remaining_chapters)))
    try:
        original_relative, version_path = publish_original_version(book, staged_original, settings, created_paths)
        asset_repository.delete(asset.id)
        for image in related_images:
            asset_repository.delete(image.id)
        for next_index, remaining in enumerate(remaining_assets, start=1):
            if remaining.index != next_index:
                asset_repository.update_index(remaining.id, next_index)

        next_owner_progress = None
        for saved_progress in saved_progresses:
            if saved_progress.reader_type != book.reader_type:
                continue
            next_progress = progress_after_chapter_delete(saved_progress, chapter_index, readable_chapters, remaining_chapters)
            if next_progress != saved_progress:
                progress_repository.rebase_position(saved_progress, next_progress)
            if next_progress.user_id == owner_id:
                next_owner_progress = next_progress
        for mark in saved_marks:
            if not mark.position_valid or mark.reader_type != book.reader_type:
                continue
            if mark.chapter_index == chapter_index:
                mark_repository.rebase_position(mark, replace(mark, position_valid=False))
            elif mark.chapter_index and mark.chapter_index > chapter_index:
                mark_repository.rebase_position(mark, replace(mark, chapter_index=mark.chapter_index - 1))

        next_reader_index = min(chapter_index, len(remaining_chapters))
        next_title = get_asset_title(remaining_chapters[next_reader_index - 1], next_reader_index)
        next_book_progress = next_owner_progress.progress_percent if next_owner_progress else book.progress_percent
        book_repository.save(
            book.with_changes(
                current_chapter=next_title if book.current_chapter == get_asset_title(asset, chapter_index) else book.current_chapter,
                file_size=version_path.stat().st_size,
                original_file_path=original_relative,
                progress_percent=next_book_progress,
            )
        )
        result = mutation.commit(result)
    except ChapterCommitUncertainError:
        raise
    except Exception:
        if session is not None:
            session.rollback()
            cleanup_committed_paths(created_paths)
            raise
        try:
            asset_repository.save(asset)
            for image in related_images:
                asset_repository.save(image)
            for previous in remaining_assets:
                if previous.index is not None:
                    asset_repository.update_index(previous.id, previous.index)
            for saved_progress in saved_progresses:
                current = progress_repository.get(saved_progress.user_id, book.id)
                if current and current.updated_at == saved_progress.updated_at:
                    progress_repository.rebase_position(current, saved_progress)
            for mark in saved_marks:
                current = mark_repository.get(mark.user_id, mark.id)
                if current and current.updated_at == mark.updated_at:
                    mark_repository.rebase_position(current, mark)
            book_repository.save(book)
        except Exception:
            pass
        cleanup_committed_paths(created_paths)
        raise
    finally:
        staged_original.unlink(missing_ok=True)
    cleanup_committed_paths(removed_paths)
    return result


def _asset_storage_paths(assets: list[BookAsset], settings: Settings) -> list[Path]:
    paths: list[Path] = []
    for asset in assets:
        for value in (asset.path, asset.metadata.get("blocks_path")):
            if not isinstance(value, str):
                continue
            try:
                path = resolve_storage_path(get_storage_root(settings), value)
            except ValueError:
                continue
            if path not in paths:
                paths.append(path)
    return paths


def normalize_edited_chapter(raw_title: str | None, raw_content: str, chapter_index: int) -> tuple[str, str]:
    """An edit already contains body text; do not infer a title or reflow its paragraphs."""
    title = (raw_title or "").strip() or f"第 {chapter_index} 章"
    content = raw_content.replace("\r\n", "\n").replace("\r", "\n")
    if len(title) > 255:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="章节名不能超过255个字符")
    if not content.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="章节正文不能为空")
    return title, content


def normalize_appended_chapter(raw_title: str | None, raw_content: str, next_index: int, *, content_is_body: bool = False) -> tuple[str, str]:
    content = normalize_pasted_text(raw_content)
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请粘贴章节正文")

    title = (raw_title or "").strip()
    first_line, separator, remainder = content.partition("\n")
    first_line = first_line.strip()
    remainder = remainder.strip()
    if not content_is_body and separator and remainder and CHAPTER_PATTERN.fullmatch(first_line):
        if not title:
            title = first_line
        content = remainder
    elif not content_is_body and title and separator and remainder and normalize_title(first_line) == normalize_title(title):
        content = remainder

    content = format_chapter_paragraphs(content)
    title = title or f"第 {next_index} 章"
    if len(title) > 255:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="章节名不能超过255个字符")
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="章节正文不能为空")
    return title, content


def normalize_pasted_text(value: str) -> str:
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\u200b-\u200d\ufeff]", "", text).replace("\u00a0", " ")
    lines = [re.sub(r"^[ \t\u3000]+|[ \t\u3000]+$", "", line) for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def format_chapter_paragraphs(content: str) -> str:
    paragraphs: list[str] = []
    for block in re.split(r"\n{2,}", content):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        if looks_hard_wrapped(lines):
            paragraphs.append(join_wrapped_lines(lines))
        else:
            paragraphs.extend(lines)
    return "\n\n".join(paragraphs)


def looks_hard_wrapped(lines: list[str]) -> bool:
    if len(lines) < 4:
        return False
    representative_lines = lines[:-1]
    lengths = sorted(len(line) for line in representative_lines)
    median_length = lengths[len(lengths) // 2]
    minimum_length = 28 if re.search(r"[\u3400-\u9fff\u3040-\u30ff]", "".join(lines)) else 56
    continuation_ratio = sum(not re.search(r"[。！？!?…」』”’）)】》]$", line) for line in representative_lines) / len(representative_lines)
    regular_length_ratio = sum(len(line) >= median_length * 0.68 for line in representative_lines) / len(representative_lines)
    return median_length >= minimum_length and continuation_ratio >= 0.6 and regular_length_ratio >= 0.7


def join_wrapped_lines(lines: list[str]) -> str:
    joined = ""
    for line in lines:
        separator = " " if joined and re.search(r"[A-Za-z0-9]$", joined) and re.match(r"[A-Za-z0-9]", line) else ""
        joined += separator + line
    return joined


def normalize_title(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def get_asset_title(asset: BookAsset, fallback_index: int) -> str:
    title = asset.metadata.get("title")
    return title.strip() if isinstance(title, str) and title.strip() else f"第 {fallback_index} 章"


def publish_original_version(book, staged_path: Path, settings: Settings, created_paths: list[Path]) -> tuple[str, Path]:
    """The database switches complete files together; uncertain commits never overwrite live files."""
    relative = Path('originals') / safe_storage_segment(book.owner_id) / safe_storage_segment(book.id) / 'versions' / uuid4().hex / ('original' + (book.file_ext or '.epub'))
    destination = resolve_storage_path(get_storage_root(settings), relative)
    destination.parent.mkdir(parents=True, exist_ok=False)
    created_paths.append(destination)
    os.replace(staged_path, destination)
    return relative.as_posix(), destination


def build_plain_blocks_sidecar(content: str) -> bytes:
    import json

    blocks: list[dict[str, object]] = []
    for block in re.split(r"\n{2,}", content):
        text = block.strip()
        if not text:
            continue
        marker = CHAPTER_IMAGE_MARKER_RE.fullmatch(text)
        if marker:
            blocks.append({"image_index": int(marker.group(1)), "type": "image"})
        else:
            blocks.append({"text": text, "type": "paragraph"})
    return json.dumps({"blocks": blocks, "version": 1}, ensure_ascii=False).encode("utf-8")


def recalculate_saved_progress(progress_percent: int, chapter_index: int, epub_cfi: str | None, chapter_count: int) -> int:
    scroll_ratio = parse_scroll_ratio(epub_cfi)
    if scroll_ratio is None:
        scroll_ratio = 1.0 if progress_percent >= 100 else 0.0
    completed = max(0.0, chapter_index - 1 + scroll_ratio)
    return min(100, max(0, round(completed / max(chapter_count, 1) * 100)))


def recalculate_progress_percent(progress_percent: int, previous_chapter_count: int, chapter_count: int) -> int:
    if progress_percent < 100 or previous_chapter_count <= 0:
        return progress_percent
    return min(100, max(0, round(previous_chapter_count / max(chapter_count, 1) * 100)))


def parse_scroll_ratio(epub_cfi: str | None) -> float | None:
    prefix = "aisu-scroll:"
    if not epub_cfi or not epub_cfi.startswith(prefix):
        return None
    try:
        return min(1.0, max(0.0, float(epub_cfi[len(prefix) :])))
    except ValueError:
        return None


def hash_chapter_content(content: str) -> str:
    normalized = re.sub(r"\s+", "", content)
    return sha256(normalized.encode("utf-8")).hexdigest()


def read_asset_content_hash(relative_path: str, settings: Settings, title: str | None = None) -> str | None:
    try:
        path = resolve_storage_path(get_storage_root(settings), relative_path)
        if not path.is_file():
            return None
        content = path.read_text(encoding="utf-8")
        if title:
            first_paragraph, separator, remainder = content.partition("\n\n")
            if separator and normalize_title(first_paragraph) == normalize_title(title):
                content = remainder
        return hash_chapter_content(content)
    except (OSError, UnicodeError, ValueError):
        return None
