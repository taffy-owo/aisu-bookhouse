import pytest
from fastapi.testclient import TestClient

from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.books.repository import SqlAlchemyBookRepository


def seed_chapters(client):
    with client.app.state.db_session_factory() as session:
        assets = SqlAlchemyBookAssetRepository(session)
        assets.clear_for_book("b1")
        chapters = [create_book_asset(book_id="b1", asset_type="text_chapter", path=f"chapter-{index}.txt", index=index,
                                     metadata={"title": f"第{index}话", "text_length": 200}) for index in range(1, 4)]
        assets.save_many(chapters)
        return chapters


def change_chapters(client, chapters, change):
    with client.app.state.db_session_factory() as session:
        assets = SqlAlchemyBookAssetRepository(session, autocommit=False)
        books = SqlAlchemyBookRepository(session, autocommit=False)
        book = books.get_by_id("b1")
        if change == "replace":
            assets.clear_for_book("b1", commit=False)
            assets.save_many([create_book_asset(book_id="b1", asset_type="text_chapter", path=f"new-{index}.txt", index=index,
                                                metadata={"title": f"新第{index}话", "text_length": 200}) for index in range(1, 4)])
        else:
            assets.delete(chapters[0].id, commit=False)
            assets.update_index(chapters[1].id, 1)
            assets.update_index(chapters[2].id, 2)
        books.save(book.with_changes(title=book.title))
        session.commit()


@pytest.mark.parametrize("kind", ["progress", "mark"])
@pytest.mark.parametrize("change", ["replace", "reindex"])
def test_delayed_old_chapter_write_is_rejected(client: TestClient, auth_headers, kind, change):
    chapters = seed_chapters(client)
    old_payload = {"reader_type": "epub", "chapter_index": 2, "progress_percent": 40,
                   "epub_cfi": "aisu-scroll:0.2", "position_key": chapters[1].id}
    assert client.put("/api/v1/books/b1/progress", headers=auth_headers, json={**old_payload, "progress_percent": 20}).status_code == 200
    change_chapters(client, chapters, change)
    before = client.get("/api/v1/books/b1/progress", headers=auth_headers).json()
    if kind == "progress":
        response = client.put("/api/v1/books/b1/progress", headers=auth_headers, json=old_payload)
        assert response.status_code == 409
        assert client.get("/api/v1/books/b1/progress", headers=auth_headers).json() == before
    else:
        response = client.post("/api/v1/books/b1/marks", headers=auth_headers, json={**old_payload, "kind": "note", "note": "old draft"})
        assert response.status_code == 409
        assert client.get("/api/v1/books/b1/marks", headers=auth_headers).json() == []


@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_current_chapter_identity_saves_without_touching_book_metadata(client, auth_headers, kind):
    chapters = seed_chapters(client)
    before = client.get("/api/v1/books/b1", headers=auth_headers).json()
    with client.app.state.db_session_factory() as session:
        revision = SqlAlchemyBookRepository(session).get_by_id("b1").updated_at
    payload = {"reader_type": "epub", "chapter_index": 2, "position_key": chapters[1].id, "progress_percent": 30}
    response = (client.put("/api/v1/books/b1/progress", headers=auth_headers, json=payload) if kind == "progress"
                else client.post("/api/v1/books/b1/marks", headers=auth_headers, json=payload))
    assert response.status_code == (200 if kind == "progress" else 201)
    assert response.json()["chapter_index"] == 2
    with client.app.state.db_session_factory() as session:
        book = SqlAlchemyBookRepository(session).get_by_id("b1")
        assert book.title == before["title"]
        assert book.favorite == before["favorite"]
        assert book.updated_at == revision


@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_foreign_chapter_identity_cannot_validate_another_book(client, auth_headers, kind):
    chapters = seed_chapters(client)
    payload = {"reader_type": "epub", "chapter_index": 2, "position_key": chapters[1].id, "progress_percent": 30}
    response = (client.put("/api/v1/books/b2/progress", headers=auth_headers, json=payload) if kind == "progress"
                else client.post("/api/v1/books/b2/marks", headers=auth_headers, json=payload))
    assert response.status_code == 409


@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_missing_chapter_index_does_not_bypass_position_validation(client, auth_headers, kind):
    chapters = seed_chapters(client)
    payload = {"reader_type": "epub", "position_key": chapters[0].id, "progress_percent": 30}
    response = (client.put("/api/v1/books/b1/progress", headers=auth_headers, json=payload) if kind == "progress"
                else client.post("/api/v1/books/b1/marks", headers=auth_headers, json=payload))
    assert response.status_code == 409


