from pathlib import PurePosixPath
from zipfile import BadZipFile, ZipFile

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, write_bytes_file
from app.modules.book_assets.repository import create_book_asset
from app.modules.books.domain import Book
from app.modules.processing.paths import processed_book_path
from app.modules.processing.processors.archive_limits import ArchiveProcessingBudget, read_limited_member
from app.modules.processing.processors.common import get_extension, is_supported_image, natural_sort_key
from app.modules.processing.types import ProcessingResult


def process_comic_archive(book: Book, settings: Settings) -> ProcessingResult:
    if not book.original_file_path:
        return ProcessingResult(reader_type="unsupported")

    original_path = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    try:
        with ZipFile(original_path) as archive:
            budget = ArchiveProcessingBudget(settings)
            budget.ensure_archive_entry_count(archive)
            image_names = sorted((name for name in archive.namelist() if is_valid_archive_image(name)), key=natural_sort_key)
            assets = []

            for index, name in enumerate(image_names, start=1):
                budget.reserve_asset()
                extension = get_extension(name) or ".jpg"
                stored_file = write_bytes_file(
                    data=read_limited_member(archive, name, budget),
                    relative_path=processed_book_path(book.owner_id, book.id, "comic", f"{index:04d}{extension}"),
                    settings=settings,
                )
                assets.append(
                    create_book_asset(
                        asset_type="comic_page",
                        book_id=book.id,
                        index=index,
                        metadata={"source": name},
                        path=stored_file.relative_path,
                    )
                )

            if not assets:
                return ProcessingResult(reader_type="unsupported")

            cover = create_book_asset(
                asset_type="cover",
                book_id=book.id,
                metadata={"source": assets[0].metadata.get("source", "first_page")},
                path=assets[0].path,
            )
            return ProcessingResult(assets=[*assets, cover], cover_path=cover.path, current_chapter="第 1 页", page_count=len(assets))
    except BadZipFile:
        return ProcessingResult(reader_type="unsupported")


def is_valid_archive_image(name: str) -> bool:
    path = PurePosixPath(name)
    return not name.endswith("/") and not any(part.startswith(("__MACOSX", "._")) for part in path.parts) and is_supported_image(name)
