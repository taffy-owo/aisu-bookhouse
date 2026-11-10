from io import BytesIO
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile

from fastapi.testclient import TestClient
from sqlalchemy import func, select

import app.modules.uploads.service as upload_service
import app.modules.uploads.worker as upload_worker
from app.modules.book_assets.models import BookAssetRecord
from app.modules.book_assets.repository import create_book_asset
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.uploads.models import UploadTaskRecord
from app.modules.uploads.worker import process_next_upload_task
from tests.test_uploads import make_minimal_epub_bytes


def test_external_upload_worker_processes_next_task(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    epub_bytes = make_minimal_epub_bytes(chapter_text="由 worker 解析的正文。")

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("worker.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )

    assert upload_response.status_code == 200
    payload = upload_response.json()
    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    assert task_response.json()["status"] == "processing"
    # Until the external worker parsed the file the book itself must stay in
    # "processing" so the frontend does not offer an unreadable "ready" book.
    book_response = client.get(f"/api/v1/books/{payload['book_id']}", headers=auth_headers)
    assert book_response.json()["status"] == "processing"

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is True
    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    assert task_response.json()["status"] == "ready"
    book_response = client.get(f"/api/v1/books/{payload['book_id']}", headers=auth_headers)
    assert book_response.json()["status"] == "ready"
    chapter_response = client.get(f"/api/v1/books/{payload['book_id']}/reader/chapters/1", headers=auth_headers)
    assert "由 worker 解析的正文。" in chapter_response.json()["content"]


def test_external_upload_worker_repairs_bare_ampersand_in_epub_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    epub_bytes = make_minimal_epub_bytes(
        chapter_text="带有瑕疵元数据的 EPUB 正文仍应可读。",
        description="作品页：https://example.test/book?shop=0&pid=123",
    )

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("bare-ampersand.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    payload = upload_response.json()

    assert process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory) is True
    task_payload = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers).json()
    book_payload = client.get(f"/api/v1/books/{payload['book_id']}", headers=auth_headers).json()

    assert task_payload["status"] == "ready"
    assert book_payload["status"] == "ready"
    assert book_payload["reader_type"] == "epub"
    chapter_response = client.get(f"/api/v1/books/{payload['book_id']}/reader/chapters/1", headers=auth_headers)
    assert "带有瑕疵元数据的 EPUB 正文仍应可读。" in chapter_response.json()["content"]


def test_external_upload_worker_imports_all_models_before_processing(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: object
) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("worker.epub", BytesIO(make_minimal_epub_bytes()), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    imported_models = False

    def remember_model_imports() -> None:
        nonlocal imported_models
        imported_models = True

    monkeypatch.setattr(upload_worker, "import_model_modules", remember_model_imports)

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is True
    assert imported_models is True


def test_external_upload_worker_recovers_session_after_processing_commit_failure(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: object
) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("broken.epub", BytesIO(make_minimal_epub_bytes()), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    payload = upload_response.json()

    def fail_during_processing_commit(**kwargs: object) -> object:
        book = kwargs["book"]
        book_repository = kwargs["book_repository"]
        return book_repository.save(book.with_changes(public_moderated_by="missing-user"))

    monkeypatch.setattr(upload_service, "process_uploaded_book", fail_during_processing_commit)

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is True
    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    task_payload = task_response.json()
    assert task_payload["status"] == "failed"
    assert task_payload["error_code"] == "processing_failed"


def test_external_upload_worker_marks_task_failed_when_book_is_unavailable(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("deleted-before-worker.epub", BytesIO(make_minimal_epub_bytes()), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    payload = upload_response.json()
    owner_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    with client.app.state.db_session_factory() as session:
        book_repository = SqlAlchemyBookRepository(session)
        book = book_repository.get_owned(owner_id, payload["book_id"])
        assert book is not None
        book_repository.save(book.with_changes(status="deleted"))

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is True
    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    task_payload = task_response.json()
    assert task_payload["status"] == "failed"
    assert task_payload["error_code"] == "book_not_found"


def test_external_upload_worker_marks_orphan_processing_task_failed(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    owner_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    now = datetime.now(timezone.utc)
    with client.app.state.db_session_factory() as session:
        session.add(
            UploadTaskRecord(
                id="orphan-processing-task",
                user_id=owner_id,
                book_id=None,
                file_name="orphan.epub",
                file_type="EPUB",
                file_size=10,
                status="processing",
                progress=72,
                message="lost book id",
                error_code=None,
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is True
    task_response = client.get("/api/v1/uploads/tasks/orphan-processing-task", headers=auth_headers)
    assert task_response.status_code == 200
    task_payload = task_response.json()
    assert task_payload["status"] == "failed"
    assert task_payload["error_code"] == "book_not_found"
    assert task_payload["progress"] == 0


def test_external_upload_worker_clears_asset_records_after_mid_processing_failure(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: object
) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("asset-cleanup.epub", BytesIO(make_minimal_epub_bytes()), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    payload = upload_response.json()
    owner_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    processed_directory = Path(client.app.state.settings.storage_root) / "processed" / owner_id / payload["book_id"]

    def save_asset_then_fail(**kwargs: object) -> object:
        book = kwargs["book"]
        asset_repository = kwargs["asset_repository"]
        processed_directory.mkdir(parents=True, exist_ok=True)
        (processed_directory / "chapter.txt").write_text("partial asset", encoding="utf-8")
        asset_repository.save(
            create_book_asset(
                asset_type="text_chapter",
                book_id=book.id,
                index=1,
                metadata={"title": "partial"},
                path=f"processed/{owner_id}/{book.id}/chapter.txt",
            )
        )
        raise RuntimeError("simulated processor failure after saving an asset")

    monkeypatch.setattr(upload_service, "process_uploaded_book", save_asset_then_fail)

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is True
    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    assert task_response.json()["status"] == "failed"
    assert not processed_directory.exists()
    with client.app.state.db_session_factory() as session:
        asset_count = session.scalar(select(func.count()).select_from(BookAssetRecord).where(BookAssetRecord.book_id == payload["book_id"]))
    assert asset_count == 0


def test_external_upload_worker_returns_false_without_tasks(client: TestClient) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)

    assert processed is False


def test_external_upload_worker_applies_embedded_metadata_on_initial_upload(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    epub_bytes = make_minimal_epub_bytes(
        author="内嵌作者",
        chapter_text="初次上传的正文。",
        description="内嵌简介",
        title="内嵌标题",
    )

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("raw-file-name.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    # Before the worker runs the book only carries the filename-derived defaults.
    book_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book_response.json()["title"] == "raw-file-name"

    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)
    assert processed is True

    # Initial uploads keep extracting embedded metadata (the user typed nothing).
    book_payload = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert book_payload["status"] == "ready"
    assert book_payload["title"] == "内嵌标题"
    assert book_payload["author"] == "内嵌作者"
    assert book_payload["description"] == "内嵌简介"


def test_external_upload_worker_reprocess_preserves_manual_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )
    epub_bytes = make_minimal_epub_bytes(
        author="内嵌作者",
        chapter_text="重解析也不覆盖手动元数据。",
        description="内嵌简介",
        title="内嵌标题",
    )

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("worker-reprocess.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    assert process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory) is True

    patch_response = client.patch(
        f"/api/v1/books/{book_id}",
        headers=auth_headers,
        json={"title": "手动书名", "author": "手动作者", "description": "手动简介"},
    )
    assert patch_response.status_code == 200

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    reprocess_task_id = reprocess_response.json()["task_id"]

    assert process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory) is True

    task_payload = client.get(f"/api/v1/uploads/tasks/{reprocess_task_id}", headers=auth_headers).json()
    assert task_payload["status"] == "ready"

    # The reprocess task ran through the external worker without clobbering manual edits.
    book_payload = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert book_payload["status"] == "ready"
    assert book_payload["title"] == "手动书名"
    assert book_payload["author"] == "手动作者"
    assert book_payload["description"] == "手动简介"

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert "重解析也不覆盖手动元数据。" in chapter_response.json()["content"]


def make_entity_expansion_epub_bytes() -> bytes:
    malicious_opf = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE package [
  <!ENTITY lol "lol">
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&lol3;</dc:title></metadata>
  <manifest /><spine />
</package>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>'
            "</container>",
        )
        archive.writestr("OPS/content.opf", malicious_opf)
    return buffer.getvalue()


def test_external_upload_worker_rejects_entity_expansion_epub(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.app.state.settings = client.app.state.settings.__class__(
        database_url=client.app.state.settings.database_url,
        seed_demo_data=client.app.state.settings.seed_demo_data,
        storage_root=client.app.state.settings.storage_root,
        upload_processing_mode="external",
    )

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("billion-laughs.epub", BytesIO(make_entity_expansion_epub_bytes()), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    payload = upload_response.json()

    # defusedxml must reject the entity bomb so the worker degrades gracefully instead of expanding it.
    processed = process_next_upload_task(settings=client.app.state.settings, session_factory=client.app.state.db_session_factory)
    assert processed is True

    task_response = client.get(f"/api/v1/uploads/tasks/{payload['task_id']}", headers=auth_headers)
    assert task_response.json()["status"] == "failed"
