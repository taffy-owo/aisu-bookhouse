from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from PIL import Image

from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.models import BookAssetRecord
from app.modules.books.models import BookRecord
from tests.test_uploads import make_minimal_epub_bytes


ENGLISH = "She opened the book and read the letter. The story was waiting for her in the quiet library. " * 12
CHINESE = "她在图书馆里读完来信，等窗外的雨慢慢停下来，故事里的人们也终于迎来了新的生活。" * 12


def upload_text(client: TestClient, headers: dict[str, str], text: str = ENGLISH) -> str:
    response = client.post("/api/v1/uploads/books", headers=headers, files={"file": ("letter.txt", text.encode(), "text/plain")})
    assert response.status_code == 200
    return response.json()["book_id"]


def reprocess(client: TestClient, headers: dict[str, str], book_id: str) -> None:
    response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=headers)
    assert response.status_code == 200
    assert client.get(f"/api/v1/uploads/tasks/{response.json()['task_id']}", headers=headers).json()["status"] == "ready"


def original_path(client: TestClient, book_id: str) -> Path:
    with client.app.state.db_session_factory() as session:
        book = session.get(BookRecord, book_id)
        return resolve_storage_path(get_storage_root(client.app.state.settings), book.original_file_path)


def test_reprocess_keeps_a_manually_corrected_language(client: TestClient, auth_headers: dict[str, str]) -> None:
    text = "Une lettre attendait dans la bibliothèque. Elle regardait les étoiles du soir. " * 12
    uploaded = client.post("/api/v1/uploads/books", headers=auth_headers, files={"file": ("letter.txt", text.encode(), "text/plain")})
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["language"] == "und"
    edited = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "other"})
    assert edited.status_code == 200
    assert edited.json()["language"] == "other"
    reprocessed = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocessed.status_code == 200
    task = client.get(f"/api/v1/uploads/tasks/{reprocessed.json()['task_id']}", headers=auth_headers)
    assert task.json()["status"] == "ready"
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book.json()["language"] == "other"
    assert book.json()["language_mode"] == "manual"
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert text.strip() in chapter.json()["content"]


@pytest.mark.parametrize("action", ["reprocess", "replace"])
@pytest.mark.parametrize("manual", [False, True])
def test_language_mode_survives_resource_changes(client: TestClient, auth_headers: dict[str, str], action: str, manual: bool) -> None:
    book_id = upload_text(client, auth_headers)
    before = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert (before["language"], before["language_mode"]) == ("en", "auto")
    if manual:
        assert client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "en"}).json()["language_mode"] == "manual"
    if action == "reprocess":
        original_path(client, book_id).write_text(CHINESE, encoding="utf-8")
        reprocess(client, auth_headers, book_id)
    else:
        response = client.post(f"/api/v1/uploads/books/{book_id}/replace", headers=auth_headers, files={"file": ("new.txt", CHINESE.encode(), "text/plain")})
        assert response.status_code == 200
        assert client.get(f"/api/v1/uploads/tasks/{response.json()['task_id']}", headers=auth_headers).json()["status"] == "ready"
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert (book["language"], book["language_mode"]) == (("en", "manual") if manual else ("zh", "auto"))
    if manual:
        previous_body = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers).json()["content"]
        previous_original = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content
        auto = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "auto"})
        assert auto.status_code == 200
        assert (auto.json()["language"], auto.json()["language_mode"]) == ("zh", "auto")
        assert client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers).json()["content"] == previous_body
        assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == previous_original


def test_unspecified_is_an_explicit_manual_choice(client: TestClient, auth_headers: dict[str, str]) -> None:
    book_id = upload_text(client, auth_headers)
    response = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "und"})
    assert response.json()["language_mode"] == "manual"
    reprocess(client, auth_headers, book_id)
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["language"] == "und"
    restored = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "auto"}).json()
    assert (restored["language"], restored["language_mode"]) == ("en", "auto")


