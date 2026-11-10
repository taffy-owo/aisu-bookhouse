from __future__ import annotations

from datetime import datetime, timezone
import logging
import re

from app.core.config import Settings
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.books.schemas import SourceCatalogSyncResult
from app.modules.books.source_episode_matching import match_source_episode_assets
from app.modules.japanese.service import translate_japanese_catalog_titles
from app.modules.reader.service import filter_readable_text_assets
from app.modules.uploads.schemas import WorkSourceEpisode
from app.modules.uploads.source_metadata import fetch_work_source_metadata


logger = logging.getLogger(__name__)
GENERIC_CHAPTER_TITLE_RE = re.compile(
    r"^(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两兩]+\s*[章节節回话話篇]|chapter\s*[0-9０-９]+)$",
    re.IGNORECASE,
)
MAX_TRANSLATED_CATALOG_LABELS = 80


async def sync_owned_source_catalog(
    *,
    owner_id: str,
    book_id: str,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository,
    settings: Settings,
) -> SourceCatalogSyncResult | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if not book.source_url:
        raise ValueError("请先保存原作链接")
    if book.reader_type not in {"epub", "text"}:
        raise ValueError("只有文字小说可以同步原作目录")

    metadata = await fetch_work_source_metadata(book.source_url)
    chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    matched_pairs = match_source_episode_assets(chapters, metadata.episodes)
    matched_count = len(matched_pairs)

    labels = catalog_labels_to_translate(matched_pairs)
    translated_labels = await translate_catalog_labels(
        labels,
        settings,
        source_work_title=metadata.title,
        translated_work_title=book.title,
    )
    renamed_count = 0
    current_chapter = book.current_chapter

    for asset, episode in matched_pairs:
        stored_title = asset.metadata.get("title")
        current_title = stored_title.strip() if isinstance(stored_title, str) and stored_title.strip() else ""
        previous_managed_title = asset.metadata.get("source_catalog_display_title")
        is_managed = is_generic_chapter_title(current_title) or (
            asset.metadata.get("source_catalog_managed") is True
            and isinstance(previous_managed_title, str)
            and current_title == previous_managed_title
        )
        display_title = translated_labels.get(episode.title, episode.title) if is_managed else current_title
        section_title = (
            translated_labels.get(episode.section_title, episode.section_title)
            if episode.section_title
            else None
        )
        next_metadata = {
            **asset.metadata,
            "source_catalog_index": episode.index,
            "source_catalog_title": episode.title,
            "source_episode_url": episode.url,
        }
        if section_title:
            next_metadata["source_section_title"] = section_title
            next_metadata["source_section_original_title"] = episode.section_title
            next_metadata["source_section_level"] = episode.section_level
        else:
            next_metadata.pop("source_section_title", None)
            next_metadata.pop("source_section_original_title", None)
            next_metadata.pop("source_section_level", None)

        if is_managed and display_title:
            next_metadata["title"] = display_title
            next_metadata["source_catalog_display_title"] = display_title
            next_metadata["source_catalog_managed"] = True
            if display_title != current_title:
                renamed_count += 1
                if current_chapter == current_title:
                    current_chapter = display_title
        else:
            next_metadata["source_catalog_managed"] = False
            next_metadata.pop("source_catalog_display_title", None)

        asset_repository.update_metadata(asset.id, next_metadata)

    covered_indexes = {episode.index for _asset, episode in matched_pairs}
    pending_indexes = tuple(
        index for index in book.source_pending_episode_indexes if index not in covered_indexes
    )
    book_repository.save(
        book.with_changes(
            current_chapter=current_chapter,
            source_character_count=metadata.character_count,
            source_checked_at=datetime.now(timezone.utc),
            source_check_error=None,
            source_episode_count=max(book.source_episode_count or 0, metadata.episode_count),
            source_pending_episode_indexes=pending_indexes,
            source_update_count=len(pending_indexes),
            source_url=metadata.source_url,
        )
    )
    return SourceCatalogSyncResult(
        catalog_count=len(metadata.episodes),
        matched_count=matched_count,
        renamed_count=renamed_count,
    )


def is_generic_chapter_title(title: str) -> bool:
    return not title or bool(GENERIC_CHAPTER_TITLE_RE.fullmatch(title.strip()))


def catalog_labels_to_translate(pairs: list[tuple[BookAsset, WorkSourceEpisode]]) -> list[str]:
    labels: list[str] = []
    for asset, episode in pairs:
        asset_metadata = asset.metadata
        stored_title = asset_metadata.get("title")
        current_title = stored_title.strip() if isinstance(stored_title, str) else ""
        previous_managed_title = asset_metadata.get("source_catalog_display_title")
        is_managed = is_generic_chapter_title(current_title) or (
            asset_metadata.get("source_catalog_managed") is True
            and isinstance(previous_managed_title, str)
            and current_title == previous_managed_title
        )
        if is_managed and episode.title not in labels:
            labels.append(episode.title)
        if episode.section_title and episode.section_title not in labels:
            labels.append(episode.section_title)
        if len(labels) >= MAX_TRANSLATED_CATALOG_LABELS:
            break
    return labels


async def translate_catalog_labels(
    labels: list[str],
    settings: Settings,
    *,
    source_work_title: str,
    translated_work_title: str,
) -> dict[str, str]:
    if not labels or not (
        settings.ai_translation_api_key
        and settings.ai_translation_base_url
        and settings.ai_translation_model
    ):
        return {}
    try:
        result = await translate_japanese_catalog_titles(
            labels,
            settings,
            source_work_title=source_work_title,
            translated_work_title=translated_work_title,
        )
    except Exception:
        logger.exception("AI translation failed while syncing a source catalog")
        return {}
    return dict(zip(labels, result.translations, strict=True))
