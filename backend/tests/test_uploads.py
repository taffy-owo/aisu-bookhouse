import base64
from contextlib import closing
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.modules.admin.backup_cli import run_offline_restore
from app.modules.admin.backups import create_backup, get_backup_root, validate_referenced_storage
from app.modules.books.models import BookRecord
from app.modules.files.service import build_download_name
from app.modules.uploads.domain import UploadTask
from app.modules.uploads.repository import InMemoryUploadTaskRepository, SqlAlchemyUploadTaskRepository
from app.modules.uploads.worker import process_next_upload_task

TINY_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYt6KwAAAABJRU5ErkJggg=="
)


def make_minimal_epub_bytes(
    *,
    author: str = "Test Author",
    chapter_text: str | None = None,
    chapter_texts: list[str] | None = None,
    cover_bytes: bytes | None = None,
    description: str | None = None,
    title: str = "Minimal Test EPUB",
) -> bytes:
    resolved_chapter_texts = chapter_texts if chapter_texts is not None else ([chapter_text] if chapter_text else [])
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        manifest_items = []
        if cover_bytes:
            manifest_items.append('<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image" />')
        for chapter_index in range(1, len(resolved_chapter_texts) + 1):
            manifest_items.append(f'<item id="chapter-{chapter_index}" href="chapter-{chapter_index}.xhtml" media-type="application/xhtml+xml" />')
        manifest = "".join(manifest_items)
        spine = "".join(f'<itemref idref="chapter-{chapter_index}" />' for chapter_index in range(1, len(resolved_chapter_texts) + 1))
        description_metadata = f"<dc:description>{description}</dc:description>" if description else ""
        archive.writestr(
            "OPS/content.opf",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>{description_metadata}
  </metadata>
  <manifest>{manifest}</manifest>
  <spine>{spine}</spine>
</package>
""",
        )
        if cover_bytes:
            archive.writestr("OPS/images/cover.png", cover_bytes)
        for chapter_index, resolved_chapter_text in enumerate(resolved_chapter_texts, start=1):
            archive.writestr(
                f"OPS/chapter-{chapter_index}.xhtml",
                f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>第{chapter_index}章 测试章节</h1>
    <p>{resolved_chapter_text}</p>
  </body>
</html>
""",
            )
    return buffer.getvalue()


def make_minimal_mobi_comic_bytes() -> bytes:
    records = [b"\x00" * 16, b"\xff\xd8\xff\xe0minimal-jpeg-page\xff\xd9"]
    record_count = len(records)
    header = bytearray(78)
    header[:9] = b"AISU MOBI"
    header[76:78] = record_count.to_bytes(2, "big")
    offset = len(header) + record_count * 8
    entries = bytearray()
    for record in records:
        entries.extend(offset.to_bytes(4, "big"))
        entries.extend(b"\x00\x00\x00\x00")
        offset += len(record)
    return bytes(header) + bytes(entries) + b"".join(records)


