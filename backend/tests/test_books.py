from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app.modules.books.service as books_service
from app.modules.book_assets.domain import BookAsset
from app.modules.books.factory import create_uploaded_book
from app.modules.books.mappers import book_to_record
from app.modules.books.repository import InMemoryBookRepository
from app.modules.books.service import list_books, list_public_books
from app.modules.comments.repository import InMemoryPublicCommentRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import InMemoryReadingProgressRepository
from tests.test_uploads import make_minimal_epub_bytes

def make_book(book_id: str, *, public: bool = False):
    book = create_uploaded_book(
        author="Tester",
        book_id=book_id,
        file_label=book_id,
        kind="novel",
        owner_id="owner-1",
        reader_type="epub",
        tags=(),
        title=book_id,
    )
    return book.with_changes(public_status="public") if public else book


def parse_book_number(book_id: str) -> int:
    suffix = book_id.rsplit("-", 1)[-1]
    return int(suffix) if suffix.isdigit() else 1


def test_owned_shelf_filters_and_pages_in_sql(client: TestClient, auth_headers: dict[str, str]) -> None:
    owner_id = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        session.add_all([
            book_to_record(create_uploaded_book(
                author="Tester", book_id=f"page-{index:03d}", file_label="TXT",
                kind="novel", owner_id=owner_id, reader_type="text",
                tags=("校园",) if index % 2 == 0 else ("校园生活",),
                title=f"Paged Title {index:03d}",
            ).with_changes(favorite=index % 3 == 0, disliked=index % 11 == 0))
            for index in range(120)
        ])
        session.commit()

    first = client.get("/api/v1/books", headers=auth_headers, params={"page": 1, "page_size": 10, "sort": "title", "shelf": "all", "q": "Paged Title"}).json()
    second = client.get("/api/v1/books", headers=auth_headers, params={"page": 2, "page_size": 10, "sort": "title", "shelf": "all", "q": "Paged Title"}).json()
    assert first["total"] == 109
    assert len(first["items"]) == len(second["items"]) == 10
    assert set(item["id"] for item in first["items"]).isdisjoint(item["id"] for item in second["items"])
    assert first["has_more"] is True

    tagged = client.get("/api/v1/books", headers=auth_headers, params={"page_size": 100, "tag": "校园", "q": "Paged Title", "shelf": "all"}).json()
    assert tagged["total"] == 54
    assert all("校园" in item["tags"] for item in tagged["items"])
    favorite = client.get("/api/v1/books", headers=auth_headers, params={"page_size": 100, "q": "Paged Title", "shelf": "favorite"}).json()
    assert favorite["total"] == 36
    assert all(item["favorite"] and not item["disliked"] for item in favorite["items"])


def test_japanese_shelf_language_search_and_pages_are_server_side(client: TestClient, auth_headers: dict[str, str]) -> None:
    from sqlalchemy import update
    from app.modules.books.models import BookRecord

    with client.app.state.db_session_factory() as session:
        session.execute(update(BookRecord).where(BookRecord.id.in_(["b1", "b2"])).values(language="ja"))
        session.commit()
    first = client.get("/api/v1/books", headers=auth_headers, params={
        "language": "ja", "page": 1, "page_size": 1, "sort": "title", "shelf": "all",
    }).json()
    second = client.get("/api/v1/books", headers=auth_headers, params={
        "language": "ja", "page": 2, "page_size": 1, "sort": "title", "shelf": "all",
    }).json()
    assert first["total"] == second["total"] == 2
    assert first["has_more"] is True and second["has_more"] is False
    assert first["items"][0]["id"] != second["items"][0]["id"]
    searched = client.get("/api/v1/books", headers=auth_headers, params={
        "language": "ja", "q": "月光", "shelf": "all",
    }).json()
    assert searched["total"] == 1 and searched["items"][0]["id"] == "b2"


