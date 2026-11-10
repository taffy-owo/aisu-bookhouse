from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, time, timedelta, timezone
import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import case, or_, select

from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import BookAssetRepository, SqlAlchemyBookAssetRepository
from app.modules.books.domain import Book
from app.modules.books.models import BookRecord
from app.modules.books.repository import BookRepository, SqlAlchemyBookRepository
from app.modules.books.schemas import BookPublic, SourceUpdateNotificationList
from app.modules.books.service import sortable_datetime, to_public
from app.modules.books.source_episode_matching import SourceEpisodeScope, covered_source_episode_indexes, infer_source_episode_scope
from app.modules.reader.service import filter_readable_text_assets
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.reading_progress.service import overlay_progress
from app.modules.translations.schemas import WholeBookTranslationJobPublic
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.translations.errors import SourceUpdateNotReady
from app.modules.uploads.schemas import WorkSourceMetadata
from app.modules.uploads.source_metadata import fetch_work_source_metadata
from app.core.config import Settings
from sqlalchemy.orm import Session

SOURCE_CHECK_TIMEZONE = ZoneInfo("Asia/Shanghai")
SOURCE_CHECK_INTERVAL = timedelta(hours=6)
SessionFactory = Callable[[], object]
logger = logging.getLogger(__name__)


def _lock_source_update_book(session: Session | None, book: Book) -> None:
    """Serialize source-update setup with chapter append/replacement writes.

    Metadata checks deliberately preserve ``Book.updated_at`` because they do
    not change reader content.  That means a source-update request must claim
    the content row explicitly before it writes its project baseline; otherwise
    an external continuation request can append a chapter in the small window
    between catalog matching and job creation.  The lock is held by the caller's
    transaction until the translation job is committed.
    """
    if session is None or not getattr(book, "id", None):
        return
    SqlAlchemyBookRepository(session, autocommit=False).lock_revision(book)


