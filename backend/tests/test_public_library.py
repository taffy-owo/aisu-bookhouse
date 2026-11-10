from io import BytesIO

from fastapi.testclient import TestClient

from app.modules.book_assets.repository import InMemoryBookAssetRepository, SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.books.repository import SqlAlchemyBookRepository
from tests.test_reader import make_epub_with_documents
from tests.test_uploads import TINY_PNG_BYTES, make_minimal_epub_bytes


def test_book_asset_repositories_return_aggregated_stats(client: TestClient) -> None:
    assets = [
        create_book_asset(asset_type="text_chapter", book_id="b1", index=1, metadata={"text_length": 1200}, path="processed/b1/chapter-1.txt"),
        create_book_asset(asset_type="text_chapter", book_id="b1", index=2, metadata={"text_length": 800}, path="processed/b1/chapter-2.txt"),
        create_book_asset(asset_type="comic_page", book_id="b1", index=1, path="processed/b1/page-1.webp"),
        create_book_asset(asset_type="cover", book_id="b1", path="processed/b1/cover.webp"),
        create_book_asset(asset_type="image_page", book_id="b2", index=1, path="processed/b2/page-1.webp"),
    ]

    memory_repository = InMemoryBookAssetRepository()
    memory_repository.save_many(assets)
    memory_stats = memory_repository.stats_by_books(["b2", "b1", "missing", "b1"])

    assert memory_stats["b1"].asset_count == 4
    assert memory_stats["b1"].chapter_count == 2
    assert memory_stats["b1"].character_count == 2000
    assert memory_stats["b1"].page_count == 1
    assert memory_stats["b2"].asset_count == 1
    assert memory_stats["missing"].asset_count == 0

    with client.app.state.db_session_factory() as session:
        sql_repository = SqlAlchemyBookAssetRepository(session)
        sql_repository.save_many(assets)
        sql_stats = sql_repository.stats_by_books(["b2", "b1", "missing", "b1"])

    assert sql_stats["b1"].asset_count == 4
    assert sql_stats["b1"].chapter_count == 2
    assert sql_stats["b1"].character_count == 2000
    assert sql_stats["b1"].page_count == 1
    assert sql_stats["b2"].asset_count == 1
    assert sql_stats["missing"].asset_count == 0


def test_book_asset_stats_exclude_front_matter_and_keep_readable_special_titles(client: TestClient) -> None:
    metadata_by_book = {
        "b1": [
            {"title": "书名页 / 简介", "source": "OEBPS/title.xhtml", "text_length": 467},
            {"title": "第一话", "text_length": 1000},
            {"title": "目录", "content_is_body": True, "text_length": 50},
            {"title": "插图", "image_count": 1, "text_length": 0},
        ],
        "b2": [{"title": "封面", "text_length": 25}],
    }
    assets = [
        create_book_asset(asset_type="text_chapter", book_id=book_id, index=index, metadata=metadata, path=f"{book_id}/{index}.txt")
        for book_id, chapters in metadata_by_book.items()
        for index, metadata in enumerate(chapters, start=1)
    ]
    memory_repository = InMemoryBookAssetRepository()
    with client.app.state.db_session_factory() as session:
        for repository in (memory_repository, SqlAlchemyBookAssetRepository(session)):
            repository.save_many(assets)
            stats = repository.stats_by_books(["b1", "b2"])
            assert stats["b1"].asset_count == 4
            assert stats["b1"].chapter_count == 3
            assert stats["b1"].character_count == 1050
            assert stats["b2"].chapter_count == 1
            assert stats["b2"].character_count == 25


