from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

import app.modules.books.repository as books_repository_module
from app.modules.books.factory import create_uploaded_book
from app.modules.reading_activity.models import ReadingActivityRecord
from app.modules.reading_activity.repository import SqlAlchemyReadingActivityRepository


def test_records_reading_activity_for_accessible_book(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/api/v1/reading-activity", headers=auth_headers, json={"book_id": "b1", "date_key": "2026-07-10", "event_id": "event-test-0001", "seconds": 90})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_seconds"] >= 90
    assert any(total["book_id"] == "b1" for total in payload["book_totals"])
    assert any(total["book_title"] for total in payload["book_totals"] if total["book_id"] == "b1")


def test_reading_activity_event_retry_is_idempotent(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = {"book_id": "b1", "date_key": "2026-07-10", "event_id": "event-test-retry", "seconds": 45}
    first = client.post("/api/v1/reading-activity", headers=auth_headers, json=body)
    second = client.post("/api/v1/reading-activity", headers=auth_headers, json=body)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["total_seconds"] == first.json()["total_seconds"]


def test_reading_activity_uses_client_local_date(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/v1/reading-activity",
        headers=auth_headers,
        json={
            "book_id": "b1",
            "date_key": "2026-07-10",
            "event_id": "event-test-timezone",
            "occurred_at": "2026-07-09T17:00:00Z",
            "seconds": 30,
        },
    )

    assert response.status_code == 200
    assert any(day["date_key"] == "2026-07-10" for day in response.json()["days"])


def test_deleting_book_preserves_reading_time_and_title(client: TestClient, auth_headers: dict[str, str]) -> None:
    recorded = client.post(
        "/api/v1/reading-activity",
        headers=auth_headers,
        json={"book_id": "b1", "date_key": "2026-07-10", "event_id": "event-before-delete", "seconds": 75},
    )
    assert recorded.status_code == 200
    original_total = next(total for total in recorded.json()["book_totals"] if total["book_id"] == "b1")

    deleted = client.delete("/api/v1/books/b1", headers=auth_headers)
    assert deleted.status_code == 204

    summary = client.get("/api/v1/reading-activity", headers=auth_headers)
    preserved = next(total for total in summary.json()["book_totals"] if total["book_id"] == "b1")
    assert preserved["seconds"] == original_total["seconds"]
    assert preserved["book_title"] == original_total["book_title"]


def test_delayed_activity_event_after_soft_delete_is_still_recorded(client: TestClient, auth_headers: dict[str, str]) -> None:
    deleted = client.delete("/api/v1/books/b2", headers=auth_headers)
    assert deleted.status_code == 204

    delayed = client.post(
        "/api/v1/reading-activity",
        headers=auth_headers,
        json={"book_id": "b2", "date_key": "2026-07-10", "event_id": "event-after-delete", "seconds": 42},
    )

    assert delayed.status_code == 200
    preserved = next(total for total in delayed.json()["book_totals"] if total["book_id"] == "b2")
    assert preserved["seconds"] >= 42
    assert preserved["book_title"]


def test_reading_activity_for_missing_book_returns_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/api/v1/reading-activity", headers=auth_headers, json={"book_id": "ghost", "seconds": 30})

    assert response.status_code == 404


def test_reading_activity_race_with_book_deletion_returns_404_instead_of_500(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    # Reproduce the race where the service-level existence check passes but the
    # book row is gone by the time the activity insert commits: get_accessible
    # returns a phantom book whose id violates the reading_activity foreign key.
    phantom_book = create_uploaded_book(
        author="Ghost",
        book_id="phantom-book-id",
        file_label="EPUB",
        kind="novel",
        owner_id="whoever",
        reader_type="epub",
        tags=(),
        title="Phantom",
    )
    monkeypatch.setattr(
        books_repository_module.SqlAlchemyBookRepository,
        "get_accessible",
        lambda self, user_id, book_id: phantom_book,
    )

    response = client.post("/api/v1/reading-activity", headers=auth_headers, json={"book_id": "phantom-book-id", "seconds": 30})

    assert response.status_code == 404


def test_add_seconds_reports_failure_and_keeps_session_usable(client: TestClient, auth_headers: dict[str, str]) -> None:
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]

    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyReadingActivityRepository(session)

        assert repository.add_seconds(user_id=user_id, date_key="2026-07-04", seconds=30, book_id="missing-book") is False
        # The rollback must leave the session usable for the next write.
        assert repository.add_seconds(user_id=user_id, date_key="2026-07-04", seconds=30, book_id=None) is True


def test_add_seconds_accumulates_existing_record_with_database_expression(client: TestClient, auth_headers: dict[str, str]) -> None:
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]

    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyReadingActivityRepository(session)

        assert repository.add_seconds(user_id=user_id, date_key="2026-07-05", seconds=30, book_id="b1", book_title="Book One") is True
        assert repository.add_seconds(user_id=user_id, date_key="2026-07-05", seconds=45, book_id="b1", book_title="Book One") is True

        record = session.scalar(
            select(ReadingActivityRecord).where(
                ReadingActivityRecord.user_id == user_id,
                ReadingActivityRecord.date_key == "2026-07-05",
                ReadingActivityRecord.book_id == "b1",
            )
        )
        assert record is not None
        assert record.seconds == 75