def source_check_day_start(now: datetime) -> datetime | None:
    aware_now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    local_now = aware_now.astimezone(SOURCE_CHECK_TIMEZONE)
    local_day_start = datetime.combine(local_now.date(), time.min, tzinfo=SOURCE_CHECK_TIMEZONE)
    elapsed = local_now - local_day_start
    intervals = int(elapsed.total_seconds() // SOURCE_CHECK_INTERVAL.total_seconds())
    return (local_day_start + intervals * SOURCE_CHECK_INTERVAL).astimezone(timezone.utc)


def source_check_window_start(
    now: datetime,
    *,
    schedule_time: str | None = None,
    schedule_timezone: str | None = None,
) -> datetime | None:
    if not schedule_time or not schedule_timezone:
        return source_check_day_start(now)

    try:
        scheduled_time = time.fromisoformat(schedule_time)
        scheduled_timezone = ZoneInfo(schedule_timezone)
    except (ValueError, ZoneInfoNotFoundError):
        return source_check_day_start(now)

    aware_now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    local_now = aware_now.astimezone(scheduled_timezone)
    scheduled_at = datetime.combine(local_now.date(), scheduled_time, tzinfo=scheduled_timezone)
    if local_now < scheduled_at:
        scheduled_at -= timedelta(days=1)
    elapsed = local_now - scheduled_at
    intervals = int(elapsed.total_seconds() // SOURCE_CHECK_INTERVAL.total_seconds())
    return (scheduled_at + intervals * SOURCE_CHECK_INTERVAL).astimezone(timezone.utc)


def is_source_check_due(
    *,
    now: datetime,
    source_checked_at: datetime | None,
    schedule_time: str | None = None,
    schedule_timezone: str | None = None,
) -> bool:
    window_start = source_check_window_start(
        now,
        schedule_time=schedule_time,
        schedule_timezone=schedule_timezone,
    )
    if window_start is None:
        return False
    if source_checked_at is None:
        return True
    aware_checked_at = source_checked_at if source_checked_at.tzinfo else source_checked_at.replace(tzinfo=timezone.utc)
    return aware_checked_at.astimezone(timezone.utc) < window_start


def find_next_due_source_book(session_factory: SessionFactory, *, now: datetime) -> tuple[str, str] | None:
    with session_factory() as session:
        supported_source = or_(
            BookRecord.source_url.like("https://kakuyomu.jp/works/%"),
            BookRecord.source_url.like("https://ncode.syosetu.com/%"),
            BookRecord.source_url.like("https://novel18.syosetu.com/%"),
            BookRecord.source_url.like("https://syosetu.org/novel/%"),
            BookRecord.source_url.like("https://www.pixiv.net/novel/%"),
        )
        records = session.scalars(
            select(BookRecord)
            .where(
                BookRecord.status != "deleted",
                BookRecord.publication_status == "ongoing",
                supported_source,
                BookRecord.source_url.is_not(None),
                BookRecord.source_url != "",
                ~select(WholeBookTranslationJobRecord.id).where(
                    WholeBookTranslationJobRecord.book_id == BookRecord.id,
                    WholeBookTranslationJobRecord.job_kind == 'whole_book',
                    WholeBookTranslationJobRecord.status != 'ready',
                ).exists(),
            )
            .order_by(case((supported_source, 0), else_=1), BookRecord.source_checked_at.asc(), BookRecord.created_at.asc())
        ).all()
        for record in records:
            if record.source_url and is_source_check_due(
                now=now,
                source_checked_at=record.source_checked_at,
                schedule_time=record.source_schedule_time,
                schedule_timezone=record.source_schedule_timezone,
            ):
                return record.id, record.source_url
        return None


async def process_next_due_source_update(
    *,
    session_factory: SessionFactory,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> bool:
    checked_at = now or datetime.now(timezone.utc)
    candidate = find_next_due_source_book(session_factory, now=checked_at)
    if not candidate:
        return False

    book_id, expected_source_url = candidate
    try:
        metadata = await fetch_work_source_metadata(expected_source_url)
    except Exception as error:
        _save_scheduled_error(
            session_factory=session_factory,
            book_id=book_id,
            expected_source_url=expected_source_url,
            checked_at=checked_at,
            error=error,
        )
        return True

    with session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id(book_id)
        if not book or book.source_url != expected_source_url:
            return True
        previous_episode_count = book.source_episode_count or 0
        asset_repository = SqlAlchemyBookAssetRepository(session)
        chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
        covered_indexes, source_scope = resolve_source_coverage(book, chapters, metadata)
        saved_book = repository.save(
            apply_source_metadata(
                book,
                metadata,
                checked_at=checked_at,
                covered_episode_indexes=covered_indexes,
                source_scope=source_scope,
            )
        )
        if settings and saved_book.auto_translate_updates and saved_book.source_pending_episode_indexes:
            try:
                _queue_detected_source_update_translation(
                    book=saved_book,
                    chapters=chapters,
                    covered_indexes=covered_indexes,
                    metadata=metadata,
                    previous_episode_count=previous_episode_count,
                    asset_repository=asset_repository,
                    session=session,
                    settings=settings,
                )
            except Exception as error:
                # Preserve pending indexes: the next scheduled check can retry
                # after a provider or local-file problem is repaired.
                log_auto_translation_error(saved_book.id, error)
                repository.save(
                    saved_book.with_changes(
                        updated_at=saved_book.updated_at,
                        source_check_error=f"自动精翻未启动：{format_source_error(error)}"[:500],
                    )
                )
    return True


def _queue_detected_source_update_translation(
    *,
    book: Book,
    chapters: list[BookAsset],
    covered_indexes: set[int],
    metadata: WorkSourceMetadata,
    previous_episode_count: int,
    asset_repository: BookAssetRepository,
    session: Session,
    settings: Settings,
) -> WholeBookTranslationJobPublic | None:
    """Start the same durable job as the manual button, without a second fetch."""
    if not settings.translation_auto_updates_enabled:
        return None
    from app.modules.translations.service import (
        prepare_source_update_translation_project,
        queue_source_update_translation,
        source_update_translation_unavailable_reason,
    )

    unavailable_reason = source_update_translation_unavailable_reason(
        book=book,
        settings=settings,
        session=session,
    )
    if unavailable_reason:
        raise SourceUpdateNotReady(unavailable_reason)
    # Claim the content row before creating the baseline.  An external
    # continuation that wins this lock will make the revision check fail and
    # can never be translated twice by this update job.
    _lock_source_update_book(session, book)
    prepare_source_update_translation_project(
        book=book,
        chapters=chapters,
        has_chapter_images=bool(asset_repository.list_by_book(book.id, "chapter_image")),
        handled_episode_indexes=covered_indexes,
        metadata=metadata,
        settings=settings,
    )
    return queue_source_update_translation(
        book=book,
        metadata=metadata,
        previous_episode_count=previous_episode_count,
        covered_episode_indexes=covered_indexes,
        requested_episode_indexes=set(book.source_pending_episode_indexes),
        settings=settings,
        session=session,
    )


async def check_owned_source_update(
    *,
    owner_id: str,
    book_id: str,
    asset_repository: BookAssetRepository,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    session: Session | None = None,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if not book.source_url:
        raise ValueError("请先填写受支持的原作链接")

    checked_at = now or datetime.now(timezone.utc)
    try:
        metadata = await fetch_work_source_metadata(book.source_url)
    except Exception as error:
        book_repository.save(
            book.with_changes(
                updated_at=book.updated_at,
                source_checked_at=checked_at,
                source_check_error=format_source_error(error),
            )
        )
        raise

    chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    covered_indexes, source_scope = resolve_source_coverage(book, chapters, metadata)
    saved_book = book_repository.save(
        apply_source_metadata(
            book,
            metadata,
            checked_at=checked_at,
            covered_episode_indexes=covered_indexes,
            source_scope=source_scope,
        )
    )
    if session is not None and settings and saved_book.auto_translate_updates and saved_book.source_pending_episode_indexes:
        try:
            _queue_detected_source_update_translation(
                book=saved_book, chapters=chapters, covered_indexes=covered_indexes, metadata=metadata,
                previous_episode_count=book.source_episode_count or 0, asset_repository=asset_repository,
                session=session, settings=settings)
        except Exception as error:
            log_auto_translation_error(saved_book.id, error)
            saved_book = book_repository.save(saved_book.with_changes(
                updated_at=saved_book.updated_at, source_check_error=f"自动精翻未启动：{format_source_error(error)}"[:500]))
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


async def queue_owned_source_update_translation(
    *,
    owner_id: str,
    book_id: str,
    asset_repository: BookAssetRepository,
    book_repository: BookRepository,
    session: Session,
    settings: Settings,
) -> WholeBookTranslationJobPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if not book.source_url:
        raise ValueError("请先关联原作链接")

    checked_at = datetime.now(timezone.utc)
    try:
        metadata = await fetch_work_source_metadata(book.source_url)
    except Exception as error:
        book_repository.save(
            book.with_changes(
                updated_at=book.updated_at,
                source_checked_at=checked_at,
                source_check_error=format_source_error(error),
            )
        )
        raise

    chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    covered_indexes, source_scope = resolve_source_coverage(book, chapters, metadata)
    previous_episode_count = book.source_episode_count or 0
    saved_book = book_repository.save(
        apply_source_metadata(
            book,
            metadata,
            checked_at=checked_at,
            covered_episode_indexes=covered_indexes,
            source_scope=source_scope,
        )
    )
    pending_indexes = set(saved_book.source_pending_episode_indexes)
    if not pending_indexes:
        raise ValueError("没有需要翻译的原作更新")

    from app.modules.translations.service import (
        queue_source_update_translation,
        source_update_translation_unavailable_reason,
    )

    unavailable_reason = source_update_translation_unavailable_reason(
        book=saved_book,
        settings=settings,
        session=session,
    )
    if unavailable_reason:
        raise ValueError(unavailable_reason)
    from app.modules.translations.service import prepare_source_update_translation_project

    _lock_source_update_book(session, saved_book)
    prepare_source_update_translation_project(
        book=saved_book,
        chapters=chapters,
        has_chapter_images=bool(asset_repository.list_by_book(book.id, "chapter_image")),
        handled_episode_indexes=covered_indexes,
        metadata=metadata,
        settings=settings,
    )
    job = queue_source_update_translation(
        book=saved_book,
        metadata=metadata,
        previous_episode_count=previous_episode_count,
        covered_episode_indexes=covered_indexes,
        requested_episode_indexes=pending_indexes,
        settings=settings,
        session=session,
    )
    if not job:
        raise ValueError("这批更新已经翻译或正在等待审核")
    return job


def acknowledge_owned_source_update(
    *,
    owner_id: str,
    book_id: str,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    saved_book = book
    source_key = source_notification_key(book)
    for candidate in book_repository.list_by_owner(owner_id):
        if candidate.id != book.id and source_notification_key(candidate) != source_key:
            continue
        saved = book_repository.save(
            candidate.with_changes(
                updated_at=candidate.updated_at,
                source_pending_episode_indexes=(),
                source_update_count=0,
            )
        )
        if candidate.id == book.id:
            saved_book = saved
    return to_public(overlay_progress(saved_book, progress_repository.get(owner_id, saved_book.id)))


def acknowledge_all_owned_source_updates(
    *,
    owner_id: str,
    book_repository: BookRepository,
) -> SourceUpdateNotificationList:
    for book in book_repository.list_by_owner(owner_id):
        if book.source_update_count > 0:
            book_repository.save(
                book.with_changes(
                    updated_at=book.updated_at,
                    source_pending_episode_indexes=(),
                    source_update_count=0,
                )
            )
    return SourceUpdateNotificationList(items=[], book_count=0, episode_count=0)


def list_owned_source_update_notifications(
    *,
    owner_id: str,
    book_repository: BookRepository,
) -> SourceUpdateNotificationList:
    books_by_source: dict[str, Book] = {}
    for book in book_repository.list_by_owner(owner_id):
        if book.source_update_count <= 0:
            continue
        key = source_notification_key(book)
        current = books_by_source.get(key)
        if current is None or (book.source_update_count, sortable_datetime(book.source_checked_at or book.updated_at)) > (
            current.source_update_count,
            sortable_datetime(current.source_checked_at or current.updated_at),
        ):
            books_by_source[key] = book
    books = sorted(
        books_by_source.values(),
        key=lambda book: sortable_datetime(book.source_checked_at or book.updated_at),
        reverse=True,
    )
    return SourceUpdateNotificationList(
        items=[to_public(book) for book in books],
        book_count=len(books),
        episode_count=sum(book.source_update_count for book in books),
    )


def source_notification_key(book: Book) -> str:
    source_url = (book.source_url or "").strip().rstrip("/").lower()
    return f"source:{source_url}" if source_url else f"book:{book.id}"


def resolve_matching_source_update_episodes(
    *,
    owner_id: str,
    source_url: str,
    resolved_indexes: set[int],
    book_repository: BookRepository,
) -> None:
    normalized_url = source_url.strip().rstrip("/").lower()
    if not normalized_url or not resolved_indexes:
        return
    for book in book_repository.list_by_owner(owner_id):
        if (book.source_url or "").strip().rstrip("/").lower() != normalized_url:
            continue
        if book.source_pending_episode_indexes:
            pending_indexes = tuple(index for index in book.source_pending_episode_indexes if index not in resolved_indexes)
            update_count = len(pending_indexes)
        else:
            pending_indexes = ()
            update_count = max(0, book.source_update_count - len(resolved_indexes))
        if pending_indexes == book.source_pending_episode_indexes and update_count == book.source_update_count:
            continue
        book_repository.save(
            book.with_changes(
                updated_at=book.updated_at,
                source_pending_episode_indexes=pending_indexes,
                source_update_count=update_count,
            )
        )


def apply_source_metadata(
    book: Book,
    metadata: WorkSourceMetadata,
    *,
    checked_at: datetime,
    covered_episode_indexes: set[int] | None = None,
    source_scope: SourceEpisodeScope | None = None,
) -> Book:
    available_indexes = {episode.index for episode in metadata.episodes}
    pending_indexes = set(book.source_pending_episode_indexes)
    previous_episode_count = book.source_episode_count
    if source_scope:
        pending_indexes.intersection_update(range(source_scope.start_index, source_scope.end_index + 1))
    if not source_scope and not pending_indexes and book.source_update_count > 0 and previous_episode_count:
        legacy_candidates = [
            episode.index
            for episode in metadata.episodes
            if episode.index <= previous_episode_count
        ]
        pending_indexes.update(legacy_candidates[-book.source_update_count :])
    if previous_episode_count is not None:
        pending_indexes.update(
            episode.index
            for episode in metadata.episodes
            if episode.index > previous_episode_count
        )
    else:
        pending_indexes.clear()
    if source_scope and pending_indexes and previous_episode_count is not None:
        pending_indexes.update(source_scope.pending_indexes)
    pending_indexes.intersection_update(available_indexes)
    pending_indexes.difference_update(covered_episode_indexes or set())
    episode_count = max(book.source_episode_count or 0, metadata.episode_count)
    publication_status = (
        "completed"
        if source_scope and source_scope.end_index < metadata.episode_count
        else metadata.publication_status
    )

    return book.with_changes(
        updated_at=book.updated_at,
        publication_status=publication_status,
        source_url=metadata.source_url,
        source_episode_count=episode_count,
        source_character_count=metadata.character_count,
        source_pending_episode_indexes=tuple(sorted(pending_indexes)),
        source_update_count=len(pending_indexes),
        source_checked_at=checked_at,
        source_check_error=None,
        source_schedule_time=metadata.schedule_time,
        source_schedule_timezone=metadata.schedule_timezone,
        source_schedule_label=metadata.schedule_label,
    )


def resolve_source_coverage(
    book: Book,
    chapters: list[BookAsset],
    metadata: WorkSourceMetadata,
) -> tuple[set[int], SourceEpisodeScope | None]:
    covered_indexes = covered_source_episode_indexes(chapters, metadata.episodes)
    source_scope = infer_source_episode_scope(book.title, chapters, metadata.episodes)
    if source_scope:
        covered_indexes.update(source_scope.covered_indexes)
    return covered_indexes, source_scope


def log_auto_translation_error(book_id: str, error: Exception) -> None:
    if isinstance(error, SourceUpdateNotReady):
        logger.warning("Book %s automatic source translation not ready: %s", book_id, format_source_error(error))
    else:
        logger.exception("Book %s automatic source translation could not be queued", book_id)


def format_source_error(error: Exception) -> str:
    if isinstance(error, HTTPException):
        return str(error.detail)[:500]
    return (str(error).strip() or "原作更新检查失败")[:500]


def _save_scheduled_error(
    *,
    session_factory: SessionFactory,
    book_id: str,
    expected_source_url: str,
    checked_at: datetime,
    error: Exception,
) -> None:
    with session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id(book_id)
        if not book or book.source_url != expected_source_url:
            return
        repository.save(
            book.with_changes(
                updated_at=book.updated_at,
                source_checked_at=checked_at,
                source_check_error=format_source_error(error),
            )
        )
