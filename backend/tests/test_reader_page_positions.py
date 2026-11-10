from pathlib import Path
import pytest

from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.books.repository import SqlAlchemyBookRepository


def seed_pages(client, reader_type, edition="old"):
    storage = Path(client.app.state.settings.storage_root)
    storage.mkdir(parents=True, exist_ok=True)
    with client.app.state.db_session_factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id("b1").with_changes(reader_type=reader_type, original_file_path=f"{edition}.pdf", file_size=32))
        (storage / f"{edition}.pdf").write_bytes(b"%PDF-1.4\n" + edition.encode() + b" page content")
        assets = SqlAlchemyBookAssetRepository(session)
        assets.clear_for_book("b1")
        if reader_type in {"comic", "image"}:
            asset_type = "comic_page" if reader_type == "comic" else "image_page"
            for index in range(1, 4):
                path = f"{edition}-{index}.png"
                (storage / path).write_bytes(edition.encode() + str(index).encode())
                assets.save(create_book_asset(book_id="b1", asset_type=asset_type, path=path, index=index, metadata={}))


def resource(client, headers):
    response = client.get("/api/v1/books/b1/reader", headers=headers)
    assert response.status_code == 200
    return response.json()


def payload_for(data):
    if data["reader_type"] == "pdf":
        return {"reader_type": "pdf", "position_key": data["position_key"], "page_number": 2, "progress_percent": 40}
    return {"reader_type": data["reader_type"], "position_key": data["pages"][1]["position_key"], "image_index": 2, "page_number": 2, "progress_percent": 40}


def write(client, headers, kind, payload):
    return client.put("/api/v1/books/b1/progress", headers=headers, json=payload) if kind == "progress" else client.post("/api/v1/books/b1/marks", headers=headers, json={**payload, "kind": "note", "note": "保留这条备注"})


@pytest.mark.parametrize("reader_type", ["pdf", "comic", "image"])
@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_current_page_identity_is_accepted(client, auth_headers, reader_type, kind):
    seed_pages(client, reader_type)
    payload = payload_for(resource(client, auth_headers))
    assert payload["position_key"]
    assert write(client, auth_headers, kind, payload).status_code == (200 if kind == "progress" else 201)


@pytest.mark.parametrize("reader_type", ["pdf", "comic", "image"])
@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_paged_coordinates_require_current_identity(client, auth_headers, reader_type, kind):
    seed_pages(client, reader_type)
    payload = payload_for(resource(client, auth_headers))
    payload.pop("position_key")
    assert write(client, auth_headers, kind, payload).status_code == 409


@pytest.mark.parametrize("reader_type", ["pdf", "comic", "image"])
@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_old_file_coordinates_cannot_overwrite_a_new_file(client, auth_headers, reader_type, kind):
    seed_pages(client, reader_type)
    old = payload_for(resource(client, auth_headers))
    seed_pages(client, reader_type, "new")
    current = payload_for(resource(client, auth_headers))
    assert current["position_key"] != old["position_key"]
    assert write(client, auth_headers, "progress", {**current, "progress_percent": 20}).status_code == 200
    before = client.get("/api/v1/books/b1/progress", headers=auth_headers).json()
    assert write(client, auth_headers, kind, old).status_code == 409
    assert client.get("/api/v1/books/b1/progress", headers=auth_headers).json() == before
    assert client.get("/api/v1/books/b1/marks", headers=auth_headers).json() == []


@pytest.mark.parametrize("reader_type", ["comic", "image"])
@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_reordered_pages_reject_old_ordinals(client, auth_headers, reader_type, kind):
    seed_pages(client, reader_type)
    old = payload_for(resource(client, auth_headers))
    with client.app.state.db_session_factory() as session:
        assets = SqlAlchemyBookAssetRepository(session)
        pages = assets.list_by_book("b1", "comic_page" if reader_type == "comic" else "image_page")
        assets.update_index(pages[0].id, 2)
        assets.update_index(pages[1].id, 1)
    assert write(client, auth_headers, kind, old).status_code == 409
    assert write(client, auth_headers, kind, payload_for(resource(client, auth_headers))).status_code == (200 if kind == "progress" else 201)


@pytest.mark.parametrize("reader_type", ["pdf", "comic", "image"])
def test_metadata_edits_do_not_change_page_identity(client, auth_headers, reader_type):
    seed_pages(client, reader_type)
    before = resource(client, auth_headers)
    with client.app.state.db_session_factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id("b1").with_changes(title="重命名后的书"))
    after = resource(client, auth_headers)
    assert payload_for(before)["position_key"] == payload_for(after)["position_key"]
    assert write(client, auth_headers, "progress", payload_for(before)).status_code == 200


@pytest.mark.parametrize("reader_type", ["pdf", "comic", "image"])
@pytest.mark.parametrize("kind", ["progress", "mark"])
def test_missing_or_mixed_page_coordinates_are_rejected(client, auth_headers, reader_type, kind):
    seed_pages(client, reader_type)
    valid = payload_for(resource(client, auth_headers))
    for payload in [{**valid, "chapter_index": 2}, {**valid, "image_index": None, "page_number": None}]:
        assert write(client, auth_headers, kind, payload).status_code == 409
    if reader_type != "pdf":
        assert write(client, auth_headers, kind, {**valid, "image_index": 20, "page_number": 20}).status_code == 409
        assert write(client, auth_headers, kind, {**valid, "page_number": 1}).status_code == 409


def test_pdf_range_requests_cannot_read_another_edition(client, auth_headers):
    seed_pages(client, "pdf")
    old = resource(client, auth_headers)
    assert client.get(old["file_url"], headers={"Range": "bytes=0-7"}).status_code == 206
    seed_pages(client, "pdf", "new")
    assert client.get(old["file_url"], headers={"Range": "bytes=0-7"}).status_code == 409
    current = resource(client, auth_headers)
    assert client.get(current["file_url"], headers={"Range": "bytes=0-7"}).status_code == 206
    assert client.get("/api/v1/files/books/b1/pdf?position_key=" + old["position_key"], headers=auth_headers).status_code == 409


@pytest.mark.parametrize("reader_type", ["comic", "image"])
def test_old_image_url_cannot_return_a_new_page_at_the_same_index(client, auth_headers, reader_type):
    seed_pages(client, reader_type)
    old = resource(client, auth_headers)["pages"][1]["image_url"]
    assert client.get(old, headers=auth_headers).content == b"old2"
    seed_pages(client, reader_type, "new")
    assert client.get(old, headers=auth_headers).status_code == 409
    current = resource(client, auth_headers)["pages"][1]["image_url"]
    assert client.get(current, headers=auth_headers).content == b"new2"