class CountingReadingProgressRepository(InMemoryReadingProgressRepository):
    def __init__(self) -> None:
        super().__init__()
        self.list_for_books_calls: list[tuple[str, tuple[str, ...]]] = []
        self.list_for_user_calls: list[str] = []

    def list_for_books(self, user_id: str, book_ids: list[str]) -> list[ReadingProgress]:
        self.list_for_books_calls.append((user_id, tuple(book_ids)))
        return super().list_for_books(user_id, book_ids)

    def list_for_user(self, user_id: str) -> list[ReadingProgress]:
        self.list_for_user_calls.append(user_id)
        return super().list_for_user(user_id)


def test_owned_book_list_loads_progress_for_page_unless_sorting_by_progress() -> None:
    books = [make_book(f"book-{index}") for index in range(1, 5)]
    book_repository = InMemoryBookRepository(books)
    progress_repository = CountingReadingProgressRepository()
    progress_repository.save(ReadingProgress(user_id="owner-1", book_id="book-4", reader_type="epub", progress_percent=99))
    progress_repository.save(ReadingProgress(user_id="owner-1", book_id="book-3", reader_type="epub", progress_percent=55))
    progress_repository.save(ReadingProgress(user_id="owner-1", book_id="book-1", reader_type="epub", progress_percent=10))

    response = list_books(
        owner_id="owner-1",
        book_repository=book_repository,
        progress_repository=progress_repository,
        q=None,
        kind=None,
        tag=None,
        sort="title",
        page=1,
        page_size=2,
    )

    assert [book.id for book in response.items] == ["book-1", "book-2"]
    assert [book.progress_percent for book in response.items] == [10, 0]
    assert progress_repository.list_for_books_calls == [("owner-1", ("book-1", "book-2"))]
    assert progress_repository.list_for_user_calls == []

    progress_response = list_books(
        owner_id="owner-1",
        book_repository=book_repository,
        progress_repository=progress_repository,
        q=None,
        kind=None,
        tag=None,
        sort="progress",
        page=1,
        page_size=2,
    )

    assert [book.id for book in progress_response.items] == ["book-4", "book-3"]
    assert progress_repository.list_for_user_calls == ["owner-1"]


def test_recent_owned_books_prioritize_active_reads_and_demote_finished_books() -> None:
    old = datetime(2026, 8, 1, tzinfo=timezone.utc)
    recent = datetime(2026, 8, 17, 8, tzinfo=timezone.utc)
    newest = datetime(2026, 8, 17, 9, tzinfo=timezone.utc)
    books = [
        make_book("finished").with_changes(created_at=old, updated_at=old),
        make_book("unread").with_changes(created_at=recent, updated_at=recent),
        make_book("reading-old").with_changes(created_at=old, updated_at=old),
        make_book("reading-new").with_changes(created_at=old, updated_at=old),
    ]
    book_repository = InMemoryBookRepository(books)
    progress_repository = CountingReadingProgressRepository()
    progress_repository.save(
        ReadingProgress(user_id="owner-1", book_id="finished", reader_type="epub", progress_percent=100, updated_at=newest)
    )
    progress_repository.save(
        ReadingProgress(user_id="owner-1", book_id="reading-old", reader_type="epub", progress_percent=20, updated_at=recent)
    )
    progress_repository.save(
        ReadingProgress(user_id="owner-1", book_id="reading-new", reader_type="epub", progress_percent=40, updated_at=newest)
    )

    response = list_books(
        owner_id="owner-1",
        book_repository=book_repository,
        progress_repository=progress_repository,
        q=None,
        kind=None,
        tag=None,
        sort="recent",
        page=1,
        page_size=10,
    )

    assert [book.id for book in response.items] == ["reading-new", "reading-old", "unread", "finished"]
    assert progress_repository.list_for_user_calls == ["owner-1"]




def test_books_require_auth(client: TestClient) -> None:
    response = client.get("/api/v1/books")

    assert response.status_code == 401


