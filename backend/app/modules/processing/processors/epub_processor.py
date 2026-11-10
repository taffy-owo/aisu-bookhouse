from collections import Counter
from dataclasses import dataclass, field
import json
from pathlib import PurePosixPath
import re
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

import defusedxml.ElementTree as DefusedElementTree
from defusedxml.common import DefusedXmlException

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, write_bytes_file
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.image_metadata import read_image_dimensions
from app.modules.book_assets.repository import create_book_asset
from app.modules.processing.processors.epub_source_identity import extract_epub_source_identity
from app.modules.books.domain import Book
from app.modules.processing.paths import processed_book_path
from app.modules.processing.processors.archive_limits import ArchiveProcessingBudget, read_limited_member
from app.modules.processing.processors.common import get_extension, is_supported_image
from app.modules.processing.processors.epub_documents import (
    build_archive_path, decode_document, extract_body_html, strip_generated_chapter_title, unescape_html_entities,
)
from app.modules.processing.processors.epub_images import (
    EpubDocumentImage, build_epub_comic_page_assets, extract_document_image_paths,
    find_epub_document_images, replace_inline_image_tags,
)
from app.modules.processing.processors.metadata import clean_metadata_description, clean_metadata_title
from app.modules.processing.language import detect_book_language
from app.modules.processing.types import ProcessingResult


@dataclass(frozen=True)
class EpubChapterExtraction:
    image_paths: list[str]
    index: int
    path: str
    text: str
    title: str
    toc_level: int
    source_identity: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class EpubTocEntry:
    level: int
    title: str


NON_READING_TITLES = {
    "cover",
    "title",
    "copyright",
    "contents",
    "credits",
    "staff",
    "tableofcontents",
    "封面",
    "封面页",
    "扉页",
    "扉頁",
    "题名页",
    "題名頁",
    "標題",
    "标题",
    "版权",
    "版權",
    "版权信息",
    "版權資訊",
    "作品信息",
    "作品資訊",
    "制作信息",
    "製作資訊",
    "制作人员",
    "製作人員",
    "目录",
    "目錄",
    "简介",
    "簡介",
    "内容简介",
    "內容簡介",
    "人物介绍",
    "人物介紹",
}
ILLUSTRATION_TITLES = {
    "illustration",
    "illustrations",
    "彩页",
    "彩頁",
    "插图",
    "插圖",
    "插画",
    "插畫",
}


def process_epub(book: Book, settings: Settings) -> ProcessingResult:
    if not book.original_file_path:
        return ProcessingResult()

    original_path = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    try:
        with ZipFile(original_path) as archive:
            budget = ArchiveProcessingBudget(settings)
            budget.ensure_archive_entry_count(archive)

            opf_path = find_opf_path(archive, budget)
            if not opf_path:
                return ProcessingResult()

            opf_root = parse_epub_opf(read_limited_member(archive, opf_path, budget), archive, opf_path)
            metadata = read_epub_metadata(opf_root)
            cover_path = find_cover_path(opf_root, opf_path)
            chapter_paths = find_chapter_paths(opf_root, opf_path)
            toc_entry_by_path = find_toc_entry_by_path(archive, opf_root, opf_path, budget)
            assets = []
            stored_cover_path = None

            if cover_path and cover_path in archive.namelist():
                budget.reserve_asset()
                extension = get_extension(cover_path) or ".jpg"
                stored_file = write_bytes_file(
                    data=read_limited_member(archive, cover_path, budget),
                    relative_path=processed_book_path(book.owner_id, book.id, "cover", f"cover{extension}"),
                    settings=settings,
                )
                cover_asset = create_book_asset(
                    asset_type="cover",
                    book_id=book.id,
                    metadata={"source": cover_path},
                    path=stored_file.relative_path,
                )
                assets.append(cover_asset)
                stored_cover_path = cover_asset.path

            chapter_extractions = extract_epub_chapters(archive, chapter_paths, budget, toc_entry_by_path)
            text_asset_metadata = [build_text_asset_metadata(chapter) for chapter in chapter_extractions]
            document_images = find_epub_document_images(archive, chapter_paths, budget)
            is_image_page_epub = looks_like_image_page_epub(text_asset_metadata) or looks_like_image_dense_epub(text_asset_metadata, document_images)
            comic_page_assets = build_epub_comic_page_assets(archive, document_images, book, settings, budget) if is_image_page_epub else []

            text_chapter_assets = []
            if not is_image_page_epub:
                text_chapter_assets = build_epub_text_chapter_assets(archive, chapter_extractions, book, settings, budget)
                assets.extend(text_chapter_assets)

            assets.extend(comic_page_assets)

            if comic_page_assets and not stored_cover_path:
                cover_asset = create_book_asset(
                    asset_type="cover",
                    book_id=book.id,
                    metadata={"source": comic_page_assets[0].metadata.get("source", "first_page")},
                    path=comic_page_assets[0].path,
                )
                assets.append(cover_asset)
                stored_cover_path = cover_asset.path

            reader_type = "comic" if is_image_page_epub else None
            current_chapter = get_epub_comic_current_chapter(comic_page_assets, reader_type) if reader_type == "comic" else get_first_text_chapter_title(text_chapter_assets)
            return ProcessingResult(
                assets=assets,
                author=metadata.get("author"),
                cover_path=stored_cover_path,
                current_chapter=current_chapter,
                description=metadata.get("description"),
                page_count=len(comic_page_assets) if comic_page_assets else None,
                reader_type=reader_type,
                title=clean_metadata_title(metadata.get("title")),
                language=detect_book_language(
                    metadata.get("title"),
                    metadata.get("author"),
                    *(chapter.text for chapter in chapter_extractions[:8]),
                    declared_language=metadata.get("language"),
                ),
            )
    except (BadZipFile, ElementTree.ParseError, DefusedXmlException, KeyError):
        return ProcessingResult(reader_type="unsupported")