def test_lists_upload_tasks(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/v1/uploads/tasks", headers=auth_headers)

    assert response.status_code == 200
    assert response.json()[0]["file_type"] == "EPUB"


def test_upload_task_repositories_list_user_tasks_newest_first(client: TestClient) -> None:
    now = datetime.now(timezone.utc)
    memory_tasks = [
        make_upload_task("old", "user-1", now - timedelta(minutes=10)),
        make_upload_task("new", "user-1", now),
        make_upload_task("middle", "user-1", now - timedelta(minutes=5)),
        make_upload_task("other-user", "user-2", now + timedelta(minutes=5)),
    ]

    memory_repository = InMemoryUploadTaskRepository(memory_tasks)
    assert [task.id for task in memory_repository.list_by_user("user-1")] == ["new", "middle", "old"]

    user_id = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()["user"]["id"]
    sql_tasks = [
        make_upload_task("sql-old", user_id, now - timedelta(minutes=10)),
        make_upload_task("sql-new", user_id, now),
        make_upload_task("sql-middle", user_id, now - timedelta(minutes=5)),
    ]
    with client.app.state.db_session_factory() as session:
        sql_repository = SqlAlchemyUploadTaskRepository(session)
        for task in sql_tasks:
            sql_repository.save(task)

        inserted_task_ids = [task.id for task in sql_repository.list_by_user(user_id) if task.id.startswith("sql-")]
        assert inserted_task_ids == ["sql-new", "sql-middle", "sql-old"]


def test_upload_task_repositories_reject_stale_updates(client: TestClient) -> None:
    now = datetime.now(timezone.utc)
    newer = make_upload_task("stale-check", "user-1", now)
    older = newer.with_changes(status="processing", updated_at=now - timedelta(seconds=1))

    memory_repository = InMemoryUploadTaskRepository([newer])
    assert memory_repository.save(older).status == "ready"

    user_id = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"}).json()["user"]["id"]
    sql_newer = make_upload_task("sql-stale-check", user_id, now)
    sql_older = sql_newer.with_changes(status="processing", updated_at=now - timedelta(seconds=1))
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyUploadTaskRepository(session)
        repository.save(sql_newer)
        assert repository.save(sql_older).status == "ready"


def make_upload_task(task_id: str, user_id: str, updated_at: datetime) -> UploadTask:
    return UploadTask(
        id=task_id,
        user_id=user_id,
        book_id=None,
        file_name=f"{task_id}.epub",
        file_type="EPUB",
        file_size=1,
        status="ready",
        progress=100,
        message=None,
        error_code=None,
        created_at=updated_at - timedelta(minutes=1),
        updated_at=updated_at,
    )


def test_upload_creates_book_and_task(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_minimal_epub_bytes(chapter_text="这是真实导入的正文。", cover_bytes=TINY_PNG_BYTES)
    response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("test.epub", BytesIO(epub_bytes), "application/epub+zip")},
        data={
            "title": "Test Book",
            "author": "Test Author",
            "description": "Imported description",
            "publication_status": "ongoing",
            "source_url": "https://kakuyomu.jp/works/16818093090598662135",
            "tags": "test,EPUB",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["book_id"]
    assert payload["status"] == "processing"

    book_response = client.get(f"/api/v1/books/{payload['book_id']}", headers=auth_headers)
    assert book_response.status_code == 200
    book_payload = book_response.json()
    assert book_payload["file_size"] == len(epub_bytes)
    assert book_payload["mime_type"] == "application/epub+zip"
    assert book_payload["cover_url"] == f"/api/v1/files/books/{payload['book_id']}/cover"
    assert book_payload["description"] == "Imported description"
    assert book_payload["publication_status"] == "ongoing"
    assert book_payload["source_url"] == "https://kakuyomu.jp/works/16818093090598662135"

    file_response = client.get(f"/api/v1/files/books/{payload['book_id']}/original", headers=auth_headers)
    assert file_response.status_code == 200
    assert file_response.content == epub_bytes

    cover_response = client.get(book_payload["cover_url"], headers=auth_headers)
    assert cover_response.status_code == 200
    assert cover_response.headers["content-type"] == "image/png"
    assert cover_response.content == TINY_PNG_BYTES

    reader_response = client.get(f"/api/v1/books/{payload['book_id']}/reader", headers=auth_headers)
    assert reader_response.status_code == 200
    assert reader_response.json()["chapter_count"] == 1

    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    assert task_response.status_code == 200
    assert task_response.json()["file_size"] == len(epub_bytes)
    assert task_response.json()["message"] == "已保存原文件，封面 1 张，正文 1 章。"

    chapter_response = client.get(f"/api/v1/books/{payload['book_id']}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert "这是真实导入的正文。" in chapter_response.json()["content"]


def test_upload_ignores_uuid_epub_title_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_minimal_epub_bytes(title="84526d8a-bf5c-4742-b2d8-6a6eaf9f7f41")
    response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("rain-night-26.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )

    assert response.status_code == 200
    payload = response.json()

    book_response = client.get(f"/api/v1/books/{payload['book_id']}", headers=auth_headers)
    assert book_response.status_code == 200
    assert book_response.json()["title"] == "rain-night-26"


def test_upload_uses_series_tag_for_numeric_file_name(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_minimal_epub_bytes(title="84526d8a-bf5c-4742-b2d8-6a6eaf9f7f41")
    response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("26.epub", BytesIO(epub_bytes), "application/epub+zip")},
        data={"tags": "本地导入,雨夜之月,EPUB"},
    )

    assert response.status_code == 200
    payload = response.json()

    book_response = client.get(f"/api/v1/books/{payload['book_id']}", headers=auth_headers)
    assert book_response.status_code == 200
    assert book_response.json()["title"] == "雨夜之月 26"


def test_original_file_requires_auth(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("私有.pdf", BytesIO(b"fake pdf"), "application/pdf")},
    )

    response = client.get(f"/api/v1/files/books/{upload_response.json()['book_id']}/original")

    assert response.status_code == 401


def test_download_name_sanitizes_unfriendly_titles() -> None:
    title = "  bad\\/:*?\"<>|\x00\x1f name...  " + "超" * 150

    download_name = build_download_name(title, "epub")

    assert download_name.endswith(".epub")
    assert "bad name" in download_name
    assert len(download_name.removesuffix(".epub")) <= 120
    assert not any(char in download_name for char in {'\\', '/', ':', '*', '?', '"', '<', '>', '|', "\x00", "\x1f"})
    assert not download_name.removesuffix(".epub").endswith((" ", "."))


def test_reprocess_uploaded_book_uses_original_file(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("retry.txt", BytesIO(b"Chapter 1\nhello again"), "text/plain")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    patch_response = client.patch(
        f"/api/v1/books/{book_id}",
        headers=auth_headers,
        json={"title": "Manual Retry Title"},
    )
    assert patch_response.status_code == 200

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)

    assert reprocess_response.status_code == 200
    payload = reprocess_response.json()
    assert payload["book_id"] == book_id
    assert payload["task_id"]

    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    assert task_response.status_code == 200
    assert task_response.json()["status"] == "ready"

    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.status_code == 200
    assert book_response.json()["status"] == "ready"
    assert book_response.json()["title"] == "Manual Retry Title"

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert "hello again" in chapter_response.json()["content"]


def test_replace_book_file_preserves_reading_time_and_percentage(client: TestClient, auth_headers: dict[str, str]) -> None:
    old_epub = make_minimal_epub_bytes(chapter_text="旧译本正文", title="旧内嵌标题")
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("old.epub", BytesIO(old_epub), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    assert client.patch(
        f"/api/v1/books/{book_id}",
        headers=auth_headers,
        json={"author": "手动作者", "description": "手动简介", "title": "我保留的书名"},
    ).status_code == 200
    assert client.put(
        f"/api/v1/books/{book_id}/progress",
        headers=auth_headers,
        json={
            "chapter_href": "OPS/chapter-1.xhtml",
            "chapter_index": 1,
            "epub_cfi": "ratio:0.57",
            "page_number": 9,
            "progress_percent": 57,
            "reader_type": "epub",
        },
    ).status_code == 200
    assert client.post(
        f"/api/v1/books/{book_id}/marks",
        headers=auth_headers,
        json={
            "chapter_index": 1,
            "kind": "note",
            "label": "旧译本标记",
            "note": "保留备注内容，替换后旧定位失效",
            "progress_percent": 57,
            "reader_type": "epub",
        },
    ).status_code == 201
    activity_response = client.post(
        "/api/v1/reading-activity",
        headers=auth_headers,
        json={"book_id": book_id, "event_id": "replace-preserve-time", "seconds": 321},
    )
    before_seconds = next(item["seconds"] for item in activity_response.json()["book_totals"] if item["book_id"] == book_id)

    new_epub = make_minimal_epub_bytes(chapter_text="质量更好的新译本正文", title="不应覆盖手动书名")
    replace_response = client.post(
        f"/api/v1/uploads/books/{book_id}/replace",
        headers=auth_headers,
        files={"file": ("better.epub", BytesIO(new_epub), "application/epub+zip")},
        data={"keep_progress": "true"},
    )

    assert replace_response.status_code == 200
    assert replace_response.json()["book_id"] == book_id
    task = client.get(f"/api/v1/uploads/tasks/{replace_response.json()['task_id']}", headers=auth_headers).json()
    assert task["status"] == "ready"
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert (book["title"], book["author"], book["description"]) == ("我保留的书名", "手动作者", "手动简介")
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers).json()["content"]
    assert "质量更好的新译本正文" in chapter
    assert "旧译本正文" not in chapter
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == new_epub

    progress = client.get(f"/api/v1/books/{book_id}/progress", headers=auth_headers).json()
    assert progress["progress_percent"] == 57
    assert progress["reader_type"] == "epub"
    assert progress["chapter_index"] == 1
    assert progress["page_number"] is None
    assert progress["chapter_href"] is None
    assert progress["epub_cfi"] == "aisu-scroll:0.5700"
    preserved_marks = client.get(f"/api/v1/books/{book_id}/marks", headers=auth_headers).json()
    assert len(preserved_marks) == 1
    assert preserved_marks[0]["note"] == "保留备注内容，替换后旧定位失效"
    assert preserved_marks[0]["position_valid"] is False
    activity = client.get("/api/v1/reading-activity", headers=auth_headers).json()
    assert next(item["seconds"] for item in activity["book_totals"] if item["book_id"] == book_id) == before_seconds


def test_replace_book_file_maps_percentage_to_new_chapter(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("old.epub", BytesIO(make_minimal_epub_bytes(chapter_text="旧正文")), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    client.put(
        f"/api/v1/books/{book_id}/progress",
        headers=auth_headers,
        json={"chapter_index": 1, "epub_cfi": "aisu-scroll:0.5700", "progress_percent": 57, "reader_type": "epub"},
    )

    equal_length_chapters = [f"新译本第 {index} 章正文" for index in range(1, 5)]
    replace_response = client.post(
        f"/api/v1/uploads/books/{book_id}/replace",
        headers=auth_headers,
        files={"file": ("new.epub", BytesIO(make_minimal_epub_bytes(chapter_texts=equal_length_chapters)), "application/epub+zip")},
        data={"keep_progress": "true"},
    )
    assert client.get(f"/api/v1/uploads/tasks/{replace_response.json()['task_id']}", headers=auth_headers).json()["status"] == "ready"

    progress = client.get(f"/api/v1/books/{book_id}/progress", headers=auth_headers).json()
    assert progress["chapter_index"] == 3
    assert progress["epub_cfi"].startswith("aisu-scroll:")
    startup = client.get(f"/api/v1/books/{book_id}/reader/startup", headers=auth_headers).json()
    assert startup["chapter"]["index"] == 3
    assert "新译本第 3 章正文" in startup["chapter"]["content"]

    client.put(
        f"/api/v1/books/{book_id}/progress",
        headers=auth_headers,
        json={"chapter_index": None, "epub_cfi": None, "progress_percent": 57, "reader_type": "epub"},
    )
    repaired_startup = client.get(f"/api/v1/books/{book_id}/reader/startup", headers=auth_headers).json()
    assert repaired_startup["progress"]["chapter_index"] == 3
    assert repaired_startup["chapter"]["index"] == 3


def test_replace_book_file_can_reset_position_without_losing_time(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("old.epub", BytesIO(make_minimal_epub_bytes(chapter_text="旧正文")), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    client.put(
        f"/api/v1/books/{book_id}/progress",
        headers=auth_headers,
        json={"chapter_index": 1, "progress_percent": 83, "reader_type": "epub"},
    )
    activity_response = client.post(
        "/api/v1/reading-activity",
        headers=auth_headers,
        json={"book_id": book_id, "event_id": "replace-reset-time", "seconds": 123},
    )
    before_seconds = next(item["seconds"] for item in activity_response.json()["book_totals"] if item["book_id"] == book_id)

    replace_response = client.post(
        f"/api/v1/uploads/books/{book_id}/replace",
        headers=auth_headers,
        files={"file": ("new.epub", BytesIO(make_minimal_epub_bytes(chapter_text="新正文")), "application/epub+zip")},
        data={"keep_progress": "false"},
    )

    assert client.get(f"/api/v1/uploads/tasks/{replace_response.json()['task_id']}", headers=auth_headers).json()["status"] == "ready"
    assert client.get(f"/api/v1/books/{book_id}/progress", headers=auth_headers).json()["progress_percent"] == 0
    activity = client.get("/api/v1/reading-activity", headers=auth_headers).json()
    assert next(item["seconds"] for item in activity["book_totals"] if item["book_id"] == book_id) == before_seconds


def test_replace_book_file_rolls_back_when_new_file_is_invalid(client: TestClient, auth_headers: dict[str, str]) -> None:
    old_epub = make_minimal_epub_bytes(chapter_text="回滚后仍然存在的旧正文", cover_bytes=TINY_PNG_BYTES)
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("old.epub", BytesIO(old_epub), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]

    replace_response = client.post(
        f"/api/v1/uploads/books/{book_id}/replace",
        headers=auth_headers,
        files={"file": ("broken.epub", BytesIO(b"not a valid epub archive"), "application/epub+zip")},
    )

    assert replace_response.status_code == 200
    task = client.get(f"/api/v1/uploads/tasks/{replace_response.json()['task_id']}", headers=auth_headers).json()
    assert task["status"] == "failed"
    assert "旧版本仍可阅读" in task["message"]
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["status"] == "ready"
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers).json()["content"]
    assert "回滚后仍然存在的旧正文" in chapter
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == old_epub
    assert client.get(f"/api/v1/files/books/{book_id}/cover", headers=auth_headers).content == TINY_PNG_BYTES


@pytest.mark.parametrize("keep_progress", [True, False])
def test_replacing_shared_book_updates_each_readers_position(client: TestClient, auth_headers: dict[str, str], keep_progress: bool) -> None:
    uploaded = client.post("/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("old.epub", make_minimal_epub_bytes(chapter_texts=["旧一", "旧二", "旧三"]), "application/epub+zip")})
    book_id = uploaded.json()["book_id"]
    invitation = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]
    registration = client.post("/api/v1/auth/register", json={"email": "replacement-reader@example.com",
        "nickname": "读者", "password": "reader-password", "invitation_code": invitation})
    assert registration.status_code == 200
    reader_headers = {"Authorization": f"Bearer {registration.json()['access_token']}"}
    client.post(f"/api/v1/books/{book_id}/share-request", headers=auth_headers)
    client.post(f"/api/v1/books/{book_id}/share-request/approve", headers=auth_headers)
    assert client.put(f"/api/v1/books/{book_id}/progress", headers=reader_headers,
        json={"reader_type": "epub", "progress_percent": 75, "chapter_index": 3,
              "updated_at": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()}).status_code == 200
    assert client.post(f"/api/v1/books/{book_id}/marks", headers=reader_headers,
        json={"kind": "bookmark", "reader_type": "epub", "chapter_index": 3, "progress_percent": 75}).status_code == 201
    replaced = client.post(f"/api/v1/uploads/books/{book_id}/replace", headers=auth_headers,
        data={"keep_progress": str(keep_progress).lower()},
        files={"file": ("new.txt", "第1章 新一\n\n正文一。\n\n第2章 新二\n\n正文二。".encode(), "text/plain")})
    assert replaced.status_code == 200
    assert client.get(f"/api/v1/uploads/tasks/{replaced.json()['task_id']}", headers=auth_headers).json()["status"] == "ready"
    progress = client.get(f"/api/v1/books/{book_id}/progress", headers=reader_headers).json()
    assert progress["reader_type"] == "text"
    assert progress["progress_percent"] == (75 if keep_progress else 0)
    assert progress["chapter_index"] == (2 if keep_progress else 1)
    preserved_marks = client.get(f"/api/v1/books/{book_id}/marks", headers=reader_headers).json()
    assert len(preserved_marks) == 1
    assert preserved_marks[0]["reader_type"] == "epub"
    assert preserved_marks[0]["chapter_index"] == 3
    assert preserved_marks[0]["position_valid"] is False


@pytest.mark.parametrize("candidate_kind", ["missing_opf", "empty_chapters", "missing_image"])
def test_replacement_rejects_unreadable_epub(client: TestClient, auth_headers: dict[str, str], candidate_kind: str) -> None:
    old_epub = make_minimal_epub_bytes(chapter_text="仍可阅读的旧正文")
    uploaded = client.post(
        "/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("old.epub", BytesIO(old_epub), "application/epub+zip")},
    )
    book_id = uploaded.json()["book_id"]
    if candidate_kind == "missing_opf":
        buffer = BytesIO()
        with ZipFile(buffer, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip")
        candidate = buffer.getvalue()
    elif candidate_kind == "empty_chapters":
        candidate = make_minimal_epub_bytes(chapter_texts=[])
    else:
        candidate = make_minimal_epub_bytes(chapter_text='<img src="missing.png" />')

    replacement = client.post(
        f"/api/v1/uploads/books/{book_id}/replace", headers=auth_headers,
        files={"file": ("candidate.epub", BytesIO(candidate), "application/epub+zip")},
    )
    assert replacement.status_code == 200
    task = client.get(f"/api/v1/uploads/tasks/{replacement.json()['task_id']}", headers=auth_headers).json()
    assert task["status"] == "failed"
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == old_epub
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter.status_code == 200 and "仍可阅读的旧正文" in chapter.json()["content"]


@pytest.mark.parametrize("mutation", ["edit", "delete"])
def test_replacement_does_not_overwrite_book_changed_during_parse(tmp_path: Path, monkeypatch, mutation: str) -> None:
    database_path = tmp_path / "books.sqlite3"
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{database_path.as_posix()}", seed_demo_data=True,
        storage_root=str(tmp_path / "storage"), upload_processing_mode="external",
    )
    old_epub = make_minimal_epub_bytes(chapter_text="编辑期间保留的旧正文")
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        uploaded = client.post(
            "/api/v1/uploads/books", headers=headers,
            files={"file": ("old.epub", BytesIO(old_epub), "application/epub+zip")},
        )
        book_id = uploaded.json()["book_id"]
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        replacement = client.post(
            f"/api/v1/uploads/books/{book_id}/replace", headers=headers,
            files={"file": ("new.epub", BytesIO(make_minimal_epub_bytes(chapter_text="不应发布的新正文")), "application/epub+zip")},
        )
        import app.modules.uploads.service as upload_service
        original_processor = upload_service.run_processor
        def parse_then_edit(staged_book, processor_settings):
            result = original_processor(staged_book, processor_settings)
            with client.app.state.db_session_factory() as editing_session:
                record = editing_session.get(BookRecord, book_id)
                if mutation == "delete":
                    record.status = "deleted"
                else:
                    record.title = "解析期间的手动修改"
                record.updated_at = datetime.now(timezone.utc) + timedelta(seconds=1)
                editing_session.commit()
            return result
        monkeypatch.setattr(upload_service, "run_processor", parse_then_edit)
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        task = client.get(f"/api/v1/uploads/tasks/{replacement.json()['task_id']}", headers=headers).json()
        assert task["status"] == "failed"
        if mutation == "delete":
            assert client.get(f"/api/v1/books/{book_id}", headers=headers).status_code == 404
        else:
            assert client.get(f"/api/v1/books/{book_id}", headers=headers).json()["title"] == "解析期间的手动修改"
            assert client.get(f"/api/v1/files/books/{book_id}/original", headers=headers).content == old_epub


@pytest.mark.parametrize("kill_stage", ["after_parse", "after_publish"])
def test_replacement_survives_worker_kill_at_publish_boundaries(tmp_path: Path, kill_stage: str) -> None:
    database_path = tmp_path / "books.sqlite3"
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{database_path.as_posix()}",
        seed_demo_data=True,
        storage_root=str(tmp_path / "storage"),
        upload_processing_mode="worker",
    )
    old_epub = make_minimal_epub_bytes(chapter_text="旧版本在崩溃后仍可阅读")
    new_epub = make_minimal_epub_bytes(chapter_text="恢复处理后的新版本")
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        uploaded = client.post(
            "/api/v1/uploads/books",
            headers=headers,
            files={"file": ("old.epub", BytesIO(old_epub), "application/epub+zip")},
        )
        assert uploaded.status_code == 200
        book_id = uploaded.json()["book_id"]
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        assert client.get(f"/api/v1/uploads/tasks/{uploaded.json()['task_id']}", headers=headers).json()["status"] == "ready"

        note = client.post(f"/api/v1/books/{book_id}/marks", headers=headers,
            json={"reader_type": "epub", "kind": "note", "note": "崩溃恢复也不能丢失", "label": "旧备注", "chapter_index": 1, "progress_percent": 20}).json()

        replacement = client.post(
            f"/api/v1/uploads/books/{book_id}/replace",
            headers=headers,
            files={"file": ("new.epub", BytesIO(new_epub), "application/epub+zip")},
        )
        assert replacement.status_code == 200
        task_id = replacement.json()["task_id"]
        marker = tmp_path / "parsed.marker"
        worker_script = """
import sys, time
from pathlib import Path
from app.core.config import Settings
from app.core.database import create_database_engine, create_session_factory
import app.modules.uploads.service as service
from app.modules.uploads.worker import process_next_upload_task

database, storage, marker, stage = sys.argv[1:]
settings = Settings(database_url=f"sqlite+pysqlite:///{database}", storage_root=storage, upload_processing_mode="worker")
def pause():
    Path(marker).write_text("parsed", encoding="utf-8")
    while True:
        time.sleep(0.1)
if stage == "after_parse":
    original = service.run_processor
    def pause_after_parse(book, settings):
        result = original(book, settings)
        pause()
        return result
    service.run_processor = pause_after_parse
else:
    def pause_after_publish(**kwargs):
        pause()
    service.update_replacement_reading_state = pause_after_publish
engine = create_database_engine(settings)
process_next_upload_task(settings=settings, session_factory=create_session_factory(engine))
"""
        worker = subprocess.Popen(
            [sys.executable, "-c", worker_script, str(database_path), settings.storage_root, str(marker), kill_stage],
            cwd=Path(__file__).resolve().parents[1],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 30
            while not marker.exists() and worker.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if not marker.exists():
                stdout, stderr = worker.communicate(timeout=5) if worker.poll() is not None else (b"", b"")
                raise AssertionError(f"Replacement did not reach parsed stage: {stdout!r} {stderr!r}")
        finally:
            if worker.poll() is None:
                worker.kill()
            worker.communicate(timeout=10)

        expected_content = "旧版本在崩溃后仍可阅读" if kill_stage == "after_parse" else "恢复处理后的新版本"
        expected_original = old_epub if kill_stage == "after_parse" else new_epub
        assert expected_content in client.get(
            f"/api/v1/books/{book_id}/reader/chapters/1", headers=headers
        ).json()["content"]
        assert client.get(f"/api/v1/files/books/{book_id}/original", headers=headers).content == expected_original
        assert client.get(f"/api/v1/uploads/tasks/{task_id}", headers=headers).json()["status"] == "processing"

        retained = client.get(f"/api/v1/books/{book_id}/marks", headers=headers).json()
        assert len(retained) == 1 and retained[0]["id"] == note["id"]
        assert retained[0]["note"] == note["note"]
        assert retained[0]["position_valid"] is (kill_stage == "after_parse")
        new_note = None
        if kill_stage == "after_publish":
            key = client.get(f"/api/v1/books/{book_id}/reader", headers=headers).json()["toc"][0]["position_key"]
            position = {"reader_type": "epub", "position_key": key, "chapter_index": 1, "progress_percent": 30}
            moved = client.put(f"/api/v1/books/{book_id}/marks/{note['id']}/position", headers=headers, json=position)
            assert moved.status_code == 200 and moved.json()["position_valid"] is True
            new_note = client.post(f"/api/v1/books/{book_id}/marks", headers=headers,
                json={**position, "kind": "note", "note": "新版发布后新增的备注"}).json()

        # Advance the durable claim past the worker's stale-claim timeout, then retry.
        stale_time = (datetime.now(timezone.utc) - timedelta(hours=1)).replace(tzinfo=None).isoformat(sep=" ")
        with closing(sqlite3.connect(database_path)) as connection:
            connection.execute("UPDATE upload_tasks SET updated_at = ? WHERE id = ?", (stale_time, task_id))
            connection.commit()
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        assert client.get(f"/api/v1/uploads/tasks/{task_id}", headers=headers).json()["status"] == "ready"
        assert "恢复处理后的新版本" in client.get(
            f"/api/v1/books/{book_id}/reader/chapters/1", headers=headers
        ).json()["content"]
        recovered_marks = {item["id"]: item for item in client.get(f"/api/v1/books/{book_id}/marks", headers=headers).json()}
        assert recovered_marks[note["id"]]["note"] == note["note"]
        assert recovered_marks[note["id"]]["position_valid"] is (kill_stage == "after_publish")
        if new_note:
            assert recovered_marks[new_note["id"]] == new_note


def test_restored_backup_opens_referenced_book(tmp_path: Path) -> None:
    database_path = tmp_path / "books.sqlite3"
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{database_path.as_posix()}",
        seed_demo_data=True,
        storage_root=str(tmp_path / "storage"),
        upload_processing_mode="worker",
    )
    original_epub = make_minimal_epub_bytes(chapter_text="备份恢复后可以打开的正文")
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        uploaded = client.post(
            "/api/v1/uploads/books",
            headers=headers,
            files={"file": ("backup.epub", BytesIO(original_epub), "application/epub+zip")},
        )
        assert uploaded.status_code == 200
        book_id = uploaded.json()["book_id"]
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        with client.app.state.db_session_factory() as session:
            backup = create_backup(session=session, settings=settings)

    with closing(sqlite3.connect(database_path)) as connection:
        connection.execute("UPDATE books SET title = ? WHERE id = ?", ("corrupted title", book_id))
        original_path = connection.execute("SELECT original_file_path FROM books WHERE id = ?", (book_id,)).fetchone()[0]
        connection.commit()
    (Path(settings.storage_root) / original_path).write_bytes(b"corrupted file")

    run_offline_restore(backup_file=get_backup_root(settings) / backup.filename, confirmation="RESTORE", settings=settings)
    assert validate_referenced_storage(database_path, Path(settings.storage_root)) > 0
    with TestClient(create_app(settings)) as restored_client:
        login = restored_client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        assert restored_client.get(f"/api/v1/files/books/{book_id}/original", headers=headers).content == original_epub
        chapter = restored_client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=headers)
        assert chapter.status_code == 200
        assert "备份恢复后可以打开的正文" in chapter.json()["content"]


def test_reprocess_epub_does_not_overwrite_manually_edited_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    # The embedded EPUB metadata must not clobber manual edits when reprocessing.
    epub_bytes = make_minimal_epub_bytes(
        author="内嵌作者",
        chapter_text="嵌入元数据的正文。",
        description="内嵌简介",
        title="内嵌标题",
    )
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("embedded-metadata.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    patch_response = client.patch(
        f"/api/v1/books/{book_id}",
        headers=auth_headers,
        json={"title": "手动书名", "author": "手动作者", "description": "手动简介"},
    )
    assert patch_response.status_code == 200

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200

    task_response = client.get(f"/api/v1/uploads/tasks/{reprocess_response.json()['task_id']}", headers=auth_headers)
    assert task_response.status_code == 200
    assert task_response.json()["status"] == "ready"

    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.status_code == 200
    book_payload = book_response.json()
    assert book_payload["status"] == "ready"
    assert book_payload["title"] == "手动书名"
    assert book_payload["author"] == "手动作者"
    assert book_payload["description"] == "手动简介"


def test_failed_reprocess_keeps_previous_parsed_chapters(client: TestClient, auth_headers: dict[str, str]) -> None:
    original = make_minimal_epub_bytes(chapter_text="重新解析失败后保留的正文")
    uploaded = client.post(
        "/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("original.epub", BytesIO(original), "application/epub+zip")},
    )
    book_id = uploaded.json()["book_id"]
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    original_path = Path(client.app.state.settings.storage_root) / "originals" / user_id / book_id / "original.epub"
    original_path.write_bytes(b"not a valid EPUB")

    reprocess = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess.status_code == 200
    task = client.get(f"/api/v1/uploads/tasks/{reprocess.json()['task_id']}", headers=auth_headers).json()
    assert task["status"] == "failed"
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["status"] == "ready"
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter.status_code == 200
    assert "重新解析失败后保留的正文" in chapter.json()["content"]


def test_reprocess_worker_kill_keeps_old_chapters_until_retry(tmp_path: Path) -> None:
    database_path = tmp_path / "books.sqlite3"
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{database_path.as_posix()}", seed_demo_data=True,
        storage_root=str(tmp_path / "storage"), upload_processing_mode="external",
    )
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        owner_id = client.get("/api/v1/auth/me", headers=headers).json()["id"]
        uploaded = client.post(
            "/api/v1/uploads/books", headers=headers,
            files={"file": ("original.epub", BytesIO(make_minimal_epub_bytes(chapter_text="旧解析正文")), "application/epub+zip")},
        )
        book_id = uploaded.json()["book_id"]
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        original_path = Path(settings.storage_root) / "originals" / owner_id / book_id / "original.epub"
        original_path.write_bytes(make_minimal_epub_bytes(chapter_text="重新解析后的正文"))
        reprocess = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=headers)
        assert reprocess.status_code == 200
        task_id = reprocess.json()["task_id"]
        marker = tmp_path / "parsed.marker"
        script = """
import sys, time
from pathlib import Path
from app.core.config import Settings
from app.core.database import create_database_engine, create_session_factory
import app.modules.uploads.service as service
from app.modules.uploads.worker import process_next_upload_task
database, storage, marker = sys.argv[1:]
settings = Settings(database_url=f"sqlite+pysqlite:///{database}", storage_root=storage, upload_processing_mode="external")
original = service.run_processor
def pause_after_parse(book, settings):
    result = original(book, settings)
    Path(marker).write_text("parsed", encoding="utf-8")
    while True:
        time.sleep(0.1)
service.run_processor = pause_after_parse
engine = create_database_engine(settings)
process_next_upload_task(settings=settings, session_factory=create_session_factory(engine))
"""
        worker = subprocess.Popen(
            [sys.executable, "-c", script, str(database_path), settings.storage_root, str(marker)],
            cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 30
            while not marker.exists() and worker.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if not marker.exists():
                stdout, stderr = worker.communicate(timeout=5) if worker.poll() is not None else (b"", b"")
                raise AssertionError(f"Reprocess did not reach parsed stage: {stdout!r} {stderr!r}")
        finally:
            if worker.poll() is None:
                worker.kill()
            worker.communicate(timeout=10)
        assert "旧解析正文" in client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=headers).json()["content"]
        assert client.get(f"/api/v1/books/{book_id}", headers=headers).json()["status"] == "ready"
        with closing(sqlite3.connect(database_path)) as connection:
            connection.execute(
                "UPDATE upload_tasks SET updated_at = ? WHERE id = ?",
                ((datetime.now(timezone.utc) - timedelta(hours=1)).replace(tzinfo=None).isoformat(sep=" "), task_id),
            )
            connection.commit()
        assert process_next_upload_task(settings=settings, session_factory=client.app.state.db_session_factory)
        assert client.get(f"/api/v1/uploads/tasks/{task_id}", headers=headers).json()["status"] == "ready"
        assert "重新解析后的正文" in client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=headers).json()["content"]