def test_detail_and_append_chapter_counts_match_reader_with_front_matter(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub = make_epub_with_documents([("作品信息", "书籍说明。"), ("第一话", "正文一。"), ("第二话", "正文二。")])
    response = client.post(
        "/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("front-matter.epub", epub, "application/epub+zip")},
    )
    assert response.status_code == 200
    book_id = response.json()["book_id"]
    detail = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    reader = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    assert detail["chapter_count"] == reader["chapter_count"] == 2

    appended = client.post(
        f"/api/v1/books/{book_id}/chapters", headers=auth_headers,
        json={"title": "第三话", "content": "追加正文。"},
    )
    assert appended.status_code == 200
    detail = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    reader = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    assert appended.json()["chapter_count"] == detail["chapter_count"] == reader["chapter_count"] == 3


def test_public_library_share_review_and_list(client: TestClient, auth_headers: dict[str, str]) -> None:
    public_response = client.get("/api/v1/books/public", headers=auth_headers)
    assert public_response.status_code == 200
    assert public_response.json()["total"] == 0

    request_response = client.post(
        "/api/v1/books/b1/share-request",
        headers=auth_headers,
        json={
            "public_download_allowed": False,
            "share_note": "Worth reading together.",
            "source_note": "Personal整理",
        },
    )
    assert request_response.status_code == 200
    assert request_response.json()["public_status"] == "pending"
    assert request_response.json()["public_share_note"] == "Worth reading together."
    assert request_response.json()["public_source_note"] == "Personal整理"
    assert request_response.json()["public_download_allowed"] is False

    pending_response = client.get("/api/v1/books/public/pending", headers=auth_headers)
    assert pending_response.status_code == 200
    assert [book["id"] for book in pending_response.json()["items"]] == ["b1"]
    assert pending_response.json()["items"][0]["owner_nickname"]

    approve_response = client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)
    assert approve_response.status_code == 200
    assert approve_response.json()["public_status"] == "public"

    public_response = client.get("/api/v1/books/public", headers=auth_headers)
    assert public_response.status_code == 200
    assert [book["id"] for book in public_response.json()["items"]] == ["b1"]
    public_book = public_response.json()["items"][0]
    assert public_book["public_approved_at"]
    assert public_book["comment_count"] == 0
    assert public_book["public_download_allowed"] is False
    assert public_book["chapter_count"] == 0
    assert public_book["character_count"] == 0


def test_public_library_list_requires_login(client: TestClient, auth_headers: dict[str, str]) -> None:
    owner_progress_response = client.put(
        "/api/v1/books/b1/progress",
        headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 72, "chapter_index": 12},
    )
    assert owner_progress_response.status_code == 200

    client.post("/api/v1/books/b1/share-request", headers=auth_headers)
    client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)

    response = client.get("/api/v1/books/public")

    assert response.status_code == 401