def parse_epub_opf(data: bytes, archive: ZipFile, opf_path: str) -> ElementTree.Element:
    try:
        return DefusedElementTree.fromstring(data)
    except ElementTree.ParseError:
        sanitized = escape_bare_xml_ampersands(data)
        if sanitized != data:
            try:
                return DefusedElementTree.fromstring(sanitized)
            except ElementTree.ParseError:
                pass
        recovered = recover_repeated_epub_opf(data, archive, opf_path)
        if recovered is None:
            raise
        return recovered


def escape_bare_xml_ampersands(data: bytes) -> bytes:
    """Repair common hand-built EPUB metadata without weakening XML safety.

    Some otherwise valid EPUB generators put URLs such as ``?a=1&b=2`` into
    OPF text without escaping the ampersand. Only bare ampersands are repaired;
    XML's five predefined entities and numeric character references are kept.
    DefusedXML still parses the repaired document, so DTD/entity payloads remain
    rejected instead of being expanded.
    """
    return re.sub(
        rb"&(?!amp;|lt;|gt;|apos;|quot;|#[0-9]+;|#x[0-9A-Fa-f]+;)",
        b"&amp;",
        data,
    )


def recover_repeated_epub_opf(data: bytes, archive: ZipFile, opf_path: str) -> ElementTree.Element | None:
    """Recover generators that accidentally append a fresh OPF for every item.

    The fallback is deliberately narrow: it only accepts a document containing
    several package/XML starts and rebuilds a synthetic tree from unique manifest
    items and spine references whose targets actually exist in the archive.
    """

    document = decode_document(data)
    if document.count("<package") < 2 or document.count("<?xml") < 2:
        return None

    opf_parent = PurePosixPath(opf_path).parent
    archive_names = set(archive.namelist())
    manifest_items: dict[str, dict[str, str]] = {}
    for tag in re.findall(r"(?is)<item\b[^>]*>", document):
        attributes = extract_xml_tag_attributes(tag)
        item_id = attributes.get("id")
        href = attributes.get("href")
        if not item_id or not href:
            continue
        target = build_archive_path(opf_parent, href)
        if target not in archive_names:
            continue
        manifest_items.setdefault(item_id, attributes)

    spine_ids: list[str] = []
    for tag in re.findall(r"(?is)<itemref\b[^>]*>", document):
        item_id = extract_xml_tag_attributes(tag).get("idref")
        if item_id and item_id in manifest_items and item_id not in spine_ids:
            spine_ids.append(item_id)

    readable_spine_ids = [
        item_id
        for item_id in spine_ids
        if is_epub_document(
            manifest_items[item_id].get("href", ""),
            manifest_items[item_id].get("media-type", ""),
        )
        and not is_epub_recovery_auxiliary_attributes(manifest_items[item_id])
    ]
    if not readable_spine_ids:
        return None

    package = ElementTree.Element("package", {"version": "3.0"})
    metadata = ElementTree.SubElement(package, "metadata")
    for source_name, target_name in (
        ("title", "title"),
        ("creator", "creator"),
        ("language", "language"),
        ("description", "description"),
    ):
        value = extract_first_epub_metadata_value(document, source_name)
        if value:
            ElementTree.SubElement(metadata, target_name).text = value

    manifest = ElementTree.SubElement(package, "manifest")
    for attributes in manifest_items.values():
        safe_attributes = {
            name: value
            for name, value in attributes.items()
            if name in {"id", "href", "media-type", "properties"}
        }
        ElementTree.SubElement(manifest, "item", safe_attributes)

    spine = ElementTree.SubElement(package, "spine")
    for item_id in readable_spine_ids:
        ElementTree.SubElement(spine, "itemref", {"idref": item_id})
    return package


