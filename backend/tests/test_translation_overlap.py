"""Cross-workflow source identity and publication regressions."""

import asyncio
from uuid import uuid4
import pytest
from fastapi import HTTPException

from sqlalchemy import select

from app.modules.book_assets.models import BookAssetRecord
from app.modules.books.models import BookRecord
from app.modules.translations import service
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from test_translation_v2_production import prepare, FakeStageClient
from test_whole_book_translation import make_source_metadata


def test_external_append_blocks_old_web_review_without_new_model_calls(
    client, auth_headers, monkeypatch
):
    book_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    asyncio.run(
        service.process_translation_job(
            job_id=book_id,
            settings=settings,
            session_factory=sessions,
            lease_owner="v2-test-lease",
        )
    )
    update_id = str(uuid4())
    with sessions() as db:
        original = db.get(Job, book_id)
        values = {
            column.name: getattr(original, column.name)
            for column in Job.__table__.columns
        }
        metadata = make_source_metadata().model_dump(mode="json")
        metadata["episodes"][0]["index"] = 2
        metadata["episodes"][0]["url"] += "2"
        url = metadata["episodes"][0]["url"]
        values.update(
            id=update_id,
            job_kind="source_update",
            book_id=book_id,
            status="processing",
            stage="queued",
            metadata_json=metadata,
            catalog_json=metadata["episodes"],
            quality_report_json={},
            memory_json={},
            progress=0,
            completed_chapters=0,
            lease_owner="update-lease",
            finished_at=None,
        )
        db.add(Job(**values))
        book = db.get(BookRecord, book_id)
        book.source_pending_episode_indexes, book.source_update_count = [2], 1
        db.commit()
    # Let the web worker finish its draft. It awaits user acceptance.
    asyncio.run(
        service.process_translation_job(
            job_id=update_id,
            settings=settings,
            session_factory=sessions,
            lease_owner="update-lease",
        )
    )
    with sessions() as db:
        assert db.get(Job, update_id).status == "review"
    token = client.post(
        "/api/v1/auth/api-tokens",
        headers=auth_headers,
        json={
            "name": "temporary overlap diagnostic",
            "permissions": ["book_read", "book_append"],
            "book_id": book_id,
        },
    ).json()["token"]
    external_headers = {"Authorization": "Bearer " + token}
    state = client.get(
        f"/api/v1/books/{book_id}/continuation", headers=external_headers
    ).json()
    payload = {
        "request_id": str(uuid4()),
        "expected_revision": state["revision"],
        "chapters": [
            {
                "title": "第2话 外部译文",
                "content": "外部工具完成的另一份译文。\n\n这是第二段正文。",
                "source_url": url,
            }
        ],
    }
    response = client.post(
        f"/api/v1/books/{book_id}/continuation", headers=external_headers, json=payload
    )
    assert response.status_code == 200, response.text
    # External API deduplication itself works on a second append.
    state = client.get(
        f"/api/v1/books/{book_id}/continuation", headers=external_headers
    ).json()
    payload.update(request_id=str(uuid4()), expected_revision=state["revision"])
    assert (
        client.post(
            f"/api/v1/books/{book_id}/continuation",
            headers=external_headers,
            json=payload,
        ).status_code
        == 409
    )
    # The old review must stop before approving or translating anything again.
    FakeStageClient.calls = []
    with sessions() as db:
        job = db.get(Job, update_id)
        with pytest.raises(HTTPException) as caught:
            service.accept_source_update_translation(
                job.user_id, update_id, db, settings
            )
        assert caught.value.status_code == 409
        assert caught.value.detail["error_code"] == "source_chapters_already_published"
    with sessions() as db:
        job = db.get(Job, update_id)
        assert job.status == "review"
        chapters = list(
            db.scalars(
                select(BookAssetRecord).where(
                    BookAssetRecord.book_id == book_id,
                    BookAssetRecord.asset_type == "text_chapter",
                )
            )
        )
        duplicate = [
            c for c in chapters if c.metadata_json.get("source_episode_url") == url
        ]
        assert len(duplicate) == 1
    assert FakeStageClient.calls == []


