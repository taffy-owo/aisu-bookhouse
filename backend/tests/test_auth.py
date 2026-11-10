from dataclasses import replace
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.modules.auth.service import register_user_with_invitation
from app.modules.invitations.domain import Invitation
from app.modules.invitations.repository import InMemoryInvitationRepository
from app.modules.users.domain import create_user
from app.modules.users.repository import InMemoryUserRepository, SqlAlchemyUserRepository

def create_png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (8, 8), (255, 120, 130)).save(output, format="PNG")
    return output.getvalue()


PNG_BYTES = create_png_bytes()


class RejectingInvitationRepository(InMemoryInvitationRepository):
    def consume_available(self, code: str, invitee_user_id: str, *, commit: bool = True):
        return None


def test_login_and_me(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})

    assert login_response.status_code == 200
    assert login_response.json()["user"]["account_number"] == 1
    token = login_response.json()["access_token"]

    me_response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert me_response.status_code == 200
    assert me_response.json()["email"] == "admin@aisu.local"


def test_login_sets_httponly_refresh_cookie_and_refresh_rotates_it(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})

    assert login_response.status_code == 200
    assert "aisu_refresh_token=" in login_response.headers["set-cookie"]
    assert "httponly" in login_response.headers["set-cookie"].lower()
    first_refresh_token = client.cookies.get("aisu_refresh_token")
    assert first_refresh_token
    me_response = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {login_response.json()['access_token']}"}
    )
    assert me_response.status_code == 200
    assert "set-cookie" not in me_response.headers

    refresh_response = client.post("/api/v1/auth/refresh")

    assert refresh_response.status_code == 200
    assert refresh_response.json()["user"]["email"] == "admin@aisu.local"
    second_refresh_token = client.cookies.get("aisu_refresh_token")
    assert second_refresh_token
    assert second_refresh_token != first_refresh_token
    client.cookies.set("aisu_refresh_token", first_refresh_token, path="/api/v1/auth")
    stale_response = client.post("/api/v1/auth/refresh")
    assert stale_response.status_code == 409
    assert "set-cookie" not in stale_response.headers
    client.cookies.set("aisu_refresh_token", second_refresh_token, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 200
    access_token = refresh_response.json()["access_token"]
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access_token}"}).status_code == 200


def test_refresh_rejects_missing_and_access_tokens(client: TestClient) -> None:
    assert client.post("/api/v1/auth/refresh").status_code == 401

    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    client.cookies.set("aisu_refresh_token", login_response.json()["access_token"], path="/api/v1/auth")

    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_logout_clears_refresh_cookie(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    access_token = login_response.json()["access_token"]
    old_refresh_token = client.cookies.get("aisu_refresh_token")
    assert client.cookies.get("aisu_refresh_token")

    response = client.post("/api/v1/auth/logout")

    assert response.status_code == 204
    assert client.cookies.get("aisu_refresh_token") is None
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access_token}"}).status_code == 401
    client.cookies.set("aisu_refresh_token", old_refresh_token, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_login_rejects_bad_password(client: TestClient) -> None:
    response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "bad"})

    assert response.status_code == 401


@pytest.mark.parametrize("purpose", ["pdf_preview", "original_download", "audiobook_chapter:1"])
def test_file_tickets_cannot_authenticate_general_api(client: TestClient, auth_headers: dict[str, str], purpose: str) -> None:
    from app.core.security import create_file_ticket, decode_file_ticket
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    settings = client.app.state.settings
    ticket = create_file_ticket(subject=user_id, book_id="b1", purpose=purpose, settings=settings)
    assert decode_file_ticket(ticket, settings) == (user_id, "b1", purpose)
    headers = {"Authorization": f"Bearer {ticket}"}
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
    assert client.get("/api/v1/books", headers=headers).status_code == 401


@pytest.mark.parametrize("password", ["x" * 73, "长" * 25])
def test_oversized_login_password_is_rejected_without_server_error(client: TestClient, password: str) -> None:
    for email in ("admin@aisu.local", "missing@example.com"):
        assert client.post("/api/v1/auth/login", json={"email": email, "password": password}).status_code == 401


