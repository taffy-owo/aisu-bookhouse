from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository


@pytest.mark.parametrize("reader_type", ["text", "epub", "pdf", "comic", "image"])
@pytest.mark.parametrize("previous_format", [False, True])
def test_default_position_is_not_a_new_reading_event(client: TestClient, auth_headers, reader_type, previous_format):
    created = datetime(2026, 1, 1, tzinfo=timezone.utc)
    prior_time = created + timedelta(days=1)
    prior_type = "pdf" if reader_type in {"text", "epub"} else "epub"
    factory = client.app.state.db_session_factory
    with factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id("b1").with_changes(reader_type=reader_type, created_at=created, updated_at=created + timedelta(days=2)))
        progress = SqlAlchemyReadingProgressRepository(session)
        progress.delete_for_book(Settings.default_user_id, "b1")
        if previous_format:
            progress.save(ReadingProgress(user_id=Settings.default_user_id, book_id="b1", reader_type=prior_type,
                                         progress_percent=75, page_number=8, chapter_index=4, updated_at=prior_time))

    for endpoint in ["/api/v1/books/b1/progress", "/api/v1/books/b1/reader/startup"]:
        response = client.get(endpoint, headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        if endpoint.endswith("startup"):
            data = data["progress"]
        assert data["reader_type"] == reader_type
        assert datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00")) == created
        coordinate = "chapter_index" if reader_type in {"text", "epub"} else "page_number" if reader_type == "pdf" else "image_index"
        assert data[coordinate] == 1
        assert all(data[key] is None for key in {"chapter_index", "page_number", "image_index"} - {coordinate})

    with factory() as session:
        saved = SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, "b1")
        if previous_format:
            assert saved.reader_type == prior_type and saved.updated_at == prior_time
        else:
            assert saved is None


@pytest.mark.parametrize("percent", [0, 100])
def test_actual_saved_reset_or_completion_keeps_its_own_time(client: TestClient, auth_headers, percent):
    saved_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    response = client.put("/api/v1/books/b2/progress", headers=auth_headers, json={
        "reader_type": "epub", "progress_percent": percent, "chapter_index": 1, "updated_at": saved_at.isoformat(),
    })
    assert response.status_code == 200
    response = client.get("/api/v1/books/b2/reader/startup", headers=auth_headers)
    assert response.status_code == 200
    progress = response.json()["progress"]
    assert progress["progress_percent"] == percent
    assert datetime.fromisoformat(progress["updated_at"].replace("Z", "+00:00")) == saved_at