def update_task(client, auth_headers, monkeypatch, status="paused", lease=None):
    book_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    asyncio.run(
        service.process_translation_job(
            job_id=book_id,
            settings=settings,
            session_factory=sessions,
            lease_owner="v2-test-lease",
        )
    )
    with sessions() as db:
        original = db.get(Job, book_id)
        values = {
            column.name: getattr(original, column.name)
            for column in Job.__table__.columns
        }
        metadata = make_source_metadata().model_dump(mode="json")
        metadata["episodes"][0]["index"] = 2
        metadata["episodes"][0]["url"] += "2"
        jid = str(uuid4())
        values.update(
            id=jid,
            job_kind="source_update",
            book_id=book_id,
            status=status,
            stage=status,
            metadata_json=metadata,
            catalog_json=metadata["episodes"],
            quality_report_json={},
            memory_json={},
            progress=0,
            completed_chapters=0,
            lease_owner=lease,
            lease_expires_at=None,
            finished_at=None,
        )
        db.add(Job(**values))
        db.commit()
    return book_id, jid, metadata["episodes"][0]["url"], sessions, settings


def append_external(
    client, headers, book_id, url, content="外部译文第一段。\n\n外部译文第二段。"
):
    state = client.get(f"/api/v1/books/{book_id}/continuation", headers=headers).json()
    return client.post(
        f"/api/v1/books/{book_id}/continuation",
        headers=headers,
        json={
            "request_id": str(uuid4()),
            "expected_revision": state["revision"],
            "chapters": [{"title": "第2话", "content": content, "source_url": url}],
        },
    )


@pytest.mark.parametrize(
    "status,lease",
    [
        ("queued", None),
        ("processing", "worker"),
        ("waiting_quota", "backoff"),
        ("paused", "worker"),
    ],
)
def test_external_cannot_race_live_or_unreleased_worker(
    client, auth_headers, monkeypatch, status, lease
):
    bid, jid, url, sessions, settings = update_task(
        client, auth_headers, monkeypatch, status, lease
    )
    result = append_external(client, auth_headers, bid, url + "/#fragment")
    assert result.status_code == 409, result.text
    assert result.json()["detail"]["error_code"] == "translation_in_progress"
    result = client.post(f"/api/v1/uploads/books/{bid}/reprocess", headers=auth_headers)
    assert (
        result.status_code == 409
        and result.json()["detail"]["error_code"] == "translation_in_progress"
    )


@pytest.mark.parametrize("action,status", [("retry", "failed"), ("resume", "paused")])
def test_old_retry_and_resume_reject_already_published_source(
    client, auth_headers, monkeypatch, action, status
):
    bid, jid, url, sessions, settings = update_task(
        client, auth_headers, monkeypatch, status
    )
    assert append_external(client, auth_headers, bid, url).status_code == 200
    FakeStageClient.calls = []
    response = client.post(f"/api/v1/translations/{jid}/{action}", headers=auth_headers)
    assert response.status_code == 409, response.text
    assert (
        response.json()["detail"]["error_code"] == "source_chapters_already_published"
    )
    with sessions() as db:
        assert db.get(Job, jid).status == status
    assert FakeStageClient.calls == []


def test_worker_preflight_stops_stale_queued_job_without_model_calls(
    client, auth_headers, monkeypatch
):
    bid, jid, url, sessions, settings = update_task(client, auth_headers, monkeypatch)
    assert append_external(client, auth_headers, bid, url).status_code == 200
    with sessions() as db:
        db.get(Job, jid).status = "queued"
        db.commit()
    assert service.claim_next_translation_job(sessions, "stale-lease") == jid
    FakeStageClient.calls = []
    asyncio.run(
        service.process_translation_job(
            job_id=jid,
            settings=settings,
            session_factory=sessions,
            lease_owner="stale-lease",
        )
    )
    with sessions() as db:
        job = db.get(Job, jid)
        assert job.status == "paused" and job.stage == "source_conflict"
        assert not job.lease_owner
    assert FakeStageClient.calls == []


