import re
from html.parser import HTMLParser

from app.core.config import Settings
from app.core.storage import StorageLimitExceededError, get_storage_root, resolve_storage_path, write_bytes_file
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import create_book_asset
from app.modules.books.domain import Book
from app.modules.processing.paths import processed_book_path
from app.modules.processing.processors.archive_limits import ArchiveProcessingBudget
from app.modules.processing.processors.txt_processor import process_text_content
from app.modules.processing.types import ProcessingResult

from app.modules.processing.processors.mobi_records import (
    MOBI_COMPRESSION_HUFF_CDIC, PALMDOC_COMPRESSION_NONE, PALMDOC_COMPRESSION_LZ77,
    MobiNoTextError, MobiProcessingError, decode_mobi_text, decompress_mobi_record,
    read_mobi_encoding, read_mobi_extra_flags, read_mobi_title, read_palm_record_offsets, read_palmdoc_header,
    read_record, read_uint16, read_uint32, strip_mobi_record_extras,
)


class ExtractedMobiText:
    def __init__(self, *, text: str, title: str | None = None, document: str = "") -> None:
        self.text = text
        self.title = title
        self.document = document


class MobiImageRecord:
    def __init__(self, *, data: bytes, extension: str, record_index: int) -> None:
        self.data = data
        self.extension = extension
        self.record_index = record_index