def extract_xml_tag_attributes(tag: str) -> dict[str, str]:
    return {
        name: unescape_html_entities(value)
        for name, _quote, value in re.findall(r'''([:\w.-]+)\s*=\s*(["'])(.*?)\2''', tag)
    }


def extract_first_epub_metadata_value(document: str, name: str) -> str | None:
    match = re.search(rf"(?is)<(?:\w+:)?{re.escape(name)}\b[^>]*>(.*?)</(?:\w+:)?{re.escape(name)}\s*>", document)
    if not match:
        return None
    value = re.sub(r"(?s)<[^>]+>", "", match.group(1))
    value = unescape_html_entities(value).strip()
    return value or None


def is_epub_recovery_auxiliary_attributes(attributes: dict[str, str]) -> bool:
    properties = set(attributes.get("properties", "").split())
    href_name = PurePosixPath(attributes.get("href", "").split("#", 1)[0].split("?", 1)[0]).name.lower()
    item_id = attributes.get("id", "").strip().lower()
    return (
        "nav" in properties
        or item_id in {"title", "titlepage", "title-page"}
        or href_name in {"nav.xhtml", "nav.html", "toc.xhtml", "toc.html", "title.xhtml", "title.html", "titlepage.xhtml", "titlepage.html"}
    )


def find_opf_path(archive: ZipFile, budget: ArchiveProcessingBudget) -> str | None:
    try:
        container_root = DefusedElementTree.fromstring(read_limited_member(archive, "META-INF/container.xml", budget))
    except (KeyError, ElementTree.ParseError, DefusedXmlException):
        return None

    for element in container_root.iter():
        if local_name(element.tag) == "rootfile":
            full_path = element.attrib.get("full-path")
            if full_path:
                return full_path

    return None


def read_epub_metadata(opf_root: ElementTree.Element) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for element in opf_root.iter():
        name = local_name(element.tag)
        text = get_metadata_text(element)
        if name == "title" and text and "title" not in metadata:
            metadata["title"] = text
        if name in {"creator", "author"} and text and "author" not in metadata:
            metadata["author"] = text
        if name == "language" and text and "language" not in metadata:
            metadata["language"] = text
        if "description" not in metadata:
            description = get_epub_description_metadata(element, name, text)
            cleaned_description = clean_metadata_description(description)
            if cleaned_description:
                metadata["description"] = cleaned_description
    return metadata


def get_metadata_text(element: ElementTree.Element) -> str:
    return " ".join(part.strip() for part in element.itertext() if part.strip())


def get_epub_description_metadata(element: ElementTree.Element, name: str, text: str) -> str | None:
    if name == "description":
        return text
    if name != "meta" or not is_description_meta(element):
        return None

    return element.attrib.get("content") or text


def is_description_meta(element: ElementTree.Element) -> bool:
    for attribute_name in ("property", "name"):
        attribute = element.attrib.get(attribute_name)
        if not attribute:
            continue
        if attribute.rsplit(":", 1)[-1].strip().lower() == "description":
            return True

    return False