def test_change_password_rotates_credentials(client: TestClient) -> None:
    token = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()["access_token"]
    old_refresh_token = client.cookies.get("aisu_refresh_token")
    headers = {"Authorization": f"Bearer {token}"}

    wrong_current = client.post("/api/v1/auth/change-password", headers=headers, json={"current_password": "nope", "new_password": "fresh-strong-pass"})
    assert wrong_current.status_code == 400

    too_short = client.post("/api/v1/auth/change-password", headers=headers, json={"current_password": "aisu-demo-password", "new_password": "short"})
    assert too_short.status_code == 400

    changed = client.post("/api/v1/auth/change-password", headers=headers, json={"current_password": "aisu-demo-password", "new_password": "fresh-strong-pass"})
    assert changed.status_code == 204
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
    client.cookies.set("aisu_refresh_token", old_refresh_token, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 401

    assert client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "fresh-strong-pass"}).status_code == 200


def test_change_password_requires_auth(client: TestClient) -> None:
    response = client.post("/api/v1/auth/change-password", json={"current_password": "a", "new_password": "fresh-strong-pass"})
    assert response.status_code == 401


def test_register_rejects_invalid_email_format(client: TestClient) -> None:
    # Format validation runs before invitation checks, so a placeholder code is fine.
    for invalid_email in ("not-an-email", "user@", "user@invalid-domain-without-dot"):
        response = client.post(
            "/api/v1/auth/register",
            json={
                "email": invalid_email,
                "invitation_code": "whatever",
                "nickname": "无效邮箱",
                "password": "some-password",
            },
        )
        assert response.status_code == 422, invalid_email


def test_register_with_invitation_logs_in_new_user(client: TestClient) -> None:
    admin_token = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()[
        "access_token"
    ]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    invitation_response = client.post("/api/v1/invitations/me", headers=admin_headers)
    invitation_code = invitation_response.json()["code"]

    register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "friend@example.com",
            "invitation_code": invitation_code,
            "nickname": "朋友",
            "password": "friend-password",
        },
    )

    assert register_response.status_code == 200
    assert register_response.json()["user"]["email"] == "friend@example.com"
    assert register_response.json()["user"]["account_number"] == 2

    token = register_response.json()["access_token"]
    me_response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_response.status_code == 200
    assert me_response.json()["nickname"] == "朋友"

    reused_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "second@example.com",
            "invitation_code": invitation_code,
            "nickname": "第二个朋友",
            "password": "friend-password",
        },
    )
    assert reused_response.status_code == 400


def test_regular_user_can_create_only_one_invitation(client: TestClient) -> None:
    admin_token = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()[
        "access_token"
    ]
    invitation_response = client.post("/api/v1/invitations/me", headers={"Authorization": f"Bearer {admin_token}"})

    register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "reader@example.com",
            "invitation_code": invitation_response.json()["code"],
            "nickname": "读者",
            "password": "reader-password",
        },
    )
    reader_headers = {"Authorization": f"Bearer {register_response.json()['access_token']}"}

    first_response = client.post("/api/v1/invitations/me", headers=reader_headers)
    second_response = client.post("/api/v1/invitations/me", headers=reader_headers)

    assert first_response.status_code == 200
    assert second_response.status_code == 200
    assert first_response.json()["code"] != second_response.json()["code"]

    revoked_register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "revoked@example.com",
            "invitation_code": first_response.json()["code"],
            "nickname": "旧码",
            "password": "friend-password",
        },
    )
    assert revoked_register_response.status_code == 400

    used_register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "used@example.com",
            "invitation_code": second_response.json()["code"],
            "nickname": "用掉",
            "password": "friend-password",
        },
    )
    assert used_register_response.status_code == 200

    third_response = client.post("/api/v1/invitations/me", headers=reader_headers)
    assert third_response.status_code == 400


