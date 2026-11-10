from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_default_bootstrap_creates_admin_without_demo_books() -> None:
    settings = Settings(database_url="sqlite+pysqlite:///:memory:")

    with TestClient(create_app(settings)) as client:
        login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        assert login_response.status_code == 200

        token = login_response.json()["access_token"]
        books_response = client.get("/api/v1/books", headers={"Authorization": f"Bearer {token}"})

    assert books_response.status_code == 200
    assert books_response.json() == {"has_more": False, "items": [], "page": 1, "page_size": 24, "total": 0}
