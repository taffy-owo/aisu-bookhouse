from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from pytest import MonkeyPatch

from app.core.storage import write_bytes_file
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.books.factory import create_uploaded_book
from app.modules.books.source_episode_matching import SourceEpisodeScope
from app.modules.books.source_updates import (
    apply_source_metadata,
    is_source_check_due,
    process_next_due_source_update,
    resolve_source_coverage,
    source_check_day_start,
    source_check_window_start,
)
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata
from app.modules.translations.models import WholeBookTranslationJobRecord
import app.modules.translations.service as translation_service
from app.modules.users.ai_settings import encrypt_ai_api_key
from app.modules.users.models import UserRecord

SOURCE_URL = "https://kakuyomu.jp/works/16817330649163498808"


def metadata(
    *,
    episode_count: int,
    publication_status: str = "ongoing",
    schedule_time: str | None = None,
) -> WorkSourceMetadata:
    return WorkSourceMetadata(
        author="犬甘あんず",
        character_count=episode_count * 3000,
        cover_url=None,
        description="简介",
        episode_count=episode_count,
        publication_status=publication_status,
        source="kakuyomu",
        source_url=SOURCE_URL,
        tags=["百合"],
        title="原作",
        episodes=[
            WorkSourceEpisode(
                index=index,
                title=f"第 {index} 話",
                url=f"{SOURCE_URL}/episodes/{index}",
            )
            for index in range(1, episode_count + 1)
        ],
        schedule_label=f"毎日 {schedule_time}" if schedule_time else None,
        schedule_time=schedule_time,
        schedule_timezone="Asia/Tokyo" if schedule_time else None,
    )


def configure_ongoing_source(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"publication_status": "ongoing", "source_url": SOURCE_URL},
    )
    assert response.status_code == 200


def test_source_scope_backfills_missing_episodes_inside_an_existing_catalog_count() -> None:
    book = create_uploaded_book(
        author="作者",
        book_id="book-2",
        file_label="part-2.epub",
        kind="novel",
        owner_id="owner-1",
        reader_type="epub",
        tags=(),
        title="作品 第二部",
    ).with_changes(
        publication_status="ongoing",
        source_episode_count=8,
        source_pending_episode_indexes=(8,),
        source_update_count=1,
        source_url=SOURCE_URL,
    )
    source = metadata(episode_count=8)
    scope = SourceEpisodeScope(start_index=4, covered_through_index=5, end_index=8)

    updated = apply_source_metadata(
        book,
        source,
        checked_at=datetime(2026, 8, 9, tzinfo=timezone.utc),
        covered_episode_indexes=scope.covered_indexes,
        source_scope=scope,
    )

    assert updated.source_pending_episode_indexes == (6, 7, 8)
    assert updated.source_update_count == 3


@pytest.mark.parametrize("previous_count", [None, 32])
def test_source_check_finds_missing_finale_without_an_existing_update_alert(previous_count: int | None) -> None:
    book = create_uploaded_book(
        author="作者", book_id="book-finale", file_label="book.epub", kind="novel",
        owner_id="owner-1", reader_type="epub", tags=(), title="作品",
    ).with_changes(
        publication_status="completed", source_url=SOURCE_URL, source_episode_count=previous_count,
        source_pending_episode_indexes=(), source_update_count=0,
    )
    chapters = [
        create_book_asset(
            asset_type="text_chapter", book_id=book.id, index=index,
            metadata={"title": f"第{index}话 既有译文"}, path=f"chapter-{index}.txt",
        )
        for index in range(1, 32)
    ]
    source = metadata(episode_count=32, publication_status="completed")
    source.episodes[-1].title = "最終話 幸せな話"
    covered, scope = resolve_source_coverage(book, chapters, source)

    updated = apply_source_metadata(
        book, source, checked_at=datetime(2026, 11, 13, tzinfo=timezone.utc),
        covered_episode_indexes=covered, source_scope=scope,
    )

    assert updated.source_pending_episode_indexes == (32,)
    assert updated.source_update_count == 1
    assert updated.source_episode_count == 32
    assert updated.updated_at == book.updated_at

    chapters.append(create_book_asset(
        asset_type="text_chapter", book_id=book.id, index=32, path="finale.txt",
        metadata={"title": "最终话 幸福的故事", "source_episode_url": source.episodes[-1].url},
    ))
    covered, scope = resolve_source_coverage(updated, chapters, source)
    completed = apply_source_metadata(
        updated, source, checked_at=datetime(2026, 11, 13, tzinfo=timezone.utc),
        covered_episode_indexes=covered, source_scope=scope,
    )
    assert completed.source_pending_episode_indexes == ()
    assert completed.source_update_count == 0


