from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.book_assets.image_metadata import read_image_file_dimensions
from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository
from app.modules.processing.processors.comic_processor import process_comic_archive
from app.modules.processing.processors.epub_processor import process_epub
from app.modules.processing.processors.image_processor import process_image
from app.modules.processing.processors.mobi_processor import process_mobi
from app.modules.processing.processors.txt_processor import process_txt
from app.modules.processing.types import ProcessingResult


def process_uploaded_book(
    *,
    asset_repository: BookAssetRepository,
    book: Book,
    book_repository: BookRepository,
    should_update_author: bool,
    should_update_title: bool,
    should_update_description: bool = True,
    settings: Settings,
) -> Book:
    result = run_processor(book, settings)
    validate_processing_result_files(result, settings)
    if result.reader_type != "unsupported":
        validate_media_result(book, result, settings)
    custom_cover = next(
        (
            asset
            for asset in asset_repository.list_by_book(book.id, "cover")
            if asset.metadata.get("source") == "user_upload"
        ),
        None,
    )

    # Replace the chapter set in the same transaction so an active reader never
    # observes an empty catalog while a translated book gains new chapters.
    asset_repository.clear_for_book(book.id, commit=False)
    asset_repository.save_many([*result.assets, *([custom_cover] if custom_cover else [])])

    changes: dict[str, object] = {}
    if result.reader_type:
        changes["reader_type"] = result.reader_type
    if result.reader_type == "comic" and book.kind != "manga":
        changes["kind"] = "manga"
    changes["cover_url"] = book.cover_url if custom_cover else (f"/api/v1/files/books/{book.id}/cover" if result.cover_path else None)
    changes["hero_image_url"] = None
    changes["current_chapter"] = result.current_chapter
    if result.title and should_update_title:
        changes["title"] = result.title
    if result.author and should_update_author:
        changes["author"] = result.author
    if result.description and should_update_description:
        changes["description"] = result.description
    changes["language"] = book.resolve_processed_language(result.language)
    changes["language_mode"] = book.effective_language_mode
    if result.reader_type == "unsupported":
        changes["status"] = "failed"
    else:
        changes["status"] = "ready"

    if not changes:
        return book

    return book_repository.save(book.with_changes(**changes))


def validate_processing_result_files(result: ProcessingResult, settings: Settings) -> None:
    """Do not publish a catalog until every referenced asset is on disk."""
    storage_root = get_storage_root(settings)
    missing_paths = [
        asset.path
        for asset in result.assets
        if not resolve_storage_path(storage_root, asset.path).is_file()
    ]
    if missing_paths:
        preview = ", ".join(missing_paths[:3])
        raise ValueError(f"Processing result references missing files: {preview}")


def validate_replacement_processing_result(book: Book, result: ProcessingResult, settings: Settings) -> None:
    """A replacement must be readable before its old references are switched."""
    validate_processing_result_files(result, settings)
    if result.reader_type == "unsupported":
        raise ValueError("Replacement format could not be parsed")
    reader_type = result.reader_type or book.reader_type
    storage_root = get_storage_root(settings)
    if reader_type in {"epub", "text"}:
        chapters = [asset for asset in result.assets if asset.asset_type == "text_chapter"]
        if not chapters or not any(
            resolve_storage_path(storage_root, chapter.path).read_text(encoding="utf-8").strip() not in {"", "（空章节）"}
            for chapter in chapters
        ):
            raise ValueError("Replacement contains no readable chapters")
    elif reader_type in {"comic", "image", "pdf"}:
        validate_media_result(book, result, settings)
    else:
        raise ValueError("Replacement format is not readable")


def validate_media_result(book: Book, result: ProcessingResult, settings: Settings) -> None:
    """Reject unrecognized media before publishing initial or replacement assets."""
    reader_type = result.reader_type or book.reader_type
    storage_root = get_storage_root(settings)
    if reader_type in {"comic", "image"}:
        pages = [asset for asset in result.assets if asset.asset_type in {"comic_page", "image_page"}]
        # MOBI image records are already filtered by the bounded parser using
        # their file signatures. Some valid legacy/image-only MOBI exports use
        # minimal or non-standard JPEG markers that Pillow cannot dimension;
        # rejecting those here would discard otherwise readable raw pages.
        if (book.file_ext or "").lower() == ".mobi":
            if not pages:
                raise ValueError("Book contains no valid image pages")
            return
        if not pages or any(
            None in read_image_file_dimensions(resolve_storage_path(storage_root, page.path)) for page in pages
        ):
            raise ValueError("Book contains no valid image pages")
    elif reader_type == "pdf":
        if not book.original_file_path:
            raise ValueError("Book PDF is missing")
        path = resolve_storage_path(storage_root, book.original_file_path)
        with path.open("rb") as source:
            if not source.read(8).startswith(b"%PDF-"):
                raise ValueError("Book PDF header is invalid")


def run_processor(book: Book, settings: Settings) -> ProcessingResult:
    if (book.file_ext or "").lower() == ".mobi":
        return process_mobi(book, settings)
    if book.reader_type == "epub":
        return process_epub(book, settings)
    if book.reader_type == "text":
        return process_txt(book, settings)
    if book.reader_type == "comic":
        return process_comic_archive(book, settings)
    if book.reader_type == "image":
        return process_image(book)

    return ProcessingResult()