def test_unrelated_edits_keep_automatic_mode(client: TestClient, auth_headers: dict[str, str]) -> None:
    book_id = upload_text(client, auth_headers)
    edited = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"title": "Edited title", "description": "Edited description"})
    assert edited.status_code == 200
    assert edited.json()["language_mode"] == "auto"
    original_path(client, book_id).write_text(CHINESE, encoding="utf-8")
    reprocess(client, auth_headers, book_id)
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert (book["title"], book["description"], book["language"], book["language_mode"]) == ("Edited title", "Edited description", "zh", "auto")


@pytest.mark.parametrize(("legacy_language", "expected", "mode"), [("other", "other", "manual"), ("und", "en", "auto")])
def test_legacy_language_choices_are_preserved(client: TestClient, auth_headers: dict[str, str], legacy_language: str, expected: str, mode: str) -> None:
    book_id = upload_text(client, auth_headers)
    with client.app.state.db_session_factory() as session:
        book = session.get(BookRecord, book_id)
        book.language = legacy_language
        book.language_mode = None
        session.commit()
    reprocess(client, auth_headers, book_id)
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert (book["language"], book["language_mode"]) == (expected, mode)


def test_reset_to_auto_keeps_epub_language_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    text = "Une lettre attendait dans la bibliothèque. Elle regardait les étoiles du soir. " * 12
    original = make_minimal_epub_bytes(chapter_text=text)
    result = BytesIO()
    with ZipFile(BytesIO(original)) as source, ZipFile(result, "w") as destination:
        for member in source.infolist():
            data = source.read(member.filename)
            if member.filename.endswith(".opf"):
                data = data.replace(b"</metadata>", b"<dc:language>fr-FR</dc:language></metadata>")
            destination.writestr(member, data)
    uploaded = client.post("/api/v1/uploads/books", headers=auth_headers, files={"file": ("french.epub", result.getvalue(), "application/epub+zip")})
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]
    assert client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "en"}).status_code == 200
    reset = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "auto"})
    assert reset.status_code == 200
    assert (reset.json()["language"], reset.json()["language_mode"]) == ("other", "auto")


def test_reset_failure_keeps_manual_choice_and_revision(client: TestClient, auth_headers: dict[str, str]) -> None:
    book_id = upload_text(client, auth_headers)
    manual = client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "ja"}).json()
    with client.app.state.db_session_factory() as session:
        asset = session.scalar(select(BookAssetRecord).where(BookAssetRecord.book_id == book_id, BookAssetRecord.asset_type == "text_chapter"))
        resolve_storage_path(get_storage_root(client.app.state.settings), asset.path).unlink()
    assert client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json={"language": "auto"}).status_code == 409
    latest = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert (latest["language"], latest["language_mode"], latest["updated_at"]) == ("ja", "manual", manual["updated_at"])


def test_reprocess_preserves_custom_cover_and_manual_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    book_id = upload_text(client, auth_headers)
    buffer = BytesIO()
    Image.new("RGB", (180, 270), (125, 96, 107)).save(buffer, format="PNG")
    cover = buffer.getvalue()
    assert client.put(f"/api/v1/books/{book_id}/cover", headers=auth_headers, files={"file": ("cover.png", cover, "image/png")}).status_code == 200
    saved_cover = client.get(f"/api/v1/files/books/{book_id}/cover", headers=auth_headers)
    assert saved_cover.status_code == 200
    manual = {"title": "Manual title", "author": "Manual author", "description": "Manual description", "language": "other", "tags": ["Manual tag"], "series_title": "Series", "series_order": 2, "rating": 8}
    assert client.patch(f"/api/v1/books/{book_id}", headers=auth_headers, json=manual).status_code == 200
    reprocess(client, auth_headers, book_id)
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert all(book[key] == value for key, value in manual.items())
    assert client.get(f"/api/v1/files/books/{book_id}/cover", headers=auth_headers).content == saved_cover.content