def test_register_rolls_back_user_when_invitation_consume_fails() -> None:
    user_repository = InMemoryUserRepository()
    now = datetime.now(timezone.utc)
    invitation_repository = RejectingInvitationRepository(
        [
            Invitation(
                id="invite-race",
                code="RACE-CODE",
                inviter_user_id="inviter",
                status="available",
                created_at=now,
                updated_at=now,
            )
        ]
    )

    try:
        register_user_with_invitation(
            email="rolled-back@example.com",
            invitation_code="race-code",
            invitation_repository=invitation_repository,
            nickname="Race",
            password="friend-password",
            user_repository=user_repository,
        )
    except ValueError:
        pass

    assert user_repository.get_by_email("rolled-back@example.com") is None


def test_user_repositories_list_requested_users_only(client: TestClient) -> None:
    users = [
        create_user(id="u1", account_number=101, email="u1@example.com", nickname="User One", password_hash="hash"),
        create_user(id="u2", account_number=102, email="u2@example.com", nickname="User Two", password_hash="hash"),
        create_user(id="u3", account_number=103, email="u3@example.com", nickname="User Three", password_hash="hash"),
    ]
    memory_repository = InMemoryUserRepository(users)

    assert [user.id for user in memory_repository.list_by_ids(["u3", "u1", "missing", "u1"])] == ["u1", "u3"]
    assert memory_repository.list_by_ids([]) == []

    with client.app.state.db_session_factory() as session:
        sql_repository = SqlAlchemyUserRepository(session)
        for user in users:
            sql_repository.save(user)

        assert [user.id for user in sql_repository.list_by_ids(["u3", "u1", "missing", "u1"])] == ["u1", "u3"]
        assert sql_repository.list_by_ids([]) == []


