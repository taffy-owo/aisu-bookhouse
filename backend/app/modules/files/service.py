from dataclasses import dataclass
import mimetypes
from pathlib import Path
from fastapi import HTTPException
import unicodedata

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.domain import AssetType
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.reader.page_identity import pdf_position_key

MAX_DOWNLOAD_BASENAME_LENGTH = 120


@dataclass(frozen=True)
class FileDownload:
    path: Path
    file_name: str
    media_type: str


def get_original_file_download(
    *,
    allowed_reader_types: set[str] | None = None,
    book_id: str,
    book_repository: BookRepository,
    owner_id: str,
    respect_public_download_policy: bool = False,
    settings: Settings,
    position_key: str | None = None,
) -> FileDownload | None:
    book = book_repository.get_accessible(owner_id, book_id)
    if not book or not book.original_file_path:
        return None
    if allowed_reader_types is not None and book.reader_type not in allowed_reader_types:
        return None
    if respect_public_download_policy and book.owner_id != owner_id and book.public_status == "public" and not book.public_download_allowed:
        return None
    if position_key is not None and position_key != pdf_position_key(book):
        raise HTTPException(409, "PDF 文件已更新，请先打开新版阅读器。")

    try:
        path = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    except ValueError:
        return None

    if not path.is_file():
        return None

    return FileDownload(
        path=path,
        file_name=build_download_name(book.title, book.file_ext or path.suffix),
        media_type=book.mime_type or "application/octet-stream",
    )


def get_asset_file_download(
    *,
    asset_repository: BookAssetRepository,
    asset_type: AssetType,
    book_id: str,
    book_repository: BookRepository,
    file_name: str,
    index: int | None = None,
    owner_id: str,
    settings: Settings,
    position_key: str | None = None,
) -> FileDownload | None:
    book = book_repository.get_accessible(owner_id, book_id)
    if not book:
        return None

    asset = asset_repository.get_by_index(book_id, asset_type, index) if index is not None else asset_repository.get_first(book_id, asset_type)
    if not asset:
        return None
    if position_key is not None and position_key != asset.id:
        raise HTTPException(409, "图片页已更新，请先打开新版阅读器。")

    try:
        path = resolve_storage_path(get_storage_root(settings), asset.path)
    except ValueError:
        return None

    if not path.is_file():
        return None

    return FileDownload(path=path, file_name=file_name, media_type=guess_media_type(path))


def build_download_name(title: str, extension: str) -> str:
    suffix = extension if extension.startswith(".") else f".{extension}"
    safe_title = "".join(char for char in title if is_safe_download_name_character(char)).strip(" .")
    safe_title = " ".join(safe_title.split())
    if len(safe_title) > MAX_DOWNLOAD_BASENAME_LENGTH:
        safe_title = safe_title[:MAX_DOWNLOAD_BASENAME_LENGTH].rstrip(" .")
    return f"{safe_title or 'book'}{suffix}"


def is_safe_download_name_character(char: str) -> bool:
    return not unicodedata.category(char).startswith("C") and char not in {'\\', '/', ':', '*', '?', '"', '<', '>', '|'}


def guess_media_type(path: Path) -> str:
    if path.suffix.lower() == ".webp":
        # Windows' system MIME registry does not always include WebP.
        return "image/webp"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"
