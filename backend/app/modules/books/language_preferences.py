from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from defusedxml.common import DefusedXmlException

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.domain import Book, BookLanguage
from app.modules.processing.language import detect_book_language
from app.modules.processing.processors.archive_limits import ArchiveProcessingBudget, read_limited_member
from app.modules.processing.processors.epub_processor import find_opf_path, parse_epub_opf, read_epub_metadata
from app.modules.reader.service import filter_readable_text_assets


def detect_existing_book_language(book: Book, assets: BookAssetRepository, settings: Settings) -> BookLanguage:
    """Read a bounded sample of the current prose without reparsing or editing it."""
    root = get_storage_root(settings)
    samples = []
    remaining = 200_000
    for asset in filter_readable_text_assets(assets.list_by_book(book.id, "text_chapter"))[:8]:
        with resolve_storage_path(root, asset.path).open(encoding="utf-8", errors="replace") as source:
            sample = source.read(remaining)
        samples.append(sample)
        remaining -= len(sample)
        if remaining <= 0:
            break
    declared = None
    if book.original_file_path:
        original = resolve_storage_path(root, book.original_file_path)
        if original.suffix.lower() == ".epub" and original.is_file():
            try:
                with ZipFile(original) as archive:
                    budget = ArchiveProcessingBudget(settings)
                    budget.ensure_archive_entry_count(archive)
                    opf_path = find_opf_path(archive, budget)
                    if opf_path:
                        opf = parse_epub_opf(read_limited_member(archive, opf_path, budget), archive, opf_path)
                        declared = read_epub_metadata(opf).get("language")
            except (BadZipFile, ElementTree.ParseError, DefusedXmlException, KeyError) as error:
                raise ValueError("原文件的语言信息无法读取") from error
    # Metadata and a Japanese title alone must not classify an image book as
    # Japanese prose. This uses the same evidence rules as initial processing.
    return detect_book_language(book.title, book.author, *samples, declared_language=declared)
