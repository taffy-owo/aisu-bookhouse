from dataclasses import replace
from datetime import datetime, timezone
import pytest

from app.core.config import Settings
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import InMemoryBookAssetRepository
from app.modules.books.repository import InMemoryBookRepository
from app.modules.reader.service import get_reader_chapter, get_reader_resource


def fixture(tmp_path):
    settings = Settings(storage_root=str(tmp_path))
    books = InMemoryBookRepository()
    book = books.create_from_upload(owner_id="owner", author="Author", title="Book", kind="novel", reader_type="text", tags=(), file_label="txt")
    assets = InMemoryBookAssetRepository()
    for index, key in enumerate(["a", "b", "c"], start=1):
        path = tmp_path / f"{key}.txt"
        path.write_text(f"第{index}话\n\n章节 {key} 的正文。", encoding="utf-8")
        assets.save(BookAsset(id=key, book_id=book.id, asset_type="text_chapter", path=path.name, index=index,
                             metadata={"title": f"第{index}话", "text_length": 200}, created_at=datetime.now(timezone.utc)))
    return settings, books, book, assets


def read_resource(books, book, assets):
    return get_reader_resource("owner", book.id, books, assets)


@pytest.mark.parametrize("reader_type", ["pdf", "comic", "image", "unsupported"])
def test_format_switches_keep_a_comparable_publication_version(tmp_path, reader_type):
    _, books, book, assets = fixture(tmp_path)
    old = read_resource(books, book, assets)
    changed = replace(book, reader_type=reader_type, updated_at=datetime(2099, 1, 1, tzinfo=timezone.utc))
    books.save(changed)
    resource = read_resource(books, changed, assets)
    assert resource.reader_type == reader_type
    assert resource.version == changed.updated_at.isoformat()
    assert resource.version != old.version


def test_catalogue_and_body_identify_the_same_chapter(tmp_path):
    settings, books, book, assets = fixture(tmp_path)
    resource = read_resource(books, book, assets)
    chapter = get_reader_chapter(asset_repository=assets, book_id=book.id, book_repository=books,
                                 chapter_index=2, owner_id="owner", settings=settings)
    assert resource.toc[1].position_key == chapter.position_key == "b"


def test_deleting_an_earlier_chapter_preserves_the_surviving_identity(tmp_path):
    settings, books, book, assets = fixture(tmp_path)
    assets.delete("a")
    assets.update_index("b", 1)
    assets.update_index("c", 2)
    resource = read_resource(books, book, assets)
    chapter = get_reader_chapter(asset_repository=assets, book_id=book.id, book_repository=books,
                                 chapter_index=1, owner_id="owner", settings=settings)
    assert resource.toc[0].index == 1
    assert resource.toc[0].position_key == chapter.position_key == "b"


def test_replacement_chapters_do_not_inherit_the_old_coordinate_identity(tmp_path):
    _, books, book, assets = fixture(tmp_path)
    old_keys = [item.position_key for item in read_resource(books, book, assets).toc]
    old = assets.list_by_book(book.id, "text_chapter")
    assets.clear_for_book(book.id)
    assets.save_many([replace(asset, id=f"replacement-{asset.id}") for asset in old])
    new_keys = [item.position_key for item in read_resource(books, book, assets).toc]
    assert not set(old_keys) & set(new_keys)


def test_renaming_or_appending_does_not_reset_existing_chapter_identity(tmp_path):
    _, books, book, assets = fixture(tmp_path)
    asset = assets.get_by_index(book.id, "text_chapter", 2)
    assets.update_metadata(asset.id, {**asset.metadata, "title": "新标题"})
    assets.save(replace(asset, id="d", index=4))
    assert [item.position_key for item in read_resource(books, book, assets).toc] == ["a", "b", "c", "d"]