class MobiHtmlTextParser(HTMLParser):
    def __init__(self, image_markers: dict[int, int] | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._ignored_tags: list[str] = []
        self._image_markers = image_markers or {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"head", "script", "style"}:
            self._ignored_tags.append(tag.lower())
        if self._ignored_tags:
            return
        if tag.lower() == "img":
            attributes = dict(attrs)
            reference = attributes.get("recindex") or ""
            if reference.isascii() and reference.isdecimal():
                image_index = self._image_markers.get(int(reference))
                if image_index is not None:
                    self._parts.append(f"\n[[AISU_CHAPTER_IMAGE:{image_index}]]\n")
            return
        if tag.lower() in {"br", "div", "h1", "h2", "h3", "h4", "li", "p"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._ignored_tags:
            position = len(self._ignored_tags) - 1 - self._ignored_tags[::-1].index(tag.lower())
            del self._ignored_tags[position:]
            return
        if self._ignored_tags:
            return
        if tag.lower() in {"div", "h1", "h2", "h3", "h4", "li", "p"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if data and not self._ignored_tags:
            self._parts.append(data)

    def get_text(self) -> str:
        text = "".join(self._parts)
        text = re.sub(r"[ \t\x0b\x0c]+", " ", text)
        text = re.sub(r" *\n *", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def process_mobi(book: Book, settings: Settings) -> ProcessingResult:
    if not book.original_file_path:
        return ProcessingResult(reader_type="unsupported")

    original_path = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    try:
        data = original_path.read_bytes()
        record_offsets = read_palm_record_offsets(data)
        try:
            extracted = extract_mobi_text_from_records(data, record_offsets, settings)
        except MobiNoTextError:
            extracted = None
        image_assets = extract_mobi_image_assets(book, settings, data, record_offsets, chapter_images=extracted is not None)
        cover = (
            create_book_asset(
                asset_type="cover",
                book_id=book.id,
                metadata={"source": image_assets[0].metadata.get("source", "mobi-image-1")},
                path=image_assets[0].path,
            )
            if image_assets else None
        )
        if extracted is None:
            if cover is None:
                return ProcessingResult(reader_type="unsupported")
            return ProcessingResult(
                assets=[*image_assets, cover],
                cover_path=cover.path,
                current_chapter="Page 1",
                page_count=len(image_assets),
                reader_type="comic",
            )

    except MobiProcessingError:
        return ProcessingResult(reader_type="unsupported")

    text = mobi_html_to_text(extracted.document, mobi_image_reference_map(data, record_offsets, image_assets))
    result = process_text_content(book, settings, text)
    return ProcessingResult(
        assets=[*result.assets, *image_assets, *([cover] if cover else [])],
        author=result.author,
        cover_path=cover.path if cover else result.cover_path,
        current_chapter=result.current_chapter,
        description=result.description,
        language=result.language,
        page_count=result.page_count,
        reader_type="text",
        title=extracted.title,
    )


def extract_mobi_text_from_records(data: bytes, record_offsets: list[int], settings: Settings) -> ExtractedMobiText:
    if not record_offsets:
        raise MobiProcessingError("MOBI has no records")

    first_record = read_record(data, record_offsets, 0)
    if len(first_record) < 16:
        raise MobiProcessingError("MOBI header is incomplete")

    compression, text_length, text_record_count = read_palmdoc_header(first_record)
    if read_uint16(first_record, 12) != 0:
        raise MobiProcessingError("Encrypted MOBI text is not supported")
    if text_length == 0 and text_record_count == 0:
        raise MobiNoTextError("MOBI has no text records")
    if text_length == 0 or not 1 <= text_record_count < len(record_offsets):
        raise MobiProcessingError("MOBI text record count or length is invalid")
    if compression == MOBI_COMPRESSION_HUFF_CDIC:
        raise MobiProcessingError("MOBI Huff/CDIC compression is not supported")
    if compression not in {PALMDOC_COMPRESSION_NONE, PALMDOC_COMPRESSION_LZ77}:
        raise MobiProcessingError(f"MOBI compression is not supported: {compression}")

    encoding = read_mobi_encoding(first_record)
    extra_flags = read_mobi_extra_flags(first_record)
    title = read_mobi_title(first_record)
    text_records = []
    processed_size = 0
    for index in range(1, text_record_count + 1):
        record = read_record(data, record_offsets, index)
        record = strip_mobi_record_extras(record, extra_flags)
        decompressed = decompress_mobi_record(record, compression, settings.max_archive_member_size_bytes)
        processed_size += len(decompressed)
        if processed_size > settings.max_processed_size_bytes:
            raise StorageLimitExceededError("MOBI text extraction exceeds configured size limit")
        text_records.append(decompressed)

    raw_text = b"".join(text_records)
    if len(raw_text) < text_length:
        raise MobiProcessingError("MOBI text records are incomplete")
    raw_text = raw_text[:text_length]
    document = decode_mobi_text(raw_text, encoding)
    text = mobi_html_to_text(document)
    if not text:
        raise MobiNoTextError("MOBI contains no readable text")

    return ExtractedMobiText(text=text, title=title, document=document)


def mobi_image_reference_map(data: bytes, record_offsets: list[int], assets: list[BookAsset]) -> dict[int, int]:
    first_record = read_record(data, record_offsets, 0)
    mobi_offset = first_record.find(b"MOBI", 16)
    if mobi_offset < 0 or len(first_record) < mobi_offset + 96:
        return {index: index for index in range(1, len(assets) + 1)}
    first_image_record = read_uint32(first_record, mobi_offset + 92)
    if not 1 <= first_image_record < len(record_offsets):
        return {index: index for index in range(1, len(assets) + 1)}
    return {
        int(str(asset.metadata["source"]).removeprefix("record-")) - first_image_record + 1: index
        for index, asset in enumerate(assets, 1)
        if int(str(asset.metadata["source"]).removeprefix("record-")) >= first_image_record
    }


def extract_mobi_image_assets(book: Book, settings: Settings, data: bytes, record_offsets: list[int], *, chapter_images: bool = False) -> list[BookAsset]:
    budget = ArchiveProcessingBudget(settings)
    image_records = find_mobi_image_records(data, record_offsets)
    if not image_records:
        return []

    assets: list[BookAsset] = []
    processed_size = 0
    for index, image_record in enumerate(image_records, start=1):
        budget.reserve_asset()
        if len(image_record.data) > settings.max_archive_member_size_bytes:
            raise StorageLimitExceededError("MOBI image exceeds configured size limit")
        processed_size += len(image_record.data)
        if processed_size > settings.max_processed_size_bytes:
            raise StorageLimitExceededError("MOBI image extraction exceeds configured size limit")
        stored_file = write_bytes_file(
            data=image_record.data,
            relative_path=processed_book_path(book.owner_id, book.id, "chapter-images" if chapter_images else "comic", f"{index:04d}{image_record.extension}"),
            settings=settings,
        )
        assets.append(
            create_book_asset(
                asset_type="chapter_image" if chapter_images else "comic_page",
                book_id=book.id,
                index=index,
                metadata={"source": f"record-{image_record.record_index}"},
                path=stored_file.relative_path,
            )
        )

    return assets


def find_mobi_image_records(data: bytes, record_offsets: list[int]) -> list[MobiImageRecord]:
    images: list[MobiImageRecord] = []
    for index in range(len(record_offsets)):
        record = read_record(data, record_offsets, index)
        image_type = detect_image_type(record)
        if image_type is None:
            continue
        extension, cleaned_data = image_type
        images.append(MobiImageRecord(data=cleaned_data, extension=extension, record_index=index))
    return images


def detect_image_type(record: bytes) -> tuple[str, bytes] | None:
    if record.startswith(b"\xff\xd8\xff"):
        return ".jpg", strip_trailing_mobi_padding(record)
    if record.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png", strip_trailing_mobi_padding(record)
    if record.startswith((b"GIF87a", b"GIF89a")):
        return ".gif", strip_trailing_mobi_padding(record)
    if record.startswith(b"RIFF") and record[8:12] == b"WEBP":
        declared_size = int.from_bytes(record[4:8], "little") + 8
        if declared_size < 12 or declared_size > len(record):
            raise MobiProcessingError("MOBI WebP image is incomplete")
        return ".webp", record[:declared_size]
    return None


def strip_trailing_mobi_padding(data: bytes) -> bytes:
    return data.rstrip(b"\x00")


def mobi_html_to_text(text: str, image_markers: dict[int, int] | None = None) -> str:
    if "<" not in text or ">" not in text:
        return normalize_plain_text(text)

    parser = MobiHtmlTextParser(image_markers)
    parser.feed(text)
    return normalize_plain_text(parser.get_text())


def normalize_plain_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\x00", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
