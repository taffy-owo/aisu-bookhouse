from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re

from app.core.config import Settings
from app.core.security import create_file_ticket
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.domain import AssetType, BookAsset
from app.modules.book_assets.image_metadata import image_reference_looks_like_inline_icon, read_image_file_dimensions
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.book_assets.text_chapters import is_auxiliary_text_metadata
from app.modules.books.repository import BookRepository
from app.modules.reader.page_identity import pdf_position_key
from app.modules.reader.schemas import ReaderChapter, ReaderChapterBlock, ReaderInlineSpan, ReaderPage, ReaderResource, ReaderTocItem


CHAPTER_IMAGE_MARKER_RE = re.compile(r"\[\[AISU_CHAPTER_IMAGE:(\d+)]]")
IMAGE_PROGRESS_EQUIVALENT_CHARACTER_COUNT = 180


def get_reader_resource(
    owner_id: str,
    book_id: str,
    book_repository: BookRepository,
    asset_repository: BookAssetRepository | None = None,
    settings: Settings | None = None,
) -> ReaderResource | None:
    book = book_repository.get_accessible(owner_id, book_id)
    if not book:
        return None

    if book.reader_type in ("comic", "image"):
        asset_type: AssetType = "comic_page" if book.reader_type == "comic" else "image_page"
        page_assets = asset_repository.list_by_book(book.id, asset_type) if asset_repository else []
        return ReaderResource(
            reader_type=book.reader_type,
            version=book.updated_at.isoformat(),
            cover_url=book.cover_url,
            page_count=len(page_assets),
            pages=[ReaderPage(position_key=asset.id, index=asset.index or index, image_url=f"/api/v1/files/books/{book.id}/pages/{asset.index or index}?position_key={asset.id}") for index, asset in enumerate(page_assets, start=1)],
        )

    if book.reader_type == "pdf":
        position_key = pdf_position_key(book)
        file_url = f"/api/v1/files/books/{book.id}/pdf"
        if settings is not None:
            ticket = create_file_ticket(subject=owner_id, book_id=book.id, purpose="pdf_preview", settings=settings)
            file_url = f"/api/v1/files/books/{book.id}/pdf-preview?ticket={ticket}"
        if position_key:
            file_url += ("&" if "?" in file_url else "?") + f"position_key={position_key}"
        return ReaderResource(
            position_key=position_key,
            reader_type=book.reader_type,
            version=book.updated_at.isoformat(),
            cover_url=book.cover_url,
            file_url=file_url,
        )

    if book.reader_type == "unsupported":
        return ReaderResource(
            reader_type=book.reader_type,
            version=book.updated_at.isoformat(),
            cover_url=book.cover_url,
            chapter_count=0,
            toc=[],
        )

    raw_text_chapters = asset_repository.list_by_book(book.id, "text_chapter") if asset_repository else []
    if raw_text_chapters and looks_like_image_only_text_assets(raw_text_chapters):
        return ReaderResource(
            reader_type="comic",
            version=book.updated_at.isoformat(),
            cover_url=book.cover_url,
            page_count=0,
            pages=[],
        )

    text_chapters = filter_readable_text_assets(raw_text_chapters)
    if not text_chapters and not book.original_file_path:
        return ReaderResource(
            reader_type=book.reader_type,
            version=book.updated_at.isoformat(),
            cover_url=book.cover_url,
            chapter_count=0,
            toc=[],
        )

    return ReaderResource(
        reader_type=book.reader_type,
        version=book.updated_at.isoformat(),
        cover_url=book.cover_url,
        file_url=get_original_reader_file_url(book.id, book.reader_type),
        chapter_count=len(text_chapters),
        toc=[
            ReaderTocItem(
                position_key=asset.id,
                content_version=get_reader_chapter_version(asset),
                index=index,
                progress_weight=get_reader_progress_weight(asset),
                title=get_asset_title(asset, index),
                level=get_reader_toc_level(asset),
                section_title=get_reader_section_title(asset),
                section_level=get_reader_section_level(asset),
            )
            for index, asset in enumerate(text_chapters, start=1)
        ],
    )