def test_reprocess_clears_stale_cover_when_new_parse_has_no_cover(client: TestClient, auth_headers: dict[str, str]) -> None:
    first_epub = make_minimal_epub_bytes(chapter_text="first version", cover_bytes=TINY_PNG_BYTES)
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("cover-then-none.epub", BytesIO(first_epub), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    original_path = Path(client.app.state.settings.storage_root) / "originals" / user_id / book_id / "original.epub"

    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.status_code == 200
    assert book_response.json()["cover_url"] == f"/api/v1/files/books/{book_id}/cover"
    assert client.get(f"/api/v1/files/books/{book_id}/cover", headers=auth_headers).status_code == 200

    original_path.write_bytes(make_minimal_epub_bytes(chapter_text="second version without cover"))
    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200

    task_response = client.get(f"/api/v1/uploads/tasks/{reprocess_response.json()['task_id']}", headers=auth_headers)
    assert task_response.status_code == 200
    assert task_response.json()["status"] == "ready"

    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.status_code == 200
    book_payload = book_response.json()
    assert book_payload["cover_url"] is None
    assert book_payload["status"] == "ready"
    assert book_payload["current_chapter"]
    assert client.get(f"/api/v1/files/books/{book_id}/cover", headers=auth_headers).status_code == 404

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert "second version without cover" in chapter_response.json()["content"]
    assert "first version" not in chapter_response.json()["content"]


def test_reprocess_requires_original_file(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/api/v1/uploads/books/b1/reprocess", headers=auth_headers)

    assert response.status_code == 400
    assert response.json()["detail"] == "Book has no original file to reprocess"


def test_deleted_uploaded_book_files_are_not_readable(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_minimal_epub_bytes(chapter_text="删除后不可读。", cover_bytes=TINY_PNG_BYTES)
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("delete-me.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    task_id = upload_response.json()["task_id"]
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    storage_root = Path(client.app.state.settings.storage_root)
    original_directory = storage_root / "originals" / user_id / book_id
    processed_directory = storage_root / "processed" / user_id / book_id

    assert original_directory.exists()
    assert processed_directory.exists()

    delete_response = client.delete(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert delete_response.status_code == 204
    assert not original_directory.exists()
    assert not processed_directory.exists()

    original_response = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers)
    assert original_response.status_code == 404

    cover_response = client.get(f"/api/v1/files/books/{book_id}/cover", headers=auth_headers)
    assert cover_response.status_code == 404

    task_response = client.get(f"/api/v1/uploads/tasks/{task_id}", headers=auth_headers)
    assert task_response.status_code == 404


def test_upload_rejects_unsupported_extension(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("bad.exe", BytesIO(b"bad"), "application/octet-stream")},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["error_code"] == "unsupported_format"

    task_id = response.json()["detail"]["task_id"]
    task_response = client.get(f"/api/v1/uploads/tasks/{task_id}", headers=auth_headers)
    assert task_response.status_code == 200
    assert task_response.json()["message"] == "不支持的文件格式"


def test_upload_rejects_declared_but_unimplemented_archive_formats(client: TestClient, auth_headers: dict[str, str]) -> None:
    for file_name in ("comic.rar", "comic.cbr", "novel.azw3"):
        response = client.post(
            "/api/v1/uploads/books",
            headers=auth_headers,
            files={"file": (file_name, BytesIO(b"not supported"), "application/octet-stream")},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["error_code"] == "unsupported_format"


def test_upload_accepts_mobi_comic_pages(client: TestClient, auth_headers: dict[str, str]) -> None:
    mobi_bytes = make_minimal_mobi_comic_bytes()

    response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("comic.mobi", BytesIO(mobi_bytes), "application/x-mobipocket-ebook")},
    )

    assert response.status_code == 200
    book_id = response.json()["book_id"]

    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.status_code == 200
    book_payload = book_response.json()
    assert book_payload["kind"] == "manga"
    assert book_payload["reader_type"] == "comic"
    assert book_payload["file_ext"] == ".mobi"
    assert book_payload["cover_url"] == f"/api/v1/files/books/{book_id}/cover"

    reader_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert reader_response.status_code == 200
    reader_payload = reader_response.json()
    assert reader_payload["reader_type"] == "comic"
    assert reader_payload["page_count"] == 1

    first_page_response = client.get(f"/api/v1/files/books/{book_id}/pages/1", headers=auth_headers)
    assert first_page_response.status_code == 200
    assert first_page_response.headers["content-type"] == "image/jpeg"
    assert first_page_response.content.startswith(b"\xff\xd8\xff")


def test_upload_accepts_gif_pages_inside_comic_zip(client: TestClient, auth_headers: dict[str, str]) -> None:
    archive_bytes = BytesIO()
    with ZipFile(archive_bytes, "w") as archive:
        archive.writestr("001.gif", TINY_PNG_BYTES)

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("comic.zip", BytesIO(archive_bytes.getvalue()), "application/zip")},
    )

    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    reader_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)

    assert reader_response.status_code == 200
    reader_payload = reader_response.json()
    assert reader_payload["reader_type"] == "comic"
    assert reader_payload["page_count"] == 1


