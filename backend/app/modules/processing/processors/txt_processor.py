import codecs
import re

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, write_bytes_file
from app.modules.book_assets.repository import create_book_asset
from app.modules.books.domain import Book
from app.modules.processing.paths import processed_book_path
from app.modules.processing.language import detect_book_language
from app.modules.processing.types import ProcessingResult
from app.modules.processing.chapter_headings import CHAPTER_PATTERN

# Any letter, kana or CJK ideograph -- what tells prose apart from a rule of
# dashes or a run of blank lines.
PROSE_CHARACTER_PATTERN = re.compile(r"[0-9A-Za-z぀-ヿㇰ-ㇿ㐀-䶿一-鿿가-힯]")
MAX_TXT_CHAPTER_CHARS = 10_000


def process_txt(book: Book, settings: Settings) -> ProcessingResult:
    if not book.original_file_path:
        return ProcessingResult()

    original_path = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    text = decode_text(original_path.read_bytes())
    return process_text_content(book, settings, text)


def process_text_content(book: Book, settings: Settings, text: str) -> ProcessingResult:
    chapters = split_chapters(text)
    assets = []

    for index, chapter in enumerate(chapters, start=1):
        stored_file = write_bytes_file(
            data=chapter["content"].encode("utf-8"),
            relative_path=processed_book_path(book.owner_id, book.id, "text", f"chapter-{index:04d}.txt"),
            settings=settings,
        )
        assets.append(
            create_book_asset(
                asset_type="text_chapter",
                book_id=book.id,
                index=index,
                metadata={"title": chapter["title"], "text_length": len(chapter["content"])},
                path=stored_file.relative_path,
            )
        )

    first_title = chapters[0]["title"] if chapters else "第 1 章"
    return ProcessingResult(
        assets=assets,
        current_chapter=first_title,
        description=book.description,
        language=detect_book_language(book.title, book.author, text),
        page_count=len(chapters),
    )


def decode_text(data: bytes) -> str:
    # UTF-32 LE shares the UTF-16 LE prefix; check the longer BOM first.
    # An explicit Unicode encoding must not fall through to a permissive
    # legacy decoder when its payload is truncated or malformed.
    if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        return data.decode("utf-32")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16")
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue

    return data.decode("utf-8", errors="ignore")


def split_chapters(text: str) -> list[dict[str, str]]:
    headings = list(CHAPTER_PATTERN.finditer(text))
    matches = [
        match
        for index, match in enumerate(headings)
        if PROSE_CHARACTER_PATTERN.search(
            text[match.end() : headings[index + 1].start() if index + 1 < len(headings) else len(text)]
        )
    ]
    if not matches:
        return chunk_chapter("第 1 章", text.strip() or "（空章节）")

    chapters: list[dict[str, str]] = []
    # Stop the preface at the first heading-like line rather than the first real
    # one, so a discarded catalogue block does not get folded into 序章.
    preface = text[: headings[0].start()].strip()
    if preface:
        chapters.extend(chunk_chapter("序章", preface))

    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        chapter_text = text[start:end].strip()
        title = match.group(1).strip()
        chapters.extend(chunk_chapter(title, chapter_text))

    return chapters


def chunk_chapter(title: str, content: str) -> list[dict[str, str]]:
    if len(content) <= MAX_TXT_CHAPTER_CHARS:
        return [{"title": title, "content": content}]

    chunks = split_text_by_length(content, MAX_TXT_CHAPTER_CHARS)
    if len(chunks) == 1:
        return [{"title": title, "content": chunks[0]}]

    return [{"title": f"{title} ({index})", "content": chunk} for index, chunk in enumerate(chunks, start=1)]


def split_text_by_length(text: str, max_chars: int) -> list[str]:
    chunks: list[str] = []
    remaining = text.strip()

    while len(remaining) > max_chars:
        split_at = find_split_index(remaining, max_chars)
        chunk = remaining[:split_at].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[split_at:].strip()

    if remaining:
        chunks.append(remaining)

    return chunks


def find_split_index(text: str, max_chars: int) -> int:
    paragraph_break = text.rfind("\n\n", 0, max_chars)
    if paragraph_break >= max_chars // 2:
        return paragraph_break

    line_break = text.rfind("\n", 0, max_chars)
    if line_break >= max_chars // 2:
        return line_break

    sentence_breaks = [text.rfind(mark, 0, max_chars) for mark in ("。", "！", "？", ".", "!", "?")]
    sentence_break = max(sentence_breaks)
    if sentence_break >= max_chars // 2:
        return sentence_break + 1

    return max_chars