def find_cover_path(opf_root: ElementTree.Element, opf_path: str) -> str | None:
    manifest_items = {element.attrib.get("id"): element for element in opf_root.iter() if local_name(element.tag) == "item"}
    cover_id = None

    for element in opf_root.iter():
        if local_name(element.tag) == "meta" and element.attrib.get("name") == "cover":
            cover_id = element.attrib.get("content")
            break

    cover_item = manifest_items.get(cover_id) if cover_id else None
    if cover_item is None:
        cover_item = next((item for item in manifest_items.values() if "cover-image" in item.attrib.get("properties", "")), None)
    if cover_item is None:
        cover_item = next((item for item in manifest_items.values() if is_supported_image(item.attrib.get("href", "")) and "cover" in item.attrib.get("href", "").lower()), None)
    if cover_item is None:
        cover_item = next((item for item in manifest_items.values() if is_supported_image(item.attrib.get("href", ""))), None)

    href = cover_item.attrib.get("href") if cover_item is not None else None
    if not href:
        return None

    opf_parent = PurePosixPath(opf_path).parent
    return build_archive_path(opf_parent, href)


def find_chapter_paths(opf_root: ElementTree.Element, opf_path: str) -> list[str]:
    manifest_items = {element.attrib.get("id"): element for element in opf_root.iter() if local_name(element.tag) == "item"}
    opf_parent = PurePosixPath(opf_path).parent
    chapter_paths: list[str] = []

    spine_items = [element.attrib.get("idref") for element in opf_root.iter() if local_name(element.tag) == "itemref"]
    for item_id in spine_items:
        item = manifest_items.get(item_id)
        href = item.attrib.get("href") if item is not None else None
        media_type = item.attrib.get("media-type", "") if item is not None else ""
        if href and not is_epub_navigation_item(item) and is_epub_document(href, media_type):
            chapter_paths.append(build_archive_path(opf_parent, href))

    if chapter_paths:
        return chapter_paths

    for item in manifest_items.values():
        href = item.attrib.get("href")
        media_type = item.attrib.get("media-type", "")
        if href and not is_epub_navigation_item(item) and is_epub_document(href, media_type):
            chapter_paths.append(build_archive_path(opf_parent, href))

    return chapter_paths


def is_epub_navigation_item(item: ElementTree.Element | None) -> bool:
    if item is None:
        return False

    href = item.attrib.get("href", "")
    media_type = item.attrib.get("media-type", "")
    properties = set(item.attrib.get("properties", "").split())
    href_name = PurePosixPath(href.split("#", 1)[0].split("?", 1)[0]).name.lower()
    return (
        "nav" in properties
        or media_type == "application/x-dtbncx+xml"
        or href_name in {"nav.xhtml", "nav.html", "toc.xhtml", "toc.html", "toc.ncx"}
    )


def is_epub_document(href: str, media_type: str) -> bool:
    return media_type in {"application/xhtml+xml", "text/html"} or get_extension(href) in {".xhtml", ".html", ".htm"}


def find_toc_entry_by_path(
    archive: ZipFile,
    opf_root: ElementTree.Element,
    opf_path: str,
    budget: ArchiveProcessingBudget,
) -> dict[str, EpubTocEntry]:
    manifest_items = [element for element in opf_root.iter() if local_name(element.tag) == "item"]
    opf_parent = PurePosixPath(opf_path).parent
    entry_by_path: dict[str, EpubTocEntry] = {}

    nav_items = [item for item in manifest_items if "nav" in set(item.attrib.get("properties", "").split())]
    ncx_items = [
        item
        for item in manifest_items
        if item.attrib.get("media-type", "") == "application/x-dtbncx+xml"
        or item.attrib.get("href", "").lower().split("?", 1)[0].split("#", 1)[0].endswith(".ncx")
    ]
    for item in [*nav_items, *ncx_items]:
        href = item.attrib.get("href", "")
        if not href:
            continue

        archive_path = build_archive_path(opf_parent, href)
        parsed_entries = read_nav_entry_by_path(archive, archive_path, budget) if item in nav_items else read_ncx_entry_by_path(archive, archive_path, budget)
        for path, entry in parsed_entries.items():
            entry_by_path.setdefault(path, entry)

    return entry_by_path


def read_nav_entry_by_path(archive: ZipFile, nav_path: str, budget: ArchiveProcessingBudget) -> dict[str, EpubTocEntry]:
    try:
        nav_root = DefusedElementTree.fromstring(read_limited_member(archive, nav_path, budget))
    except (KeyError, ElementTree.ParseError, DefusedXmlException):
        return {}

    entry_by_path: dict[str, EpubTocEntry] = {}
    nav_parent = PurePosixPath(nav_path).parent
    toc_root = find_toc_nav_element(nav_root) or nav_root

    def walk(element: ElementTree.Element, level: int) -> None:
        current_level = level + 1 if local_name(element.tag) == "ol" else level
        if local_name(element.tag) == "a":
            href = element.attrib.get("href")
            title = normalize_toc_title(get_metadata_text(element))
            if href and title:
                entry_by_path.setdefault(
                    build_archive_path(nav_parent, href),
                    EpubTocEntry(level=max(1, current_level), title=title),
                )
        for child in element:
            walk(child, current_level)

    walk(toc_root, 0)
    return entry_by_path


