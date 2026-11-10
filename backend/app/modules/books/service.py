from __future__ import annotations

from dataclasses import replace
import logging
from pathlib import Path
import shutil
from datetime import datetime, timezone
from fastapi import HTTPException

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment
from app.modules.book_assets.domain import BookAssetStats
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository, SqlAlchemyBookRepository
from app.modules.books.schemas import BookListResponse, BookPublic, BookPublicShareRequest, BookReadingStatusResult, BookShelfOverview, BookSortKey, BookUpdate
from app.modules.comments.repository import PublicCommentRepository
from app.modules.reader_marks.repository import ReaderMarkRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.reading_progress.service import overlay_progress, to_public as progress_to_public
from app.modules.uploads.repository import UploadTaskRepository
from app.modules.users.repository import UserRepository

logger = logging.getLogger(__name__)


def build_book_list_response(*, items: list[BookPublic], total: int, page: int, page_size: int) -> BookListResponse:
    return BookListResponse(items=items, total=total, page=page, page_size=page_size, has_more=page * page_size < total)


def list_books(
    *,
    owner_id: str,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    q: str | None,
    kind: str | None,
    tag: str | None,
    sort: BookSortKey,
    page: int,
    page_size: int,
    language: str | None = None,
    shelf: str | None = None,
    asset_repository: BookAssetRepository | None = None,
) -> BookListResponse:
    if isinstance(book_repository, SqlAlchemyBookRepository):
        page_books, total = book_repository.list_owned_page(
            owner_id, q=q, kind=kind, tag=tag, language=language,
            shelf=shelf, sort=sort, page=page, page_size=page_size,
        )
        progress_by_id = {progress.book_id: progress for progress in progress_repository.list_for_books(owner_id, [book.id for book in page_books])}
        page_items = [overlay_progress(book, progress_by_id.get(book.id)) for book in page_books]
        stats_by_id = get_book_stats(page_items, asset_repository)
        return build_book_list_response(
            items=[to_public(book, stats=stats_by_id.get(book.id)) for book in page_items],
            total=total, page=page, page_size=page_size,
        )
    books = filter_books(book_repository.list_by_owner(owner_id), q=q, kind=kind, tag=tag, language=language)
    filtered_books = overlay_owned_progress_for_sort(
        owner_id=owner_id,
        books=books,
        progress_repository=progress_repository,
        sort="recent" if shelf in {"recent", "finished", "unread"} else sort,
    )
    if shelf == "disliked":
        filtered_books = [book for book in filtered_books if book.disliked]
    elif shelf is not None:
        filtered_books = [book for book in filtered_books if not book.disliked]
        if shelf == "favorite":
            filtered_books = [book for book in filtered_books if book.favorite]
        elif shelf == "recent":
            filtered_books = [book for book in filtered_books if book.has_reading_history and book.progress_percent < 100]
        elif shelf == "finished":
            filtered_books = [book for book in filtered_books if book.progress_percent >= 100]
        elif shelf == "unread":
            filtered_books = [book for book in filtered_books if not book.has_reading_history]
    sort_stats_by_book_id = get_book_stats(filtered_books, asset_repository) if sort_requires_book_stats(sort) else {}
    sorted_books = sort_owned_books(filtered_books, sort, stats_by_book_id=sort_stats_by_book_id)
    start = (page - 1) * page_size
    page_items = overlay_owned_progress_for_page(
        owner_id=owner_id,
        books=sorted_books[start : start + page_size],
        progress_repository=progress_repository,
        sort=sort,
    )
    stats_by_book_id = sort_stats_by_book_id or get_book_stats(page_items, asset_repository)
    return build_book_list_response(
        items=[to_public(book, stats=stats_by_book_id.get(book.id)) for book in page_items],
        total=len(sorted_books),
        page=page,
        page_size=page_size,
    )