def test_finished_source_part_discards_updates_from_later_numbering_runs() -> None:
    book = create_uploaded_book(
        author="作者",
        book_id="book-1",
        file_label="part-1.epub",
        kind="novel",
        owner_id="owner-1",
        reader_type="epub",
        tags=(),
        title="作品",
    ).with_changes(
        publication_status="completed",
        source_episode_count=8,
        source_pending_episode_indexes=(7, 8),
        source_update_count=2,
        source_url=SOURCE_URL,
    )
    source = metadata(episode_count=8)
    scope = SourceEpisodeScope(start_index=1, covered_through_index=5, end_index=5)

    updated = apply_source_metadata(
        book,
        source,
        checked_at=datetime(2026, 8, 9, tzinfo=timezone.utc),
        covered_episode_indexes=scope.covered_indexes,
        source_scope=scope,
    )

    assert updated.publication_status == "completed"
    assert updated.source_pending_episode_indexes == ()
    assert updated.source_update_count == 0


def test_source_check_window_repeats_every_six_hours_in_shanghai() -> None:
    assert source_check_day_start(datetime(2026, 7, 21, 3, 59, tzinfo=timezone.utc)) == datetime(2026, 7, 20, 22, 0, tzinfo=timezone.utc)
    assert source_check_day_start(datetime(2026, 7, 21, 4, 0, tzinfo=timezone.utc)) == datetime(2026, 7, 21, 4, 0, tzinfo=timezone.utc)


def test_source_check_window_uses_the_kakuyomu_schedule_in_japan_time() -> None:
    before_update = datetime(2026, 8, 2, 7, 59, tzinfo=timezone.utc)
    at_update = datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc)

    assert source_check_window_start(
        before_update,
        schedule_time="17:00",
        schedule_timezone="Asia/Tokyo",
    ) == datetime(2026, 8, 2, 2, 0, tzinfo=timezone.utc)
    assert source_check_window_start(
        at_update,
        schedule_time="17:00",
        schedule_timezone="Asia/Tokyo",
    ) == at_update
    assert is_source_check_due(
        now=at_update,
        source_checked_at=datetime(2026, 8, 1, 8, 0, tzinfo=timezone.utc),
        schedule_time="17:00",
        schedule_timezone="Asia/Tokyo",
    ) is True
    assert is_source_check_due(
        now=at_update,
        source_checked_at=at_update,
        schedule_time="17:00",
        schedule_timezone="Asia/Tokyo",
    ) is False


@pytest.mark.asyncio
async def test_scheduled_source_check_runs_regularly_and_again_at_the_source_update_time(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    configure_ongoing_source(client, auth_headers)
    response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "source_schedule_label": "毎日 17:00",
            "source_schedule_time": "17:00",
            "source_schedule_timezone": "Asia/Tokyo",
        },
    )
    assert response.status_code == 200

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=10, schedule_time="17:00")

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    assert await process_next_due_source_update(
        session_factory=client.app.state.db_session_factory,
        now=datetime(2026, 8, 2, 7, 59, tzinfo=timezone.utc),
    ) is True
    assert await process_next_due_source_update(
        session_factory=client.app.state.db_session_factory,
        now=datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc),
    ) is True
    assert await process_next_due_source_update(
        session_factory=client.app.state.db_session_factory,
        now=datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc),
    ) is False

    payload = client.get("/api/v1/books/b1", headers=auth_headers).json()
    assert payload["source_schedule_label"] == "毎日 17:00"
    assert payload["source_schedule_time"] == "17:00"
    assert payload["source_schedule_timezone"] == "Asia/Tokyo"


