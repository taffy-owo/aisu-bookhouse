from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.modules.reader_marks.domain import ReaderMark
from app.modules.reader_marks.repository import SqlAlchemyReaderMarkRepository


def test_reader_mark_repository_rejects_stale_sql_update(client: TestClient) -> None:
    base_time = datetime.now(timezone.utc)
    newer = ReaderMark(
        id="stale-mark",
        user_id="11111111-1111-4111-8111-111111111111",
        book_id="b1",
        reader_type="epub",
        kind="note",
        note="new note",
        label="Chapter 1",
        progress_percent=10,
        created_at=base_time,
        updated_at=base_time + timedelta(seconds=2),
    )
    older = newer.with_changes(note="old note")
    older = ReaderMark(**{**older.__dict__, "updated_at": base_time + timedelta(seconds=1)})

    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyReaderMarkRepository(session)
        repository.save(newer)
        saved = repository.save(older)

    assert saved.note == "new note"


def test_reader_marks_create_update_delete(client: TestClient, auth_headers: dict[str, str]) -> None:
    create_response = client.post(
        "/api/v1/books/b1/marks",
        headers=auth_headers,
        json={
            "chapter_index": 3,
            "epub_cfi": "ratio:0.42",
            "kind": "note",
            "label": "Chapter 3",
            "note": "Come back here",
            "progress_percent": 12,
            "reader_type": "epub",
        },
    )

    assert create_response.status_code == 201
    created_mark = create_response.json()
    assert created_mark["book_id"] == "b1"
    assert created_mark["chapter_index"] == 3
    assert created_mark["note"] == "Come back here"

    list_response = client.get("/api/v1/books/b1/marks", headers=auth_headers)
    assert list_response.status_code == 200
    assert [mark["id"] for mark in list_response.json()] == [created_mark["id"]]

    update_response = client.patch(
        f"/api/v1/books/b1/marks/{created_mark['id']}",
        headers=auth_headers,
        json={"note": "Updated note"},
    )

    assert update_response.status_code == 200
    assert update_response.json()["note"] == "Updated note"
    assert update_response.json()["label"] == "Chapter 3"

    delete_response = client.delete(f"/api/v1/books/b1/marks/{created_mark['id']}", headers=auth_headers)
    assert delete_response.status_code == 204
    assert client.get("/api/v1/books/b1/marks", headers=auth_headers).json() == []


def test_reader_mark_update_preserves_note_when_omitted(client: TestClient, auth_headers: dict[str, str]) -> None:
    create_response = client.post(
        "/api/v1/books/b1/marks",
        headers=auth_headers,
        json={"chapter_index": 2, "kind": "note", "label": "Chapter 2", "note": "Keep this note", "progress_percent": 8, "reader_type": "epub"},
    )
    assert create_response.status_code == 201
    mark_id = create_response.json()["id"]

    # Updating only the label must not wipe the existing note.
    label_only = client.patch(f"/api/v1/books/b1/marks/{mark_id}", headers=auth_headers, json={"label": "Renamed"})
    assert label_only.status_code == 200
    assert label_only.json()["label"] == "Renamed"
    assert label_only.json()["note"] == "Keep this note"

    # Sending an explicit empty note still clears it.
    cleared = client.patch(f"/api/v1/books/b1/marks/{mark_id}", headers=auth_headers, json={"note": ""})
    assert cleared.status_code == 200
    assert cleared.json()["note"] == ""


def test_reader_mark_rejects_coordinates_from_a_previous_format(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/v1/books/b1/marks",
        headers=auth_headers,
        json={"chapter_index": 3, "progress_percent": 12, "reader_type": "comic"},
    )

    assert response.status_code == 409
    assert "格式已更新" in response.json()["detail"]


def test_reader_mark_update_and_delete_require_matching_book(client: TestClient, auth_headers: dict[str, str]) -> None:
    create_response = client.post(
        "/api/v1/books/b1/marks",
        headers=auth_headers,
        json={
            "chapter_index": 1,
            "kind": "bookmark",
            "label": "Chapter 1",
            "note": "",
            "progress_percent": 1,
            "reader_type": "epub",
        },
    )
    assert create_response.status_code == 201
    mark_id = create_response.json()["id"]

    assert client.patch(f"/api/v1/books/b3/marks/{mark_id}", headers=auth_headers, json={"note": "wrong book"}).status_code == 404
    assert client.delete(f"/api/v1/books/b3/marks/{mark_id}", headers=auth_headers).status_code == 404
    assert client.get("/api/v1/books/b1/marks", headers=auth_headers).json()[0]["id"] == mark_id


def test_reader_marks_are_private_and_removed_with_book(client: TestClient, auth_headers: dict[str, str]) -> None:
    from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, create_book_asset
    with client.app.state.db_session_factory() as session:
        assets = SqlAlchemyBookAssetRepository(session)
        pages = [create_book_asset(book_id="b3", asset_type="comic_page", path=f"page-{index}.png", index=index, metadata={}) for index in range(1, 10)]
        assets.save_many(pages)
    create_response = client.post(
        "/api/v1/books/b3/marks",
        headers=auth_headers,
        json={
            "image_index": 9,
            "position_key": pages[8].id,
            "kind": "bookmark",
            "label": "Page 9",
            "note": "",
            "progress_percent": 30,
            "reader_type": "comic",
        },
    )
    assert create_response.status_code == 201

    invitation_response = client.post("/api/v1/invitations/me", headers=auth_headers)
    second_user = client.post(
        "/api/v1/auth/register",
        json={"email": "reader@example.com", "invitation_code": invitation_response.json()["code"], "nickname": "Reader", "password": "reader-password"},
    )
    second_headers = {"Authorization": f"Bearer {second_user.json()['access_token']}"}
    assert client.get("/api/v1/books/b3/marks", headers=second_headers).status_code == 404

    delete_book_response = client.delete("/api/v1/books/b3", headers=auth_headers)
    assert delete_book_response.status_code == 204
    assert client.get("/api/v1/books/b3/marks", headers=auth_headers).status_code == 404