def find_toc_nav_element(root: ElementTree.Element) -> ElementTree.Element | None:
    for element in root.iter():
        if local_name(element.tag) != "nav":
            continue

        attribute_values = " ".join(str(value).lower() for value in element.attrib.values())
        if "toc" in attribute_values:
            return element

    return None


def read_ncx_entry_by_path(archive: ZipFile, ncx_path: str, budget: ArchiveProcessingBudget) -> dict[str, EpubTocEntry]:
    try:
        ncx_root = DefusedElementTree.fromstring(read_limited_member(archive, ncx_path, budget))
    except (KeyError, ElementTree.ParseError, DefusedXmlException):
        return {}

    entry_by_path: dict[str, EpubTocEntry] = {}
    ncx_parent = PurePosixPath(ncx_path).parent

    def walk(element: ElementTree.Element, level: int) -> None:
        for child in element:
            if local_name(child.tag) == "navPoint":
                href = get_ncx_content_href(child)
                title = normalize_toc_title(get_ncx_label_text(child))
                if href and title:
                    entry_by_path.setdefault(
                        build_archive_path(ncx_parent, href),
                        EpubTocEntry(level=max(1, level), title=title),
                    )
                walk(child, level + 1)
            else:
                walk(child, level)

    walk(ncx_root, 1)
    return entry_by_path


def get_ncx_label_text(nav_point: ElementTree.Element) -> str:
    for child in nav_point:
        if local_name(child.tag) == "navLabel":
            return get_metadata_text(child)

    return ""


def get_ncx_content_href(nav_point: ElementTree.Element) -> str | None:
    for child in nav_point:
        if local_name(child.tag) == "content":
            return child.attrib.get("src")

    return None


def normalize_toc_title(title: str) -> str:
    return re.sub(r"\s+", " ", title).strip()


def extract_epub_chapters(
    archive: ZipFile,
    chapter_paths: list[str],
    budget: ArchiveProcessingBudget,
    toc_entry_by_path: dict[str, EpubTocEntry] | None = None,
) -> list[EpubChapterExtraction]:
    archive_names = set(archive.namelist())
    chapters: list[EpubChapterExtraction] = []

    for index, chapter_path in enumerate(chapter_paths, start=1):
        if chapter_path not in archive_names:
            continue

        chapter_data = read_limited_member(archive, chapter_path, budget)
        chapter_text = extract_chapter_text(chapter_data)
        chapter_image_paths = extract_document_image_paths(chapter_data, chapter_path, archive, budget, skip_inline_icons=True)
        if any(image_path not in archive_names for image_path in chapter_image_paths):
            raise KeyError(f"EPUB chapter references a missing image: {chapter_path}")
        if not chapter_text and not chapter_image_paths:
            continue

        toc_entry = (toc_entry_by_path or {}).get(chapter_path)
        chapters.append(
            EpubChapterExtraction(
                image_paths=chapter_image_paths,
                index=index,
                path=chapter_path,
                text=chapter_text,
                title=toc_entry.title if toc_entry else extract_chapter_title(chapter_text, index),
                toc_level=toc_entry.level if toc_entry else 1,
                source_identity=extract_epub_source_identity(chapter_data),
            )
        )

    return chapters


def build_text_asset_metadata(chapter: EpubChapterExtraction) -> dict[str, object]:
    return {
        "image_count": len(chapter.image_paths),
        "is_auxiliary": looks_like_auxiliary_chapter_text(chapter.text),
        "source": chapter.path,
        "text_length": len(chapter.text),
        "title": chapter.title,
        "toc_level": chapter.toc_level,
        **chapter.source_identity,
    }


