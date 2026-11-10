from fastapi.testclient import TestClient
from datetime import datetime, timezone
from sqlalchemy import select
import pytest
from app.modules.reading_progress.models import ReadingProgressRecord

from app.core.config import Settings
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import InMemoryReadingProgressRepository, SqlAlchemyReadingProgressRepository
from app.modules.books.repository import SqlAlchemyBookRepository


@pytest.mark.parametrize("reader_type,position", [("text", "chapter_index"), ("epub", "chapter_index"), ("pdf", "page_number"), ("comic", "image_index"), ("image", "image_index")])
def test_changed_format_does_not_reinterpret_previous_coordinates(client: TestClient, auth_headers, reader_type, position):
    factory = client.app.state.db_session_factory
    with factory() as session:
        books = SqlAlchemyBookRepository(session)
        book = books.get_by_id("b1")
        books.save(book.with_changes(reader_type=reader_type))
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(
            user_id=Settings.default_user_id, book_id="b1", reader_type="pdf" if reader_type in {"text", "epub"} else "epub",
            progress_percent=99, chapter_index=29, image_index=77, page_number=88, epub_cfi="aisu-scroll:0.99",
        ))
    for endpoint in ["/api/v1/books/b1/progress", "/api/v1/books/b1/reader/startup"]:
        response = client.get(endpoint, headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        if endpoint.endswith("startup"):
            assert data["book"]["progress_percent"] == 0
            data = data["progress"]
        assert data["reader_type"] == reader_type
        assert data["progress_percent"] == 0 and data[position] == 1
        assert data["epub_cfi"] is None
        assert all(data[key] is None for key in {"chapter_index", "image_index", "page_number"} - {position})


def test_stale_database_session_cannot_overwrite_newer_position(client: TestClient) -> None:
    factory = client.app.state.db_session_factory

    def progress(day: int, percent: int) -> ReadingProgress:
        return ReadingProgress(user_id=Settings.default_user_id, book_id="b2", reader_type="epub", progress_percent=percent,
                               updated_at=datetime(2030, 1, day, tzinfo=timezone.utc))

    with factory() as first, factory() as second:
        repo = SqlAlchemyReadingProgressRepository(first)
        repo.save(progress(1, 10))
        stale = first.scalar(select(ReadingProgressRecord).where(ReadingProgressRecord.user_id == Settings.default_user_id, ReadingProgressRecord.book_id == "b2"))
        SqlAlchemyReadingProgressRepository(second).save(progress(3, 80))
        assert stale.progress_percent == 10
        saved = repo.save(progress(2, 30))
        assert saved.progress_percent == 80
        assert saved.updated_at.day == 3

    with factory() as verify:
        assert SqlAlchemyReadingProgressRepository(verify).get(Settings.default_user_id, "b2").progress_percent == 80


def test_progress_repositories_list_requested_books_only(client: TestClient) -> None:
    progress_items = [
        ReadingProgress(user_id="reader", book_id="b1", reader_type="epub", progress_percent=10).touch(),
        ReadingProgress(user_id="reader", book_id="b2", reader_type="epub", progress_percent=20).touch(),
        ReadingProgress(user_id="reader", book_id="b3", reader_type="epub", progress_percent=30).touch(),
        ReadingProgress(user_id="other", book_id="b1", reader_type="epub", progress_percent=90).touch(),
    ]

    memory_repository = InMemoryReadingProgressRepository()
    for progress in progress_items:
        memory_repository.save(progress)

    assert {progress.book_id for progress in memory_repository.list_for_books("reader", ["b3", "b1", "missing", "b1"])} == {"b1", "b3"}
    assert memory_repository.list_for_books("reader", []) == []

    with client.app.state.db_session_factory() as session:
        sql_repository = SqlAlchemyReadingProgressRepository(session)
        for progress in [
            ReadingProgress(user_id=Settings.default_user_id, book_id="b1", reader_type="epub", progress_percent=10).touch(),
            ReadingProgress(user_id=Settings.default_user_id, book_id="b2", reader_type="epub", progress_percent=20).touch(),
            ReadingProgress(user_id=Settings.default_user_id, book_id="b3", reader_type="epub", progress_percent=30).touch(),
        ]:
            sql_repository.save(progress)

        assert {progress.book_id for progress in sql_repository.list_for_books(Settings.default_user_id, ["b3", "b1", "missing", "b1"])} == {"b1", "b3"}
        assert sql_repository.list_for_books(Settings.default_user_id, []) == []


def test_saves_progress_and_overlays_book_list(client: TestClient, auth_headers: dict[str, str]) -> None:
    progress_response = client.put(
        "/api/v1/books/b2/progress",
        headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 45, "chapter_index": 9},
    )

    assert progress_response.status_code == 200
    assert progress_response.json()["progress_percent"] == 45

    book_response = client.get("/api/v1/books/b2", headers=auth_headers)

    assert book_response.status_code == 200
    assert book_response.json()["progress_percent"] == 45
    assert book_response.json()["current_chapter"] == "第 9 章"