def test_final_native_publication_and_epub_writer_refuse_duplicate_source(
    client, auth_headers, monkeypatch
):
    from app.modules.translation_v2.publication import publish
    from app.modules.translation_v2.pilot import TrialError
    from app.modules.translations.epub import append_translation_epub
    from pathlib import Path

    bid, jid, url, sessions, settings = update_task(client, auth_headers, monkeypatch)
    assert append_external(client, auth_headers, bid, url).status_code == 200
    with sessions() as db:
        job = db.get(Job, jid)
        job.status = "processing"
        job.quality_report_json = {"_v2_publication_approved": True}
        db.commit()
        original = Path(
            settings.storage_root, db.get(BookRecord, bid).original_file_path
        ).read_bytes()
    with pytest.raises(TrialError, match="source_publication_conflict"):
        publish(
            job_id=jid,
            lease_owner=None,
            chapters=[],
            metadata=None,
            settings=settings,
            session_factory=sessions,
            guard=lambda: None,
        )
    with pytest.raises(ValueError, match="Source chapter already exists"):
        append_translation_epub(
            original_epub=original,
            chapters=[
                {
                    "index": 2,
                    "title": "另一译名",
                    "source_url": url + "/#fragment",
                    "paragraphs": ["完全不同的另一份译文。"],
                }
            ],
        )


@pytest.mark.parametrize(
    "status,lease,code",
    [
        ("processing", "worker", "translation_in_progress"),
        ("paused", None, "translation_batch_pending"),
        ("failed", None, "translation_batch_pending"),
    ],
)
def test_external_cannot_jump_over_an_unfinished_batch_in_same_book(
    client, auth_headers, monkeypatch, status, lease, code
):
    bid, jid, url, sessions, settings = update_task(
        client, auth_headers, monkeypatch, status, lease
    )
    result = append_external(client, auth_headers, bid, url + "different")
    assert result.status_code == 409, result.text
    assert result.json()["detail"]["error_code"] == code
    manual = client.post(
        f"/api/v1/books/{bid}/chapters",
        headers=auth_headers,
        json={"title": "手工备注", "content": "待审期间保留用户主动追加备注的能力。"},
    )
    assert manual.status_code == (409 if status == "processing" else 200), manual.text


def test_active_translation_in_other_book_does_not_block_external_write(
    client, auth_headers, monkeypatch
):
    from test_external_publication import upload, SOURCE

    update_task(client, auth_headers, monkeypatch, "processing", "worker")
    second = upload(client, auth_headers)
    result = append_external(client, auth_headers, second, SOURCE + "/episodes/2")
    assert result.status_code == 200, result.text


def test_external_project_and_native_whole_book_share_source_reservation(
    client, auth_headers, monkeypatch
):
    from app.modules.agent import api as agent_api
    from test_whole_book_translation import configure_translation_provider

    configure_translation_provider(client, auth_headers)

    async def metadata(*args, **kwargs):
        return make_source_metadata()

    monkeypatch.setattr(agent_api, "fetch_work_source_metadata", metadata)
    monkeypatch.setattr(service, "fetch_work_source_metadata", metadata)
    payload = {
        "request_id": str(uuid4()),
        "source_url": make_source_metadata().source_url,
    }
    first = client.post("/api/v1/agent/projects", headers=auth_headers, json=payload)
    assert first.status_code == 200, first.text
    assert (
        client.post(
            "/api/v1/agent/projects", headers=auth_headers, json=payload
        ).json()["id"]
        == first.json()["id"]
    )
    second = client.post(
        "/api/v1/agent/projects",
        headers=auth_headers,
        json={**payload, "request_id": str(uuid4())},
    )
    assert (
        second.status_code == 409
        and second.json()["detail"]["error_code"] == "source_project_exists"
    )
    response = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={
            "source_url": make_source_metadata().source_url,
            "model": "literary-model",
        },
    )
    assert (
        response.status_code == 409
        and response.json()["detail"]["error_code"] == "source_project_exists"
    )