@pytest.mark.asyncio
async def test_daily_source_check_skips_completed_books(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"publication_status": "completed", "source_url": SOURCE_URL},
    )
    assert response.status_code == 200

    noon = datetime(2026, 7, 21, 4, 0, tzinfo=timezone.utc)
    assert await process_next_due_source_update(session_factory=client.app.state.db_session_factory, now=noon) is False


@pytest.mark.asyncio
async def test_daily_source_check_skips_links_without_a_supported_metadata_parser(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"publication_status": "ongoing", "source_url": "https://dengekibunko.jp/product/example/"},
    )
    assert response.status_code == 200

    noon = datetime(2026, 7, 21, 4, 0, tzinfo=timezone.utc)
    assert await process_next_due_source_update(session_factory=client.app.state.db_session_factory, now=noon) is False


@pytest.mark.asyncio
async def test_daily_source_check_builds_baseline_once_then_detects_new_episodes(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    configure_ongoing_source(client, auth_headers)
    current_metadata = metadata(episode_count=10)

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return current_metadata

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    first_noon = datetime(2026, 7, 21, 4, 0, tzinfo=timezone.utc)

    assert await process_next_due_source_update(session_factory=client.app.state.db_session_factory, now=first_noon) is True
    assert await process_next_due_source_update(session_factory=client.app.state.db_session_factory, now=first_noon) is False
    first_payload = client.get("/api/v1/books/b1", headers=auth_headers).json()
    assert first_payload["source_episode_count"] == 10
    assert first_payload["source_update_count"] == 0

    current_metadata = metadata(episode_count=12)
    next_noon = datetime(2026, 7, 22, 4, 0, tzinfo=timezone.utc)
    assert await process_next_due_source_update(session_factory=client.app.state.db_session_factory, now=next_noon) is True
    next_payload = client.get("/api/v1/books/b1", headers=auth_headers).json()
    assert next_payload["source_episode_count"] == 12
    assert next_payload["source_character_count"] == 36_000
    assert next_payload["source_update_count"] == 2
    assert next_payload["source_check_error"] is None

    following_noon = datetime(2026, 7, 23, 4, 0, tzinfo=timezone.utc)
    assert await process_next_due_source_update(session_factory=client.app.state.db_session_factory, now=following_noon) is True
    unchanged_payload = client.get("/api/v1/books/b1", headers=auth_headers).json()
    assert unchanged_payload["source_episode_count"] == 12
    assert unchanged_payload["source_update_count"] == 2


def test_manual_source_check_and_acknowledge_update(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    baseline_response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "publication_status": "ongoing",
            "source_url": SOURCE_URL,
            "source_episode_count": 5,
            "source_character_count": 15_000,
        },
    )
    assert baseline_response.status_code == 200

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=8)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    checked = client.post("/api/v1/books/b1/source-update/check", headers=auth_headers)
    assert checked.status_code == 200
    assert checked.json()["source_update_count"] == 3

    notifications = client.get("/api/v1/books/source-updates", headers=auth_headers)
    assert notifications.status_code == 200
    assert notifications.json()["book_count"] == 1
    assert notifications.json()["episode_count"] == 3
    assert [(item["id"], item["source_update_count"]) for item in notifications.json()["items"]] == [("b1", 3)]

    acknowledged = client.post("/api/v1/books/b1/source-update/acknowledge", headers=auth_headers)
    assert acknowledged.status_code == 200
    assert acknowledged.json()["source_update_count"] == 0

    cleared_notifications = client.get("/api/v1/books/source-updates", headers=auth_headers)
    assert cleared_notifications.json() == {"book_count": 0, "episode_count": 0, "items": []}


