import json

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from app.modules.uploads.schemas import WorkSourceMetadata
from app.modules.japanese.schemas import JapaneseAiTranslationResponse
from app.core.config import Settings
from app.modules.uploads.source_metadata import (
    build_narou_api_url,
    normalize_kakuyomu_work_url,
    normalize_work_source_url,
    parse_hameln_work_html,
    parse_kakuyomu_work_html,
    parse_narou_api_json,
    parse_pixiv_api_json,
)
from app.modules.uploads.source_metadata_translation import translate_source_metadata


WORK_ID = "16818093090598662135"
SOURCE_URL = f"https://kakuyomu.jp/works/{WORK_ID}"


def source_metadata(**changes: object) -> WorkSourceMetadata:
    values = {
        "author": "犬甘あんず",
        "character_count": 12000,
        "description": "少女たちの恋の物語です。",
        "episode_count": 4,
        "publication_status": "ongoing",
        "source": "kakuyomu",
        "source_url": SOURCE_URL,
        "tags": ["百合", "恋愛"],
        "title": "彼女と私の物語",
    }
    values.update(changes)
    return WorkSourceMetadata(**values)


@pytest.mark.asyncio
async def test_translates_japanese_source_metadata_without_changing_author(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_texts: list[str] = []

    async def fake_translate(
        items: list[tuple[str, str]],
        _settings: Settings,
        **_kwargs: object,
    ) -> JapaneseAiTranslationResponse:
        requested_texts.extend(text for _, text in items)
        return JapaneseAiTranslationResponse(
            model="test-model",
            translations=["她与我的故事", "少女们的恋爱故事。", "百合", "恋爱"],
        )

    monkeypatch.setattr(
        "app.modules.uploads.source_metadata_translation.translate_japanese_metadata",
        fake_translate,
    )
    metadata = source_metadata()
    translated = await translate_source_metadata(
        metadata,
        Settings(ai_translation_api_key="secret", ai_translation_base_url="https://ai.example.com/v1", ai_translation_model="test-model"),
    )

    assert requested_texts == [metadata.title, metadata.description, *metadata.tags]
    assert translated.title == "她与我的故事"
    assert translated.original_title == metadata.title
    assert translated.description == "少女们的恋爱故事。"
    assert translated.tags == ["百合", "恋爱"]
    assert translated.author == metadata.author
    assert translated.translation_status == "translated"


@pytest.mark.asyncio
async def test_source_metadata_translation_skips_non_japanese_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unexpected_translate(*_args: object) -> JapaneseAiTranslationResponse:
        raise AssertionError("AI translation should not be called")

    monkeypatch.setattr(
        "app.modules.uploads.source_metadata_translation.translate_japanese_metadata",
        unexpected_translate,
    )
    metadata = source_metadata(title="English title", description="English summary", tags=["romance"])

    translated = await translate_source_metadata(
        metadata,
        Settings(ai_translation_api_key="secret", ai_translation_base_url="https://ai.example.com/v1"),
    )

    assert translated == metadata
    assert translated.translation_status == "not_needed"


@pytest.mark.asyncio
async def test_source_metadata_translation_failure_keeps_original_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failed_translate(*_args: object) -> JapaneseAiTranslationResponse:
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(
        "app.modules.uploads.source_metadata_translation.translate_japanese_metadata",
        failed_translate,
    )
    metadata = source_metadata()

    translated = await translate_source_metadata(
        metadata,
        Settings(ai_translation_api_key="secret", ai_translation_base_url="https://ai.example.com/v1"),
    )

    assert translated.title == metadata.title
    assert translated.description == metadata.description
    assert translated.tags == metadata.tags
    assert translated.translation_status == "unavailable"


@pytest.mark.asyncio
async def test_strict_source_metadata_translation_raises_instead_of_degrading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A whole-book job must not publish silently-untranslated metadata.

    The soft fallback above is right for browsing a link, but a job stored that
    degraded result and reused it forever, so the book landed in the library
    with a Japanese title, description and tags and nothing ever retried it.
    """

    async def failed_translate(*_args: object, **_kwargs: object) -> JapaneseAiTranslationResponse:
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(
        "app.modules.uploads.source_metadata_translation.translate_japanese_metadata",
        failed_translate,
    )

    with pytest.raises(RuntimeError):
        await translate_source_metadata(
            source_metadata(),
            Settings(ai_translation_api_key="secret", ai_translation_base_url="https://ai.example.com/v1"),
            strict=True,
        )


def test_parses_kakuyomu_next_data() -> None:
    state = {
        f"Work:{WORK_ID}": {
            "author": {"__ref": "UserAccount:author-1"},
            "catchphrase": "逃げた先で、また私は恋をする",
            "introduction": "作品紹介です。",
            "ogImageUrl": "https://cdn-static.kakuyomu.jp/cover.png",
            "publicEpisodeCount": 96,
            "serialStatus": "COMPLETED",
            "tagLabels": ["ガールズラブ", "百合", "百合"],
            "title": "影を抱く私と光を灯すあなた",
            "totalCharacterCount": 242820,
            "schedule": {"__ref": f"WorkSchedule:{WORK_ID}"},
            "tableOfContentsV2": [
                {"__ref": "TableOfContentsChapter:chapter-1"},
            ],
        },
        "TableOfContentsChapter:chapter-1": {
            "chapter": {"__ref": "Chapter:chapter-1"},
            "episodeUnions": [
                {"__ref": "Episode:episode-1"},
                {"__ref": "Episode:episode-2"},
            ],
        },
        "Chapter:chapter-1": {"level": 1, "title": "第一章"},
        "Episode:episode-1": {"id": "episode-1", "title": "第1話 はじまり"},
        "Episode:episode-2": {"id": "episode-2", "title": "第2話 再会"},
        "UserAccount:author-1": {"activityName": "恋みぞれ雨", "name": "glislily1111"},
        f"WorkSchedule:{WORK_ID}": {"description": "毎日 17:00"},
    }
    payload = {"props": {"pageProps": {"__APOLLO_STATE__": state}}}
    html = f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(payload, ensure_ascii=False)}</script></html>'

    metadata = parse_kakuyomu_work_html(html, source_url=SOURCE_URL, work_id=WORK_ID)

    assert metadata.title == "影を抱く私と光を灯すあなた"
    assert metadata.author == "恋みぞれ雨"
    assert metadata.description == "逃げた先で、また私は恋をする\n\n作品紹介です。"
    assert metadata.tags == ["ガールズラブ", "百合"]
    assert metadata.publication_status == "completed"
    assert metadata.episode_count == 96
    assert metadata.character_count == 242820
    assert metadata.schedule_label == "毎日 17:00"
    assert metadata.schedule_time == "17:00"
    assert metadata.schedule_timezone == "Asia/Tokyo"
    assert [(episode.index, episode.title, episode.section_title) for episode in metadata.episodes] == [
        (1, "第1話 はじまり", "第一章"),
        (2, "第2話 再会", "第一章"),
    ]
    assert metadata.episodes[0].url == f"{SOURCE_URL}/episodes/episode-1"


def test_keeps_kakuyomu_schedule_label_without_guessing_a_time() -> None:
    state = {
        f"Work:{WORK_ID}": {
            "author": {"__ref": "UserAccount:author-1"},
            "publicEpisodeCount": 1,
            "schedule": {"__ref": f"WorkSchedule:{WORK_ID}"},
            "serialStatus": "ONGOING",
            "title": "作品",
        },
        "UserAccount:author-1": {"activityName": "作者"},
        f"WorkSchedule:{WORK_ID}": {"description": "不定期更新"},
    }
    payload = {"props": {"pageProps": {"__APOLLO_STATE__": state}}}
    html = f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(payload, ensure_ascii=False)}</script>'

    metadata = parse_kakuyomu_work_html(html, source_url=SOURCE_URL, work_id=WORK_ID)

    assert metadata.schedule_label == "不定期更新"
    assert metadata.schedule_time is None
    assert metadata.schedule_timezone is None


def test_rejects_non_kakuyomu_urls() -> None:
    for url in ("https://example.com/works/1", "https://kakuyomu.jp/users/author"):
        with pytest.raises(HTTPException) as error:
            normalize_kakuyomu_work_url(url)
        assert error.value.status_code == 400


def test_normalizes_kakuyomu_query_and_www_host() -> None:
    assert normalize_kakuyomu_work_url(f"https://www.kakuyomu.jp/works/{WORK_ID}/?from=share") == (SOURCE_URL, WORK_ID)


def test_extracts_work_from_shared_text_episode_links_and_missing_schemes() -> None:
    cases = {
        f"作品链接：kakuyomu.jp/works/{WORK_ID}/episodes/16818093090600000000。": ("kakuyomu", SOURCE_URL),
        "http://ncode.syosetu.com/n2267be/12/?from=share": ("narou", "https://ncode.syosetu.com/n2267be/"),
        "https://www.syosetu.org/novel/134043/7.html#main": ("hameln", "https://syosetu.org/novel/134043/"),
        "阅读 https://www.pixiv.net/ja/novel/series/755013?share=1": ("pixiv", "https://www.pixiv.net/novel/series/755013"),
        "pixiv.net/en/novel/show.php?id=7402143&utm_source=share": ("pixiv", "https://www.pixiv.net/novel/show.php?id=7402143"),
    }
    for raw_value, expected in cases.items():
        target = normalize_work_source_url(raw_value)
        assert (target.provider, target.source_url) == expected


def test_normalizes_other_supported_work_urls() -> None:
    cases = {
        "https://ncode.syosetu.com/n2267be/?from=top": ("narou", "https://ncode.syosetu.com/n2267be/", "n2267be"),
        "https://novel18.syosetu.com/n1234ab/": ("narou", "https://novel18.syosetu.com/n1234ab/", "n1234ab"),
        "https://www.syosetu.org/novel/134043/": ("hameln", "https://syosetu.org/novel/134043/", "134043"),
        "https://pixiv.net/novel/series/755013?share=1": ("pixiv", "https://www.pixiv.net/novel/series/755013", "755013"),
        "https://www.pixiv.net/novel/show.php?id=7402143&utm_source=test": ("pixiv", "https://www.pixiv.net/novel/show.php?id=7402143", "7402143"),
    }
    for raw_url, expected in cases.items():
        target = normalize_work_source_url(raw_url)
        assert (target.provider, target.source_url, target.work_id) == expected


def test_uses_the_separate_narou_adult_api() -> None:
    regular = normalize_work_source_url("https://ncode.syosetu.com/n2267be/")
    adult = normalize_work_source_url("https://novel18.syosetu.com/n1015hi/")

    assert build_narou_api_url(regular) == "https://api.syosetu.com/novelapi/api/?out=json&ncode=N2267BE"
    assert build_narou_api_url(adult) == "https://api.syosetu.com/novel18api/api/?out=json&ncode=N1015HI"


def test_parses_narou_official_api_response() -> None:
    payload = json.dumps(
        [
            {"allcount": 1},
            {
                "end": 1,
                "general_all_no": 783,
                "keyword": "R15 異世界転移 ファンタジー",
                "length": 9513053,
                "story": "作品紹介",
                "title": "Ｒｅ：ゼロから始める異世界生活",
                "writer": "鼠色猫/長月達平",
            },
        ],
        ensure_ascii=False,
    ).encode()

    metadata = parse_narou_api_json(payload, source_url="https://ncode.syosetu.com/n2267be/")

    assert metadata.source == "narou"
    assert metadata.author == "鼠色猫/長月達平"
    assert metadata.episode_count == 783
    assert metadata.character_count == 9513053
    assert metadata.publication_status == "ongoing"
    assert metadata.tags == ["R15", "異世界転移", "ファンタジー"]


def test_parses_hameln_microdata() -> None:
    html = """
    <meta property="og:image" content="https://img.syosetu.org/ogp_134043">
    <div class="ss">
      <span itemprop="name">作品タイトル</span>
      <span itemprop="author"><a>作者名</a></span>
      <span itemprop="genre"><a>原作名</a></span>
      <span itemprop="keywords"><a>タグA</a></span>
    </div>
    <div class="ss">一行目<br>二行目</div>
    <a href="./1.html">第一話</a><a href="./2.html">第二話</a>
    """

    metadata = parse_hameln_work_html(html, source_url="https://syosetu.org/novel/134043/")

    assert metadata.source == "hameln"
    assert metadata.title == "作品タイトル"
    assert metadata.author == "作者名"
    assert metadata.description == "一行目\n二行目"
    assert metadata.tags == ["原作名", "タグA"]
    assert metadata.episode_count == 2


def test_parses_pixiv_series_and_single_novel_responses() -> None:
    series_payload = json.dumps(
        {
            "error": False,
            "body": {
                "caption": "シリーズ<br>紹介",
                "isConcluded": True,
                "publishedContentCount": 3,
                "publishedTotalCharacterCount": 12050,
                "tags": ["百合"],
                "title": "pixiv シリーズ",
                "userName": "作者",
            },
        },
        ensure_ascii=False,
    ).encode()
    novel_payload = json.dumps(
        {
            "error": False,
            "body": {
                "characterCount": 4502,
                "description": "短編<br>紹介",
                "tags": {"tags": [{"tag": "百合"}, {"tag": "短編"}]},
                "title": "pixiv 短編",
                "userName": "作者",
            },
        },
        ensure_ascii=False,
    ).encode()

    series = parse_pixiv_api_json(series_payload, source_url="https://www.pixiv.net/novel/series/755013", kind="series")
    novel = parse_pixiv_api_json(novel_payload, source_url="https://www.pixiv.net/novel/show.php?id=7402143", kind="novel")

    assert (series.episode_count, series.character_count, series.publication_status) == (3, 12050, "completed")
    assert series.description == "シリーズ\n紹介"
    assert (novel.episode_count, novel.character_count, novel.publication_status) == (1, 4502, "completed")
    assert novel.tags == ["百合", "短編"]


def test_source_metadata_endpoint_requires_authentication(client: TestClient) -> None:
    response = client.post("/api/v1/uploads/source-metadata", json={"url": SOURCE_URL})
    assert response.status_code == 401


def test_source_metadata_endpoint_returns_parsed_result(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_lookup(url: str) -> WorkSourceMetadata:
        assert url == SOURCE_URL
        return WorkSourceMetadata(
            author="恋みぞれ雨",
            character_count=242820,
            description="简介",
            episode_count=96,
            publication_status="completed",
            source="kakuyomu",
            source_url=SOURCE_URL,
            tags=["百合"],
            title="影を抱く私と光を灯すあなた",
        )

    monkeypatch.setattr("app.modules.uploads.api.fetch_work_source_metadata", fake_lookup)
    response = client.post("/api/v1/uploads/source-metadata", headers=auth_headers, json={"url": SOURCE_URL})

    assert response.status_code == 200
    assert response.json()["title"] == "影を抱く私と光を灯すあなた"