def test_published_book_prevents_accidental_second_full_translation(
    client, auth_headers, monkeypatch
):
    from app.modules.agent import api as agent_api

    bid, jid, url, sessions, settings = update_task(client, auth_headers, monkeypatch)

    async def metadata(*args, **kwargs):
        return make_source_metadata()

    monkeypatch.setattr(agent_api, "fetch_work_source_metadata", metadata)
    response = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={
            "source_url": make_source_metadata().source_url,
            "model": "literary-model",
        },
    )
    assert (
        response.status_code == 409
        and response.json()["detail"]["error_code"] == "source_book_exists"
    )
    response = client.post(
        "/api/v1/agent/projects",
        headers=auth_headers,
        json={
            "request_id": str(uuid4()),
            "source_url": make_source_metadata().source_url,
        },
    )
    assert (
        response.status_code == 409
        and response.json()["detail"]["error_code"] == "source_book_exists"
    )


def test_two_api_writers_cannot_publish_same_source_concurrently(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from fastapi.testclient import TestClient
    from app.core.config import Settings
    from app.main import create_app

    settings = Settings(
        database_url=f"sqlite+pysqlite:///{(tmp_path / 'parallel.db').as_posix()}",
        seed_demo_data=True,
        storage_root=str(tmp_path / "storage"),
    )
    with TestClient(create_app(settings)) as client:
        auth_headers = {
            "Authorization": "Bearer "
            + client.post(
                "/api/v1/auth/login",
                json={"email": "admin@aisu.local", "password": "aisu-demo-password"},
            ).json()["access_token"]
        }
        _parallel_append(client, auth_headers, monkeypatch, ThreadPoolExecutor, Barrier)


def _parallel_append(client, auth_headers, monkeypatch, ThreadPoolExecutor, Barrier):
    bid, jid, url, sessions, settings = update_task(client, auth_headers, monkeypatch)
    state = client.get(f"/api/v1/books/{bid}/continuation", headers=auth_headers).json()
    barrier = Barrier(2)

    def submit(index):
        barrier.wait(timeout=10)
        return client.post(
            f"/api/v1/books/{bid}/continuation",
            headers=auth_headers,
            json={
                "request_id": str(uuid4()),
                "expected_revision": state["revision"],
                "chapters": [
                    {
                        "title": "第2话",
                        "content": f"第{index}份独立译文。",
                        "source_url": url,
                    }
                ],
            },
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(submit, [1, 2])) == [200, 409]
    with sessions() as db:
        chapters = list(
            db.scalars(
                select(BookAssetRecord).where(
                    BookAssetRecord.book_id == bid,
                    BookAssetRecord.asset_type == "text_chapter",
                )
            )
        )
        assert (
            sum(a.metadata_json.get("source_episode_url") == url for a in chapters) == 1
        )


def test_native_task_prevents_new_external_whole_book_project(
    client, auth_headers, monkeypatch
):
    from app.modules.agent import api as agent_api

    bid, sessions, settings = prepare(client, auth_headers, monkeypatch)

    async def metadata(*args, **kwargs):
        return make_source_metadata()

    monkeypatch.setattr(agent_api, "fetch_work_source_metadata", metadata)
    response = client.post(
        "/api/v1/agent/projects",
        headers=auth_headers,
        json={
            "request_id": str(uuid4()),
            "source_url": make_source_metadata().source_url,
        },
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["error_code"] == "source_translation_exists"


def test_partial_coverage_stops_entire_retry_without_discarding_unpublished_chapter(
    client, auth_headers, monkeypatch
):
    bid, jid, url, sessions, settings = update_task(
        client, auth_headers, monkeypatch, "failed"
    )
    with sessions() as db:
        job = db.get(Job, jid)
        third = {**job.catalog_json[0], "index": 3, "title": "第3話", "url": url + "3"}
        job.catalog_json = [*job.catalog_json, third]
        job.metadata_json = {**job.metadata_json, "episodes": job.catalog_json}
        job.total_chapters = 2
        db.commit()
    assert append_external(client, auth_headers, bid, url).status_code == 200
    response = client.post(f"/api/v1/translations/{jid}/retry", headers=auth_headers)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["source_indexes"] == [2]
    with sessions() as db:
        job = db.get(Job, jid)
        assert (
            len(job.catalog_json) == 2
            and job.total_chapters == 2
            and job.status == "failed"
        )


def test_source_reservation_serializes_native_and_external_creation(
    tmp_path, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from fastapi.testclient import TestClient
    from app.core.config import Settings
    from app.main import create_app
    from app.modules.agent import api as agent_api
    from app.modules.agent.models import AgentProjectRecord
    from test_whole_book_translation import configure_translation_provider

    settings = Settings(
        database_url=f"sqlite+pysqlite:///{(tmp_path / 'source-lock.db').as_posix()}",
        seed_demo_data=True,
        storage_root=str(tmp_path / "source-storage"),
    )
    barrier = Barrier(2)

    async def metadata(*args, **kwargs):
        await asyncio.to_thread(barrier.wait, 10)
        return make_source_metadata()

    monkeypatch.setattr(agent_api, "fetch_work_source_metadata", metadata)
    monkeypatch.setattr(service, "fetch_work_source_metadata", metadata)
    with TestClient(create_app(settings)) as client:
        headers = {
            "Authorization": "Bearer "
            + client.post(
                "/api/v1/auth/login",
                json={"email": "admin@aisu.local", "password": "aisu-demo-password"},
            ).json()["access_token"]
        }
        configure_translation_provider(client, headers)

        def submit(kind):
            if kind == "native":
                return client.post(
                    "/api/v1/translations",
                    headers=headers,
                    json={
                        "source_url": make_source_metadata().source_url,
                        "model": "literary-model",
                    },
                ).status_code
            return client.post(
                "/api/v1/agent/projects",
                headers=headers,
                json={
                    "request_id": str(uuid4()),
                    "source_url": make_source_metadata().source_url,
                },
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(submit, ["native", "external"]))
        assert (
            statuses.count(409) == 1 and sum(s in {200, 202} for s in statuses) == 1
        ), statuses
        with client.app.state.db_session_factory() as db:
            assert (
                len(list(db.scalars(select(Job))))
                + len(list(db.scalars(select(AgentProjectRecord))))
                == 1
            )


def test_final_commit_rechecks_source_after_epub_processing(
    client, auth_headers, monkeypatch
):
    from app.modules.translation_v2 import publication
    from app.modules.translation_v2.pilot import TrialError
    from app.modules.uploads.schemas import WorkSourceMetadata

    bid, jid, url, sessions, settings = update_task(client, auth_headers, monkeypatch)
    with sessions() as db:
        job = db.get(Job, jid)
        job.status = "processing"
        job.quality_report_json = {"_v2_publication_approved": True}
        metadata = WorkSourceMetadata.model_validate(job.metadata_json)
        old_path = db.get(BookRecord, bid).original_file_path
        db.commit()
    verify = publication.verify_epub

    def concurrent_publication(*args, **kwargs):
        result = verify(*args, **kwargs)
        with sessions() as db:
            asset = db.scalar(
                select(BookAssetRecord).where(
                    BookAssetRecord.book_id == bid,
                    BookAssetRecord.asset_type == "text_chapter",
                )
            )
            asset.metadata_json = {**asset.metadata_json, "source_episode_url": url}
            db.commit()
        return result

    monkeypatch.setattr(publication, "verify_epub", concurrent_publication)
    with pytest.raises(TrialError, match="source_publication_conflict"):
        publication.publish(
            job_id=jid,
            lease_owner=None,
            chapters=[
                {
                    "index": 2,
                    "title": "第2话",
                    "source_url": url,
                    "paragraphs": ["稍后的译文。"],
                }
            ],
            metadata=metadata,
            settings=settings,
            session_factory=sessions,
            guard=lambda: None,
        )
    with sessions() as db:
        assert db.get(BookRecord, bid).original_file_path == old_path
        assert (
            len(
                list(
                    db.scalars(
                        select(BookAssetRecord).where(
                            BookAssetRecord.book_id == bid,
                            BookAssetRecord.asset_type == "text_chapter",
                        )
                    )
                )
            )
            == 1
        )


def test_external_project_pause_releases_work_and_resume_rechecks_reservation(
    client, auth_headers, monkeypatch
):
    from app.modules.agent import api as agent_api
    from test_whole_book_translation import configure_translation_provider

    configure_translation_provider(client, auth_headers)

    async def metadata(*args, **kwargs):
        return make_source_metadata()

    monkeypatch.setattr(agent_api, "fetch_work_source_metadata", metadata)
    monkeypatch.setattr(service, "fetch_work_source_metadata", metadata)
    token = client.post(
        "/api/v1/auth/api-tokens",
        headers=auth_headers,
        json={"name": "external importer", "permissions": ["book_import"]},
    ).json()["token"]
    headers = {"Authorization": "Bearer " + token}
    response = client.post(
        "/api/v1/agent/projects",
        headers=headers,
        json={
            "request_id": str(uuid4()),
            "source_url": make_source_metadata().source_url,
        },
    )
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    pause = client.post(f"/api/v1/agent/projects/{pid}/pause", headers=headers)
    assert pause.status_code == 200 and pause.json()["status"] == "paused", pause.text
    assert (
        client.post(
            f"/api/v1/agent/projects/{pid}/publish", headers=headers
        ).status_code
        == 409
    )
    resumed = client.post(f"/api/v1/agent/projects/{pid}/resume", headers=headers)
    assert resumed.status_code == 200 and resumed.json()["status"] == "draft", (
        resumed.text
    )
    assert (
        client.post(f"/api/v1/agent/projects/{pid}/pause", headers=headers).status_code
        == 200
    )
    native = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={
            "source_url": make_source_metadata().source_url,
            "model": "literary-model",
        },
    )
    assert native.status_code == 202, native.text
    response = client.post(f"/api/v1/agent/projects/{pid}/resume", headers=headers)
    assert (
        response.status_code == 409
        and response.json()["detail"]["error_code"] == "source_translation_exists"
    )


def test_existing_v2_job_keeps_its_engine_when_global_default_changes(
    client, auth_headers, monkeypatch
):
    from dataclasses import replace

    bid, sessions, settings = prepare(client, auth_headers, monkeypatch)
    FakeStageClient.fail_stage = "review"
    asyncio.run(
        service.process_translation_job(
            job_id=bid,
            settings=settings,
            session_factory=sessions,
            lease_owner="v2-test-lease",
        )
    )
    with sessions() as db:
        job = db.get(Job, bid)
        assert (
            job.status == "failed" and job.quality_report_json["_workflow_version"] == 2
        )
        job.status = "queued"
        job.lease_owner = None
        job.lease_expires_at = None
        db.commit()

    def legacy_executor():
        raise AssertionError("A saved V2 task must retain its V2 checkpoints")

    monkeypatch.setattr(service, "_legacy_job_executor", legacy_executor)
    FakeStageClient.fail_stage = None
    assert service.claim_next_translation_job(sessions, "resume-v2") == bid
    asyncio.run(
        service.process_translation_job(
            job_id=bid,
            settings=replace(settings, translation_engine="legacy"),
            session_factory=sessions,
            lease_owner="resume-v2",
        )
    )
    with sessions() as db:
        assert db.get(Job, bid).status == "ready"


def test_epub_append_repairs_duplicate_modified_metadata_without_changing_old_chapter():
    from io import BytesIO
    from zipfile import ZipFile
    from xml.etree import ElementTree as ET
    from app.modules.translations.epub import (
        build_translation_epub,
        append_translation_epub,
        OPF_NS,
    )

    original = build_translation_epub(
        title="测试",
        author="作者",
        description="",
        source_url="https://example.org/work",
        chapters=[{"index": 1, "title": "第一话", "paragraphs": ["保留原来的正文。"]}],
    )
    buffer = BytesIO()
    with ZipFile(BytesIO(original)) as source, ZipFile(buffer, "w") as target:
        before_chapter = source.read("OEBPS/chapters/0001.xhtml")
        for info in source.infolist():
            data = source.read(info)
            if info.filename == "OEBPS/content.opf":
                data = data.replace(
                    b"</metadata>",
                    b'<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata>',
                )
            target.writestr(info, data)
    updated = append_translation_epub(
        original_epub=buffer.getvalue(),
        chapters=[{"index": 2, "title": "第二话", "paragraphs": ["新的正文。"]}],
    )
    with ZipFile(BytesIO(updated)) as result:
        assert result.read("OEBPS/chapters/0001.xhtml") == before_chapter
        package = ET.fromstring(result.read("OEBPS/content.opf"))
        stamps = [
            m
            for m in package.findall(f"{{{OPF_NS}}}metadata/{{{OPF_NS}}}meta")
            if m.get("property") == "dcterms:modified"
        ]
        assert len(stamps) == 1 and stamps[0].text != "2000-01-01T00:00:00Z"


def test_accepted_v2_candidate_preserves_user_edits_and_multiple_notes_without_model_calls(
    client, auth_headers, monkeypatch
):
    bid, jid, url, sessions, settings = update_task(
        client, auth_headers, monkeypatch, "processing", "draft-lease"
    )
    asyncio.run(
        service.process_translation_job(
            job_id=jid,
            settings=settings,
            session_factory=sessions,
            lease_owner="draft-lease",
        )
    )
    for title, content in [
        ("用户备注一", "这份备注应保留在原书中。"),
        ("用户备注二", "第二份备注也应保留。"),
    ]:
        response = client.post(
            f"/api/v1/books/{bid}/chapters",
            headers=auth_headers,
            json={"title": title, "content": content},
        )
        assert response.status_code == 200, response.text
    response = client.put(
        f"/api/v1/books/{bid}/chapters/1",
        headers=auth_headers,
        json={"title": "第一话", "content": "人工校订后的正文。\n\n保留用户的新修改。"},
    )
    assert response.status_code == 200, response.text
    accepted = client.post(f"/api/v1/translations/{jid}/accept", headers=auth_headers)
    assert accepted.status_code == 200, accepted.text
    from app.modules.translation_v2 import runner

    class NoModelCalls:
        def __init__(self, *args, **kwargs):
            raise AssertionError("Approved prose must not be translated again")

    monkeypatch.setattr(runner, "StageClient", NoModelCalls)
    assert service.claim_next_translation_job(sessions, "publish-lease") == jid
    asyncio.run(
        service.process_translation_job(
            job_id=jid,
            settings=settings,
            session_factory=sessions,
            lease_owner="publish-lease",
        )
    )
    job = client.get(f"/api/v1/translations/{jid}", headers=auth_headers).json()
    assert job["status"] == "ready", job
    check = client.get(
        f"/api/v1/books/{bid}/publication-check", headers=auth_headers
    ).json()
    assert check["in_sync"] and check["reader_chapter_count"] == 4, check
    titles = [c["title"] for c in check["chapters"]]
    assert titles[1:3] == ["用户备注一", "用户备注二"]
    first = client.get(
        f"/api/v1/books/{bid}/continuation/chapters/1", headers=auth_headers
    ).json()
    assert "人工校订后的正文" in first["content"]


@pytest.mark.parametrize("action", ["edit", "delete"])
@pytest.mark.parametrize("status,lease", [("queued", None), ("processing", "live-worker"), ("paused", "stopping-worker")])
def test_chapter_mutations_wait_for_native_worker_to_stop(client, auth_headers, monkeypatch, action, status, lease):
    bid, jid, _, sessions, _ = update_task(client, auth_headers, monkeypatch, status, lease)
    original = client.get(f"/api/v1/files/books/{bid}/original", headers=auth_headers).content
    if action == "edit":
        response = client.put(f"/api/v1/books/{bid}/chapters/1", headers=auth_headers,
            json={"title": "第一话", "content": "不应在后台发布过程中写入。"})
    else:
        response = client.delete(f"/api/v1/books/{bid}/chapters/1", headers=auth_headers)
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "translation_in_progress"
    assert client.get(f"/api/v1/files/books/{bid}/original", headers=auth_headers).content == original


@pytest.mark.parametrize("action", ["edit", "delete", "append", "continuation"])
def test_chapter_mutations_wait_for_file_processing(client, auth_headers, monkeypatch, action):
    from datetime import datetime, timezone
    from app.modules.uploads.models import UploadTaskRecord
    bid, _, _, sessions, _ = update_task(client, auth_headers, monkeypatch, "paused", None)
    with sessions() as db:
        book = db.get(BookRecord, bid)
        db.add(UploadTaskRecord(id=str(uuid4()), user_id=book.owner_id, book_id=bid, file_name="original.epub",
            file_type="epub", file_size=book.file_size, kind="reprocess", status="processing", progress=50,
            created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc)))
        db.commit()
    original = client.get(f"/api/v1/files/books/{bid}/original", headers=auth_headers).content
    if action == "edit":
        response = client.put(f"/api/v1/books/{bid}/chapters/1", headers=auth_headers,
            json={"title": "第一话", "content": "与解析并发的修改。"})
    elif action == "delete":
        response = client.delete(f"/api/v1/books/{bid}/chapters/1", headers=auth_headers)
    elif action == "append":
        response = client.post(f"/api/v1/books/{bid}/chapters", headers=auth_headers,
            json={"title": "备注", "content": "与解析并发的新备注。"})
    else:
        state = client.get(f"/api/v1/books/{bid}/continuation", headers=auth_headers).json()
        response = client.post(f"/api/v1/books/{bid}/continuation", headers=auth_headers,
            json={"request_id": str(uuid4()), "expected_revision": state["revision"],
                  "chapters": [{"title": "第二话", "content": "与解析并发的新章节。", "source_url": "https://kakuyomu.jp/works/1/episodes/2"}]})
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "book_processing"
    assert client.get(f"/api/v1/files/books/{bid}/original", headers=auth_headers).content == original


def test_append_keeps_distinct_documents_when_reader_and_source_positions_coincide():
    from io import BytesIO
    from zipfile import ZipFile
    from app.modules.translations.epub import (
        build_translation_epub,
        append_translation_epub,
    )

    original = build_translation_epub(
        title="测试",
        author="作者",
        description="",
        source_url="https://example.org/work",
        chapters=[{"index": 1, "title": "旧章", "paragraphs": ["原来的正文。"]}],
    )
    paths = []
    data = append_translation_epub(
        original_epub=original,
        appended_paths=paths,
        chapters=[
            {"index": 2, "title": "用户备注", "paragraphs": ["用户自己的备注。"]},
            {
                "index": 2,
                "title": "第二话",
                "source_url": "https://example.org/work/2",
                "paragraphs": ["源作的第二话译文。"],
            },
        ],
    )
    assert len(paths) == len(set(paths)) == 2
    with ZipFile(BytesIO(data)) as archive:
        assert "用户自己的备注" in archive.read(paths[0]).decode()
        assert "源作的第二话译文" in archive.read(paths[1]).decode()
