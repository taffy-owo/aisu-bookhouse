from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository


@pytest.mark.parametrize("finished", [True, False])
def test_explicit_completion_supersedes_accepted_device_clock(
    client: TestClient, auth_headers: dict[str, str], finished: bool,
) -> None:
    position_time = datetime.now(timezone.utc) + timedelta(minutes=2)
    position = client.put("/api/v1/books/b2/progress", headers=auth_headers, json={
        "reader_type": "epub", "progress_percent": 45, "chapter_index": 9,
        "epub_cfi": "aisu-scroll:0.45", "updated_at": position_time.isoformat(),
    })
    assert position.status_code == 200
    expected = 100 if finished else 0
    changed = client.put("/api/v1/books/b2/reading-status", headers=auth_headers, json={"finished": finished})
    assert changed.status_code == 200
    assert changed.json()["progress_percent"] == expected

    for endpoint in ["/api/v1/books/b2", "/api/v1/books/b2/progress", "/api/v1/books/b2/reader/startup"]:
        response = client.get(endpoint, headers=auth_headers)
        assert response.status_code == 200
        progress = response.json()["progress"] if endpoint.endswith("startup") else response.json()
        assert progress["progress_percent"] == expected
        assert datetime.fromisoformat(progress["updated_at"].replace("Z", "+00:00")) > position_time
        if "chapter_index" in progress:
            assert progress["chapter_index"] == (9 if finished else None)
            assert progress["epub_cfi"] == ("aisu-scroll:0.45" if finished else None)

    # A delayed autosave from before the explicit action cannot undo it.
    delayed = client.put("/api/v1/books/b2/progress", headers=auth_headers, json={
        "reader_type": "epub", "progress_percent": 45, "chapter_index": 9,
        "epub_cfi": "aisu-scroll:0.45", "updated_at": position_time.isoformat(),
    })
    assert delayed.status_code == 200
    assert delayed.json()["progress_percent"] == expected


@pytest.mark.parametrize("reader_type", ["text", "epub", "pdf", "comic", "image"])
@pytest.mark.parametrize("finished", [True, False])
def test_completion_uses_current_format_without_importing_old_coordinates(
    client: TestClient, auth_headers: dict[str, str], reader_type: str, finished: bool,
) -> None:
    owner = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id("b1").with_changes(reader_type=reader_type))
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(
            user_id=owner, book_id="b1", reader_type="pdf" if reader_type != "pdf" else "epub",
            progress_percent=99, chapter_index=29, page_number=88, image_index=77,
            chapter_href="old.xhtml", epub_cfi="aisu-scroll:0.99",
        ))
    expected = 100 if finished else 0
    response = client.put("/api/v1/books/b1/reading-status", headers=auth_headers, json={"finished": finished})
    assert response.status_code == 200
    assert response.json()["progress_percent"] == expected
    progress = client.get("/api/v1/books/b1/progress", headers=auth_headers).json()
    assert progress["reader_type"] == reader_type
    assert progress["progress_percent"] == expected
    assert all(progress[key] is None for key in ("chapter_index", "page_number", "image_index", "chapter_href", "epub_cfi"))


@pytest.mark.parametrize("finished", [True, False])
def test_completion_orders_before_a_delayed_local_save(
    client: TestClient, auth_headers: dict[str, str], finished: bool,
) -> None:
    pending_time = datetime.now(timezone.utc) + timedelta(minutes=2)
    action_time = pending_time + timedelta(milliseconds=1)
    changed = client.put("/api/v1/books/b2/reading-status", headers=auth_headers, json={
        "finished": finished, "updated_at": action_time.isoformat(),
    })
    assert changed.status_code == 200
    delayed = client.put("/api/v1/books/b2/progress", headers=auth_headers, json={
        "reader_type": "epub", "progress_percent": 45, "chapter_index": 9,
        "epub_cfi": "aisu-scroll:0.45", "updated_at": pending_time.isoformat(),
    })
    assert delayed.status_code == 200
    assert delayed.json()["progress_percent"] == (100 if finished else 0)


@pytest.mark.parametrize("updated_at", ["2099-01-01T00:00:00Z", "2026-10-29T00:00:00", "invalid"])
def test_completion_rejects_invalid_action_times(client: TestClient, auth_headers: dict[str, str], updated_at: str) -> None:
    response = client.put("/api/v1/books/b2/reading-status", headers=auth_headers, json={
        "finished": False, "updated_at": updated_at,
    })
    assert response.status_code == 422