def build_epub_text_chapter_assets(archive: ZipFile, chapters: list[EpubChapterExtraction], book: Book, settings: Settings, budget: ArchiveProcessingBudget) -> list[BookAsset]:
    assets: list[BookAsset] = []
    next_image_index = 1

    for chapter in chapters:
        image_marker_by_path: dict[str, int] = {}
        for image_path in chapter.image_paths:
            if image_path in image_marker_by_path:
                continue

            budget.reserve_asset()
            extension = get_extension(image_path) or ".jpg"
            image_data = read_limited_member(archive, image_path, budget)
            stored_image = write_bytes_file(
                data=image_data,
                relative_path=processed_book_path(book.owner_id, book.id, "chapter-images", f"{next_image_index:04d}{extension}"),
                settings=settings,
            )
            image_metadata: dict[str, object] = {"chapter_index": chapter.index, "document": chapter.path, "source": image_path}
            pixel_width, pixel_height = read_image_dimensions(image_data)
            if isinstance(pixel_width, int) and isinstance(pixel_height, int):
                image_metadata["pixel_width"] = pixel_width
                image_metadata["pixel_height"] = pixel_height
            assets.append(
                create_book_asset(
                    asset_type="chapter_image",
                    book_id=book.id,
                    index=next_image_index,
                    metadata=image_metadata,
                    path=stored_image.relative_path,
                )
            )
            image_marker_by_path[image_path] = next_image_index
            next_image_index += 1

        chapter_document = read_limited_member(archive, chapter.path, budget)
        chapter_document, content_is_body = strip_generated_chapter_title(chapter_document)
        chapter_text = extract_chapter_text(chapter_document, chapter.path, image_marker_by_path)
        if not chapter_text:
            continue

        budget.reserve_asset()
        stored_text = write_bytes_file(
            data=chapter_text.encode("utf-8"),
            relative_path=processed_book_path(book.owner_id, book.id, "text", f"chapter-{chapter.index:04d}.txt"),
            settings=settings,
        )
        metadata = build_text_asset_metadata(
            EpubChapterExtraction(
                image_paths=chapter.image_paths,
                index=chapter.index,
                path=chapter.path,
                text=chapter_text,
                title=chapter.title or extract_chapter_title(chapter_text, chapter.index),
                toc_level=chapter.toc_level,
                source_identity=chapter.source_identity,
            )
        )
        blocks_path = store_epub_chapter_blocks(chapter_document, chapter, book, settings, image_marker_by_path)
        if content_is_body:
            metadata["content_is_body"] = True
        if blocks_path:
            metadata["blocks_path"] = blocks_path
        assets.append(
            create_book_asset(
                asset_type="text_chapter",
                book_id=book.id,
                index=chapter.index,
                metadata=metadata,
                path=stored_text.relative_path,
            )
        )

    return assets


def store_epub_chapter_blocks(
    chapter_document: bytes,
    chapter: EpubChapterExtraction,
    book: Book,
    settings: Settings,
    image_marker_by_path: dict[str, int],
) -> str | None:
    """Persist a structured rich-text sidecar next to the plain-text chapter.

    Best-effort: the ``.txt`` remains authoritative, so any parsing/storage
    failure just skips the sidecar and the reader falls back to plain text.
    Imported lazily to avoid a module import cycle with ``epub_richtext``.
    """

    from app.modules.processing.processors.epub_richtext import extract_chapter_blocks

    try:
        blocks = extract_chapter_blocks(chapter_document, chapter.path, image_marker_by_path)
        if not blocks:
            return None
        stored_blocks = write_bytes_file(
            data=json.dumps({"version": 1, "blocks": blocks}, ensure_ascii=False).encode("utf-8"),
            relative_path=processed_book_path(book.owner_id, book.id, "text", f"chapter-{chapter.index:04d}.json"),
            settings=settings,
        )
    except Exception:
        return None

    return stored_blocks.relative_path


def extract_chapter_text(data: bytes, document_path: str | None = None, image_marker_by_path: dict[str, int] | None = None) -> str:
    html = extract_body_html(decode_document(data))
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", html)
    if image_marker_by_path and document_path:
        text = replace_inline_image_tags(text, document_path, image_marker_by_path)
    else:
        text = re.sub(r"(?is)<(?:img|image)\b[^>]*>", "", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|section|article|h[1-6]|li|tr)>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = unescape_html_entities(text)
    lines = [line.strip() for line in text.splitlines()]
    return "\n\n".join(line for line in lines if line)


def extract_chapter_title(text: str, index: int) -> str:
    first_line = next((line.strip() for line in text.splitlines() if line.strip() and not is_chapter_image_marker(line)), "")
    if first_line and len(first_line) <= 80:
        return first_line

    return f"第 {index} 章"


