import hashlib
import json

from app.modules.books.domain import Book


def pdf_position_key(book: Book) -> str | None:
    if book.reader_type != "pdf" or not book.original_file_path:
        return None
    # Published replacements use immutable, versioned original paths. Metadata
    # edits and ticket renewal therefore do not change the reading identity.
    identity = json.dumps([book.id, book.reader_type, book.original_file_path, book.file_size], separators=(",", ":"))
    return "pdf:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