def test_source_update_notifications_merge_books_with_the_same_source_link(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id("b1")
        assert book is not None
        repository.save(book.with_changes(source_url=SOURCE_URL, source_update_count=2))
        duplicate = repository.create_from_upload(
            author="同一作者",
            book_id="b2",
            file_label="EPUB",
            kind="novel",
            owner_id=book.owner_id,
            reader_type="epub",
            tags=(),
            title="同一原作的另一份文件",
        )
        repository.save(duplicate.with_changes(source_url=f"{SOURCE_URL}/", source_update_count=2))

    notifications = client.get("/api/v1/books/source-updates", headers=auth_headers)
    assert notifications.status_code == 200
    assert notifications.json()["book_count"] == 1
    assert notifications.json()["episode_count"] == 2

    acknowledged = client.post("/api/v1/books/b1/source-update/acknowledge", headers=auth_headers)
    assert acknowledged.status_code == 200
    assert client.get("/api/v1/books/source-updates", headers=auth_headers).json()["book_count"] == 0
    with client.app.state.db_session_factory() as session:
        duplicate = SqlAlchemyBookRepository(session).get_by_id("b2")
        assert duplicate is not None
        assert duplicate.source_update_count == 0


def test_manual_source_check_clears_false_update_when_episode_was_already_appended(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    configured = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "publication_status": "ongoing",
            "source_url": SOURCE_URL,
            "source_episode_count": 12,
        },
    )
    assert configured.status_code == 200
    with client.app.state.db_session_factory() as session:
        book_repository = SqlAlchemyBookRepository(session)
        book = book_repository.get_by_id("b1")
        assert book is not None
        book_repository.save(book.with_changes(source_update_count=1))
        SqlAlchemyBookAssetRepository(session).save(
            create_book_asset(
                asset_type="text_chapter",
                book_id="b1",
                index=999,
                metadata={"source": "manual_append", "title": "第12话 已经上传的最新话"},
                path="manual-chapters/chapter-12.txt",
            )
        )

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=12)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    checked = client.post("/api/v1/books/b1/source-update/check", headers=auth_headers)

    assert checked.status_code == 200
    assert checked.json()["source_update_count"] == 0
    with client.app.state.db_session_factory() as session:
        book = SqlAlchemyBookRepository(session).get_by_id("b1")
        assert book is not None
        assert book.source_pending_episode_indexes == ()


def test_all_source_updates_can_be_acknowledged_together(client: TestClient, auth_headers: dict[str, str]) -> None:
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id("b1")
        assert book is not None
        repository.save(book.with_changes(source_update_count=4))

    acknowledged = client.post("/api/v1/books/source-updates/acknowledge", headers=auth_headers)
    assert acknowledged.status_code == 200
    assert acknowledged.json() == {"book_count": 0, "episode_count": 0, "items": []}
    assert client.get("/api/v1/books/b1", headers=auth_headers).json()["source_update_count"] == 0


def test_manual_source_check_requires_a_link(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/api/v1/books/b1/source-update/check", headers=auth_headers)

    assert response.status_code == 400
    assert response.json()["detail"] == "请先填写受支持的原作链接"


@pytest.mark.asyncio
async def test_manual_source_update_translation_requires_a_configured_provider(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    configured = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "publication_status": "ongoing",
            "source_episode_count": 1,
            "source_url": SOURCE_URL,
        },
    )
    assert configured.status_code == 200

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=2)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)

    without_provider = client.post("/api/v1/books/b1/source-update/translate", headers=auth_headers)
    assert without_provider.status_code == 400
    assert without_provider.json()["detail"] == "请先在设置中配置翻译渠道和模型"


