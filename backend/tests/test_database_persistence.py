from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings
from app.main import create_app
from app.modules.books.factory import create_uploaded_book
from app.modules.books.mappers import book_to_record


def login_headers(client: TestClient) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_sqlite_database_persists_progress_between_app_instances(tmp_path: Path) -> None:
    database_url = f"sqlite+pysqlite:///{tmp_path / 'aisu-test.db'}"
    settings = Settings(database_url=database_url, seed_demo_data=True)

    with TestClient(create_app(settings)) as first_client:
        first_headers = login_headers(first_client)
        save_response = first_client.put(
            "/api/v1/books/b2/progress",
            headers=first_headers,
            json={"reader_type": "epub", "progress_percent": 45, "chapter_index": 9},
        )
        assert save_response.status_code == 200

    with TestClient(create_app(settings)) as second_client:
        second_headers = login_headers(second_client)
        book_response = second_client.get("/api/v1/books/b2", headers=second_headers)

    assert book_response.status_code == 200
    assert book_response.json()["progress_percent"] == 45


def test_sqlite_database_enforces_foreign_keys(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'aisu-fk-test.db'}", bootstrap_admin=False)

    with TestClient(create_app(settings)) as client:
        with client.app.state.db_session_factory() as session:
            session.add(
                book_to_record(
                    create_uploaded_book(
                        author="Nobody",
                        book_id="missing-owner-book",
                        file_label="TXT",
                        kind="novel",
                        owner_id="missing-owner",
                        reader_type="text",
                        tags=("test",),
                        title="Missing Owner",
                    )
                )
            )
            with pytest.raises(IntegrityError):
                session.commit()
