from collections.abc import Generator
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings

os.environ.setdefault("AISU_DATABASE_URL", "sqlite+pysqlite:///:memory:")

from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path) -> Generator[TestClient, None, None]:
    settings = Settings(database_url="sqlite+pysqlite:///:memory:", seed_demo_data=True, storage_root=str(tmp_path / "storage"))
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture()
def auth_headers(client: TestClient) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}
