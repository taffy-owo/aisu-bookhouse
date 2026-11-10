import asyncio

from fastapi.testclient import TestClient
import pytest
from pytest import MonkeyPatch
from fastapi import HTTPException

from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.books.source_updates import _lock_source_update_book
from app.modules.uploads.schemas import WorkSourceMetadata


@pytest.mark.parametrize("new_source", [None, "https://kakuyomu.jp/works/999"])
@pytest.mark.parametrize("fetch_fails", [False, True])
def test_old_source_check_cannot_restore_replaced_association(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
    new_source: str | None,
    fetch_fails: bool,
) -> None:
    old_source = "https://kakuyomu.jp/works/16817330649163498808"
    assert client.patch("/api/v1/books/b1", headers=auth_headers, json={
        "source_url": old_source, "publication_status": "ongoing",
    }).status_code == 200

    async def fetch_while_association_changes(url: str) -> WorkSourceMetadata:
        assert url == old_source
        changed = await asyncio.to_thread(client.patch, "/api/v1/books/b1", headers=auth_headers, json={
            "source_url": new_source, "auto_translate_updates": False,
        })
        assert changed.status_code == 200
        if fetch_fails:
            raise ValueError("Old source unavailable")
        return WorkSourceMetadata(author="Old author", character_count=1000, cover_url=None,
            description="Old source", episode_count=10, publication_status="ongoing",
            source="kakuyomu", source_url=old_source, tags=[], title="Old source")

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fetch_while_association_changes)
    checked = client.post("/api/v1/books/b1/source-update/check", headers=auth_headers)
    assert checked.status_code == 409
    saved = client.get("/api/v1/books/b1", headers=auth_headers).json()
    assert saved["source_url"] == new_source
    assert saved["source_checked_at"] is None
    assert saved["source_check_error"] is None
    assert saved["source_update_count"] == 0
    assert saved["auto_translate_updates"] is False


def test_source_update_setup_rejects_a_book_changed_after_catalog_read(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    # The source catalog fetch happens before the update project is prepared.
    # Keep that snapshot, change the book through another writer, and verify
    # the setup lock refuses the stale snapshot instead of creating a duplicate
    # translation baseline.
    with client.app.state.db_session_factory() as session:
        stale = SqlAlchemyBookRepository(session).get_by_id("b1")
    assert stale is not None

    changed = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"title": "她与星光的告白（已更新）"},
    )
    assert changed.status_code == 200

    with client.app.state.db_session_factory() as session:
        with pytest.raises(HTTPException) as error:
            _lock_source_update_book(session, stale)
    assert error.value.status_code == 409