def test_update_profile(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    update_response = client.put("/api/v1/auth/me", headers=headers, json={"nickname": "New Nickname"})
    assert update_response.status_code == 200
    assert update_response.json()["nickname"] == "New Nickname"

    me_response = client.get("/api/v1/auth/me", headers=headers)
    assert me_response.status_code == 200
    assert me_response.json()["nickname"] == "New Nickname"


def test_update_profile_rejects_blank_nickname(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    update_response = client.put("/api/v1/auth/me", headers=headers, json={"nickname": "   "})

    assert update_response.status_code == 400


def test_user_can_save_ai_model_preferences(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    headers = {"Authorization": f"Bearer {login_response.json()['access_token']}"}

    empty = client.get("/api/v1/auth/me/ai-settings", headers=headers)
    assert empty.status_code == 200
    assert empty.json()["provider_base_url"] == ""
    assert empty.json()["api_key_configured"] is False
    assert empty.json()["audiobook_api_key_configured"] is False
    assert empty.json()["translation_model"] == ""
    assert empty.json()["translation_prompt"] == ""
    assert empty.json()["translation_concurrency"] == 2

    updated = client.put(
        "/api/v1/auth/me/ai-settings",
        headers=headers,
        json={
            "provider_base_url": "https://api.example.com/v1/",
            "api_key": "third-party-secret",
            "audiobook_provider_base_url": "https://speech.example.com/v1/",
            "audiobook_api_key": "speech-secret",
            "translation_model": "custom-literary-model",
            "translation_prompt": " 雪乃固定译为雪乃；对话保持克制。 ",
            "translation_concurrency": 4,
            "audiobook_tts_model": "custom-tts-model",
            "audiobook_tts_voice": "alloy",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["provider_base_url"] == "https://api.example.com/v1"
    assert updated.json()["api_key_configured"] is True
    assert updated.json()["audiobook_api_key_configured"] is True
    assert updated.json()["audiobook_provider_base_url"] == "https://speech.example.com/v1"
    assert "api_key" not in updated.json()
    assert updated.json()["translation_model"] == "custom-literary-model"
    assert updated.json()["translation_prompt"] == "雪乃固定译为雪乃；对话保持克制。"
    assert updated.json()["translation_concurrency"] == 4
    assert updated.json()["audiobook_tts_model"] == "custom-tts-model"
    assert updated.json()["audiobook_tts_voice"] == "alloy"

    persisted = client.get("/api/v1/auth/me/ai-settings", headers=headers)
    assert persisted.json()["provider_base_url"] == "https://api.example.com/v1"
    assert persisted.json()["api_key_configured"] is True
    assert persisted.json()["translation_model"] == "custom-literary-model"
    assert persisted.json()["translation_prompt"] == "雪乃固定译为雪乃；对话保持克制。"
    assert persisted.json()["translation_concurrency"] == 4
    assert persisted.json()["audiobook_tts_model"] == "custom-tts-model"
    assert persisted.json()["audiobook_provider_base_url"] == "https://speech.example.com/v1"

    cleared = client.delete("/api/v1/auth/me/ai-settings", headers=headers)
    assert cleared.json()["provider_base_url"] == ""
    assert cleared.json()["api_key_configured"] is False
    assert cleared.json()["audiobook_api_key_configured"] is False
    assert cleared.json()["translation_model"] == ""
    assert cleared.json()["translation_prompt"] == ""
    assert cleared.json()["translation_concurrency"] == 2


def test_ai_model_preferences_reject_invalid_names(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    headers = {"Authorization": f"Bearer {login_response.json()['access_token']}"}

    response = client.put(
        "/api/v1/auth/me/ai-settings",
        headers=headers,
        json={"translation_model": "bad model name", "audiobook_tts_model": "mimo-v2.5-tts"},
    )

    assert response.status_code == 422


@pytest.mark.parametrize("concurrency", [0, 5])
def test_ai_model_preferences_reject_invalid_translation_concurrency(
    client: TestClient,
    concurrency: int,
) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    headers = {"Authorization": f"Bearer {login_response.json()['access_token']}"}

    response = client.put(
        "/api/v1/auth/me/ai-settings",
        headers=headers,
        json={"translation_concurrency": concurrency},
    )

    assert response.status_code == 422


def test_audiobook_model_lookup_uses_only_its_saved_provider(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    headers = {"Authorization": f"Bearer {login_response.json()['access_token']}"}
    client.put(
        "/api/v1/auth/me/ai-settings",
        headers=headers,
        json={
            "provider_base_url": "https://text.example.com/v1",
            "api_key": "text-secret",
            "translation_model": "text-model",
            "audiobook_provider_base_url": "https://speech.example.com/v1",
            "audiobook_api_key": "speech-secret",
            "audiobook_tts_model": "speech-model",
        },
    )
    seen: list[tuple[str, str]] = []

    async def fake_fetch(settings):
        seen.append((settings.ai_translation_base_url, settings.ai_translation_api_key))
        return ["speech-model", "speech-model-hd"]

    monkeypatch.setattr("app.modules.auth.api.fetch_provider_ai_models", fake_fetch)
    response = client.post(
        "/api/v1/auth/me/ai-models",
        headers=headers,
        json={
            "credential_scope": "audiobook",
            "provider_base_url": "https://speech.example.com/v1",
        },
    )

    assert response.status_code == 200
    assert response.json()["models"] == ["speech-model", "speech-model-hd"]
    assert seen == [("https://speech.example.com/v1", "speech-secret")]

    mismatched = client.post(
        "/api/v1/auth/me/ai-models",
        headers=headers,
        json={
            "credential_scope": "audiobook",
            "provider_base_url": "https://text.example.com/v1",
        },
    )
    assert mismatched.status_code == 400


def test_upload_avatar_and_serve(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    user_id = login_response.json()["user"]["id"]
    headers = {"Authorization": f"Bearer {token}"}

    files = {"file": ("avatar.png", PNG_BYTES, "image/png")}
    upload_response = client.post("/api/v1/auth/me/avatar", headers=headers, files=files)
    
    assert upload_response.status_code == 200
    avatar_path = upload_response.json()["avatar"]
    assert avatar_path is not None
    assert avatar_path.endswith(".webp")
    assert "avatar-" in avatar_path

    # Serving the avatar requires auth; anonymous requests are rejected.
    anonymous_response = client.get(f"/api/v1/files/users/{user_id}/avatar")
    assert anonymous_response.status_code == 401

    serve_response = client.get(f"/api/v1/files/users/{user_id}/avatar", headers=headers)
    assert serve_response.status_code == 200
    assert serve_response.headers["content-type"] == "image/webp"
    assert serve_response.headers["cache-control"] == "private, max-age=86400"
    assert serve_response.content.startswith(b"RIFF")


def test_upload_avatar_keeps_new_file_when_replacing_legacy_avatar(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    user_id = login_response.json()["user"]["id"]
    headers = {"Authorization": f"Bearer {token}"}
    legacy_avatar = f"avatars/{user_id}/avatar.webp"
    legacy_path = Path(client.app.state.settings.storage_root) / legacy_avatar
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_bytes(b"legacy-avatar")

    with client.app.state.db_session_factory() as session:
        user_repository = SqlAlchemyUserRepository(session)
        user = user_repository.get_by_id(user_id)
        assert user is not None
        user_repository.save(replace(user, avatar=legacy_avatar))

    upload_response = client.post("/api/v1/auth/me/avatar", headers=headers, files={"file": ("avatar.png", PNG_BYTES, "image/png")})

    assert upload_response.status_code == 200
    avatar_path = upload_response.json()["avatar"]
    assert avatar_path != legacy_avatar
    assert (Path(client.app.state.settings.storage_root) / avatar_path).is_file()
    assert not legacy_path.exists()

    serve_response = client.get(f"/api/v1/files/users/{user_id}/avatar", headers=headers)
    assert serve_response.status_code == 200


def test_upload_avatar_accepts_octet_stream_when_signature_matches(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    upload_response = client.post(
        "/api/v1/auth/me/avatar",
        headers=headers,
        files={"file": ("avatar.png", PNG_BYTES, "application/octet-stream")},
    )

    assert upload_response.status_code == 200
    assert upload_response.json()["avatar"] is not None


def test_upload_avatar_rejects_invalid_file_type(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    extension_response = client.post(
        "/api/v1/auth/me/avatar",
        headers=headers,
        files={"file": ("avatar.txt", b"not-an-image", "image/png")},
    )
    content_type_response = client.post(
        "/api/v1/auth/me/avatar",
        headers=headers,
        files={"file": ("avatar.png", b"not-an-image", "text/plain")},
    )

    assert extension_response.status_code == 400
    assert content_type_response.status_code == 400


def test_upload_avatar_rejects_disguised_image(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    upload_response = client.post(
        "/api/v1/auth/me/avatar",
        headers=headers,
        files={"file": ("avatar.png", b"not-an-image", "image/png")},
    )

    assert upload_response.status_code == 400


def test_upload_avatar_rejects_oversized_file(client: TestClient) -> None:
    login_response = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    upload_response = client.post(
        "/api/v1/auth/me/avatar",
        headers=headers,
        files={"file": ("avatar.png", PNG_BYTES + b"x" * (5 * 1024 * 1024 + 1), "image/png")},
    )

    assert upload_response.status_code == 413


def test_register_rejects_password_longer_than_72_bytes(client: TestClient, auth_headers: dict[str, str]) -> None:
    invitation_code = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]

    response = client.post(
        "/api/v1/auth/register",
        json={"email": "longpass@example.com", "invitation_code": invitation_code, "nickname": "Long", "password": "a" * 73},
    )

    assert response.status_code == 400


def test_register_maps_unique_constraint_race_to_400(client: TestClient, auth_headers: dict[str, str], monkeypatch) -> None:
    import app.modules.users.repository as user_repository_module

    first_code = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]
    first_response = client.post(
        "/api/v1/auth/register",
        json={"email": "race@example.com", "invitation_code": first_code, "nickname": "First", "password": "password123"},
    )
    assert first_response.status_code == 200

    # Simulate a concurrent insert winning the race: the duplicate-email pre-check passes
    # but the unique constraint still fires on commit. It must surface as 400, not 500.
    monkeypatch.setattr(user_repository_module.SqlAlchemyUserRepository, "get_by_email", lambda self, email: None)
    second_code = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]
    second_response = client.post(
        "/api/v1/auth/register",
        json={"email": "race@example.com", "invitation_code": second_code, "nickname": "Second", "password": "password123"},
    )

    assert second_response.status_code == 400
