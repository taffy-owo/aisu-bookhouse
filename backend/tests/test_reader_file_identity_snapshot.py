from dataclasses import replace
from datetime import datetime, timezone
import pytest
from fastapi import HTTPException

from app.core.config import Settings
from app.modules.books.repository import InMemoryBookRepository
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import InMemoryBookAssetRepository
from app.modules.files.service import get_original_file_download, get_asset_file_download
from app.modules.reader.page_identity import pdf_position_key


def test_in_flight_pdf_read_keeps_its_immutable_path_during_publication(tmp_path, monkeypatch):
    books = InMemoryBookRepository()
    book = books.create_from_upload(owner_id="owner", title="PDF", author="Author", kind="pdf", reader_type="pdf", tags=(), file_label="pdf")
    book = books.save(book.with_changes(original_file_path="old.pdf", file_size=3))
    (tmp_path / "old.pdf").write_bytes(b"old")
    (tmp_path / "new.pdf").write_bytes(b"new")
    read = books.get_accessible

    def publish_after_access(owner_id, book_id):
        snapshot = read(owner_id, book_id)
        books.save(snapshot.with_changes(original_file_path="new.pdf"))
        return snapshot

    monkeypatch.setattr(books, "get_accessible", publish_after_access)
    download = get_original_file_download(book_id=book.id, book_repository=books, owner_id="owner", settings=Settings(storage_root=str(tmp_path)), position_key=pdf_position_key(book))
    assert download.path.read_bytes() == b"old"
    assert books.get_by_id(book.id).original_file_path == "new.pdf"


@pytest.mark.parametrize("publish_before_lookup", [False, True])
def test_image_reads_return_old_bytes_or_conflict_but_never_new_bytes_under_an_old_identity(tmp_path, monkeypatch, publish_before_lookup):
    books = InMemoryBookRepository()
    book = books.create_from_upload(owner_id="owner", title="Comic", author="Author", kind="manga", reader_type="comic", tags=(), file_label="cbz")
    assets = InMemoryBookAssetRepository()
    old = BookAsset(id="old", book_id=book.id, asset_type="comic_page", path="old.png", index=1, metadata={}, created_at=datetime.now(timezone.utc))
    assets.save(old)
    (tmp_path / "old.png").write_bytes(b"old")
    (tmp_path / "new.png").write_bytes(b"new")
    read = assets.get_by_index

    def concurrent_lookup(*args):
        snapshot = read(*args)
        assets.clear_for_book(book.id)
        assets.save(replace(old, id="new", path="new.png"))
        return read(*args) if publish_before_lookup else snapshot

    monkeypatch.setattr(assets, "get_by_index", concurrent_lookup)
    def download():
        return get_asset_file_download(book_id=book.id, book_repository=books, owner_id="owner", settings=Settings(storage_root=str(tmp_path)), asset_repository=assets, asset_type="comic_page", index=1, file_name="page.png", position_key=old.id)
    if publish_before_lookup:
        with pytest.raises(HTTPException) as caught:
            download()
        assert caught.value.status_code == 409
    else:
        assert download().path.read_bytes() == b"old"
