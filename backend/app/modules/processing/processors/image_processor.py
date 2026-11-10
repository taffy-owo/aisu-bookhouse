from app.modules.book_assets.repository import create_book_asset
from app.modules.books.domain import Book
from app.modules.processing.types import ProcessingResult


def process_image(book: Book) -> ProcessingResult:
    if not book.original_file_path:
        return ProcessingResult()

    asset = create_book_asset(
        asset_type="image_page",
        book_id=book.id,
        index=1,
        metadata={"source": "original"},
        path=book.original_file_path,
    )
    cover = create_book_asset(
        asset_type="cover",
        book_id=book.id,
        metadata={"source": "original"},
        path=book.original_file_path,
    )
    return ProcessingResult(assets=[asset, cover], cover_path=cover.path, current_chapter="第 1 页", page_count=1)