def is_chapter_image_marker(text: str) -> bool:
    return bool(re.fullmatch(r"\[\[AISU_CHAPTER_IMAGE:\d+]]", text.strip()))


def looks_like_auxiliary_chapter_text(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip() and not is_chapter_image_marker(line)]
    compact_text = "".join(lines).replace(" ", "").replace("　", "")
    single_char_line_ratio = sum(1 for line in lines if len(line) <= 1) / max(len(lines), 1)

    return (
        len(compact_text) <= 80
        and single_char_line_ratio >= 0.45
        and any(marker in compact_text for marker in ("作者", "插画", "插圖", "著者", "イラスト"))
    )


def get_epub_comic_current_chapter(comic_page_assets: list[BookAsset], reader_type: str | None) -> str | None:
    if comic_page_assets:
        return "第 1 页"
    if reader_type == "comic":
        return "等待漫画页解析"
    return None


def get_first_text_chapter_title(text_chapter_assets: list[BookAsset]) -> str | None:
    readable_assets = [asset for asset in text_chapter_assets if not is_current_chapter_auxiliary_asset(asset)]
    for assets in (readable_assets, text_chapter_assets):
        for asset in assets:
            title = asset.metadata.get("title")
            if isinstance(title, str) and title.strip():
                return title.strip()

    return None


def is_current_chapter_auxiliary_asset(asset: BookAsset) -> bool:
    title = asset.metadata.get("title")
    if not isinstance(title, str):
        return False

    compact_title = title.strip().replace(" ", "").replace("　", "").lower()
    image_count = asset.metadata.get("image_count")
    if isinstance(image_count, int) and image_count > 0 and compact_title in ILLUSTRATION_TITLES:
        return False

    return compact_title in NON_READING_TITLES or compact_title in ILLUSTRATION_TITLES


def looks_like_image_page_epub(text_assets: list[BookAsset | dict[str, object]]) -> bool:
    if len(text_assets) < 20:
        return False

    short_page_titles = 0
    short_text_assets = 0
    image_bearing_assets = 0
    titles: list[str] = []
    for asset in text_assets:
        metadata = get_asset_metadata(asset)
        title = metadata.get("title")
        if isinstance(title, str) and (len(title.strip()) <= 16 and ("页" in title or "頁" in title or title.upper() in {"THE END", "END"})):
            short_page_titles += 1
        if isinstance(title, str) and title.strip():
            titles.append(title.strip())

        text_length = metadata.get("text_length")
        if isinstance(text_length, int) and text_length <= 40:
            short_text_assets += 1

        image_count = metadata.get("image_count")
        if isinstance(image_count, int) and image_count > 0:
            image_bearing_assets += 1

    # A title containing “页” is only a hint, never proof of a comic. Some
    # web-novel exporters name perfectly ordinary, text-heavy chapters
    # “1页/章节名”; the old title-only rule classified those books as comics,
    # discarded every text chapter, and left the reader with zero pages. A real
    # image-page EPUB must also be overwhelmingly short and image-bearing.
    if (
        short_page_titles / len(text_assets) >= 0.7
        and short_text_assets / len(text_assets) >= 0.7
        and image_bearing_assets / len(text_assets) >= 0.7
    ):
        return True

    repeated_title_ratio = get_most_common_title_ratio(titles)
    return short_text_assets / len(text_assets) >= 0.85 and repeated_title_ratio >= 0.7


def looks_like_image_dense_epub(text_assets: list[BookAsset | dict[str, object]], document_images: list[EpubDocumentImage]) -> bool:
    if len(document_images) < 20:
        return False

    text_length = get_total_text_length(text_assets)
    return text_length <= max(800, len(document_images) * 30)


def get_total_text_length(text_assets: list[BookAsset | dict[str, object]]) -> int:
    total = 0
    for asset in text_assets:
        text_length = get_asset_metadata(asset).get("text_length")
        if isinstance(text_length, int):
            total += text_length

    return total


def get_asset_metadata(asset: BookAsset | dict[str, object]) -> dict[str, object]:
    if isinstance(asset, dict):
        return asset

    return asset.metadata


def get_most_common_title_ratio(titles: list[str]) -> float:
    if not titles:
        return 0

    most_common_count = Counter(titles).most_common(1)[0][1]
    return most_common_count / len(titles)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]