def get_bookshelf_overview(
    *,
    owner_id: str,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    recent_limit: int,
    asset_repository: BookAssetRepository | None = None,
    include_labels: bool = True,
) -> BookShelfOverview:
    if isinstance(book_repository, SqlAlchemyBookRepository):
        recent_books = book_repository.list_owner_overview_books(owner_id, limit=recent_limit)
        updated_books = book_repository.list_owner_overview_books(owner_id, limit=12, updated_only=True)
        continue_candidates = book_repository.list_owner_overview_books(owner_id, limit=1, in_progress_only=True)
        continue_book = continue_candidates[0] if continue_candidates else None
        selected = list({book.id: book for book in [*recent_books, *updated_books, *continue_candidates]}.values())
        progress_by_id = {
            progress.book_id: progress for progress in progress_repository.list_for_books(owner_id, [book.id for book in selected])
        }
        overlaid = {book.id: overlay_progress(book, progress_by_id.get(book.id)) for book in selected}
        stats_by_id = get_book_stats(list(overlaid.values()), asset_repository)
        total, favorite_count, in_progress_count, finished_count, ongoing_count, source_update_count = (
            book_repository.owner_overview_stats(owner_id)
        )
        return BookShelfOverview(
            items=[to_public(overlaid[book.id], stats=stats_by_id.get(book.id)) for book in recent_books],
            book_labels=book_repository.owner_overview_labels(owner_id) if include_labels else [],
            total=total, favorite_count=favorite_count, in_progress_count=in_progress_count,
            finished_count=finished_count, ongoing_count=ongoing_count, source_update_count=source_update_count,
            updated_items=[to_public(overlaid[book.id], stats=stats_by_id.get(book.id)) for book in updated_books],
            continue_book=to_public(overlaid[continue_book.id], stats=stats_by_id.get(continue_book.id)) if continue_book else None,
        )
    books = [book for book in book_repository.list_by_owner(owner_id) if not book.disliked]
    progress_by_book_id = get_progress_for_books(viewer_id=owner_id, books=books, progress_repository=progress_repository)
    books_with_progress = [apply_viewer_progress(book, viewer_id=owner_id, progress=progress_by_book_id.get(book.id)) for book in books]
    sorted_books = sort_owned_books(books_with_progress, "recent")
    recent_books = sorted(books_with_progress, key=lambda book: (
        book.has_reading_history,
        sortable_datetime(book.updated_at), sortable_datetime(book.created_at),
    ), reverse=True)[:recent_limit]
    continue_book = next((book for book in sorted_books if book.has_reading_history and book.progress_percent < 100), None)
    updated_books = [book for book in sorted_books if book.source_update_count > 0][:12]
    stat_books = list({book.id: book for book in [*recent_books, *updated_books, *([continue_book] if continue_book else [])]}.values())
    stats_by_book_id = get_book_stats(stat_books, asset_repository)

    return BookShelfOverview(
        items=[to_public(book, stats=stats_by_book_id.get(book.id)) for book in recent_books],
        book_labels=[{"id": book.id, "title": book.title} for book in books_with_progress] if include_labels else [],
        total=len(books_with_progress),
        favorite_count=sum(1 for book in books_with_progress if book.favorite),
        in_progress_count=sum(1 for book in books_with_progress if book.has_reading_history and book.progress_percent < 100),
        finished_count=sum(1 for book in books_with_progress if book.progress_percent >= 100),
        ongoing_count=sum(1 for book in books_with_progress if book.publication_status == "ongoing"),
        source_update_count=sum(max(0, book.source_update_count) for book in books_with_progress),
        updated_items=[to_public(book, stats=stats_by_book_id.get(book.id)) for book in updated_books],
        continue_book=to_public(continue_book, stats=stats_by_book_id.get(continue_book.id)) if continue_book else None,
    )