def test_public_book_cover_requires_login(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("public-cover.epub", BytesIO(make_minimal_epub_bytes(chapter_text="public cover", cover_bytes=TINY_PNG_BYTES)), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    private_cover_response = client.get(f"/api/v1/files/books/{book_id}/cover")
    assert private_cover_response.status_code == 401

    client.post(f"/api/v1/books/{book_id}/share-request", headers=auth_headers)
    client.post(f"/api/v1/books/{book_id}/share-request/approve", headers=auth_headers)

    public_response = client.get("/api/v1/books/public", headers=auth_headers)
    assert public_response.status_code == 200
    public_book = next(book for book in public_response.json()["items"] if book["id"] == book_id)
    assert public_book["cover_url"] == f"/api/v1/files/books/{book_id}/cover"

    cover_response = client.get(public_book["cover_url"])
    assert cover_response.status_code == 401

    cover_response = client.get(public_book["cover_url"], headers=auth_headers)
    assert cover_response.status_code == 200
    assert cover_response.headers["content-type"] == "image/png"
    assert cover_response.content == TINY_PNG_BYTES


def test_epub_download_respects_public_download_policy(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("policy.epub", BytesIO(make_minimal_epub_bytes(chapter_text="policy body")), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    client.post(f"/api/v1/books/{book_id}/share-request", headers=auth_headers, json={"public_download_allowed": False})
    client.post(f"/api/v1/books/{book_id}/share-request/approve", headers=auth_headers)

    invitation_code = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]
    register_response = client.post(
        "/api/v1/auth/register",
        json={"email": "reader@example.com", "invitation_code": invitation_code, "nickname": "读者", "password": "reader-password"},
    )
    reader_headers = {"Authorization": f"Bearer {register_response.json()['access_token']}"}

    # The owner can always download the original epub.
    owner_epub_response = client.get(f"/api/v1/files/books/{book_id}/epub", headers=auth_headers)
    assert owner_epub_response.status_code == 200

    # A non-owner is blocked because the author disabled public downloads, even though the book is public.
    reader_epub_response = client.get(f"/api/v1/files/books/{book_id}/epub", headers=reader_headers)
    assert reader_epub_response.status_code == 404


def test_pdf_download_respects_public_download_policy(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("policy.pdf", BytesIO(b"%PDF-1.4 fake body"), "application/pdf")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    client.post(f"/api/v1/books/{book_id}/share-request", headers=auth_headers, json={"public_download_allowed": False})
    client.post(f"/api/v1/books/{book_id}/share-request/approve", headers=auth_headers)

    invitation_code = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]
    register_response = client.post(
        "/api/v1/auth/register",
        json={"email": "pdf-reader@example.com", "invitation_code": invitation_code, "nickname": "PDF读者", "password": "reader-password"},
    )
    reader_headers = {"Authorization": f"Bearer {register_response.json()['access_token']}"}

    # The owner can always download their own PDF.
    owner_pdf_response = client.get(f"/api/v1/files/books/{book_id}/pdf", headers=auth_headers)
    assert owner_pdf_response.status_code == 200
    owner_ticket_response = client.post(f"/api/v1/files/books/{book_id}/download-ticket", headers=auth_headers)
    assert owner_ticket_response.status_code == 200
    owner_ticket_download = client.get(owner_ticket_response.json()["url"])
    assert owner_ticket_download.status_code == 200
    assert owner_ticket_download.headers["content-disposition"].startswith("attachment")

    # A non-owner must be blocked from both the /pdf and /original endpoints when downloads are disabled.
    reader_pdf_response = client.get(f"/api/v1/files/books/{book_id}/pdf", headers=reader_headers)
    assert reader_pdf_response.status_code == 404
    reader_original_response = client.get(f"/api/v1/files/books/{book_id}/original", headers=reader_headers)
    assert reader_original_response.status_code == 404
    reader_ticket_response = client.post(f"/api/v1/files/books/{book_id}/download-ticket", headers=reader_headers)
    assert reader_ticket_response.status_code == 404

    # Download-disabled public books must still be readable inside the site.
    reader_resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=reader_headers)
    assert reader_resource_response.status_code == 200
    preview_response = client.get(reader_resource_response.json()["file_url"])
    assert preview_response.status_code == 200
    assert preview_response.headers["content-disposition"].startswith("inline")


def test_moderation_rejects_non_pending_book(client: TestClient, auth_headers: dict[str, str]) -> None:
    # b1 has not been submitted for review, so it cannot be approved straight to public.
    response = client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)
    assert response.status_code == 404

    public_response = client.get("/api/v1/books/public", headers=auth_headers)
    assert public_response.json()["total"] == 0


def test_public_library_list_rejects_invalid_bearer_token(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.post("/api/v1/books/b1/share-request", headers=auth_headers)
    client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)

    response = client.get("/api/v1/books/public", headers={"Authorization": "Bearer invalid-token"})

    assert response.status_code == 401


def test_public_library_hides_public_books_that_are_not_ready(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.post("/api/v1/books/b1/share-request", headers=auth_headers)
    client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)

    with client.app.state.db_session_factory() as session:
        book_repository = SqlAlchemyBookRepository(session)
        book = book_repository.get_by_id("b1")
        assert book is not None
        book_repository.save(book.with_changes(status="failed", reader_type="unsupported"))

    public_response = client.get("/api/v1/books/public", headers=auth_headers)
    assert public_response.status_code == 200
    assert public_response.json()["total"] == 0

    detail_response = client.get("/api/v1/books/b1", headers=auth_headers)
    assert detail_response.status_code == 200

    invitation_response = client.post("/api/v1/invitations/me", headers=auth_headers)
    register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "public-failed-reader@example.com",
            "invitation_code": invitation_response.json()["code"],
            "nickname": "Public Failed Reader",
            "password": "reader-password",
        },
    )
    reader_headers = {"Authorization": f"Bearer {register_response.json()['access_token']}"}

    detail_response = client.get("/api/v1/books/b1", headers=reader_headers)
    assert detail_response.status_code == 404

    comment_response = client.post("/api/v1/books/b1/comments", headers=reader_headers, json={"body": "No stale public comments.", "target_type": "book"})
    assert comment_response.status_code == 404


