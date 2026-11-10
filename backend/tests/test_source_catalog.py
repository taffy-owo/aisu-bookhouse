import pytest

from app.core.config import Settings
from app.modules.book_assets.repository import InMemoryBookAssetRepository, create_book_asset
from app.modules.books.factory import create_uploaded_book
from app.modules.books.repository import InMemoryBookRepository
from app.modules.books.source_catalog import is_generic_chapter_title, sync_owned_source_catalog
from app.modules.books.source_episode_matching import extract_episode_number, infer_source_episode_scope, match_source_episode_assets
from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata


SOURCE_URL = "https://kakuyomu.jp/works/2912051602530709792"


def test_only_plain_fallback_names_are_considered_generic() -> None:
    assert is_generic_chapter_title("第 1 章")
    assert is_generic_chapter_title("第２話")
    assert is_generic_chapter_title("Chapter 3")
    assert not is_generic_chapter_title("第2话 第一位客人")
    assert not is_generic_chapter_title("第一章 魔法人偶屋")


def test_source_episode_matching_uses_episode_number_and_skips_cover_document() -> None:
    assets = [
        create_book_asset(
            asset_type="text_chapter",
            book_id="book-1",
            index=1,
            metadata={"source": "OEBPS/cover.xhtml", "title": "第 1 章"},
            path="cover.txt",
        ),
        create_book_asset(
            asset_type="text_chapter",
            book_id="book-1",
            index=2,
            metadata={"source": "manual_append", "title": "第48话 无法接受"},
            path="chapter-48.txt",
        ),
    ]
    episodes = [
        WorkSourceEpisode(index=1, title="第1話", url=f"{SOURCE_URL}/episodes/1"),
        WorkSourceEpisode(index=48, title="第48話", url=f"{SOURCE_URL}/episodes/48"),
    ]

    matches = match_source_episode_assets(assets, episodes)

    assert extract_episode_number("第４８話 納得いかない") == 48
    assert [(asset.index, episode.index) for asset, episode in matches] == [(2, 48)]


def test_source_scope_uses_second_numbering_run_for_compiled_second_part() -> None:
    assets = [
        create_book_asset(
            asset_type="text_chapter",
            book_id="book-1",
            index=1,
            metadata={"source": "OEBPS/preface.xhtml", "title": "前言"},
            path="preface.txt",
        ),
        create_book_asset(
            asset_type="text_chapter",
            book_id="book-1",
            index=2,
            metadata={"title": "爱25 怜24"},
            path="part.txt",
        ),
        create_book_asset(
            asset_type="text_chapter",
            book_id="book-1",
            index=3,
            metadata={"title": "第2话 第二部正文"},
            path="chapter-2.txt",
        ),
    ]
    episodes = [
        WorkSourceEpisode(index=1, title="第1話", url=f"{SOURCE_URL}/episodes/1"),
        WorkSourceEpisode(index=2, title="第2話", url=f"{SOURCE_URL}/episodes/2"),
        WorkSourceEpisode(index=3, title="最終話", url=f"{SOURCE_URL}/episodes/3"),
        WorkSourceEpisode(index=4, title="第1話", url=f"{SOURCE_URL}/episodes/4"),
        WorkSourceEpisode(index=5, title="第2話", url=f"{SOURCE_URL}/episodes/5"),
        WorkSourceEpisode(index=6, title="第3話", url=f"{SOURCE_URL}/episodes/6"),
    ]

    scope = infer_source_episode_scope("作品 第二部：Sweet Sister", assets, episodes)

    assert scope is not None
    assert (scope.start_index, scope.covered_through_index, scope.end_index) == (4, 5, 6)
    assert scope.covered_indexes == {4, 5}
    assert scope.pending_indexes == {6}


@pytest.mark.asyncio
async def test_source_catalog_sync_renames_fallback_and_preserves_manual_title(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    book = create_uploaded_book(
        author="作者",
        book_id="book-1",
        file_label="book.txt",
        kind="novel",
        owner_id="owner-1",
        reader_type="text",
        tags=(),
        title="作品",
    ).with_changes(status="ready", source_url=SOURCE_URL, current_chapter="第 1 章")
    book_repository = InMemoryBookRepository([book])
    asset_repository = InMemoryBookAssetRepository()
    asset_repository.save_many(
        [
            create_book_asset(
                asset_type="text_chapter",
                book_id=book.id,
                index=1,
                metadata={"title": "第 1 章"},
                path="chapter-1.txt",
            ),
            create_book_asset(
                asset_type="text_chapter",
                book_id=book.id,
                index=2,
                metadata={"source": "manual_append", "title": "第2话 第一位客人"},
                path="chapter-2.txt",
            ),
        ]
    )
    metadata = WorkSourceMetadata(
        author="八星 こはく",
        character_count=4076,
        description="",
        episode_count=2,
        publication_status="ongoing",
        source="kakuyomu",
        source_url=SOURCE_URL,
        tags=[],
        title="作品",
        episodes=[
            WorkSourceEpisode(index=1, title="第1話 魔法人形屋『ルクス』", url=f"{SOURCE_URL}/episodes/1", section_title="プロローグ"),
            WorkSourceEpisode(index=2, title="第2話 初めての客", url=f"{SOURCE_URL}/episodes/2", section_title="第一章 魔法人形屋『ルクス』"),
        ],
    )

    async def fake_fetch(_url: str) -> WorkSourceMetadata:
        return metadata

    async def fake_translate(
        labels: list[str],
        _settings: Settings,
        *,
        source_work_title: str,
        translated_work_title: str,
    ) -> dict[str, str]:
        assert source_work_title == "作品"
        assert translated_work_title == "作品"
        return {
            "第1話 魔法人形屋『ルクス』": "第1话 魔法人偶屋『卢克斯』",
            "プロローグ": "序章",
            "第一章 魔法人形屋『ルクス』": "第一章 魔法人偶屋『卢克斯』",
        }

    monkeypatch.setattr("app.modules.books.source_catalog.fetch_work_source_metadata", fake_fetch)
    monkeypatch.setattr("app.modules.books.source_catalog.translate_catalog_labels", fake_translate)

    result = await sync_owned_source_catalog(
        owner_id="owner-1",
        book_id=book.id,
        book_repository=book_repository,
        asset_repository=asset_repository,
        settings=Settings(),
    )

    assert result is not None
    assert (result.catalog_count, result.matched_count, result.renamed_count) == (2, 2, 1)
    chapters = asset_repository.list_by_book(book.id, "text_chapter")
    assert chapters[0].metadata["title"] == "第1话 魔法人偶屋『卢克斯』"
    assert chapters[0].metadata["source_section_title"] == "序章"
    assert chapters[1].metadata["title"] == "第2话 第一位客人"
    assert chapters[1].metadata["source_section_title"] == "第一章 魔法人偶屋『卢克斯』"
    assert book_repository.get_owned("owner-1", book.id).current_chapter == "第1话 魔法人偶屋『卢克斯』"