def list_public_books(
    *,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    q: str | None,
    kind: str | None,
    tag: str | None,
    sort: BookSortKey,
    page: int,
    page_size: int,
    viewer_id: str | None,
    language: str | None = None,
    comment_repository: PublicCommentRepository | None = None,
    user_repository: UserRepository | None = None,
    asset_repository: BookAssetRepository | None = None,
) -> BookListResponse:
    sort_stats_by_book_id = {}
    sort_comment_counts = {}
    if isinstance(book_repository, SqlAlchemyBookRepository):
        page_items, total = book_repository.list_public_page(
            q=q, kind=kind, tag=tag, language=language, sort=sort, page=page, page_size=page_size,
        )
    else:
        books = book_repository.list_public()
        filtered_books = filter_books(books, q=q, kind=kind, tag=tag, language=language)
        sort_stats_by_book_id = get_book_stats(filtered_books, asset_repository) if sort_requires_book_stats(sort) else {}
        sort_comment_counts = get_comment_counts(filtered_books, comment_repository) if sort == "comments" else {}
        sorted_books = sort_books(filtered_books, sort, comment_counts=sort_comment_counts, stats_by_book_id=sort_stats_by_book_id)
        total = len(sorted_books)
        start = (page - 1) * page_size
        page_items = sorted_books[start : start + page_size]
    progress_by_book_id = get_progress_for_books(viewer_id=viewer_id, books=page_items, progress_repository=progress_repository)
    comment_counts = sort_comment_counts or get_comment_counts(page_items, comment_repository)
    stats_by_book_id = sort_stats_by_book_id or get_book_stats(page_items, asset_repository)
    owner_nicknames = get_owner_nicknames(page_items, user_repository)
    return build_book_list_response(
        items=[
            to_public(
                apply_viewer_progress(book, viewer_id=viewer_id, progress=progress_by_book_id.get(book.id)),
                viewer_id=viewer_id,
                is_owned=viewer_id == book.owner_id if viewer_id else False,
                owner_nickname=owner_nicknames.get(book.owner_id),
                comment_count=comment_counts.get(book.id, 0),
                stats=stats_by_book_id.get(book.id),
            )
            for book in page_items
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


def list_pending_public_books(
    *,
    book_repository: BookRepository,
    viewer_id: str,
    comment_repository: PublicCommentRepository | None = None,
    user_repository: UserRepository | None = None,
    asset_repository: BookAssetRepository | None = None,
) -> BookListResponse:
    books = sort_books(book_repository.list_pending_public(), "recent")
    owner_nicknames = get_owner_nicknames(books, user_repository)
    comment_counts = get_comment_counts(books, comment_repository)
    stats_by_book_id = get_book_stats(books, asset_repository)
    return build_book_list_response(
        items=[
            to_public(
                book,
                viewer_id=viewer_id,
                owner_nickname=owner_nicknames.get(book.owner_id),
                comment_count=comment_counts.get(book.id, 0),
                stats=stats_by_book_id.get(book.id),
            )
            for book in books
        ],
        total=len(books),
        page=1,
        page_size=len(books) or 24,
    )


def get_book(owner_id: str, book_id: str, book_repository: BookRepository, progress_repository: ReadingProgressRepository) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    return to_public(overlay_progress(book, progress_repository.get(owner_id, book.id)))


def get_accessible_book(
    user_id: str,
    book_id: str,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    comment_repository: PublicCommentRepository | None = None,
    user_repository: UserRepository | None = None,
    asset_repository: BookAssetRepository | None = None,
) -> BookPublic | None:
    book = book_repository.get_accessible(user_id, book_id)
    if not book:
        return None
    book = apply_viewer_progress(book, viewer_id=user_id, progress=progress_repository.get(user_id, book.id))
    owner = user_repository.get_by_id(book.owner_id) if user_repository else None
    comment_count = comment_repository.count_for_book(book.id) if comment_repository else 0
    stats = get_book_stat(book.id, asset_repository) if asset_repository else None
    return to_public(book, viewer_id=user_id, owner_nickname=owner.nickname if owner else None, comment_count=comment_count, stats=stats)


def update_book(
    owner_id: str,
    book_id: str,
    payload: BookUpdate,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    *,
    asset_repository: BookAssetRepository | None = None,
    settings: Settings | None = None,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    if payload.expected_updated_at is not None:
        expected = payload.expected_updated_at
        actual = book.updated_at
        expected = expected.replace(tzinfo=timezone.utc) if expected.tzinfo is None else expected.astimezone(timezone.utc)
        actual = actual.replace(tzinfo=timezone.utc) if actual.tzinfo is None else actual.astimezone(timezone.utc)
        if expected != actual:
            raise HTTPException(409, "Book metadata changed; read the latest version before editing")

    changes: dict[str, object] = {}
    if payload.title is not None:
        changes["title"] = payload.title
    if payload.author is not None:
        changes["author"] = payload.author
    if payload.description is not None:
        changes["description"] = payload.description
    if payload.tags is not None:
        changes["tags"] = tuple(payload.tags)
    if payload.publication_status is not None:
        changes["publication_status"] = payload.publication_status
    if "source_url" in payload.model_fields_set:
        next_source_url = normalize_optional_text(payload.source_url)
        changes["source_url"] = next_source_url
        if next_source_url != book.source_url:
            changes.update(
                source_episode_count=None,
                source_character_count=None,
                source_pending_episode_indexes=(),
                source_update_count=0,
                source_checked_at=None,
                source_check_error=None,
                source_schedule_time=None,
                source_schedule_timezone=None,
                source_schedule_label=None,
            )
    if "source_episode_count" in payload.model_fields_set:
        changes["source_episode_count"] = payload.source_episode_count
        changes["source_pending_episode_indexes"] = ()
        changes["source_update_count"] = 0
        changes["source_checked_at"] = datetime.now(timezone.utc)
        changes["source_check_error"] = None
    if "source_character_count" in payload.model_fields_set:
        changes["source_character_count"] = payload.source_character_count
    if "source_schedule_time" in payload.model_fields_set:
        changes["source_schedule_time"] = payload.source_schedule_time
    if "source_schedule_timezone" in payload.model_fields_set:
        changes["source_schedule_timezone"] = payload.source_schedule_timezone
    if "source_schedule_label" in payload.model_fields_set:
        changes["source_schedule_label"] = normalize_optional_text(payload.source_schedule_label)
    if payload.auto_translate_updates is not None:
        if payload.auto_translate_updates and not (payload.source_url or book.source_url):
            raise ValueError("请先关联原作链接，再开启更新自动精翻")
        changes["auto_translate_updates"] = payload.auto_translate_updates
    if "series_title" in payload.model_fields_set:
        changes["series_title"] = normalize_optional_text(payload.series_title)
    if "series_order" in payload.model_fields_set:
        changes["series_order"] = payload.series_order
    if "series_kind" in payload.model_fields_set:
        changes["series_kind"] = normalize_optional_text(payload.series_kind)
    if payload.rating is not None:
        changes["rating"] = max(0.0, min(10.0, payload.rating))
    if payload.language == "auto":
        if book.status != "ready":
            raise HTTPException(409, "请在书籍处理完成后再自动识别语言")
        if asset_repository is None or settings is None:
            raise ValueError("Automatic language recognition requires readable book resources")
        from app.modules.books.language_preferences import detect_existing_book_language
        try:
            changes["language"] = detect_existing_book_language(book, asset_repository, settings)
        except (OSError, ValueError) as error:
            raise HTTPException(409, "暂时无法读取正文或原文件，请稍后重试自动识别") from error
        changes["language_mode"] = "auto"
    elif payload.language is not None:
        changes["language"] = payload.language
        changes["language_mode"] = "manual"

    saved_book = book_repository.save(book.with_changes(**changes))
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


def delete_book(
    owner_id: str,
    book_id: str,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    mark_repository: ReaderMarkRepository,
    progress_repository: ReadingProgressRepository,
    upload_task_repository: UploadTaskRepository,
    settings: Settings,
) -> bool:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return False

    asset_paths = [asset.path for asset in asset_repository.list_by_book(book.id)]

    # All database changes happen in one transaction: the repositories share the
    # request session, the intermediate steps skip their commit, and the final
    # book save commits everything at once. Physical files are only removed after
    # the commit succeeded, so an interruption can no longer leave records that
    # point at deleted files.
    asset_repository.clear_for_book(book.id, commit=False)
    mark_repository.delete_for_book(owner_id, book.id, commit=False)
    progress_repository.delete_for_book(owner_id, book.id, commit=False)
    upload_task_repository.delete_for_book(owner_id, book.id, commit=False)
    book_repository.save(book.with_changes(cover_url=None, hero_image_url=None, original_file_path=None, status="deleted"))

    # Orphaned files (removal failures are only logged) are picked up by the
    # maintenance health check instead of failing the request.
    remove_book_storage(owner_id=owner_id, book=book, asset_paths=asset_paths, settings=settings)
    return True


def set_favorite(
    owner_id: str,
    book_id: str,
    is_favorite: bool,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    saved_book = book_repository.save(book.with_changes(favorite=is_favorite))
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


def set_disliked(
    owner_id: str,
    book_id: str,
    is_disliked: bool,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    saved_book = book_repository.save(book.with_changes(disliked=is_disliked))
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


def set_reading_completion(
    owner_id: str,
    book_id: str,
    finished: bool,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    *,
    updated_at: datetime | None = None,
) -> BookReadingStatusResult | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    existing = progress_repository.get(owner_id, book_id)
    position = existing if existing and existing.reader_type == book.reader_type else None
    if finished:
        # Keep any saved reading position so "继续阅读" still resumes where the
        # reader left off; only the completion percentage is forced to 100.
        progress = ReadingProgress(
            user_id=owner_id,
            book_id=book_id,
            reader_type=book.reader_type,
            progress_percent=100,
            chapter_index=position.chapter_index if position else None,
            page_number=position.page_number if position else None,
            image_index=position.image_index if position else None,
            chapter_href=position.chapter_href if position else None,
            epub_cfi=position.epub_cfi if position else None,
        )
    else:
        progress = ReadingProgress(
            user_id=owner_id,
            book_id=book_id,
            reader_type=book.reader_type,
            progress_percent=0,
        )

    # An explicit action must supersede an accepted fast device clock.
    timestamps = [value for value in (updated_at, existing.updated_at if existing else None) if value is not None]
    boundary = max((value if value.tzinfo else value.replace(tzinfo=timezone.utc) for value in timestamps), default=None)
    progress = replace(progress, updated_at=boundary).touch()
    saved_progress = progress_repository.save(progress)
    if saved_progress != progress:
        raise HTTPException(409, "阅读进度刚在其他设备更新，请刷新后再操作。")
    return BookReadingStatusResult(
        **to_public(overlay_progress(book, saved_progress)).model_dump(),
        reading_progress=progress_to_public(saved_progress),
    )


def request_public_share(owner_id: str, book_id: str, payload: BookPublicShareRequest, book_repository: BookRepository, progress_repository: ReadingProgressRepository) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if book.status != "ready":
        return None

    now = datetime.now(timezone.utc)
    saved_book = book_repository.save(
        book.with_changes(
            public_status="pending",
            public_requested_at=now,
            public_approved_at=None,
            public_rejected_at=None,
            public_moderated_by=None,
            public_share_note=normalize_optional_text(payload.share_note),
            public_source_note=normalize_optional_text(payload.source_note),
            public_download_allowed=payload.public_download_allowed,
            readers_label="公共书库审核中",
        )
    )
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


def cancel_public_share(owner_id: str, book_id: str, book_repository: BookRepository, progress_repository: ReadingProgressRepository) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    saved_book = book_repository.save(
        book.with_changes(
            public_status="private",
            public_requested_at=None,
            public_approved_at=None,
            public_rejected_at=None,
            public_moderated_by=None,
            public_share_note=None,
            public_source_note=None,
            public_download_allowed=True,
            readers_label="仅自己",
        )
    )
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


def moderate_public_share(
    *,
    book_id: str,
    book_repository: BookRepository,
    moderator_id: str,
    progress_repository: ReadingProgressRepository,
    approve: bool,
) -> BookPublic | None:
    book = book_repository.get_by_id(book_id)
    if not book:
        return None
    if book.public_status != "pending":
        return None

    now = datetime.now(timezone.utc)
    saved_book = book_repository.save(
        book.with_changes(
            public_status="public" if approve else "rejected",
            public_approved_at=now if approve else None,
            public_rejected_at=None if approve else now,
            public_moderated_by=moderator_id,
            readers_label="公共书库" if approve else "仅自己",
        )
    )
    return to_public(overlay_progress(saved_book, progress_repository.get(moderator_id, saved_book.id)), viewer_id=moderator_id)


def filter_books(books: list[Book], *, q: str | None, kind: str | None, tag: str | None, language: str | None = None) -> list[Book]:
    query = q.strip().lower() if q else ""
    return [
        book
        for book in books
        if (not kind or kind == "all" or book.kind == kind)
        and (not tag or tag == "全部" or tag in book.tags)
        and (not language or book.language == language)
        and (not query or query in get_book_search_text(book))
    ]


def get_book_search_text(book: Book) -> str:
    return " ".join(
        [
            book.title,
            book.subtitle or "",
            book.author,
            book.description,
            book.series_title or "",
            book.series_kind or "",
            book.public_share_note or "",
            book.public_source_note or "",
            " ".join(book.tags),
        ]
    ).lower()


def sort_books(
    books: list[Book],
    sort: BookSortKey,
    *,
    comment_counts: dict[str, int] | None = None,
    stats_by_book_id: dict[str, BookAssetStats] | None = None,
) -> list[Book]:
    if sort == "created":
        return sorted(books, key=lambda book: sortable_datetime(book.created_at), reverse=True)
    if sort == "title":
        return sorted(books, key=lambda book: book.title)
    if sort == "progress":
        return sorted(books, key=lambda book: book.progress_percent, reverse=True)
    if sort == "comments":
        return sorted(books, key=lambda book: ((comment_counts or {}).get(book.id, 0), sortable_datetime(book.updated_at)), reverse=True)
    if sort == "words":
        return sorted(books, key=lambda book: ((stats_by_book_id or {}).get(book.id, EMPTY_BOOK_STATS).character_count, sortable_datetime(book.updated_at)), reverse=True)
    if sort == "chapters":
        return sorted(books, key=lambda book: ((stats_by_book_id or {}).get(book.id, EMPTY_BOOK_STATS).chapter_count, sortable_datetime(book.updated_at)), reverse=True)
    return sorted(books, key=lambda book: sortable_datetime(book.updated_at), reverse=True)


def sort_owned_books(
    books: list[Book],
    sort: BookSortKey,
    *,
    comment_counts: dict[str, int] | None = None,
    stats_by_book_id: dict[str, BookAssetStats] | None = None,
) -> list[Book]:
    """Sort a private bookshelf with reading intent for the default view.

    A bookshelf's "recent" order is about what the reader is using, not which
    file happened to be edited most recently. Keep active reads at the front,
    unread books next, and completed books at the back. Inside each state the
    progress overlay's ``updated_at`` is the real last-reading timestamp.
    Ongoing works only win exact timestamp ties, so they get a gentle nudge
    without displacing a genuinely more recent read.
    """
    if sort != "recent":
        return sort_books(books, sort, comment_counts=comment_counts, stats_by_book_id=stats_by_book_id)

    return sorted(books, key=owned_recent_sort_key, reverse=True)


def owned_recent_sort_key(book: Book) -> tuple[int, datetime, int, datetime]:
    progress = max(0, min(100, book.progress_percent))
    if book.has_reading_history and progress < 100:
        reading_state = 2
    elif not book.has_reading_history:
        reading_state = 1
    else:
        reading_state = 0

    return (
        reading_state,
        sortable_datetime(book.updated_at),
        1 if book.publication_status == "ongoing" else 0,
        sortable_datetime(book.created_at),
    )


def sortable_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def to_public(
    book: Book,
    *,
    viewer_id: str | None = None,
    is_owned: bool | None = None,
    owner_nickname: str | None = None,
    comment_count: int = 0,
    stats: BookAssetStats | None = None,
) -> BookPublic:
    resolved_stats = stats or EMPTY_BOOK_STATS
    return BookPublic(
        id=book.id,
        owner_id=book.owner_id,
        is_owned=is_owned if is_owned is not None else viewer_id is None or viewer_id == book.owner_id,
        title=book.title,
        subtitle=book.subtitle,
        author=book.author,
        kind=book.kind,
        reader_type=book.reader_type,
        language=book.language,
        language_mode=book.effective_language_mode,
        tags=list(book.tags),
        progress_percent=book.progress_percent,
        current_chapter=book.current_chapter,
        last_read_at=book.last_read_at,
        rating=book.rating,
        readers_label=book.readers_label,
        updated_at=book.updated_at,
        version=book.version or book.updated_at,
        created_at=book.created_at,
        description=book.description,
        cover_url=book.cover_url,
        hero_image_url=book.hero_image_url,
        file_ext=book.file_ext,
        file_size=book.file_size,
        mime_type=book.mime_type,
        publication_status=book.publication_status,
        source_url=book.source_url,
        source_episode_count=book.source_episode_count,
        source_character_count=book.source_character_count,
        source_update_count=book.source_update_count,
        source_checked_at=book.source_checked_at,
        source_check_error=book.source_check_error,
        source_schedule_time=book.source_schedule_time,
        source_schedule_timezone=book.source_schedule_timezone,
        source_schedule_label=book.source_schedule_label,
        auto_translate_updates=book.auto_translate_updates,
        series_title=book.series_title,
        series_order=book.series_order,
        series_kind=book.series_kind,
        favorite=book.favorite,
        disliked=book.disliked,
        status=book.status,
        public_status=book.public_status,
        public_requested_at=book.public_requested_at,
        public_approved_at=book.public_approved_at,
        public_rejected_at=book.public_rejected_at,
        public_share_note=book.public_share_note,
        public_source_note=book.public_source_note,
        public_download_allowed=book.public_download_allowed,
        owner_nickname=owner_nickname,
        comment_count=comment_count,
        chapter_count=resolved_stats.chapter_count,
        page_count=resolved_stats.page_count,
        character_count=resolved_stats.character_count,
        asset_count=resolved_stats.asset_count,
        last_content_updated_at=resolved_stats.last_content_updated_at,
    )


def apply_viewer_progress(book: Book, *, viewer_id: str | None, progress: ReadingProgress | None) -> Book:
    viewed_book = overlay_progress(book, progress) if progress else book
    if viewer_id is None:
        return replace(viewed_book, current_chapter=None, favorite=False, disliked=False, progress_percent=0)
    if viewer_id == book.owner_id:
        return viewed_book

    if progress:
        return replace(viewed_book, favorite=False, disliked=False)

    return replace(viewed_book, current_chapter=None, favorite=False, disliked=False, progress_percent=0)


def overlay_owned_progress_for_sort(
    *,
    owner_id: str,
    books: list[Book],
    progress_repository: ReadingProgressRepository,
    sort: BookSortKey,
) -> list[Book]:
    if sort not in {"progress", "recent"} or not books:
        return books
    progress_by_book_id = {progress.book_id: progress for progress in progress_repository.list_for_user(owner_id)}
    return [overlay_progress(book, progress_by_book_id.get(book.id)) for book in books]


def overlay_owned_progress_for_page(
    *,
    owner_id: str,
    books: list[Book],
    progress_repository: ReadingProgressRepository,
    sort: BookSortKey,
) -> list[Book]:
    if sort == "progress" or not books:
        return books
    progress_by_book_id = {progress.book_id: progress for progress in progress_repository.list_for_books(owner_id, [book.id for book in books])}
    return [overlay_progress(book, progress_by_book_id.get(book.id)) for book in books]


def get_owner_nicknames(books: list[Book], user_repository: UserRepository | None) -> dict[str, str]:
    if not user_repository:
        return {}
    owner_ids = {book.owner_id for book in books}
    if not owner_ids:
        return {}
    return {user.id: user.nickname for user in user_repository.list_by_ids(list(owner_ids))}


def get_comment_counts(books: list[Book], comment_repository: PublicCommentRepository | None) -> dict[str, int]:
    if not comment_repository:
        return {}
    return comment_repository.count_by_book_ids([book.id for book in books])


def get_progress_for_books(*, viewer_id: str | None, books: list[Book], progress_repository: ReadingProgressRepository) -> dict[str, ReadingProgress]:
    if not viewer_id or not books:
        return {}
    return {progress.book_id: progress for progress in progress_repository.list_for_books(viewer_id, [book.id for book in books])}


def sort_requires_book_stats(sort: BookSortKey) -> bool:
    return sort in {"words", "chapters"}


EMPTY_BOOK_STATS = BookAssetStats(book_id="")


def get_book_stats(books: list[Book], asset_repository: BookAssetRepository | None) -> dict[str, BookAssetStats]:
    if not asset_repository:
        return {}
    return asset_repository.stats_by_books([book.id for book in books])


def get_book_stat(book_id: str, asset_repository: BookAssetRepository) -> BookAssetStats:
    return asset_repository.stats_by_books([book_id]).get(book_id, EMPTY_BOOK_STATS)


def normalize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized_value = value.strip()
    return normalized_value or None


def remove_book_storage(*, owner_id: str, book: Book, asset_paths: list[str], settings: Settings) -> None:
    storage_root = get_storage_root(settings)

    for relative_path in [book.original_file_path, *asset_paths]:
        if relative_path:
            try:
                remove_storage_file(storage_root, relative_path)
            except (OSError, ValueError):
                logger.warning("Failed to remove storage file %s for deleted book %s", relative_path, book.id, exc_info=True)

    for relative_directory in get_book_storage_directories(owner_id, book.id):
        try:
            remove_storage_directory(storage_root, relative_directory)
        except (OSError, ValueError):
            logger.warning("Failed to remove storage directory %s for deleted book %s", relative_directory, book.id, exc_info=True)


def get_book_storage_directories(owner_id: str, book_id: str) -> list[Path]:
    safe_owner_id = safe_storage_segment(owner_id)
    safe_book_id = safe_storage_segment(book_id)

    return [
        Path("audiobooks") / safe_owner_id / safe_book_id,
        Path("originals") / safe_owner_id / safe_book_id,
        Path("processed") / safe_owner_id / safe_book_id,
    ]


def remove_storage_file(storage_root: Path, relative_path: str) -> None:
    path = resolve_storage_path(storage_root, relative_path)
    if path.is_file() or path.is_symlink():
        path.unlink()


def remove_storage_directory(storage_root: Path, relative_path: Path) -> None:
    path = resolve_storage_path(storage_root, relative_path)
    if path.is_dir():
        shutil.rmtree(path)
