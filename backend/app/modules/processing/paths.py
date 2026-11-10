from pathlib import Path

from app.core.storage import safe_storage_segment


def processed_book_path(owner_id: str, book_id: str, *parts: str) -> Path:
    return Path("processed") / safe_storage_segment(owner_id) / safe_storage_segment(book_id) / Path(*parts)
