from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.modules.book_assets.models import BookAssetRecord
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.uploads.models import UploadTaskRecord


def test_admin_lists_users_with_account_numbers(client: TestClient) -> None:
    admin_token = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()[
        "access_token"
    ]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    invitation = client.post("/api/v1/invitations/me", headers=admin_headers).json()
    client.post(
        "/api/v1/auth/register",
        json={
            "email": "reader@example.com",
            "invitation_code": invitation["code"],
            "nickname": "Reader",
            "password": "reader-password",
        },
    )

    response = client.get("/api/v1/admin/users", headers=admin_headers)

    assert response.status_code == 200
    users = response.json()
    assert [user["account_number"] for user in users] == [1, 2]
    assert users[0]["role"] == "admin"
    assert users[1]["email"] == "reader@example.com"


def test_admin_can_disable_and_enable_regular_user(client: TestClient) -> None:
    admin_token = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()[
        "access_token"
    ]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    invitation = client.post("/api/v1/invitations/me", headers=admin_headers).json()
    register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "reader@example.com",
            "invitation_code": invitation["code"],
            "nickname": "Reader",
            "password": "reader-password",
        },
    )
    user_id = register_response.json()["user"]["id"]

    disable_response = client.patch(f"/api/v1/admin/users/{user_id}/status", headers=admin_headers, json={"status": "disabled"})
    assert disable_response.status_code == 200
    assert disable_response.json()["status"] == "disabled"

    disabled_login = client.post("/api/v1/auth/login", json={"email": "reader@example.com", "password": "reader-password"})
    assert disabled_login.status_code == 401

    enable_response = client.patch(f"/api/v1/admin/users/{user_id}/status", headers=admin_headers, json={"status": "active"})
    assert enable_response.status_code == 200
    assert enable_response.json()["status"] == "active"


def test_admin_cannot_disable_self(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()
    headers = {"Authorization": f"Bearer {login_response['access_token']}"}

    response = client.patch(f"/api/v1/admin/users/{login_response['user']['id']}/status", headers=headers, json={"status": "disabled"})

    assert response.status_code == 400


def test_admin_system_report(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()
    headers = {"Authorization": f"Bearer {login_response['access_token']}"}

    response = client.get("/api/v1/admin/system", headers=headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["database_engine"] == "sqlite"
    assert payload["sqlite_quick_check"] == "ok"
    assert payload["sqlite_foreign_keys"] is True
    assert any(table["name"] == "books" and table["rows"] >= 3 for table in payload["table_stats"])
    assert payload["issues"]


def test_admin_system_report_flags_stale_and_unavailable_upload_data(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()
    headers = {"Authorization": f"Bearer {login_response['access_token']}"}
    owner_id = login_response["user"]["id"]
    now = datetime.now(timezone.utc)
    with client.app.state.db_session_factory() as session:
        book_repository = SqlAlchemyBookRepository(session)
        book = book_repository.get_owned(owner_id, "b1")
        assert book is not None
        book_repository.save(book.with_changes(status="deleted"))
        session.add(
            BookAssetRecord(
                id="orphaned-deleted-book-asset",
                book_id="b1",
                asset_type="text_chapter",
                path="processed/old/deleted/chapter.txt",
                index=1,
                metadata_json={"title": "old"},
                created_at=now,
            )
        )
        session.add(
            UploadTaskRecord(
                id="stale-processing-task",
                user_id=owner_id,
                book_id="b1",
                file_name="stale.epub",
                file_type="EPUB",
                file_size=1,
                status="processing",
                progress=72,
                message="stale",
                error_code=None,
                created_at=now - timedelta(hours=3),
                updated_at=now - timedelta(hours=3),
            )
        )
        session.commit()

    response = client.get("/api/v1/admin/system", headers=headers)

    assert response.status_code == 200
    issue_codes = {issue["code"] for issue in response.json()["issues"]}
    assert "deleted_book_assets" in issue_codes
    assert "unavailable_processing_upload_tasks" in issue_codes
    assert "stale_processing_upload_tasks" in issue_codes