def test_public_library_exposes_work_stats_and_sorts_by_comments(client: TestClient, auth_headers: dict[str, str]) -> None:
    with client.app.state.db_session_factory() as session:
        asset_repository = SqlAlchemyBookAssetRepository(session)
        asset_repository.save(
            create_book_asset(
                asset_type="text_chapter",
                book_id="b1",
                index=1,
                metadata={"title": "第一章", "text_length": 1200},
                path="processed/seed/b1/chapter-1.txt",
            )
        )
        asset_repository.save(
            create_book_asset(
                asset_type="text_chapter",
                book_id="b1",
                index=2,
                metadata={"title": "第二章", "text_length": 800},
                path="processed/seed/b1/chapter-2.txt",
            )
        )
        asset_repository.save(
            create_book_asset(
                asset_type="text_chapter",
                book_id="b2",
                index=1,
                metadata={"title": "第一章", "text_length": 300},
                path="processed/seed/b2/chapter-1.txt",
            )
        )

    for book_id in ("b1", "b2"):
        client.post(f"/api/v1/books/{book_id}/share-request", headers=auth_headers)
        client.post(f"/api/v1/books/{book_id}/share-request/approve", headers=auth_headers)

    client.post("/api/v1/books/b2/comments", headers=auth_headers, json={"body": "More active.", "target_type": "book"})

    public_response = client.get("/api/v1/books/public?sort=comments", headers=auth_headers)

    assert public_response.status_code == 200
    items = public_response.json()["items"]
    assert [book["id"] for book in items[:2]] == ["b2", "b1"]
    b1 = next(book for book in items if book["id"] == "b1")
    assert b1["chapter_count"] == 2
    assert b1["character_count"] == 2000
    assert b1["asset_count"] == 2
    assert b1["last_content_updated_at"]


def test_public_library_searches_share_metadata_and_returns_pagination(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.post(
        "/api/v1/books/b1/share-request",
        headers=auth_headers,
        json={"share_note": "quiet archive signal", "source_note": "curated source", "public_download_allowed": True},
    )
    client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)
    client.post("/api/v1/books/b2/share-request", headers=auth_headers)
    client.post("/api/v1/books/b2/share-request/approve", headers=auth_headers)

    paged_response = client.get("/api/v1/books/public?page=1&page_size=1&sort=title", headers=auth_headers)
    assert paged_response.status_code == 200
    assert paged_response.json()["page"] == 1
    assert paged_response.json()["page_size"] == 1
    assert paged_response.json()["total"] == 2
    assert paged_response.json()["has_more"] is True
    assert len(paged_response.json()["items"]) == 1

    search_response = client.get("/api/v1/books/public?q=archive%20signal", headers=auth_headers)
    assert search_response.status_code == 200
    assert search_response.json()["total"] == 1
    assert search_response.json()["items"][0]["id"] == "b1"


