"""Shared database filtering and ordering for private and public shelves."""

from sqlalchemy import String, case, cast, func, or_, select

from app.modules.book_assets.models import BookAssetRecord
from app.modules.books.models import BookRecord
from app.modules.comments.models import PublicCommentRecord
from app.modules.reading_progress.models import ReadingProgressRecord


def owner_reading_state():
    # Match overlay_progress: a saved position in a replaced format is unread,
    # while books without a saved position retain their imported default.
    progress = ReadingProgressRecord
    same_format = progress.reader_type == BookRecord.reader_type
    percent = case(
        (progress.book_id.is_(None), BookRecord.progress_percent),
        (same_format, progress.progress_percent),
        else_=0,
    )
    updated_at = case((same_format, progress.updated_at), else_=BookRecord.updated_at)
    started = case(
        (progress.book_id.is_(None), BookRecord.progress_percent > 0),
        (same_format, or_(
            progress.progress_percent > 0,
            progress.chapter_index.is_not(None), progress.page_number.is_not(None),
            progress.image_index.is_not(None),
            func.coalesce(progress.chapter_href, "") != "",
            func.coalesce(progress.epub_cfi, "") != "",
        )),
        else_=False,
    )
    return percent, updated_at, started


def book_filters(*, q: str | None, kind: str | None, tag: str | None, language: str | None, dialect: str):
    conditions = []
    if kind and kind != "all":
        conditions.append(BookRecord.kind == kind)
    if language:
        conditions.append(BookRecord.language == language)
    if dialect == "postgresql":
        tags = func.json_array_elements_text(BookRecord.tags).table_valued("value").render_derived()
    else:
        tags = func.json_each(BookRecord.tags).table_valued("value")
    if tag and tag != "全部":
        conditions.append(select(1).select_from(tags).where(tags.c.value == tag).exists())
    if q and q.strip():
        # contains(autoescape=True) treats user '%' and '_' as literal text.
        needle = q.strip().lower()
        fields = (
            BookRecord.title, BookRecord.subtitle, BookRecord.author, BookRecord.description,
            BookRecord.series_title, BookRecord.series_kind, BookRecord.public_share_note,
            BookRecord.public_source_note,
        )
        text_matches = [func.lower(func.coalesce(field, "")).contains(needle, autoescape=True) for field in fields]
        tag_matches = select(1).select_from(tags).where(
            func.lower(cast(tags.c.value, String)).contains(needle, autoescape=True)
        ).exists()
        conditions.append(or_(*text_matches, tag_matches))
    return conditions


def book_ordering(sort: str, *, progress, recent):
    if sort == "created":
        return (BookRecord.created_at.desc(),)
    if sort == "title":
        return (BookRecord.title.asc(),)
    if sort == "progress":
        return (progress.desc(),)
    if sort == "comments":
        count = select(func.count(PublicCommentRecord.id)).where(
            PublicCommentRecord.book_id == BookRecord.id, PublicCommentRecord.deleted_at.is_(None)
        ).scalar_subquery()
        return (count.desc(), BookRecord.updated_at.desc())
    if sort in {"words", "chapters"}:
        measure = (
            func.sum(BookAssetRecord.metadata_json["text_length"].as_integer())
            if sort == "words" else func.count(BookAssetRecord.id)
        )
        count = select(func.coalesce(measure, 0)).where(
            BookAssetRecord.book_id == BookRecord.id, BookAssetRecord.asset_type == "text_chapter",
        ).scalar_subquery()
        return (count.desc(), BookRecord.updated_at.desc())
    return recent
