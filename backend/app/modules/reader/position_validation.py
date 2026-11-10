from fastapi import HTTPException

from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository
from app.modules.reader.service import filter_readable_text_assets, get_reader_chapter_version
from app.modules.reader.page_identity import pdf_position_key


def require_current_reader_position(
    *, book: Book, book_repository: BookRepository, asset_repository: BookAssetRepository | None,
    chapter_index: int | None, position_key: str | None, reader_type: str,
    image_index: int | None = None, page_number: int | None = None, content_version: str | None = None,
) -> None:
    if reader_type != book.reader_type:
        raise HTTPException(409, "阅读格式已更新，请先打开新版阅读器后再保存。")
    if content_version is not None and (book.reader_type not in {"text", "epub"} or chapter_index is None
                                        or asset_repository is None or image_index is not None or page_number is not None):
        raise HTTPException(409, "正文版本与章节坐标不一致，请加载新版正文后再保存。")
    if position_key is None:
        if book.reader_type in {"pdf", "comic", "image"} and any(value is not None for value in (chapter_index, image_index, page_number)):
            raise HTTPException(409, "保存页码需要当前文件的页标识，请刷新阅读资源后再保存。")
        if book.reader_type in {"text", "epub"} and chapter_index is not None and asset_repository is not None:
            book_repository.lock_revision(book)
            chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
            # Legacy clients may omit stable keys, but an extracted catalog
            # still makes impossible chapter numbers unambiguous.
            if chapters and not 1 <= chapter_index <= len(chapters):
                raise HTTPException(409, "章节位置已失效，请重新打开阅读器后再保存。")
            if content_version is not None and (not chapters or get_reader_chapter_version(chapters[chapter_index - 1]) != content_version):
                raise HTTPException(409, "本话正文已修订，请加载新版后再保存；备注内容已保留。")
        # Percentage-only updates are explicit manual progress changes. Older
        # chapter API clients remain compatible; paged coordinates require keys.
        return
    book_repository.lock_revision(book)
    if book.reader_type == "pdf":
        if chapter_index is not None or image_index is not None or page_number is None or page_number < 1 or position_key != pdf_position_key(book):
            raise HTTPException(409, "PDF 文件或页码已更新，请先打开新版阅读器后再保存。")
        return
    if book.reader_type in {"comic", "image"}:
        index = image_index if image_index is not None else page_number
        if chapter_index is not None or index is None or index < 1 or asset_repository is None or (image_index is not None and page_number is not None and image_index != page_number):
            raise HTTPException(409, "图片页位置已失效，请先打开新版阅读器后再保存。")
        pages = asset_repository.list_by_book(book.id, "comic_page" if book.reader_type == "comic" else "image_page")
        if index > len(pages) or pages[index - 1].id != position_key:
            raise HTTPException(409, "图片页内容或顺序已更新，请先打开新版阅读器后再保存。")
        return
    if book.reader_type not in {"text", "epub"} or chapter_index is None or chapter_index < 1 or asset_repository is None:
        raise HTTPException(409, "章节位置已失效，请重新打开阅读器后再保存。")
    if image_index is not None or page_number is not None:
        raise HTTPException(409, "章节坐标与当前阅读格式不一致，请加载新版正文后再保存。")
    chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    if chapter_index > len(chapters) or chapters[chapter_index - 1].id != position_key:
        raise HTTPException(409, "章节内容或顺序已更新，请加载新版正文后再保存。")
    if content_version is not None and get_reader_chapter_version(chapters[chapter_index - 1]) != content_version:
        raise HTTPException(409, "本话正文已修订，请加载新版后再保存；备注内容已保留。")