@pytest.mark.asyncio
@pytest.mark.parametrize("known_episode_count", [2, 3])
async def test_manual_source_update_translation_bootstraps_uploaded_epub_without_retranslating_existing_chapters(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
    known_episode_count: int,
) -> None:
    configured = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "publication_status": "ongoing",
            "source_episode_count": known_episode_count,
            "source_url": SOURCE_URL,
        },
    )
    assert configured.status_code == 200
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id("b1")
        assert book is not None
        repository.save(book.with_changes(original_file_path="originals/b1/original.epub", reader_type="epub", status="ready"))
        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        user.ai_provider_base_url = "https://translator.example/v1"
        user.ai_provider_api_key_encrypted = encrypt_ai_api_key("test-key", client.app.state.settings)
        user.ai_translation_model = "quality-model"
        session.commit()
        asset_repository = SqlAlchemyBookAssetRepository(session)
        for index in (1, 2):
            stored = write_bytes_file(
                data=f"第 {index} 话\n\n已经上传的第 {index} 话译文。".encode(),
                relative_path=Path(f"tests/b1/chapter-{index}.txt"),
                settings=client.app.state.settings,
            )
            asset_repository.save(
                create_book_asset(
                    asset_type="text_chapter",
                    book_id="b1",
                    index=index,
                    metadata={"title": f"第 {index} 话"},
                    path=stored.relative_path,
                )
            )

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=3)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    started = client.post("/api/v1/books/b1/source-update/translate", headers=auth_headers)

    assert started.status_code == 202
    assert started.json()["total_chapters"] == 1
    with client.app.state.db_session_factory() as session:
        job = session.query(WholeBookTranslationJobRecord).filter_by(book_id="b1", job_kind="source_update").one()
        assert [item["index"] for item in job.catalog_json] == [3]
        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        project_path = translation_service._translation_project_path(client.app.state.settings, user.id, "b1")
        assert sorted(path.name for path in (project_path / "translated").glob("*.json")) == ["00001.json", "00002.json"]


@pytest.mark.asyncio
async def test_source_update_translation_only_starts_after_owner_requests_it(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    configured = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "auto_translate_updates": False,
            "publication_status": "ongoing",
            "source_episode_count": 1,
            "source_url": SOURCE_URL,
        },
    )
    assert configured.status_code == 200
    with client.app.state.db_session_factory() as session:
        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        user.ai_provider_base_url = "https://translator.example/v1"
        user.ai_provider_api_key_encrypted = encrypt_ai_api_key("test-key", client.app.state.settings)
        user.ai_translation_model = "quality-model"
        session.commit()
        project_path = translation_service._translation_project_path(client.app.state.settings, user.id, "b1")
        project_path.mkdir(parents=True, exist_ok=True)
        translation_service._write_json_atomic(project_path / "project.json", {"memory": {"characters": []}})
        translation_service._write_json_atomic(
            project_path / "translated" / "00001.json",
            {"index": 1, "title": "第一话", "paragraphs": ["既有译文。"]},
        )

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=3)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    processed = await process_next_due_source_update(
        session_factory=client.app.state.db_session_factory,
        settings=client.app.state.settings,
        now=datetime(2027, 1, 1, 4, 0, tzinfo=timezone.utc),
    )

    assert processed is True
    with client.app.state.db_session_factory() as session:
        assert session.query(WholeBookTranslationJobRecord).filter_by(book_id="b1", job_kind="source_update").count() == 0

    started = client.post("/api/v1/books/b1/source-update/translate", headers=auth_headers)

    assert started.status_code == 202
    assert started.json()["job_kind"] == "source_update"
    with client.app.state.db_session_factory() as session:
        job = session.query(WholeBookTranslationJobRecord).filter_by(book_id="b1", job_kind="source_update").one()
        assert job.status == "queued"
        assert job.total_chapters == 2
        assert [item["index"] for item in job.catalog_json] == [2, 3]