def test_lists_owned_books(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/v1/books", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] >= 3
    assert payload["items"][0]["readers_label"] == "仅自己"


def test_bookshelf_overview_returns_compact_items_and_exact_counts(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.post("/api/v1/books/b2/favorite", headers=auth_headers)
    client.put("/api/v1/books/b2/reading-status", headers=auth_headers, json={"finished": True})

    response = client.get("/api/v1/books/overview?recent_limit=2", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["items"]) == 2
    assert len(payload["book_labels"]) == payload["total"]
    assert payload["favorite_count"] >= 1
    assert payload["finished_count"] >= 1


def test_home_overview_uses_bounded_queries_without_full_book_read(
    client: TestClient, auth_headers: dict[str, str], monkeypatch
) -> None:
    from app.modules.books.repository import SqlAlchemyBookRepository

    def full_read_is_forbidden(*_args, **_kwargs):
        raise AssertionError("Home overview must not materialize the entire library")

    monkeypatch.setattr(SqlAlchemyBookRepository, "list_by_owner", full_read_is_forbidden)
    response = client.get("/api/v1/books/overview?recent_limit=2&include_labels=false", headers=auth_headers)

    assert response.status_code == 200
    assert len(response.json()["items"]) == 2
    assert response.json()["book_labels"] == []
    assert response.json()["total"] >= 3


@pytest.mark.parametrize("use_sql", [False, True])
def test_home_overview_recents_follow_reading_time_across_reading_states(client: TestClient, use_sql: bool) -> None:
    from app.modules.books.repository import SqlAlchemyBookRepository
    from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository

    owner_id = client.app.state.settings.default_user_id
    books = [make_book(f"history-{name}").with_changes(owner_id=owner_id) for name in ("reading", "opened", "finished", "unread")]
    books[-1] = books[-1].with_changes(updated_at=datetime(2100, 1, 4, tzinfo=timezone.utc))
    progresses = [ReadingProgress(
        user_id=owner_id, book_id=f"history-{name}", reader_type="epub", chapter_index=1,
        progress_percent=percent, updated_at=datetime(2100, 1, day, tzinfo=timezone.utc),
    ) for name, percent, day in (("reading", 20, 1), ("opened", 0, 2), ("finished", 100, 3))]

    with client.app.state.db_session_factory() as session:
        if use_sql:
            session.add_all([book_to_record(book) for book in books])
            session.commit()
            book_repository = SqlAlchemyBookRepository(session)
            progress_repository = SqlAlchemyReadingProgressRepository(session)
        else:
            book_repository = InMemoryBookRepository(books)
            progress_repository = InMemoryReadingProgressRepository()
        for progress in progresses:
            progress_repository.save(progress)
        overview = books_service.get_bookshelf_overview(
            owner_id=owner_id, book_repository=book_repository, progress_repository=progress_repository, recent_limit=3,
        )

    assert [book.id for book in overview.items] == ["history-finished", "history-opened", "history-reading"]
    assert overview.continue_book.id == "history-opened"


@pytest.mark.parametrize("reader_type, position", [
    ("epub", {"chapter_index": 2}),
    ("text", {"chapter_index": 2}),
    ("pdf", {"page_number": 4}),
    ("comic", {"image_index": 4}),
    ("epub", {"chapter_href": "chapter-two.xhtml"}),
    ("epub", {"epub_cfi": "epubcfi(/6/4!/4/2:10)"}),
])
def test_zero_percent_position_is_reading_until_explicitly_reset(
    client: TestClient, auth_headers: dict[str, str], reader_type: str, position: dict,
) -> None:
    from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository

    owner_id = client.app.state.settings.default_user_id
    baseline = client.get("/api/v1/books/overview", headers=auth_headers).json()["in_progress_count"]
    saved_at = datetime(2100, 1, 1, tzinfo=timezone.utc)
    book = make_book("zero-percent-position").with_changes(owner_id=owner_id, reader_type=reader_type)
    with client.app.state.db_session_factory() as session:
        session.add(book_to_record(book))
        session.commit()
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(
            user_id=owner_id, book_id=book.id, reader_type=reader_type,
            progress_percent=0, updated_at=saved_at, **position,
        ))

    detail = client.get(f"/api/v1/books/{book.id}", headers=auth_headers).json()
    assert detail["progress_percent"] == 0
    assert detail["last_read_at"] is not None
    overview = client.get("/api/v1/books/overview", headers=auth_headers).json()
    assert overview["in_progress_count"] == baseline + 1
    assert overview["continue_book"]["id"] == book.id
    for shelf, total in (("recent", 1), ("unread", 0)):
        listed = client.get("/api/v1/books", headers=auth_headers, params={"shelf": shelf, "q": book.title}).json()
        assert listed["total"] == total

    reset = client.put(f"/api/v1/books/{book.id}/reading-status", headers=auth_headers, json={"finished": False})
    assert reset.status_code == 200
    assert reset.json()["last_read_at"] is None
    assert reset.json()["current_chapter"] is None
    assert datetime.fromisoformat(reset.json()["updated_at"].replace("Z", "+00:00")) > saved_at
    overview_after = client.get("/api/v1/books/overview", headers=auth_headers).json()
    assert overview_after["in_progress_count"] == baseline
    assert overview_after["continue_book"]["id"] != book.id
    for shelf, total in (("recent", 0), ("unread", 1)):
        listed = client.get("/api/v1/books", headers=auth_headers, params={"shelf": shelf, "q": book.title}).json()
        assert listed["total"] == total


def test_overview_counts_and_updates_include_books_outside_recent_page() -> None:
    books = [make_book(f"book-{index}").with_changes(publication_status="ongoing", source_update_count=2) for index in range(30)]
    books.append(make_book("hidden").with_changes(disliked=True, source_update_count=100))
    books.append(make_book("other-owner").with_changes(owner_id="someone-else", source_update_count=100))
    overview = books_service.get_bookshelf_overview(
        owner_id="owner-1", book_repository=InMemoryBookRepository(books),
        progress_repository=InMemoryReadingProgressRepository(), recent_limit=2,
    )
    assert len(overview.items) == 2
    assert overview.total == overview.ongoing_count == 30
    assert overview.source_update_count == 60
    assert len(overview.updated_items) == 12
    assert {book.id for book in overview.updated_items} - {book.id for book in overview.items}
    assert not {"hidden", "other-owner"} & {book.id for book in overview.updated_items}


def test_searches_books(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/v1/books?q=星光", headers=auth_headers)

    assert response.status_code == 200
    assert [book["id"] for book in response.json()["items"]] == ["b1"]


def test_updates_favorite(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/api/v1/books/b2/favorite", headers=auth_headers)

    assert response.status_code == 200
    assert response.json()["favorite"] is True


def test_disliked_book_is_hidden_from_overview_and_can_be_restored(client: TestClient, auth_headers: dict[str, str]) -> None:
    disliked = client.post("/api/v1/books/b2/dislike", headers=auth_headers)
    assert disliked.status_code == 200
    assert disliked.json()["disliked"] is True

    overview = client.get("/api/v1/books/overview", headers=auth_headers)
    assert overview.status_code == 200
    assert "b2" not in [book["id"] for book in overview.json()["items"]]
    assert "b2" not in [book["id"] for book in overview.json()["book_labels"]]

    listed = client.get("/api/v1/books", headers=auth_headers)
    assert next(book for book in listed.json()["items"] if book["id"] == "b2")["disliked"] is True

    restored = client.delete("/api/v1/books/b2/dislike", headers=auth_headers)
    assert restored.status_code == 200
    assert restored.json()["disliked"] is False


def test_marks_book_finished_then_unread(client: TestClient, auth_headers: dict[str, str]) -> None:
    finished = client.put("/api/v1/books/b2/reading-status", headers=auth_headers, json={"finished": True})
    assert finished.status_code == 200
    assert finished.json()["progress_percent"] == 100

    detail = client.get("/api/v1/books/b2", headers=auth_headers)
    assert detail.json()["progress_percent"] == 100

    unread = client.put("/api/v1/books/b2/reading-status", headers=auth_headers, json={"finished": False})
    assert unread.status_code == 200
    assert unread.json()["progress_percent"] == 0

    detail_after = client.get("/api/v1/books/b2", headers=auth_headers)
    assert detail_after.json()["progress_percent"] == 0


def test_reading_status_unknown_book_returns_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.put("/api/v1/books/missing/reading-status", headers=auth_headers, json={"finished": True})
    assert response.status_code == 404


def test_updates_book_rating(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.patch("/api/v1/books/b1", headers=auth_headers, json={"rating": 8.5})
    assert response.status_code == 200
    assert response.json()["rating"] == 8.5

    out_of_range = client.patch("/api/v1/books/b1", headers=auth_headers, json={"rating": 99})
    assert out_of_range.status_code == 422


def test_updates_book_metadata_series_fields(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"series_title": "她与星光", "series_order": 1, "series_kind": "正篇"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["series_title"] == "她与星光"
    assert payload["series_order"] == 1
    assert payload["series_kind"] == "正篇"

    clear_response = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"series_title": None, "series_order": None, "series_kind": ""},
    )

    assert clear_response.status_code == 200
    cleared_payload = clear_response.json()
    assert cleared_payload["series_title"] is None
    assert cleared_payload["series_order"] is None
    assert cleared_payload["series_kind"] is None


def test_custom_cover_can_be_replaced_and_restored(client: TestClient, auth_headers: dict[str, str]) -> None:
    original_cover = make_cover_bytes(size=(120, 180), color=(220, 180, 190))
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("covered.epub", BytesIO(make_minimal_epub_bytes(chapter_text="正文", cover_bytes=original_cover)), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]
    original_url = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["cover_url"]
    assert original_url == f"/api/v1/files/books/{book_id}/cover"

    first_custom = make_cover_bytes(size=(400, 600), color=(80, 120, 180))
    first_response = client.put(
        f"/api/v1/books/{book_id}/cover",
        headers=auth_headers,
        files={"file": ("first.png", BytesIO(first_custom), "image/png")},
    )
    assert first_response.status_code == 200
    assert "custom=1" in first_response.json()["cover_url"]

    served_cover = client.get(first_response.json()["cover_url"], headers=auth_headers)
    assert served_cover.status_code == 200
    assert served_cover.headers["content-type"] == "image/webp"
    with Image.open(BytesIO(served_cover.content)) as image:
        assert image.format == "WEBP"
        assert image.size == (400, 600)
    small_cover = client.get(first_response.json()["cover_url"] + "&size=small", headers=auth_headers)
    assert small_cover.status_code == 200
    assert small_cover.headers["content-type"] == "image/webp"
    with Image.open(BytesIO(small_cover.content)) as image:
        assert image.size == (160, 240)

    second_custom = make_cover_bytes(size=(800, 1200), color=(170, 90, 130))
    second_response = client.put(
        f"/api/v1/books/{book_id}/cover",
        headers=auth_headers,
        files={"file": ("second.jpg", BytesIO(second_custom), "image/jpeg")},
    )
    assert second_response.status_code == 200
    updated_small_cover = client.get(second_response.json()["cover_url"] + "&size=small", headers=auth_headers)
    assert updated_small_cover.content != small_cover.content

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    after_reprocess = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert "custom=1" in after_reprocess["cover_url"]
    with Image.open(BytesIO(client.get(after_reprocess["cover_url"], headers=auth_headers).content)) as image:
        assert image.size == (800, 1200)

    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    custom_cover_directory = Path(client.app.state.settings.storage_root) / "originals" / user_id / book_id / "custom-cover"
    assert len(list(custom_cover_directory.glob("*.webp"))) == 1

    restore_response = client.delete(f"/api/v1/books/{book_id}/cover", headers=auth_headers)
    assert restore_response.status_code == 200
    restored_url = restore_response.json()["cover_url"]
    assert restored_url.startswith(f"/api/v1/files/books/{book_id}/cover?v=")
    assert "custom=1" not in restored_url
    assert client.get(restored_url, headers=auth_headers).content == original_cover
    assert list(custom_cover_directory.glob("*.webp")) == []


def test_custom_cover_rejects_invalid_and_oversized_files(client: TestClient, auth_headers: dict[str, str]) -> None:
    invalid_response = client.put(
        "/api/v1/books/b1/cover",
        headers=auth_headers,
        files={"file": ("not-an-image.png", BytesIO(b"not an image"), "image/png")},
    )
    assert invalid_response.status_code == 400
    assert "无法读取" in invalid_response.json()["detail"]

    oversized_response = client.put(
        "/api/v1/books/b1/cover",
        headers=auth_headers,
        files={"file": ("huge.png", BytesIO(b"x" * (10 * 1024 * 1024 + 1)), "image/png")},
    )
    assert oversized_response.status_code == 413

    missing_response = client.put(
        "/api/v1/books/missing/cover",
        headers=auth_headers,
        files={"file": ("cover.png", BytesIO(make_cover_bytes()), "image/png")},
    )
    assert missing_response.status_code == 404


def test_delete_book_hides_it_from_library(client: TestClient, auth_headers: dict[str, str]) -> None:
    delete_response = client.delete("/api/v1/books/b2", headers=auth_headers)

    assert delete_response.status_code == 204

    detail_response = client.get("/api/v1/books/b2", headers=auth_headers)
    assert detail_response.status_code == 404

    list_response = client.get("/api/v1/books", headers=auth_headers)
    assert list_response.status_code == 200
    assert "b2" not in [book["id"] for book in list_response.json()["items"]]


def test_delete_book_commits_database_changes_even_when_file_removal_fails(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("undeletable.epub", BytesIO(make_minimal_epub_bytes(chapter_text="锁定的文件")), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]
    user_id = client.get("/api/v1/auth/me", headers=auth_headers).json()["id"]
    original_directory = Path(client.app.state.settings.storage_root) / "originals" / user_id / book_id
    assert original_directory.exists()

    def refuse_removal(*args: object, **kwargs: object) -> None:
        raise OSError("simulated locked file")

    monkeypatch.setattr(books_service, "remove_storage_file", refuse_removal)
    monkeypatch.setattr(books_service, "remove_storage_directory", refuse_removal)

    delete_response = client.delete(f"/api/v1/books/{book_id}", headers=auth_headers)

    # File removal failures are only logged; the database deletion must win.
    assert delete_response.status_code == 204
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).status_code == 404
    # The orphaned files stay on disk for the maintenance health check.
    assert original_directory.exists()


def test_update_book_rejects_oversized_metadata(client: TestClient, auth_headers: dict[str, str]) -> None:
    too_long_title = client.patch("/api/v1/books/b1", headers=auth_headers, json={"title": "长" * 256})
    assert too_long_title.status_code == 422

    too_long_author = client.patch("/api/v1/books/b1", headers=auth_headers, json={"author": "a" * 256})
    assert too_long_author.status_code == 422

    too_long_description = client.patch("/api/v1/books/b1", headers=auth_headers, json={"description": "简" * 5001})
    assert too_long_description.status_code == 422

    too_many_tags = client.patch("/api/v1/books/b1", headers=auth_headers, json={"tags": [f"tag-{index}" for index in range(51)]})
    assert too_many_tags.status_code == 422

    too_long_tag = client.patch("/api/v1/books/b1", headers=auth_headers, json={"tags": ["t" * 65]})
    assert too_long_tag.status_code == 422

    still_valid = client.patch(
        "/api/v1/books/b1",
        headers=auth_headers,
        json={"title": "标" * 255, "description": "述" * 5000, "tags": [f"tag-{index}" for index in range(50)]},
    )
    assert still_valid.status_code == 200
    assert still_valid.json()["title"] == "标" * 255


def make_cover_bytes(*, size: tuple[int, int] = (80, 120), color: tuple[int, int, int] = (190, 120, 140)) -> bytes:
    output = BytesIO()
    image = Image.new("RGB", size, color)
    image.save(output, format="PNG")
    return output.getvalue()