def test_public_book_comments_for_book_and_volume(client: TestClient, auth_headers: dict[str, str]) -> None:
    client.post("/api/v1/books/b1/share-request", headers=auth_headers)
    client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)

    empty_comments_response = client.get("/api/v1/books/b1/comments?target_type=book", headers=auth_headers)
    assert empty_comments_response.status_code == 200
    assert empty_comments_response.json() == {"items": [], "total": 0}

    book_comment_response = client.post(
        "/api/v1/books/b1/comments",
        headers=auth_headers,
        json={"body": "A gentle note.", "target_type": "book"},
    )
    assert book_comment_response.status_code == 200
    assert book_comment_response.json()["body"] == "A gentle note."

    volume_comment_response = client.post(
        "/api/v1/books/b1/comments",
        headers=auth_headers,
        json={"body": "Volume note.", "target_type": "volume", "target_index": 1},
    )
    assert volume_comment_response.status_code == 200

    book_comments_response = client.get("/api/v1/books/b1/comments?target_type=book", headers=auth_headers)
    assert book_comments_response.status_code == 200
    assert book_comments_response.json()["total"] == 1

    volume_comments_response = client.get("/api/v1/books/b1/comments?target_type=volume&target_index=1", headers=auth_headers)
    assert volume_comments_response.status_code == 200
    assert volume_comments_response.json()["items"][0]["body"] == "Volume note."

    paged_comments_response = client.get(
        "/api/v1/books/b1/comments?target_type=book&limit=1&offset=1",
        headers=auth_headers,
    )
    assert paged_comments_response.status_code == 200
    assert paged_comments_response.json() == {"items": [], "total": 1}

    public_response = client.get("/api/v1/books/public", headers=auth_headers)
    assert public_response.json()["items"][0]["comment_count"] == 2

    comment_id = volume_comment_response.json()["id"]
    delete_response = client.delete(f"/api/v1/books/b1/comments/{comment_id}", headers=auth_headers)
    assert delete_response.status_code == 204

    volume_comments_response = client.get("/api/v1/books/b1/comments?target_type=volume&target_index=1", headers=auth_headers)
    assert volume_comments_response.json()["total"] == 0


def test_private_book_comments_are_rejected(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/v1/books/b1/comments",
        headers=auth_headers,
        json={"body": "Nope.", "target_type": "book"},
    )

    assert response.status_code == 404


def test_public_book_progress_is_scoped_to_viewer(client: TestClient, auth_headers: dict[str, str]) -> None:
    # Old imports store an owner fallback on the book itself, separately from
    # each account's current reading_progress row.
    from app.modules.books.repository import SqlAlchemyBookRepository
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id("b1")
        repository.save(book.with_changes(progress_percent=63))
    owner_progress_response = client.put(
        "/api/v1/books/b1/progress",
        headers=auth_headers,
        json={"reader_type": "epub", "progress_percent": 72, "chapter_index": 12},
    )
    assert owner_progress_response.status_code == 200

    client.post("/api/v1/books/b1/share-request", headers=auth_headers)
    client.post("/api/v1/books/b1/share-request/approve", headers=auth_headers)

    invitation_response = client.post("/api/v1/invitations/me", headers=auth_headers)
    register_response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "public-reader@example.com",
            "invitation_code": invitation_response.json()["code"],
            "nickname": "公共读者",
            "password": "reader-password",
        },
    )
    reader_headers = {"Authorization": f"Bearer {register_response.json()['access_token']}"}

    public_response = client.get("/api/v1/books/public", headers=reader_headers)
    assert public_response.status_code == 200
    public_book = public_response.json()["items"][0]
    assert public_book["id"] == "b1"
    assert public_book["is_owned"] is False
    assert public_book["progress_percent"] == 0
    assert public_book["current_chapter"] != "第 12 章"

    initial_progress = client.get("/api/v1/books/b1/progress", headers=reader_headers)
    assert initial_progress.status_code == 200
    assert initial_progress.json()["progress_percent"] == 0
    startup = client.get("/api/v1/books/b1/reader/startup", headers=reader_headers)
    assert startup.status_code == 200
    assert startup.json()["progress"]["progress_percent"] == 0
    assert client.get("/api/v1/books/b1/progress", headers=auth_headers).json()["progress_percent"] == 72

    reader_progress_response = client.put(
        "/api/v1/books/b1/progress",
        headers=reader_headers,
        json={"reader_type": "epub", "progress_percent": 18, "chapter_index": 3},
    )
    assert reader_progress_response.status_code == 200

    detail_response = client.get("/api/v1/books/b1", headers=reader_headers)
    assert detail_response.status_code == 200
    assert detail_response.json()["progress_percent"] == 18
    assert detail_response.json()["current_chapter"] == "第 3 章"

    public_response = client.get("/api/v1/books/public", headers=reader_headers)
    public_book = public_response.json()["items"][0]
    assert public_book["progress_percent"] == 18
    assert public_book["current_chapter"] == "第 3 章"

    owner_detail_response = client.get("/api/v1/books/b1", headers=auth_headers)
    assert owner_detail_response.json()["progress_percent"] == 72
    assert owner_detail_response.json()["current_chapter"] == "第 12 章"
