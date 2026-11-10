from collections import defaultdict
from dataclasses import replace
from pathlib import Path
import re

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment, write_bytes_file
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository


def preserve_manual_chapters(*, owner_id: str, book_id: str, asset_repository: BookAssetRepository, settings: Settings) -> list[BookAsset]:
    preserved: list[BookAsset] = []
    storage_root = get_storage_root(settings)
    for asset in asset_repository.list_by_book(book_id, "text_chapter"):
        if asset.metadata.get("source") != "manual_append":
            continue
        source_path = resolve_storage_path(storage_root, asset.path)
        if not source_path.is_file():
            continue
        persistent_path = (
            Path("originals")
            / safe_storage_segment(owner_id)
            / safe_storage_segment(book_id)
            / "manual-chapters"
            / f"{asset.id}.txt"
        )
        if Path(asset.path) != persistent_path:
            write_bytes_file(data=source_path.read_bytes(), relative_path=persistent_path, settings=settings)
        preserved.append(replace(asset, path=persistent_path.as_posix()))
    return preserved


def restore_manual_chapters(
    *,
    asset_repository: BookAssetRepository,
    book_repository: BookRepository,
    chapters: list[BookAsset],
    processed_book: Book,
) -> Book:
    if not chapters:
        return processed_book
    next_index = max((asset.index or 0 for asset in asset_repository.list_by_book(processed_book.id, "text_chapter")), default=0) + 1
    restored = [replace(asset, index=next_index + offset) for offset, asset in enumerate(chapters)]
    asset_repository.save_many(restored)
    last_title = restored[-1].metadata.get("title")
    return book_repository.save(processed_book.with_changes(current_chapter=last_title if isinstance(last_title, str) else processed_book.current_chapter))


def preserve_external_source_identity(new_assets, old_chapters, settings):
    """Reparsing must not lose the source identity used by continuation retries."""
    from app.modules.books.chapter_append import get_asset_title, normalize_title, read_asset_content_hash

    def identity(asset):
        return tuple(value.strip() if isinstance(value, str) and value.strip() else None
                     for value in (asset.metadata.get("external_source_id"), asset.metadata.get("source_episode_url")))

    def title(asset):
        value = asset.metadata.get("title")
        return normalize_title(value) if isinstance(value, str) and value.strip() else None

    # Explicit provenance in the original document is authoritative. Reserve
    # its old matches so fallback matching cannot reuse that same episode.
    explicit = [identity(asset) for asset in new_assets if asset.asset_type == "text_chapter" and any(identity(asset))]
    old_by_hash = defaultdict(list)
    for asset in old_chapters:
        old_identity = identity(asset)
        if not any(old_identity):
            continue
        if any(any(left and left == right for left, right in zip(old_identity, known)) for known in explicit):
            continue
        stored_hash = asset.metadata.get("content_sha256")
        digest = stored_hash.lower() if isinstance(stored_hash, str) and re.fullmatch(r"[0-9a-fA-F]{64}", stored_hash) else None
        digest = digest or read_asset_content_hash(asset.path, settings, get_asset_title(asset, asset.index or 1))
        if digest:
            old_by_hash[digest].append(asset)

    new_by_hash = defaultdict(list)
    digests = {}
    for asset in new_assets:
        if asset.asset_type != "text_chapter" or any(identity(asset)):
            continue
        digest = read_asset_content_hash(asset.path, settings, get_asset_title(asset, asset.index or 1))
        if digest:
            digests[asset.id] = digest
            new_by_hash[digest].append(asset)

    matches = {}
    for digest, chapters in new_by_hash.items():
        candidates = old_by_hash.get(digest, [])
        if not candidates:
            continue
        if len(chapters) == len(candidates) == 1:
            matches[chapters[0].id] = candidates[0]
            continue
        old_by_title, new_by_title = defaultdict(list), defaultdict(list)
        for asset in candidates:
            if title(asset):
                old_by_title[title(asset)].append(asset)
        for asset in chapters:
            if title(asset):
                new_by_title[title(asset)].append(asset)
        used_old = set()
        for chapter_title, titled_chapters in new_by_title.items():
            titled_candidates = old_by_title.get(chapter_title, [])
            if len(titled_chapters) == len(titled_candidates) == 1:
                matches[titled_chapters[0].id] = titled_candidates[0]
                used_old.add(titled_candidates[0].id)
        remaining_new = [asset for asset in chapters if asset.id not in matches]
        remaining_old = [asset for asset in candidates if asset.id not in used_old]
        if len(remaining_new) == len(remaining_old) == 1:
            matches[remaining_new[0].id] = remaining_old[0]
        elif remaining_new and remaining_old:
            # Reprocess publication catches this before replacing old assets.
            # Equal text and an ambiguous title cannot establish provenance.
            raise ValueError("Ambiguous source identity while reparsing repeated chapter content")

    preserved = []
    for asset in new_assets:
        previous = matches.get(asset.id)
        if previous:
            metadata = {**asset.metadata, "content_sha256": digests[asset.id],
                        "external_source_id": previous.metadata.get("external_source_id"),
                        "source_episode_url": previous.metadata.get("source_episode_url")}
            catalog_index = previous.metadata.get("source_catalog_index")
            if isinstance(catalog_index, int) and not isinstance(catalog_index, bool) and catalog_index > 0:
                metadata.setdefault("source_catalog_index", catalog_index)
            asset = replace(asset, metadata=metadata)
        preserved.append(asset)
    return preserved
