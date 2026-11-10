from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from time import time

from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import BookAssetRepository, create_book_asset
from app.modules.books.repository import BookRepository
from app.modules.books.schemas import BookPublic
from app.modules.books.service import to_public
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.reading_progress.service import overlay_progress

COVER_MAX_FILE_BYTES = 10 * 1024 * 1024
COVER_MAX_PIXELS = 40_000_000
COVER_MAX_WIDTH = 1600
COVER_MAX_HEIGHT = 2400
COVER_WEBP_QUALITY = 88
SUPPORTED_COVER_FORMATS = {"JPEG", "PNG", "WEBP"}
USER_COVER_SOURCE = "user_upload"


@dataclass(frozen=True)
class OptimizedCover:
    data: bytes
    width: int
    height: int


def replace_owned_book_cover(
    *,
    asset_repository: BookAssetRepository,
    book_id: str,
    book_repository: BookRepository,
    data: bytes,
    owner_id: str,
    progress_repository: ReadingProgressRepository,
    settings: Settings,
    timestamp_ms: int | None = None,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    optimized = optimize_cover_bytes(data)
    revision = timestamp_ms if timestamp_ms is not None else int(time() * 1000)
    old_custom_cover = get_user_cover(asset_repository, book_id)
    original_cover_url = get_original_cover_url(book.cover_url, old_custom_cover)
    relative_path = (
        Path("originals")
        / safe_storage_segment(owner_id)
        / safe_storage_segment(book_id)
        / "custom-cover"
        / f"cover-{revision}.webp"
    )
    absolute_path = resolve_storage_path(get_storage_root(settings), relative_path)
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_path.write_bytes(optimized.data)

    new_asset = create_book_asset(
        asset_type="cover",
        book_id=book_id,
        index=-1,
        metadata={
            "height": optimized.height,
            "original_cover_url": original_cover_url,
            "source": USER_COVER_SOURCE,
            "width": optimized.width,
        },
        path=relative_path.as_posix(),
    )

    try:
        if old_custom_cover:
            asset_repository.delete(old_custom_cover.id, commit=False)
        asset_repository.save(new_asset)
        saved_book = book_repository.save(
            book.with_changes(cover_url=f"/api/v1/files/books/{book_id}/cover?v={revision}&custom=1")
        )
    except Exception:
        absolute_path.unlink(missing_ok=True)
        raise

    if old_custom_cover:
        remove_asset_file(old_custom_cover, settings)
    return build_public_book(saved_book, asset_repository, progress_repository, owner_id)


def remove_owned_book_cover(
    *,
    asset_repository: BookAssetRepository,
    book_id: str,
    book_repository: BookRepository,
    owner_id: str,
    progress_repository: ReadingProgressRepository,
    settings: Settings,
    timestamp_ms: int | None = None,
) -> BookPublic | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None

    custom_cover = get_user_cover(asset_repository, book_id)
    if not custom_cover:
        return build_public_book(book, asset_repository, progress_repository, owner_id)

    remaining_covers = [
        asset
        for asset in asset_repository.list_by_book(book_id, "cover")
        if asset.id != custom_cover.id
    ]
    revision = timestamp_ms if timestamp_ms is not None else int(time() * 1000)
    original_cover_url = custom_cover.metadata.get("original_cover_url")
    fallback_url = f"/api/v1/files/books/{book_id}/cover?v={revision}" if remaining_covers else None
    if fallback_url is None and isinstance(original_cover_url, str) and "custom=1" not in original_cover_url:
        fallback_url = original_cover_url

    asset_repository.delete(custom_cover.id, commit=False)
    saved_book = book_repository.save(book.with_changes(cover_url=fallback_url))
    remove_asset_file(custom_cover, settings)
    return build_public_book(saved_book, asset_repository, progress_repository, owner_id)


def optimize_cover_bytes(data: bytes) -> OptimizedCover:
    if not data:
        raise ValueError("请选择封面图片")
    if len(data) > COVER_MAX_FILE_BYTES:
        raise ValueError("封面不能超过 10 MB")

    try:
        with Image.open(BytesIO(data)) as source:
            if source.format not in SUPPORTED_COVER_FORMATS:
                raise ValueError("仅支持 JPG、PNG 或 WebP 图片")
            if source.width * source.height > COVER_MAX_PIXELS:
                raise ValueError("图片尺寸过大，请换一张更小的封面")
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((COVER_MAX_WIDTH, COVER_MAX_HEIGHT), Image.Resampling.LANCZOS)
            output = BytesIO()
            image.save(output, format="WEBP", quality=COVER_WEBP_QUALITY, method=6)
            return OptimizedCover(data=output.getvalue(), width=image.width, height=image.height)
    except ValueError:
        raise
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as error:
        raise ValueError("无法读取这张图片，请换一张 JPG、PNG 或 WebP 封面") from error


def get_user_cover(asset_repository: BookAssetRepository, book_id: str) -> BookAsset | None:
    return next(
        (
            asset
            for asset in asset_repository.list_by_book(book_id, "cover")
            if asset.metadata.get("source") == USER_COVER_SOURCE
        ),
        None,
    )


def get_original_cover_url(current_cover_url: str | None, old_custom_cover: BookAsset | None) -> str | None:
    if old_custom_cover:
        original_cover_url = old_custom_cover.metadata.get("original_cover_url")
        return original_cover_url if isinstance(original_cover_url, str) else None
    if current_cover_url and "custom=1" not in current_cover_url:
        return current_cover_url
    return None


def remove_asset_file(asset: BookAsset, settings: Settings) -> None:
    try:
        resolve_storage_path(get_storage_root(settings), asset.path).unlink(missing_ok=True)
    except OSError:
        # The database state is authoritative; maintenance can remove an orphan later.
        pass


def build_public_book(
    book,
    asset_repository: BookAssetRepository,
    progress_repository: ReadingProgressRepository,
    owner_id: str,
) -> BookPublic:
    stats = asset_repository.stats_by_books([book.id]).get(book.id)
    return to_public(
        overlay_progress(book, progress_repository.get(owner_id, book.id)),
        stats=stats,
    )