@pytest.mark.parametrize("key", ["", "x" * 129])
def test_invalid_identity_input_is_rejected(client, auth_headers, key):
    response = client.put("/api/v1/books/b1/progress", headers=auth_headers,
                          json={"reader_type": "epub", "chapter_index": 1, "position_key": key, "progress_percent": 20})
    assert response.status_code == 422


@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_book_change_between_access_check_and_lock_rejects_the_write(client, auth_headers, monkeypatch, kind):
    chapters = seed_chapters(client)
    original = SqlAlchemyBookRepository.lock_revision
    changed = False

    def publish_before_lock(repository, book):
        nonlocal changed
        if not changed:
            changed = True
            change_chapters(client, chapters, "replace")
        return original(repository, book)

    monkeypatch.setattr(SqlAlchemyBookRepository, "lock_revision", publish_before_lock)
    payload = {"reader_type": "epub", "chapter_index": 2, "position_key": chapters[1].id, "progress_percent": 30}
    response = (client.put("/api/v1/books/b1/progress", headers=auth_headers, json=payload) if kind == "progress"
                else client.post("/api/v1/books/b1/marks", headers=auth_headers, json=payload))
    assert changed and response.status_code == 409
    assert client.get("/api/v1/books/b1/marks", headers=auth_headers).json() == []


def test_reader_position_lock_lasts_until_the_dependent_progress_commit(client):
    from sqlalchemy.exc import OperationalError
    from app.core.config import Settings
    from app.modules.reading_progress.domain import ReadingProgress
    from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository

    with client.app.state.db_session_factory() as reader, client.app.state.db_session_factory() as publisher:
        reader_books = SqlAlchemyBookRepository(reader)
        publisher_books = SqlAlchemyBookRepository(publisher)
        snapshot = reader_books.get_by_id("b1")
        competing = publisher_books.get_by_id("b1")
        reader_books.lock_revision(snapshot)
        publisher.connection().exec_driver_sql("PRAGMA busy_timeout=50")
        with pytest.raises(OperationalError):
            publisher_books.save(competing.with_changes(title="New publication"))
        publisher.rollback()
        SqlAlchemyReadingProgressRepository(reader).save(ReadingProgress(user_id=Settings.default_user_id,
            book_id="b1", reader_type="epub", chapter_index=1, progress_percent=20).touch())
        saved = publisher_books.save(competing.with_changes(title="New publication"))
        assert saved.title == "New publication"


def test_memory_repository_also_rejects_an_obsolete_book_revision():
    from fastapi import HTTPException
    from app.modules.books.repository import InMemoryBookRepository

    books = InMemoryBookRepository()
    book = books.create_from_upload(owner_id="owner", title="Book", author="Author", kind="novel", reader_type="text", tags=(), file_label="txt")
    from datetime import timedelta
    books.save(book.with_changes(title="New title", updated_at=book.updated_at + timedelta(seconds=1)))
    with pytest.raises(HTTPException) as caught:
        books.lock_revision(book)
    assert caught.value.status_code == 409


@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_unrelated_book_rename_keeps_valid_chapter_positions_usable(client, auth_headers, kind):
    chapters = seed_chapters(client)
    assert client.patch("/api/v1/books/b1", headers=auth_headers, json={"title": "Renamed book"}).status_code == 200
    payload = {"reader_type": "epub", "chapter_index": 2, "position_key": chapters[1].id, "progress_percent": 30}
    response = (client.put("/api/v1/books/b1/progress", headers=auth_headers, json=payload) if kind == "progress"
                else client.post("/api/v1/books/b1/marks", headers=auth_headers, json=payload))
    assert response.status_code == (200 if kind == "progress" else 201)


def test_contended_reader_lock_reports_a_retryable_update_instead_of_an_internal_error(client):
    from fastapi import HTTPException

    with client.app.state.db_session_factory() as first, client.app.state.db_session_factory() as second:
        a = SqlAlchemyBookRepository(first)
        b = SqlAlchemyBookRepository(second)
        a.lock_revision(a.get_by_id("b1"))
        snapshot = b.get_by_id("b1")
        second.connection().exec_driver_sql("PRAGMA busy_timeout=50")
        with pytest.raises(HTTPException) as caught:
            b.lock_revision(snapshot)
        assert caught.value.status_code == 503
        first.commit()
        b.lock_revision(snapshot)
        second.commit()