def test_clear_completed_upload_tasks_keeps_books(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_minimal_epub_bytes(chapter_text="清理队列后书还在。")
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("clear-task.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]

    clear_response = client.delete("/api/v1/uploads/tasks/completed", headers=auth_headers)

    assert clear_response.status_code == 200
    assert clear_response.json()["deleted"] >= 1
    task_response = client.get(f"/api/v1/uploads/tasks/{upload_response.json()['task_id']}", headers=auth_headers)
    assert task_response.status_code == 404
    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.status_code == 200
    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert "清理队列后书还在。" in chapter_response.json()["content"]


def test_upload_fails_and_cleans_processed_files_when_archive_asset_limit_is_exceeded(tmp_path: Path) -> None:
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        max_processed_assets_per_book=1,
        seed_demo_data=True,
        storage_root=str(tmp_path / "storage"),
    )
    with TestClient(create_app(settings)) as limited_client:
        login_response = limited_client.post("/api/v1/auth/login", json={"email": "admin@aisu.local", "password": "aisu-demo-password"})
        headers = {"Authorization": f"Bearer {login_response.json()['access_token']}"}
        user_id = limited_client.get("/api/v1/auth/me", headers=headers).json()["id"]

        archive_bytes = BytesIO()
        with ZipFile(archive_bytes, "w") as archive:
            archive.writestr("001.png", TINY_PNG_BYTES)
            archive.writestr("002.png", TINY_PNG_BYTES)

        upload_response = limited_client.post(
            "/api/v1/uploads/books",
            headers=headers,
            files={"file": ("too-many-pages.zip", BytesIO(archive_bytes.getvalue()), "application/zip")},
        )

        assert upload_response.status_code == 200
        book_id = upload_response.json()["book_id"]
        task_id = upload_response.json()["task_id"]

        task_response = limited_client.get(f"/api/v1/uploads/tasks/{task_id}", headers=headers)
        book_response = limited_client.get(f"/api/v1/books/{book_id}", headers=headers)
        processed_directory = Path(settings.storage_root) / "processed" / user_id / book_id

    assert task_response.status_code == 200
    assert task_response.json()["status"] == "failed"
    assert task_response.json()["error_code"] == "processing_failed"
    assert book_response.status_code == 200
    assert book_response.json()["status"] == "failed"
    assert not processed_directory.exists()