@pytest.mark.asyncio
@pytest.mark.parametrize('check_mode', ['scheduled', 'manual'])
async def test_scheduled_source_check_queues_translation_when_auto_update_is_enabled(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
    check_mode: str,
) -> None:
    configured = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "auto_translate_updates": True,
            "publication_status": "ongoing",
            "source_episode_count": 1,
            "source_url": SOURCE_URL,
        },
    )
    assert configured.status_code == 200
    with client.app.state.db_session_factory() as session:
        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        user.ai_provider_base_url = "https://translator.example/v1"
        user.ai_provider_api_key_encrypted = encrypt_ai_api_key("test-key", client.app.state.settings)
        user.ai_translation_model = "quality-model"
        session.commit()
        project_path = translation_service._translation_project_path(client.app.state.settings, user.id, "b1")
        translation_service._write_json_atomic(
            project_path / "project.json",
            {"handled_episode_indexes": [1], "memory": {"characters": []}},
        )
        translation_service._write_json_atomic(
            project_path / "translated" / "00001.json",
            {"index": 1, "title": "第一话", "paragraphs": ["既有译文。"]},
        )

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=3)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    if check_mode == 'scheduled':
        processed = await process_next_due_source_update(
            session_factory=client.app.state.db_session_factory,
            settings=client.app.state.settings,
            now=datetime(2027, 1, 1, 4, 0, tzinfo=timezone.utc),
        )
        assert processed is True
    else:
        response = client.post('/api/v1/books/b1/source-update/check', headers=auth_headers)
        assert response.status_code == 200
    # A repeated detection must reuse the pending translation, not charge twice.
    assert client.post('/api/v1/books/b1/source-update/check', headers=auth_headers).status_code == 200
    with client.app.state.db_session_factory() as session:
        job = session.query(WholeBookTranslationJobRecord).filter_by(book_id="b1", job_kind="source_update").one()
        assert job.status == "queued"
        assert job.total_chapters == 2
        assert [item["index"] for item in job.catalog_json] == [2, 3]


@pytest.mark.asyncio
async def test_source_update_catches_up_unhandled_episode_after_earlier_draft_was_resolved(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    configured = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={
            "auto_translate_updates": False,
            "publication_status": "ongoing",
            "source_episode_count": 2,
            "source_url": SOURCE_URL,
        },
    )
    assert configured.status_code == 200
    with client.app.state.db_session_factory() as session:
        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        user.ai_provider_base_url = "https://translator.example/v1"
        user.ai_provider_api_key_encrypted = encrypt_ai_api_key("test-key", client.app.state.settings)
        user.ai_translation_model = "quality-model"
        session.commit()
        project_path = translation_service._translation_project_path(client.app.state.settings, user.id, "b1")
        translation_service._write_json_atomic(
            project_path / "project.json",
            {"dismissed_episode_indexes": [2], "memory": {"characters": []}},
        )
        translation_service._write_json_atomic(
            project_path / "translated" / "00001.json",
            {"index": 1, "title": "第一话", "paragraphs": ["既有译文。"]},
        )

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata(episode_count=3)

    monkeypatch.setattr("app.modules.books.source_updates.fetch_work_source_metadata", fake_fetch)
    processed = await process_next_due_source_update(
        session_factory=client.app.state.db_session_factory,
        settings=client.app.state.settings,
        now=datetime(2027, 1, 1, 4, 0, tzinfo=timezone.utc),
    )

    assert processed is True
    started = client.post("/api/v1/books/b1/source-update/translate", headers=auth_headers)
    assert started.status_code == 202
    with client.app.state.db_session_factory() as session:
        job = session.query(WholeBookTranslationJobRecord).filter_by(book_id="b1", job_kind="source_update").one()
        assert job.total_chapters == 1
        assert [item["index"] for item in job.catalog_json] == [3]