def get_reader_chapter_version(asset: BookAsset) -> str:
    # Mutations publish immutable files while keeping the stable chapter id.
    # Hash only content-related fields; appending another chapter or changing
    # book metadata must not make the currently visible chapter obsolete.
    fields = [asset.path, *(asset.metadata.get(key) for key in
              ("title", "content_sha256", "blocks_path", "content_is_body"))]
    return sha256(json.dumps(fields, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def get_reader_progress_weight(asset: BookAsset) -> int | None:
    text_length = asset.metadata.get("text_length")
    image_count = asset.metadata.get("image_count")
    has_text_length = isinstance(text_length, int) and not isinstance(text_length, bool) and text_length >= 0
    has_image_count = isinstance(image_count, int) and not isinstance(image_count, bool) and image_count >= 0
    if not has_text_length and not has_image_count:
        return None

    text_weight = text_length if has_text_length else 0
    image_weight = image_count * IMAGE_PROGRESS_EQUIVALENT_CHARACTER_COUNT if has_image_count else 0
    return max(1, text_weight + image_weight)


def resolve_progress_chapter_position(progress_percent: int, chapter_weights: list[int | None]) -> tuple[int | None, float | None]:
    if not chapter_weights:
        return None, None

    weights = [float(weight) for weight in chapter_weights] if all(weight is not None and weight > 0 for weight in chapter_weights) else [1.0] * len(chapter_weights)
    target_weight = min(100, max(0, progress_percent)) / 100 * sum(weights)
    completed_weight = 0.0

    for chapter_index, weight in enumerate(weights, start=1):
        chapter_end = completed_weight + weight
        if target_weight < chapter_end or chapter_index == len(weights):
            chapter_ratio = min(1.0, max(0.0, (target_weight - completed_weight) / weight))
            return chapter_index, chapter_ratio
        completed_weight = chapter_end

    return len(weights), 1.0


def get_reader_toc_level(asset: BookAsset) -> int:
    level = asset.metadata.get("toc_level")
    if not isinstance(level, int) or isinstance(level, bool):
        return 1
    return min(6, max(1, level))


def get_reader_section_title(asset: BookAsset) -> str | None:
    title = asset.metadata.get("source_section_title")
    return title.strip() if isinstance(title, str) and title.strip() else None


def get_reader_section_level(asset: BookAsset) -> int:
    level = asset.metadata.get("source_section_level")
    if not isinstance(level, int) or isinstance(level, bool):
        return 1
    return min(6, max(1, level))


def get_original_reader_file_url(book_id: str, reader_type: str) -> str | None:
    if reader_type == "epub":
        return f"/api/v1/files/books/{book_id}/epub"
    if reader_type in {"text", "pdf"}:
        return f"/api/v1/files/books/{book_id}/original"
    return None


def get_reader_chapter(
    *,
    asset_repository: BookAssetRepository,
    book_id: str,
    book_repository: BookRepository,
    chapter_index: int,
    owner_id: str,
    settings: Settings,
) -> ReaderChapter | None:
    book = book_repository.get_accessible(owner_id, book_id)
    if not book:
        return None

    if book.reader_type in ("comic", "image"):
        return None

    text_chapters = asset_repository.list_by_book(book_id, "text_chapter")
    if text_chapters and looks_like_image_only_text_assets(text_chapters):
        return None

    readable_text_chapters = filter_readable_text_assets(text_chapters)
    if chapter_index < 1 or chapter_index > len(readable_text_chapters):
        return None

    asset = readable_text_chapters[chapter_index - 1]
    path = resolve_storage_path(get_storage_root(settings), asset.path)
    if not path.is_file():
        return None

    title = get_asset_title(asset, chapter_index)
    raw_content = path.read_text(encoding="utf-8")
    content = strip_leading_chapter_title(raw_content, title, content_is_body=asset.metadata.get("content_is_body") is True)
    blocks = build_chapter_blocks_for_asset(
        asset,
        content,
        title,
        book_id,
        asset_repository=asset_repository,
        settings=settings,
    )
    return ReaderChapter(
        position_key=asset.id,
        content_version=get_reader_chapter_version(asset),
        blocks=blocks,
        # Speech, paragraph recovery and rendered prose must share one text source.
        content="\n\n".join(block.text for block in blocks if block.type != "image" and block.text),
        index=chapter_index,
        title=title,
    )


def get_asset_title(asset: BookAsset, fallback_index: int) -> str:
    title = asset.metadata.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()

    return f"第 {fallback_index} 章"


def build_chapter_blocks_for_asset(
    asset: BookAsset,
    content: str,
    title: str,
    book_id: str,
    *,
    asset_repository: BookAssetRepository | None = None,
    settings: Settings | None = None,
) -> list[ReaderChapterBlock]:
    """Prefer the structured rich-text sidecar; fall back to plain text.

    Books processed before rich extraction (or any book whose sidecar is
    missing/unreadable) keep rendering from the plain ``.txt`` blocks, so
    already-ingested books stay fully readable without re-processing.
    """

    stored_blocks = load_rich_chapter_blocks(asset, settings)
    if stored_blocks is not None:
        rich_blocks = build_rich_reader_blocks(
            stored_blocks,
            title,
            book_id,
            asset_repository=asset_repository,
            settings=settings,
            content_is_body=asset.metadata.get("content_is_body") is True,
        )
        if rich_blocks:
            return rich_blocks

    return build_reader_chapter_blocks(content, book_id, asset_repository=asset_repository, settings=settings)


def load_rich_chapter_blocks(asset: BookAsset, settings: Settings | None) -> list[object] | None:
    blocks_path = asset.metadata.get("blocks_path")
    if not isinstance(blocks_path, str) or not blocks_path or settings is None:
        return None

    try:
        path = resolve_storage_path(get_storage_root(settings), blocks_path)
    except ValueError:
        return None
    if not path.is_file():
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None

    blocks = payload.get("blocks") if isinstance(payload, dict) else None
    return blocks if isinstance(blocks, list) else None


def build_rich_reader_blocks(
    stored_blocks: list[object],
    title: str,
    book_id: str,
    *,
    asset_repository: BookAssetRepository | None,
    settings: Settings | None,
    content_is_body: bool = False,
) -> list[ReaderChapterBlock]:
    blocks: list[ReaderChapterBlock] = []
    title_key = normalize_heading_text(title)
    stripping_leading_title = bool(title_key) and not content_is_body

    for raw_block in stored_blocks:
        if not isinstance(raw_block, dict):
            continue

        block_type = raw_block.get("type")
        if block_type == "image":
            stripping_leading_title = False
            image_index = raw_block.get("image_index")
            if isinstance(image_index, int):
                image_block = build_reader_image_block(
                    asset_repository=asset_repository,
                    book_id=book_id,
                    image_index=image_index,
                    settings=settings,
                )
                if image_block is not None:
                    blocks.append(image_block)
            continue

        if block_type not in ("paragraph", "heading"):
            continue

        text = raw_block.get("text")
        if not isinstance(text, str) or not text.strip():
            continue

        # Drop the leading heading/paragraph that merely repeats the chapter
        # title (shown separately in the reader header), matching the
        # plain-text path's strip_leading_chapter_title behaviour.
        if stripping_leading_title and normalize_heading_text(text) == title_key:
            continue
        stripping_leading_title = False

        spans = build_reader_inline_spans(raw_block.get("spans"))
        if block_type == "heading":
            blocks.append(ReaderChapterBlock(type="heading", text=text, level=clamp_heading_level(raw_block.get("level")), spans=spans))
        else:
            blocks.append(ReaderChapterBlock(type="paragraph", text=text, spans=spans))

    return blocks


def build_reader_inline_spans(raw_spans: object) -> list[ReaderInlineSpan] | None:
    """Re-validate stored spans against the mark whitelist (defence in depth)."""

    if not isinstance(raw_spans, list):
        return None

    spans: list[ReaderInlineSpan] = []
    for raw_span in raw_spans:
        if not isinstance(raw_span, dict):
            continue
        text = raw_span.get("text")
        if not isinstance(text, str) or text == "":
            continue
        raw_marks = raw_span.get("marks")
        marks = [mark for mark in raw_marks if mark in ("strong", "emphasis", "emphasis_dot")] if isinstance(raw_marks, list) else []
        ruby = raw_span.get("ruby")
        spans.append(ReaderInlineSpan(text=text, marks=marks, ruby=ruby if isinstance(ruby, str) and ruby else None))

    return spans or None


def clamp_heading_level(level: object) -> int:
    if isinstance(level, int) and 1 <= level <= 6:
        return level
    return 2


def build_reader_chapter_blocks(
    content: str,
    book_id: str,
    *,
    asset_repository: BookAssetRepository | None = None,
    settings: Settings | None = None,
) -> list[ReaderChapterBlock]:
    blocks: list[ReaderChapterBlock] = []
    cursor = 0

    for match in CHAPTER_IMAGE_MARKER_RE.finditer(content):
        append_paragraph_blocks(blocks, content[cursor : match.start()])
        image_index = int(match.group(1))
        image_block = build_reader_image_block(
            asset_repository=asset_repository,
            book_id=book_id,
            image_index=image_index,
            settings=settings,
        )
        if image_block is not None:
            blocks.append(image_block)
        cursor = match.end()

    append_paragraph_blocks(blocks, content[cursor:])
    return blocks


def build_reader_image_block(
    *,
    asset_repository: BookAssetRepository | None,
    book_id: str,
    image_index: int,
    settings: Settings | None,
) -> ReaderChapterBlock | None:
    if not asset_repository or not settings:
        return ReaderChapterBlock(
            type="image",
            alt=f"第 {image_index} 张插图",
            image_url=f"/api/v1/files/books/{book_id}/chapter-images/{image_index}",
        )

    image_asset = asset_repository.get_by_index(book_id, "chapter_image", image_index)
    if not image_asset:
        return None

    try:
        image_path = resolve_storage_path(get_storage_root(settings), image_asset.path)
    except ValueError:
        return None

    if not image_path.is_file():
        return None

    pixel_width, pixel_height = get_chapter_image_dimensions(image_asset, image_path)
    source = image_asset.metadata.get("source")
    if image_reference_looks_like_inline_icon(
        pixel_height=pixel_height,
        pixel_width=pixel_width,
        source=source if isinstance(source, str) else image_asset.path,
    ):
        return None

    return ReaderChapterBlock(
        type="image",
        alt=f"第 {image_index} 张插图",
        image_url=f"/api/v1/files/books/{book_id}/chapter-images/{image_index}",
        image_width=pixel_width,
        image_height=pixel_height,
    )


def get_chapter_image_dimensions(asset: BookAsset, image_path: Path) -> tuple[int | None, int | None]:
    stored_width = asset.metadata.get("pixel_width")
    stored_height = asset.metadata.get("pixel_height")
    if isinstance(stored_width, int) and isinstance(stored_height, int):
        return stored_width, stored_height

    return read_image_file_dimensions(image_path)


def append_paragraph_blocks(blocks: list[ReaderChapterBlock], text: str) -> None:
    for paragraph in split_paragraphs(text):
        blocks.append(ReaderChapterBlock(type="paragraph", text=paragraph))


def split_paragraphs(text: str) -> list[str]:
    # Plain-text novels commonly use one physical line per paragraph and only
    # reserve empty lines for scene changes. Splitting only on blank lines
    # turns an entire scene into one enormous reader paragraph and also stops
    # the leading chapter title from being removed. EPUB extraction already
    # emits one logical paragraph per line, so the same rule is safe for both
    # reader types. Normalize legacy CR-only files at the same boundary.
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def strip_leading_chapter_title(content: str, title: str, *, content_is_body: bool = False) -> str:
    if content_is_body:
        return content
    title_key = normalize_heading_text(title)
    if not title_key:
        return content

    paragraphs = split_paragraphs(content)
    while paragraphs and normalize_heading_text(paragraphs[0]) == title_key:
        paragraphs.pop(0)

    return "\n\n".join(paragraphs)


def normalize_heading_text(text: str) -> str:
    return re.sub(r"\s+", "", text).strip().lower()


def filter_readable_text_assets(text_assets: list[BookAsset]) -> list[BookAsset]:
    readable_assets = [asset for asset in text_assets if not is_auxiliary_text_asset(asset)]
    return readable_assets or text_assets


def is_auxiliary_text_asset(asset: BookAsset) -> bool:
    return is_auxiliary_text_metadata(asset.metadata)


def looks_like_image_only_text_assets(text_assets: list[BookAsset]) -> bool:
    if len(text_assets) < 20:
        return False

    marker_count = 0
    short_text_count = 0
    titles: list[str] = []
    for asset in text_assets:
        title = asset.metadata.get("title")
        if not isinstance(title, str):
            continue

        titles.append(title.strip())
        normalized_title = title.strip().upper()
        if normalized_title in {"THE END", "END"} or is_page_marker_title(title):
            marker_count += 1

        text_length = asset.metadata.get("text_length")
        if isinstance(text_length, int) and text_length <= 40:
            short_text_count += 1

    if marker_count / len(text_assets) >= 0.7:
        return True

    return short_text_count / len(text_assets) >= 0.85 and get_most_common_title_ratio(titles) >= 0.7


def get_most_common_title_ratio(titles: list[str]) -> float:
    if not titles:
        return 0

    most_common_count = Counter(titles).most_common(1)[0][1]
    return most_common_count / len(titles)


def is_page_marker_title(title: str) -> bool:
    normalized_title = title.strip().replace(" ", "")
    return normalized_title.startswith("第") and normalized_title.endswith(("页", "頁"))