def test_progress_rejects_coordinates_from_a_previous_format(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.put(
        "/api/v1/books/b2/progress",
        headers=auth_headers,
        json={"reader_type": "comic", "progress_percent": 45, "chapter_index": 9},
    )

    assert response.status_code == 409
    assert "格式已更新" in response.json()["detail"]


def test_older_device_progress_cannot_overwrite_newer_position(client: TestClient, auth_headers: dict[str, str]) -> None:
    newer_response = client.put(
        "/api/v1/books/b2/progress",
        headers=auth_headers,
        json={
            "reader_type": "epub",
            "progress_percent": 80,
            "chapter_index": 16,
            "updated_at": "2026-07-10T02:00:00Z",
        },
    )
    assert newer_response.status_code == 200

    stale_response = client.put(
        "/api/v1/books/b2/progress",
        headers=auth_headers,
        json={
            "reader_type": "epub",
            "progress_percent": 10,
            "chapter_index": 2,
            "updated_at": "2026-07-10T01:00:00Z",
        },
    )

    assert stale_response.status_code == 200
    assert stale_response.json()["progress_percent"] == 80
    assert stale_response.json()["chapter_index"] == 16


def test_future_device_clock_cannot_pin_progress(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.put(
        "/api/v1/books/b2/progress", headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 90, "updated_at": "2099-01-01T00:00:00Z"},
    )
    assert response.status_code == 422
    normal = client.put(
        "/api/v1/books/b2/progress", headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 20},
    )
    assert normal.status_code == 200
    assert normal.json()["progress_percent"] == 20


def test_progress_rejects_non_positive_positions(client: TestClient, auth_headers: dict[str, str]) -> None:
    for field in ("chapter_index", "page_number", "image_index"):
        response = client.put(
            "/api/v1/books/b2/progress",
            headers=auth_headers,
            json={"reader_type": "epub", "progress_percent": 20, field: 0},
        )
        assert response.status_code == 422


def test_progress_rejects_unknown_book(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.put(
        "/api/v1/books/not-found/progress",
        headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 45, "chapter_index": 9},
    )

    assert response.status_code == 404


def test_deleted_book_progress_is_not_readable_or_writable(client: TestClient, auth_headers: dict[str, str]) -> None:
    save_response = client.put(
        "/api/v1/books/b2/progress",
        headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 45, "chapter_index": 9},
    )
    assert save_response.status_code == 200

    delete_response = client.delete("/api/v1/books/b2", headers=auth_headers)
    assert delete_response.status_code == 204

    get_response = client.get("/api/v1/books/b2/progress", headers=auth_headers)
    assert get_response.status_code == 404

    put_response = client.put(
        "/api/v1/books/b2/progress",
        headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 50, "chapter_index": 10},
    )
    assert put_response.status_code == 404
