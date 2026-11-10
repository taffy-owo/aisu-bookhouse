"""EPUB image references, dimensions, inline markers and comic assets.

HTMLParser resolves entities once and respects complete attribute names,
quoted delimiters, comments, and unquoted publisher markup.
"""
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import PurePosixPath
import re
from zipfile import ZipFile

from app.core.config import Settings
from app.core.storage import write_bytes_file
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.image_metadata import image_reference_looks_like_inline_icon, read_image_dimensions
from app.modules.book_assets.repository import create_book_asset
from app.modules.books.domain import Book
from app.modules.processing.paths import processed_book_path
from app.modules.processing.processors.archive_limits import ArchiveProcessingBudget, read_limited_member
from app.modules.processing.processors.common import get_extension, is_supported_image
from app.modules.processing.processors.epub_documents import build_archive_path, decode_document


@dataclass(frozen=True)
class _ImageTag:
    start: int
    end: int
    attributes: tuple[tuple[str, str | None], ...]


class _DocumentImageParser(HTMLParser):
    def __init__(self, html: str) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[_ImageTag] = []
        self._line_offsets = [0, *[match.end() for match in re.finditer("\n", html)]]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in {"img", "image"}:
            return
        raw = self.get_starttag_text()
        line, column = self.getpos()
        start = self._line_offsets[line - 1] + column
        self.tags.append(_ImageTag(start, start + len(raw), tuple(attrs)))


def parse_document_image_tags(html: str) -> list[_ImageTag]:
    parser = _DocumentImageParser(html)
    parser.feed(html)
    parser.close()
    return parser.tags


def attribute_value(attributes: tuple[tuple[str, str | None], ...] | list[tuple[str, str | None]], name: str) -> str | None:
    for attribute_name, value in attributes:
        if attribute_name.lower() == name and value and value.strip():
            return value.strip()
    return None


def image_href_from_attributes(attributes: tuple[tuple[str, str | None], ...] | list[tuple[str, str | None]]) -> str | None:
    for name in ("src", "href", "xlink:href"):
        value = attribute_value(attributes, name)
        if value:
            return value
    return None


@dataclass(frozen=True)
class EpubDocumentImage:
    document_path: str
    image_path: str
    display_height: int | None = None
    display_width: int | None = None
    pixel_height: int | None = None
    pixel_width: int | None = None



def replace_inline_image_tags(html: str, document_path: str, image_marker_by_path: dict[str, int]) -> str:
    document_parent = PurePosixPath(document_path).parent
    parts: list[str] = []
    cursor = 0
    for tag in parse_document_image_tags(html):
        parts.append(html[cursor:tag.start])
        href = image_href_from_attributes(tag.attributes)
        image_index = None
        if href and not href.lower().startswith("data:"):
            image_index = image_marker_by_path.get(build_archive_path(document_parent, href))
        if image_index is not None:
            parts.append(f"\n\n[[AISU_CHAPTER_IMAGE:{image_index}]]\n\n")
        cursor = tag.end
    parts.append(html[cursor:])
    return "".join(parts)


def find_epub_document_images(archive: ZipFile, chapter_paths: list[str], budget: ArchiveProcessingBudget) -> list[EpubDocumentImage]:
    archive_names = set(archive.namelist())
    document_images: list[EpubDocumentImage] = []
    seen_image_paths: set[str] = set()

    for chapter_path in chapter_paths:
        if chapter_path not in archive_names:
            continue

        for document_image in extract_document_images(read_limited_member(archive, chapter_path, budget), chapter_path, archive, budget, skip_inline_icons=True):
            if document_image.image_path not in archive_names or document_image.image_path in seen_image_paths:
                continue

            seen_image_paths.add(document_image.image_path)
            document_images.append(document_image)

    return document_images



def build_epub_comic_page_assets(archive: ZipFile, document_images: list[EpubDocumentImage], book: Book, settings: Settings, budget: ArchiveProcessingBudget) -> list[BookAsset]:
    assets: list[BookAsset] = []

    for index, document_image in enumerate(document_images, start=1):
        budget.reserve_asset()
        extension = get_extension(document_image.image_path) or ".jpg"
        stored_file = write_bytes_file(
            data=read_limited_member(archive, document_image.image_path, budget),
            relative_path=processed_book_path(book.owner_id, book.id, "comic", f"{index:04d}{extension}"),
            settings=settings,
        )
        assets.append(
            create_book_asset(
                asset_type="comic_page",
                book_id=book.id,
                index=index,
                metadata={"document": document_image.document_path, "source": document_image.image_path},
                path=stored_file.relative_path,
            )
        )

    return assets



def extract_document_image_paths(
    data: bytes,
    document_path: str,
    archive: ZipFile | None = None,
    budget: ArchiveProcessingBudget | None = None,
    *,
    skip_inline_icons: bool = False,
) -> list[str]:
    return [
        document_image.image_path
        for document_image in extract_document_images(data, document_path, archive, budget, skip_inline_icons=skip_inline_icons)
    ]



def extract_document_images(
    data: bytes,
    document_path: str,
    archive: ZipFile | None = None,
    budget: ArchiveProcessingBudget | None = None,
    *,
    skip_inline_icons: bool = False,
) -> list[EpubDocumentImage]:
    document_parent = PurePosixPath(document_path).parent
    document_images: list[EpubDocumentImage] = []
    for tag in parse_document_image_tags(decode_document(data)):
        href = image_href_from_attributes(tag.attributes)
        if not href or href.lower().startswith("data:"):
            continue
        image_path = build_archive_path(document_parent, href)
        if not image_path or not is_supported_image(image_path):
            continue
        display_width, display_height = extract_image_display_dimensions(tag.attributes)
        pixel_width, pixel_height = get_epub_image_dimensions(archive, image_path, budget)
        document_image = EpubDocumentImage(
            display_height=display_height, display_width=display_width,
            document_path=document_path, image_path=image_path,
            pixel_height=pixel_height, pixel_width=pixel_width,
        )
        if skip_inline_icons and image_reference_looks_like_inline_icon(
            display_height=document_image.display_height, display_width=document_image.display_width,
            pixel_height=document_image.pixel_height, pixel_width=document_image.pixel_width,
            source=document_image.image_path,
        ):
            continue
        document_images.append(document_image)
    return document_images


def get_epub_image_dimensions(archive: ZipFile | None, image_path: str, budget: ArchiveProcessingBudget | None) -> tuple[int | None, int | None]:
    if archive is None or budget is None:
        return None, None

    try:
        return read_image_dimensions(read_limited_member(archive, image_path, budget))
    except KeyError:
        return None, None



def extract_image_display_dimensions(attributes: tuple[tuple[str, str | None], ...]) -> tuple[int | None, int | None]:
    width = parse_image_dimension(attribute_value(attributes, "width"))
    height = parse_image_dimension(attribute_value(attributes, "height"))
    style = attribute_value(attributes, "style")
    if style:
        width = width or parse_css_dimension(style, "width")
        height = height or parse_css_dimension(style, "height")
    return width, height


def parse_image_dimension(value: str | None) -> int | None:
    if not value or "%" in value:
        return None
    match = re.match(r"\s*(\d+(?:\.\d+)?)", value)
    if not match:
        return None
    try:
        return int(float(match.group(1)))
    except (OverflowError, ValueError):
        return None


def parse_css_dimension(style: str, property_name: str) -> int | None:
    match = re.search(rf"(?is)(?:^|;)\s*{re.escape(property_name)}\s*:\s*([^;]+)", style)
    return parse_image_dimension(match.group(1)) if match else None

