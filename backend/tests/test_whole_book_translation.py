import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZipFile

from fastapi.testclient import TestClient
import httpx
import pytest

import app.modules.translations.service as translation_service
import app.modules.translations.source_text as source_text
from app.core.config import Settings
from app.modules.book_assets.repository import create_book_asset
from app.modules.books.factory import create_uploaded_book
from app.modules.translations.ai import ProviderUnavailableError, is_transient_status
from app.modules.translations.epub import append_translation_epub, build_translation_epub
from app.modules.translations.text import build_translation_txt
from app.modules.processing.processors.txt_processor import split_chapters
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.translations.source_text import SourceBodyHTMLParser, SourceChapter
from app.modules.japanese.schemas import JapaneseAiTranslationResponse
from app.modules.uploads import worker
from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata


EMPTY_INTERPRETATION: dict[str, object] = {"interpretations": [], "open_questions": []}
JAPANESE_PAIR = ["彼女は笑った。", "私は頷いた。"]
CHINESE_PAIR = ["她笑了。", "我点了点头。"]


class StopWorkerLoop(BaseException):
    """Breaks out of the worker's infinite loop without tripping its except clause."""


def test_quality_failure_is_persisted_and_retry_clears_only_failure_report(client,auth_headers,monkeypatch):
    configure_translation_provider(client,auth_headers)
    async def metadata(*args,**kwargs):
        return make_source_metadata()
    async def fail(*args,**kwargs):
        raise translation_service.TranslationQualityError(2,1,[translation_service.QualityIssue('第 24 段专名测试不一致','hard',24)])
    monkeypatch.setattr(translation_service,'fetch_work_source_metadata',metadata)
    monkeypatch.setattr(translation_service,'_download_source_chapters',fail)
    created=client.post('/api/v1/translations',headers=auth_headers,json={
        'source_url':make_source_metadata().source_url,'model':'literary-model'}).json()
    with client.app.state.db_session_factory() as session:
        record=session.get(WholeBookTranslationJobRecord,created['id'])
        record.quality_report_json={'1':{'chunks':[]}}
        session.commit()
    asyncio.run(translation_service.process_translation_job(job_id=created['id'],
        settings=client.app.state.settings,session_factory=client.app.state.db_session_factory))
    with client.app.state.db_session_factory() as session:
        record=session.get(WholeBookTranslationJobRecord,created['id'])
        assert record.quality_report_json['_failure']['chapter']==2
        assert translation_service._translation_quality_summary(record)==('warning',1)
    result=client.post('/api/v1/translations/'+created['id']+'/retry',headers=auth_headers)
    assert result.status_code==200
    with client.app.state.db_session_factory() as session:
        record=session.get(WholeBookTranslationJobRecord,created['id'])
        assert record.quality_report_json=={'1':{'chunks':[]}}


@pytest.mark.parametrize('refused', [False, True])
def test_terminal_failure_is_not_presented_as_manual_pause(client, auth_headers, monkeypatch, refused):
    from app.modules.translations.ai import ContentFilteredError
    configure_translation_provider(client, auth_headers)
    async def fake_metadata(*args, **kwargs):
        return make_source_metadata()
    async def fail_download(*args, **kwargs):
        raise ContentFilteredError('提供方明确拒绝', diagnostics={'reason':'recitation', 'phase':'译文校对', 'chapter':2}) if refused else RuntimeError('测试永久错误')
    monkeypatch.setattr(translation_service, 'fetch_work_source_metadata', fake_metadata)
    monkeypatch.setattr(translation_service, '_download_source_chapters', fail_download)
    created = client.post('/api/v1/translations', headers=auth_headers, json={
        'source_url':make_source_metadata().source_url, 'model':'literary-model'}).json()
    asyncio.run(translation_service.process_translation_job(job_id=created['id'],
        settings=client.app.state.settings, session_factory=client.app.state.db_session_factory))
    job = next(j for j in client.get('/api/v1/translations', headers=auth_headers).json() if j['id']==created['id'])
    assert job['status'] == 'failed'
    assert '暂停' not in job['message']
    assert '草稿已保留' in job['message']
    assert ('停止自动重试' in job['message']) == refused
    if refused:
        assert 'reason=recitation' in job['error_message']
        assert '译文校对' in job['message']
        with client.app.state.db_session_factory() as session:
            record=session.get(WholeBookTranslationJobRecord,created['id'])
            assert record.quality_report_json['_provider_failure']['reason']=='recitation'


@pytest.mark.parametrize("failure_stage", ["first_chapter", "memory"])
def test_successful_drafts_survive_sibling_and_memory_failures(client, auth_headers, monkeypatch, failure_stage):
    configure_translation_provider(client, auth_headers)
    metadata = make_source_metadata()
    metadata = metadata.model_copy(update={"episode_count":2, "episodes":[
        *metadata.episodes,
        WorkSourceEpisode(index=2,title="第二話",url=metadata.source_url+"/episodes/2"),
    ]})
    chapters=[SourceChapter(index=i,title="测试",url=e.url,paragraphs=["彼女は笑った。"])
              for i,e in enumerate(metadata.episodes,1)]
    async def get_metadata(*args, **kwargs):
        return metadata
    async def get_chapters(*args, **kwargs):
        return chapters
    async def get_titles(*args, **kwargs):
        return ["第一话","第二话"]
    async def get_memory(*args, **kwargs):
        return {"glossary":[],"characters":[]}
    window_calls=[]
    async def window(*, positions, **kwargs):
        window_calls.append(list(positions))
        return [ValueError("第 1 话质检不通过") if failure_stage=="first_chapter" and len(window_calls)==1 and i==0
                else (["她笑了。"], {"chunks":[],"paragraph_count":1}) for i in positions]
    memory_calls=0
    async def update_memory(*args, **kwargs):
        nonlocal memory_calls
        memory_calls+=1
        if failure_stage=="memory" and memory_calls==1:
            raise ProviderUnavailableError("memory temporarily unavailable")
        return {"glossary":[],"characters":[]}
    monkeypatch.setattr(translation_service,"fetch_work_source_metadata",get_metadata)
    monkeypatch.setattr(translation_service,"_download_source_chapters",get_chapters)
    monkeypatch.setattr(translation_service,"translate_source_metadata",get_metadata)
    monkeypatch.setattr(translation_service,"_translate_chapter_titles",get_titles)
    monkeypatch.setattr(translation_service,"_build_series_memory",get_memory)
    monkeypatch.setattr(translation_service,"_translate_chapter_window",window)
    monkeypatch.setattr(translation_service,"_update_series_memory",update_memory)
    created=client.post("/api/v1/translations",headers=auth_headers,json={"source_url":metadata.source_url,"model":"literary-model","request_concurrency":2}).json()
    kwargs={"job_id":created["id"],"settings":client.app.state.settings,"session_factory":client.app.state.db_session_factory}
    asyncio.run(translation_service.process_translation_job(**kwargs))
    with client.app.state.db_session_factory() as session:
        record=session.get(WholeBookTranslationJobRecord,created["id"])
        assert record.status in {"failed","queued"}
        output=translation_service._translated_chapter_path(client.app.state.settings,record.user_id,record.id,chapters[1].index)
        assert (output.parent.parent / "drafts" / output.name).is_file()
        record.status="queued"
        record.lease_owner=None
        record.lease_expires_at=None
        session.commit()
    asyncio.run(translation_service.process_translation_job(**kwargs))
    assert window_calls == ([[0,1],[0]] if failure_stage=="first_chapter" else [[0,1]])
    job=client.get("/api/v1/translations",headers=auth_headers).json()[0]
    assert job["status"]=="ready" and job["completed_chapters"]==2
    reader=client.get(f"/api/v1/books/{job['book_id']}/reader",headers=auth_headers).json()
    assert reader["chapter_count"]==2


def test_translated_outer_brackets_follow_multi_paragraph_source_boundaries() -> None:
    assert translation_service.align_translated_outer_brackets("『お父様、お母様。", "父亲，母亲。") == "『父亲，母亲。"
    assert translation_service.align_translated_outer_brackets("お母様。", "「母亲。」") == "母亲。"
    assert translation_service.align_translated_outer_brackets("クリスタ』", "「克里斯塔」") == "克里斯塔』"
    assert translation_service.align_translated_outer_brackets("「大丈夫？」", "没事吗？") == "「没事吗？」"


def test_translated_outer_brackets_remove_redundant_dialogue_quotes() -> None:
    source = "「はい……ありがとうございます、ルルナリア様」"
    expected = "「好的……谢谢您，露露娜莉亚大人。」"

    assert translation_service.align_translated_outer_brackets(source, "“好的……谢谢您，露露娜莉亚大人。”") == expected
    assert translation_service.align_translated_outer_brackets(source, "「“好的……谢谢您，露露娜莉亚大人。”」") == expected
    assert translation_service.align_translated_outer_brackets(source, '"好的……谢谢您，露露娜莉亚大人。"') == expected

    assert translation_service.align_translated_outer_brackets("「じゃが、おぬし", "“但是，你——”") == "「但是，你——"
    assert translation_service.align_translated_outer_brackets("知りたいと言うのじゃろうなぁ」", "“——还是想知道吧。”") == "——还是想知道吧。」"


def test_translated_outer_brackets_keep_quotes_without_a_source_dialogue_wrapper() -> None:
    assert translation_service.align_translated_outer_brackets("彼女は『はい』と言った。", "她说：“好的。”") == "她说：“好的。”"
    assert translation_service.align_translated_outer_brackets("（注記）", "“注释”") == "（“注释”）"


def test_source_update_checkpoint_normalizes_redundant_dialogue_quotes() -> None:
    checkpoint = translation_service._normalize_translated_checkpoint(
        {"paragraphs": ["「もう少し抱っこ」", "地の文。"]},
        {"index": 53, "paragraphs": ["「“还要再抱一会儿。”」", "旁白。"]},
    )

    assert checkpoint["paragraphs"] == ["「还要再抱一会儿。」", "旁白。"]


def test_appending_translation_epub_preserves_existing_inline_images() -> None:
    base = build_translation_epub(
        title="插图连载",
        author="作者",
        description="简介",
        source_url="https://example.com/work",
        chapters=[{"index": 1, "title": "第一话", "paragraphs": ["已有正文。"]}],
    )
    source_buffer = BytesIO()
    with ZipFile(BytesIO(base), "r") as source, ZipFile(source_buffer, "w") as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == "META-INF/container.xml":
                data = data.replace(
                    b"urn:oasis:names:tc:opendocument:xmlns:container",
                    b"urn:oasis-open-database-xml:ns:container",
                )
            if info.filename == "OEBPS/chapters/0001.xhtml":
                data = data.replace(b"</article>", b'<img src="../images/inline.png" alt="inline"/></article>')
            target.writestr(info, data)
        target.writestr("OEBPS/images/inline.png", b"preserved-image")

    updated = append_translation_epub(
        original_epub=source_buffer.getvalue(),
        chapters=[{"index": 2, "title": "第二话", "paragraphs": ["新增译文。"]}],
    )

    with ZipFile(BytesIO(updated), "r") as archive:
        assert archive.read("OEBPS/images/inline.png") == b"preserved-image"
        assert b'../images/inline.png' in archive.read("OEBPS/chapters/0001.xhtml")
        appended_path = next(name for name in archive.namelist() if name.startswith("OEBPS/aisu-updates/"))
        assert "新增译文" in archive.read(appended_path).decode("utf-8")
        assert "第二话" in archive.read("OEBPS/nav.xhtml").decode("utf-8")


def test_chapter_window_uses_global_concurrency_and_preserves_source_order(monkeypatch: object) -> None:
    chapters = [
        SourceChapter(
            index=index,
            title=f"第{index}話",
            paragraphs=[f"第{index}話の冒頭。", f"第{index}話の末尾。"],
            url=f"https://example.com/{index}",
        )
        for index in range(1, 5)
    ]
    active = 0
    maximum_active = 0
    previous_tails: dict[int, list[str]] = {}

    async def fake_translate(*, chapter: SourceChapter, previous_chapter_tail: list[str], request_limiter: asyncio.Semaphore, **_kwargs: object) -> tuple[list[str], dict[str, object]]:
        nonlocal active, maximum_active
        previous_tails[chapter.index] = previous_chapter_tail
        async with request_limiter:
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.02)
            active -= 1
        return [f"第{chapter.index}话开头。", f"第{chapter.index}话结尾。"], {"chapter": chapter.index}

    monkeypatch.setattr(translation_service, "_translate_chapter", fake_translate)
    results = asyncio.run(
        translation_service._translate_chapter_window(
            positions=[0, 1, 2, 3],
            chapters=chapters,
            memory={"characters": [], "glossary": []},
            settings=object(),
            request_concurrency=4,
        )
    )

    assert maximum_active == 4
    assert [result[1]["chapter"] for result in results if not isinstance(result, BaseException)] == [1, 2, 3, 4]
    assert previous_tails[1] == []
    assert previous_tails[2] == ["第1話の冒頭。", "第1話の末尾。"]
    assert previous_tails[4] == ["第3話の冒頭。", "第3話の末尾。"]


def test_chapter_window_rejects_more_chapters_than_global_limit() -> None:
    chapters = [
        SourceChapter(index=index, title=str(index), paragraphs=["本文。"], url=f"https://example.com/{index}")
        for index in range(1, 4)
    ]

    with pytest.raises(ValueError, match="并行章节窗口"):
        asyncio.run(
            translation_service._translate_chapter_window(
                positions=[0, 1, 2],
                chapters=chapters,
                memory={},
                settings=object(),
                request_concurrency=2,
            )
        )


def test_chapter_window_retries_only_transiently_failed_lanes(monkeypatch: object) -> None:
    chapters = [
        SourceChapter(index=index, title=str(index), paragraphs=["本文。"], url=f"https://example.com/{index}")
        for index in range(1, 4)
    ]
    attempts: dict[int, int] = {}

    async def fake_translate(*, chapter: SourceChapter, **_kwargs: object) -> tuple[list[str], dict[str, object]]:
        attempts[chapter.index] = attempts.get(chapter.index, 0) + 1
        if chapter.index == 2 and attempts[chapter.index] == 1:
            raise ProviderUnavailableError("AI 渠道连续返回空白或无效 JSON，已用尽重试")
        return [f"第{chapter.index}话。"], {"chapter": chapter.index}

    monkeypatch.setattr(translation_service, "_translate_chapter", fake_translate)
    monkeypatch.setattr(translation_service, "TRANSLATION_WINDOW_RETRY_DELAYS_SECONDS", (0.0,))
    results = asyncio.run(
        translation_service._translate_chapter_window(
            positions=[0, 1, 2],
            chapters=chapters,
            memory={},
            settings=object(),
            request_concurrency=3,
        )
    )

    assert attempts == {1: 1, 2: 2, 3: 1}
    assert [result[1]["chapter"] for result in results if not isinstance(result, BaseException)] == [1, 2, 3]


def test_chapter_window_does_not_retry_non_transient_failures(monkeypatch: object) -> None:
    chapter = SourceChapter(index=1, title="1", paragraphs=["本文。"], url="https://example.com/1")
    attempts = 0

    async def fake_translate(**_kwargs: object) -> tuple[list[str], dict[str, object]]:
        nonlocal attempts
        attempts += 1
        raise ValueError("确定性的输入错误")

    monkeypatch.setattr(translation_service, "_translate_chapter", fake_translate)
    monkeypatch.setattr(translation_service, "TRANSLATION_WINDOW_RETRY_DELAYS_SECONDS", (0.0, 0.0))
    results = asyncio.run(
        translation_service._translate_chapter_window(
            positions=[0],
            chapters=[chapter],
            memory={},
            settings=object(),
            request_concurrency=1,
        )
    )

    assert attempts == 1
    assert isinstance(results[0], ValueError)


def run_chapter_translation(
    monkeypatch: object,
    *,
    paragraphs: list[str],
    responses: list[dict[str, object]] | None = None,
    responder: object = None,
    memory: dict[str, object] | None = None,
) -> tuple[list[str], dict[str, object], list[dict[str, object]]]:
    """Drive _translate_chapter against a scripted provider and report every call made."""
    calls: list[dict[str, object]] = []
    queued = iter(responses or [])

    async def fake_ai(_settings: object, **kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        if responder is not None:
            return responder(kwargs)
        return next(queued)

    monkeypatch.setattr(translation_service, "request_structured_ai", fake_ai)
    translated, report = asyncio.run(
        translation_service._translate_chapter(
            chapter=SourceChapter(index=1, title="第一話", paragraphs=paragraphs, url="https://example.com/1"),
            memory=memory if memory is not None else {"characters": [], "glossary": [], "voices": []},
            next_preview="",
            settings=object(),
            translation_preferences="",
        )
    )
    return translated, report, calls


def make_source_metadata() -> WorkSourceMetadata:
    return WorkSourceMetadata(
        author="原作者",
        character_count=120,
        description="作品简介",
        episode_count=1,
        publication_status="completed",
        source="kakuyomu",
        source_url="https://kakuyomu.jp/works/16800000000000000000",
        tags=["百合"],
        title="原作标题",
        episodes=[
            WorkSourceEpisode(
                index=1,
                title="第一話",
                url="https://kakuyomu.jp/works/16800000000000000000/episodes/16800000000000000001",
            )
        ],
    )


def test_compiled_epub_can_bootstrap_source_updates_without_one_to_one_chapters(tmp_path: Path) -> None:
    settings = translation_service.Settings(storage_root=str(tmp_path))
    metadata = WorkSourceMetadata(
        author="原作者",
        character_count=600,
        description="简介",
        episode_count=6,
        publication_status="ongoing",
        source="kakuyomu",
        source_url="https://kakuyomu.jp/works/16800000000000000000",
        tags=[],
        title="原作",
        episodes=[
            WorkSourceEpisode(index=index, title=f"第{index}話", url=f"https://example.com/{index}")
            for index in range(1, 7)
        ],
    )
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
        original_file_path="originals/owner-1/book-2/original.epub",
        source_url=metadata.source_url,
        status="ready",
    )
    chapter_directory = tmp_path / "processed" / "book-2"
    chapter_directory.mkdir(parents=True)
    (chapter_directory / "one.txt").write_text("合并章节\n\n已有译文一。", encoding="utf-8")
    (chapter_directory / "two.txt").write_text("第2话\n\n已有译文二。", encoding="utf-8")
    chapters = [
        create_book_asset(
            asset_type="text_chapter",
            book_id=book.id,
            index=1,
            metadata={"title": "合并章节"},
            path="processed/book-2/one.txt",
        ),
        create_book_asset(
            asset_type="text_chapter",
            book_id=book.id,
            index=2,
            metadata={"title": "第2话"},
            path="processed/book-2/two.txt",
        ),
    ]

    translation_service.prepare_source_update_translation_project(
        book=book,
        chapters=chapters,
        handled_episode_indexes={4, 5},
        has_chapter_images=False,
        metadata=metadata,
        settings=settings,
    )

    project_path = translation_service._translation_project_path(settings, book.owner_id, book.id)
    manifest = translation_service._read_json(project_path / "project.json")
    assert manifest["bootstrap_kind"] == "compiled_uploaded_epub"
    assert manifest["handled_episode_indexes"] == [4, 5]
    assert sorted(path.name for path in (project_path / "translated").glob("*.json")) == [
        "local-00001.json",
        "local-00002.json",
    ]


def test_local_project_positions_are_not_treated_as_source_episode_indexes(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    translation_service._write_json_atomic(
        project_path / "project.json",
        {"handled_episode_indexes": [4, 5]},
    )
    translation_service._write_json_atomic(
        project_path / "translated" / "local-00006.json",
        {"index": 6, "title": "本地第六章", "paragraphs": ["正文。"]},
    )
    translation_service._write_json_atomic(
        project_path / "translated" / "00008.json",
        {"index": 8, "title": "源站第八话", "paragraphs": ["正文。"]},
    )

    assert translation_service._source_update_project_handled_indexes(project_path) == {4, 5, 8}


def test_catalog_title_contexts_include_neighbors_and_bounded_opening() -> None:
    chapters = [
        SourceChapter(index=1, title="それぞれの、", paragraphs=["前文" * 1000], url="https://example.com/1"),
        SourceChapter(index=2, title="次なる一手", paragraphs=["本文"], url="https://example.com/2"),
    ]

    contexts = translation_service._catalog_title_contexts(chapters)

    assert contexts[0]["previous_title"] is None
    assert contexts[0]["next_title"] == "次なる一手"
    assert len(contexts[0]["opening_excerpt"]) == translation_service.CATALOG_TITLE_EXCERPT_CHARACTERS
    assert contexts[1]["previous_title"] == "それぞれの、"


def test_catalog_title_memory_keeps_translation_terms_but_bounds_history() -> None:
    memory = {
        "characters": [{"source": f"人物{index}"} for index in range(100)],
        "glossary": [{"source": "令嬢", "target": "大小姐"}],
        "timeline": ["不应发送"],
        "previous_summary": "摘要" * 2000,
    }

    compact = translation_service._catalog_title_memory(memory)

    assert len(compact["characters"]) <= 20
    assert compact["glossary"] == [{"source": "令嬢", "target": "大小姐"}]
    assert "timeline" not in compact
    assert len(compact["previous_summary"]) == 500


def test_series_memory_sampling_covers_the_whole_work() -> None:
    chapters = [
        SourceChapter(index=index, title=f"第 {index} 话", paragraphs=[f"正文 {index}" * 80], url=f"https://example.com/{index}")
        for index in range(1, 101)
    ]

    excerpts = translation_service._series_memory_excerpts(chapters, budget=8000, max_samples=8)

    assert excerpts[0]["index"] == 1
    assert excerpts[-1]["index"] == 100
    assert any(40 <= int(item["index"]) <= 60 for item in excerpts)


def test_terminology_preflight_scans_names_in_unsampled_chapters() -> None:
    chapters = [
        SourceChapter(index=index, title=f"第 {index} 话", paragraphs=["普通的正文。"], url=f"https://example.com/{index}")
        for index in range(1, 101)
    ]
    chapters[48] = SourceChapter(
        index=49,
        title="第 49 话",
        paragraphs=["そこでシルヴィアが静かに振り返った。"],
        url="https://example.com/49",
    )

    candidates = translation_service._terminology_candidates(chapters)

    assert any(item["source"] == "シルヴィア" for item in candidates)


def test_locked_glossary_is_preserved_across_model_memory_updates() -> None:
    committed = {
        "glossary": [{"source": "シルヴィア", "target": "西尔维娅", "kind": "person", "locked": True}],
        "_terminology_version": 1,
    }
    model_update = {
        "glossary": [{"source": "シルヴィア", "target": "西尔维亚", "kind": "person"}],
    }

    memory = translation_service._coerce_memory(model_update, fallback=committed)

    assert memory["_terminology_version"] == 1
    assert memory["glossary"] == [
        {"source": "シルヴィア", "target": "西尔维娅", "kind": "person", "locked": True}
    ]


def test_locked_glossary_checks_every_matching_paragraph() -> None:
    issues = translation_service._deterministic_quality_issues(
        ["シルヴィアは笑った。", "シルヴィアは頷いた。"],
        ["西尔维娅笑了。", "西尔维亚点了点头。"],
        {"glossary": [{"source": "シルヴィア", "target": "西尔维娅", "locked": True}]},
    )

    matching = [issue for issue in issues if "シルヴィア" in issue.message]
    assert len(matching) == 1
    assert matching[0].severity == "hard"
    assert matching[0].paragraph == 2


def test_locked_media_title_allows_contextual_book_title_marks() -> None:
    issues = translation_service._deterministic_quality_issues(
        ["プリンキュアを一緒に見た。"],
        ["我们一起看了布丁Q娃。"],
        {"glossary": [{"source": "プリンキュア", "target": "《布丁Q娃》", "locked": True}]},
    )

    assert not any("プリンキュア" in issue.message for issue in issues)


def test_name_only_locked_term_has_deterministic_repair_fallback() -> None:
    memory = {"glossary": [{"source": "プリンキュア", "target": "《布丁Q娃》", "locked": True}]}

    repaired = translation_service._repair_name_only_locked_terms(
        ["「プリンキュアー！"],
        ["「普林Q娃——！"],
        memory,
    )

    assert repaired == ["「布丁Q娃——！"]
    assert not any(
        issue.severity == "hard"
        for issue in translation_service._deterministic_quality_issues(
            ["「プリンキュアー！"],
            repaired,
            memory,
        )
    )


def test_series_memory_keeps_foundation_recent_entries_and_summary() -> None:
    characters = [
        {"source": f"角色{index}-" + ("原名" * 12), "target": f"译名{index}-" + ("中文" * 12)}
        for index in range(800)
    ]
    memory = translation_service._coerce_memory(
        {
            "characters": characters,
            "relationships": [],
            "addressing": [],
            "glossary": [],
            "voices": [],
            "timeline": [],
            "motifs": [],
            "open_questions": [],
            "previous_summary": "上一章关键情节" * 200,
        }
    )

    kept_characters = memory["characters"]
    assert isinstance(kept_characters, list)
    assert len(kept_characters) < len(characters)
    assert kept_characters[0] == characters[0]
    assert kept_characters[-1] == characters[-1]
    assert str(memory["previous_summary"]).startswith("上一章关键情节")


@pytest.mark.parametrize(
    ("source", "translated", "expected"),
    [
        ("if : 友情エンドの後で", "if : 友情结局之后", "if：友情结局之后"),
        ("EX04-10:わたしの片割れ", "EX０４-１０:我的另一半", "EX04-10：我的另一半"),
        ("if：ほしいもの、ひとつ（１）", "if：想要的东西（１）", "if：想要的东西（1）"),
        ("それぞれの、", "各自的、", "各自的……"),
        ("幼馴染と、婚約者と、＿＿と", "与青梅竹马、未婚夫、＿＿", "与青梅竹马、未婚夫、——"),
    ],
)
def test_normalizes_catalog_title_punctuation(source: str, translated: str, expected: str) -> None:
    assert translation_service._normalize_catalog_title(source, translated) == expected


def test_rewrites_real_translation_checkpoint_titles(tmp_path: object) -> None:
    settings = translation_service.Settings(storage_root=str(tmp_path))
    chapter = SourceChapter(index=1, title="私の推しは。", paragraphs=["本文"], url="https://example.com/1")
    path = translation_service._translated_chapter_path(settings, "user-1", "job-1", 1)
    translation_service._write_json_atomic(
        path,
        {"index": 1, "title": "我的推是。", "paragraphs": ["正文"], "memory_after": {}},
    )

    rewritten = translation_service._rewrite_translated_checkpoint_titles(
        settings=settings,
        user_id="user-1",
        job_id="job-1",
        chapters=[chapter],
        translated_titles=["我推的人是……"],
    )

    assert rewritten[0]["title"] == "我推的人是……"
    assert translation_service._read_json(path)["title"] == "我推的人是……"


def test_catalog_title_translation_uses_small_ordered_concurrent_batches(monkeypatch: object) -> None:
    episodes = [
        WorkSourceEpisode(index=index, title=f"原题{index}", url=f"https://example.com/{index}")
        for index in range(1, 26)
    ]
    metadata = make_source_metadata().model_copy(update={"episode_count": 25, "episodes": episodes})
    chapters = [
        SourceChapter(index=episode.index, title=episode.title, paragraphs=[f"第{episode.index}话正文"], url=episode.url)
        for episode in episodes
    ]
    active = 0
    maximum_active = 0
    batch_sizes: list[int] = []

    async def fake_catalog_titles(titles: list[str], *_args: object, **_kwargs: object) -> JapaneseAiTranslationResponse:
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        batch_sizes.append(len(titles))
        await asyncio.sleep(0.01)
        active -= 1
        return JapaneseAiTranslationResponse(model="test", translations=[f"译{title}" for title in titles])

    monkeypatch.setattr(translation_service, "translate_japanese_catalog_titles", fake_catalog_titles)
    translated = asyncio.run(
        translation_service._translate_chapter_titles(
            metadata,
            metadata.model_copy(update={"title": "译名"}),
            chapters,
            {"characters": [], "glossary": []},
            object(),
            request_concurrency=4,
        )
    )

    assert sorted(batch_sizes) == [1, 12, 12]
    assert maximum_active == 3
    assert translated == [f"译原题{index}" for index in range(1, 26)]


def test_catalog_title_translation_splits_gateway_timeouts_without_losing_order(monkeypatch: object) -> None:
    episodes = [
        WorkSourceEpisode(index=index, title=f"原题{index}", url=f"https://example.com/{index}")
        for index in range(1, 8)
    ]
    metadata = make_source_metadata().model_copy(update={"episode_count": 7, "episodes": episodes})
    chapters = [
        SourceChapter(index=episode.index, title=episode.title, paragraphs=["正文"], url=episode.url)
        for episode in episodes
    ]
    attempted_sizes: list[int] = []

    async def fake_catalog_titles(titles: list[str], *_args: object, **_kwargs: object) -> JapaneseAiTranslationResponse:
        attempted_sizes.append(len(titles))
        if len(titles) > 3:
            request = httpx.Request("POST", "https://provider.example.com/v1/chat/completions")
            response = httpx.Response(524, request=request)
            raise httpx.HTTPStatusError("gateway timeout", request=request, response=response)
        return JapaneseAiTranslationResponse(model="test", translations=[f"译{title}" for title in titles])

    monkeypatch.setattr(translation_service, "translate_japanese_catalog_titles", fake_catalog_titles)
    translated = asyncio.run(
        translation_service._translate_chapter_titles(
            metadata,
            metadata.model_copy(update={"title": "译名"}),
            chapters,
            {"characters": [], "glossary": []},
            object(),
            request_concurrency=4,
        )
    )

    assert attempted_sizes[0] == 7
    assert max(attempted_sizes[1:]) <= 4
    assert translated == [f"译原题{index}" for index in range(1, 8)]


def test_catalog_title_translation_retains_previous_title_when_single_item_gateway_fails(monkeypatch: object) -> None:
    metadata = make_source_metadata().model_copy(
        update={
            "episodes": [WorkSourceEpisode(index=1, title="私の推しは。", url="https://example.com/1")],
        }
    )
    translated_metadata = metadata.model_copy(
        update={
            "title": "译名",
            "episodes": [WorkSourceEpisode(index=1, title="我推的是。", url="https://example.com/1")],
        }
    )
    calls = 0

    async def always_timeout(*_args: object, **_kwargs: object) -> JapaneseAiTranslationResponse:
        nonlocal calls
        calls += 1
        request = httpx.Request("POST", "https://provider.example.com/v1/chat/completions")
        response = httpx.Response(524, request=request)
        raise httpx.HTTPStatusError("gateway timeout", request=request, response=response)

    monkeypatch.setattr(translation_service, "translate_japanese_catalog_titles", always_timeout)
    translated = asyncio.run(
        translation_service._translate_chapter_titles(
            metadata,
            translated_metadata,
            [SourceChapter(index=1, title="私の推しは。", paragraphs=["正文"], url="https://example.com/1")],
            {"characters": [], "glossary": []},
            object(),
            request_concurrency=4,
        )
    )

    assert calls == 2
    assert translated == ["我推的是。"]


def configure_translation_provider(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.put(
        "/api/v1/auth/me/ai-settings",
        headers=auth_headers,
        json={
            "provider_base_url": "https://provider.example.com/v1",
            "api_key": "private-test-key",
            "translation_model": "literary-model",
            "audiobook_provider_base_url": "",
            "audiobook_api_key": "",
            "audiobook_tts_model": "",
            "audiobook_tts_voice": "",
        },
    )
    assert response.status_code == 200


def prepare_translated_serial_project(
    client: TestClient,
    auth_headers: dict[str, str],
    *,
    auto_translate_updates: bool = False,
) -> tuple[str, str, bytes, WorkSourceMetadata]:
    configure_translation_provider(client, auth_headers)
    source_metadata = make_source_metadata().model_copy(
        update={
            "episode_count": 2,
            "publication_status": "ongoing",
            "episodes": [
                make_source_metadata().episodes[0],
                WorkSourceEpisode(
                    index=2,
                    title="第二話",
                    url="https://kakuyomu.jp/works/16800000000000000000/episodes/16800000000000000002",
                ),
            ],
        }
    )
    original_epub = build_translation_epub(
        title="连载译本",
        author="译者",
        description="简介",
        source_url=source_metadata.source_url,
        chapters=[
            {
                "index": 1,
                "title": "第一话",
                "source_title": "第一話",
                "source_url": source_metadata.episodes[0].url,
                "paragraphs": ["既有译文。"],
            }
        ],
    )
    uploaded = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("serial-translation.epub", BytesIO(original_epub), "application/epub+zip")},
        data={
            "title": "连载译本",
            "author": "译者",
            "publication_status": "ongoing",
            "source_url": source_metadata.source_url,
        },
    )
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]

    with client.app.state.db_session_factory() as session:
        from app.modules.books.repository import SqlAlchemyBookRepository
        from app.modules.users.models import UserRecord

        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_owned(user.id, book_id)
        assert book is not None
        repository.save(
            book.with_changes(
                auto_translate_updates=auto_translate_updates,
                source_episode_count=2,
                source_update_count=1,
            )
        )
        project = translation_service._translation_project_path(client.app.state.settings, user.id, book_id)
        translation_service._write_json_atomic(
            project / "project.json",
            {"memory": {"characters": [], "glossary": [], "previous_summary": ""}},
        )
        translation_service._write_json_atomic(
            project / "translated" / "00001.json",
            {
                "index": 1,
                "title": "第一话",
                "source_title": "第一話",
                "source_url": source_metadata.episodes[0].url,
                "paragraphs": ["既有译文。"],
                "memory_after": {"characters": [], "glossary": [], "previous_summary": ""},
            },
        )
        user_id = user.id
    return user_id, book_id, original_epub, source_metadata


def test_source_body_parser_preserves_paragraphs_and_removes_ruby_reading() -> None:
    parser = SourceBodyHTMLParser("kakuyomu")
    parser.feed(
        '<h1 class="widget-episodeTitle">第一話</h1><div class="widget-episodeBody js-episode-body">'
        '<p>私<ruby>達<rt>たち</rt></ruby>は歩いた。</p><p class="blank"><br /></p><p>次の段落。</p></div>'
    )

    assert parser.title == "第一話"
    assert parser.paragraphs == ["私達は歩いた。", "次の段落。"]


def test_narou_source_parser_excludes_preface_and_afterword() -> None:
    parser = SourceBodyHTMLParser("narou")
    parser.feed(
        '<div class="p-novel__body">'
        '<div class="js-novel-text p-novel__text p-novel__text--preface"><p>作者前言。</p></div>'
        '<div class="js-novel-text p-novel__text p-novel__text--body"><p>第一段。</p><p>第二段。</p></div>'
        '<div class="js-novel-text p-novel__text p-novel__text--afterword"><p>作者后记。</p></div>'
        '</div>'
    )

    assert parser.paragraphs == ["第一段。", "第二段。"]


def test_narou_source_parser_reads_body_without_modifier_class() -> None:
    # Narou dropped the --body modifier: the prose block now carries only the
    # base p-novel__text class, while preface/afterword keep their modifiers.
    parser = SourceBodyHTMLParser("narou")
    parser.feed(
        '<div class="p-novel__body">'
        '<div class="js-novel-text p-novel__text p-novel__text--preface"><p>作者前言。</p></div>'
        '<div class="js-novel-text p-novel__text"><p>第一段。</p><p>第二段。</p></div>'
        '<div class="js-novel-text p-novel__text p-novel__text--afterword"><p>作者后记。</p></div>'
        '</div>'
    )

    assert parser.paragraphs == ["第一段。", "第二段。"]


@pytest.mark.parametrize(
    ("source_url", "expected_headers"),
    [
        ("https://novel18.syosetu.com/n1234ab/1/", {"Cookie": "over18=yes"}),
        ("https://ncode.syosetu.com/n1234ab/1/", None),
    ],
)
def test_narou_adult_source_sends_age_verification_cookie(
    monkeypatch: pytest.MonkeyPatch,
    source_url: str,
    expected_headers: dict[str, str] | None,
) -> None:
    captured_headers: dict[str, str] | None = None

    async def fake_fetch_limited_bytes(
        _client: httpx.AsyncClient,
        _url: str,
        *,
        accept: str,
        headers: dict[str, str] | None = None,
    ) -> bytes:
        nonlocal captured_headers
        assert accept == "text/html,application/xhtml+xml"
        captured_headers = headers
        return b'<div class="js-novel-text p-novel__text"><p>chapter body</p></div>'

    monkeypatch.setattr(source_text, "fetch_limited_bytes", fake_fetch_limited_bytes)
    chapter = asyncio.run(
        source_text.fetch_source_chapter(
            WorkSourceEpisode(index=1, title="episode 1", url=source_url),
            "narou",
        )
    )

    assert chapter.paragraphs == ["chapter body"]
    assert captured_headers == expected_headers


def test_hameln_chapter_uses_flaresolverr_after_cloudflare_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str] = {}

    async def rejected(*_args: object, **_kwargs: object) -> bytes:
        from fastapi import HTTPException

        raise HTTPException(status_code=502, detail="来源网站暂时拒绝访问")

    async def solved(_client: httpx.AsyncClient, endpoint: str, source_url: str) -> bytes:
        captured.update(endpoint=endpoint, source_url=source_url)
        return '<div id="honbun"><p>解锁后的正文。</p></div>'.encode()

    monkeypatch.setattr(source_text, "fetch_limited_bytes", rejected)
    monkeypatch.setattr(source_text, "_fetch_with_flaresolverr", solved)
    chapter = asyncio.run(
        source_text.fetch_source_chapter(
            WorkSourceEpisode(index=1, title="episode 1", url="https://syosetu.org/novel/263758/1.html"),
            "hameln",
            flaresolverr_url="http://127.0.0.1:8191",
        )
    )

    assert chapter.paragraphs == ["解锁后的正文。"]
    assert captured == {
        "endpoint": "http://127.0.0.1:8191",
        "source_url": "https://syosetu.org/novel/263758/1.html",
    }


def test_translation_epub_has_navigation_source_and_chapters() -> None:
    payload = build_translation_epub(
        title="译名",
        author="作者",
        description="简介",
        source_url="https://example.com/work",
        chapters=[{"title": "第一话", "paragraphs": ["第一段。", "第二段。"]}],
    )

    with ZipFile(BytesIO(payload)) as archive:
        assert archive.read("mimetype") == b"application/epub+zip"
        assert "https://example.com/work" in archive.read("OEBPS/content.opf").decode("utf-8")
        chapter = archive.read("OEBPS/chapters/0001.xhtml").decode("utf-8")
        assert "第一话" in chapter
        assert "第二段。" in chapter


def test_translation_txt_round_trips_common_episode_titles() -> None:
    chapters = [
        {"title": f"第{index}话 标题{index}", "paragraphs": [f"这是第{index}话正文。", "第二段。"]}
        for index in range(1, 10)
    ]

    rebuilt = build_translation_txt(chapters=chapters).decode("utf-8")
    parsed = split_chapters(rebuilt)

    assert [chapter["title"] for chapter in parsed] == [f"第{index}话 标题{index}" for index in range(1, 10)]
    assert "这是第9话正文。" in parsed[-1]["content"]


def test_translation_job_is_deduplicated_and_uses_unified_notifications(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    first = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={
            "source_url": make_source_metadata().source_url,
            "model": "literary-model",
            "custom_instructions": " 角色名使用既定译法。 ",
            "request_concurrency": 4,
        },
    )
    second = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    )

    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["model"] == "literary-model"
    assert first.json()["request_concurrency"] == 4
    with client.app.state.db_session_factory() as session:
        saved_job = session.get(WholeBookTranslationJobRecord, first.json()["id"])
        assert saved_job.custom_instructions == "角色名使用既定译法。"
        assert saved_job.request_concurrency == 4
    notifications = client.get("/api/v1/translations/notifications", headers=auth_headers).json()
    assert notifications["active_count"] == 1
    assert notifications["items"][0]["status"] == "queued"


def test_translation_job_snapshots_saved_account_prompt(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    updated = client.put(
        "/api/v1/auth/me/ai-settings",
        headers=auth_headers,
        json={"translation_prompt": "人名采用指定译法；对话保持克制。", "translation_concurrency": 3},
    )
    assert updated.status_code == 200

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    with client.app.state.db_session_factory() as session:
        saved_job = session.get(WholeBookTranslationJobRecord, created["id"])
        assert saved_job.custom_instructions == "人名采用指定译法；对话保持克制。"
        assert saved_job.request_concurrency == 3


def test_translation_job_can_pause_resume_and_change_concurrency(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    adjusted = client.patch(
        f"/api/v1/translations/{created['id']}/concurrency",
        headers=auth_headers,
        json={"request_concurrency": 4},
    )
    assert adjusted.status_code == 200
    assert adjusted.json()["request_concurrency"] == 4

    paused_while_queued = client.post(f"/api/v1/translations/{created['id']}/pause", headers=auth_headers)
    assert paused_while_queued.status_code == 200
    assert paused_while_queued.json()["status"] == "paused"
    assert not paused_while_queued.json()["pause_requested"]
    notifications = client.get("/api/v1/translations/notifications", headers=auth_headers).json()
    assert notifications["active_count"] == 0

    resumed = client.post(f"/api/v1/translations/{created['id']}/resume", headers=auth_headers)
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "queued"
    assert resumed.json()["request_concurrency"] == 4

    lease_owner = "pause-test-worker"
    assert translation_service.claim_next_translation_job(client.app.state.db_session_factory, lease_owner) == created["id"]
    pause_requested = client.post(f"/api/v1/translations/{created['id']}/pause", headers=auth_headers)
    assert pause_requested.status_code == 200
    assert pause_requested.json()["status"] == "processing"
    assert pause_requested.json()["pause_requested"]

    lease_token = translation_service.current_translation_lease_owner.set(lease_owner)
    try:
        with pytest.raises(translation_service.TranslationPaused):
            translation_service._raise_if_translation_pause_requested(created["id"], client.app.state.db_session_factory)
    finally:
        translation_service.current_translation_lease_owner.reset(lease_token)

    jobs = client.get("/api/v1/translations", headers=auth_headers).json()
    paused = next(job for job in jobs if job["id"] == created["id"])
    assert paused["status"] == "paused"
    assert paused["request_concurrency"] == 4
    assert paused["current_chapter_index"] is None


@pytest.mark.parametrize("concurrency", [0, 17])
def test_translation_job_rejects_invalid_runtime_concurrency(
    client: TestClient,
    auth_headers: dict[str, str],
    concurrency: int,
) -> None:
    response = client.patch(
        "/api/v1/translations/missing/concurrency",
        headers=auth_headers,
        json={"request_concurrency": concurrency},
    )

    assert response.status_code == 422


def test_channel_model_sets_its_own_concurrency_ceiling(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    """Concurrency limits come from the channel config, not a hardcoded name."""
    configure_translation_provider(client, auth_headers)
    channel = client.get("/api/v1/ai-channels", headers=auth_headers).json()[0]
    updated = client.patch(
        f"/api/v1/ai-channels/{channel['id']}",
        headers=auth_headers,
        json={
            "models": [
                {"model": "literary-model", "max_concurrency": 4},
                {"model": "fast-model", "max_concurrency": 8},
            ]
        },
    )

    assert updated.status_code == 200
    ceilings = {item["model"]: item["max_concurrency"] for item in updated.json()["models"]}
    assert ceilings == {"literary-model": 4, "fast-model": 8}

    options = client.get("/api/v1/ai-channels/translation-models", headers=auth_headers).json()
    assert {option["model"]: option["max_concurrency"] for option in options} == ceilings


def test_clear_completed_translation_jobs_keeps_active_jobs(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    from datetime import datetime, timezone
    from app.modules.users.models import UserRecord

    with client.app.state.db_session_factory() as session:
        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        now = datetime.now(timezone.utc)
        for job_id, job_status in (("ready-job", "ready"), ("failed-job-to-clear", "failed"), ("processing-job", "processing")):
            session.add(WholeBookTranslationJobRecord(
                id=job_id,
                user_id=user_id,
                book_id=None,
                source_url=f"https://kakuyomu.jp/works/{job_id}",
                source_provider="kakuyomu",
                title=job_id,
                author="作者",
                status=job_status,
                stage=job_status,
                progress=100 if job_status == "ready" else 50,
                total_chapters=2,
                completed_chapters=2 if job_status == "ready" else 1,
                current_chapter_index=None,
                message=None,
                error_message="失败" if job_status == "failed" else None,
                model="literary-model",
                provider_base_url="https://provider.example.com/v1",
                provider_api_key_encrypted="encrypted",
                metadata_json={},
                catalog_json=[],
                memory_json={},
                quality_report_json={},
                acknowledged=False,
                retry_count=0,
                created_at=now,
                updated_at=now,
                started_at=now,
                finished_at=now if job_status in {"ready", "failed"} else None,
            ))
        session.commit()

    for job_id in ("ready-job", "failed-job-to-clear", "processing-job"):
        checkpoint = translation_service._job_root(client.app.state.settings, user_id, job_id) / "source" / "00001.json"
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.write_text("{}", encoding="utf-8")

    cleared = client.delete("/api/v1/translations/completed", headers=auth_headers)

    assert cleared.status_code == 200
    assert cleared.json() == {"deleted": 2}
    remaining = client.get("/api/v1/translations", headers=auth_headers).json()
    assert [job["id"] for job in remaining] == ["processing-job"]
    assert not translation_service._job_root_path(client.app.state.settings, user_id, "ready-job").exists()
    assert not translation_service._job_root_path(client.app.state.settings, user_id, "failed-job-to-clear").exists()
    assert translation_service._job_root_path(client.app.state.settings, user_id, "processing-job").exists()


def test_deletes_one_finished_translation_record_without_deleting_its_book(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    from datetime import datetime, timezone
    from app.modules.users.models import UserRecord

    with client.app.state.db_session_factory() as session:
        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        now = datetime.now(timezone.utc)
        session.add(WholeBookTranslationJobRecord(
            id="failed-job-delete-one",
            user_id=user_id,
            book_id=None,
            source_url="https://kakuyomu.jp/works/123",
            source_provider="kakuyomu",
            title="失败任务",
            author="作者",
            status="failed",
            stage="failed",
            progress=30,
            total_chapters=2,
            completed_chapters=1,
            current_chapter_index=None,
            message=None,
            error_message="失败",
            model="literary-model",
            provider_base_url="https://provider.example.com/v1",
            provider_api_key_encrypted="encrypted",
            metadata_json={},
            catalog_json=[],
            memory_json={},
            quality_report_json={},
            acknowledged=False,
            retry_count=0,
            created_at=now,
            updated_at=now,
            started_at=now,
            finished_at=now,
        ))
        session.commit()

    checkpoint = translation_service._job_root(client.app.state.settings, user_id, "failed-job-delete-one") / "translated" / "00001.json"
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.write_text("{}", encoding="utf-8")

    deleted = client.delete("/api/v1/translations/failed-job-delete-one", headers=auth_headers)

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": 1}
    assert not translation_service._job_root_path(client.app.state.settings, user_id, "failed-job-delete-one").exists()
    assert all(job["id"] != "failed-job-delete-one" for job in client.get("/api/v1/translations", headers=auth_headers).json())


def test_deleting_book_removes_its_translation_draft_and_notification(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    from app.modules.users.models import UserRecord

    with client.app.state.db_session_factory() as session:
        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        now = datetime.now(timezone.utc)
        session.add(WholeBookTranslationJobRecord(
            id="deleted-book-review-job",
            user_id=user_id,
            book_id="b2",
            job_kind="source_update",
            source_url="https://kakuyomu.jp/works/deleted-book-review",
            source_provider="kakuyomu",
            title="删除图书后不应残留的译稿",
            author="作者",
            status="review",
            stage="review",
            progress=100,
            total_chapters=1,
            completed_chapters=1,
            current_chapter_index=None,
            message="1 话更新译稿已完成，等待确认",
            error_message=None,
            model="literary-model",
            provider_base_url="https://provider.example.com/v1",
            provider_api_key_encrypted="encrypted",
            metadata_json={},
            translated_metadata_json={},
            catalog_json=[],
            memory_json={},
            quality_report_json={},
            acknowledged=False,
            retry_count=0,
            created_at=now,
            updated_at=now,
            started_at=now,
            finished_at=now,
        ))
        session.commit()

    checkpoint = translation_service._job_root(client.app.state.settings, user_id, "deleted-book-review-job") / "translated" / "00001.json"
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.write_text("{}", encoding="utf-8")
    assert any(
        job["id"] == "deleted-book-review-job"
        for job in client.get("/api/v1/translations/notifications", headers=auth_headers).json()["items"]
    )

    deleted = client.delete("/api/v1/books/b2", headers=auth_headers)

    assert deleted.status_code == 204
    with client.app.state.db_session_factory() as session:
        assert session.get(WholeBookTranslationJobRecord, "deleted-book-review-job") is None
    assert not translation_service._job_root_path(client.app.state.settings, user_id, "deleted-book-review-job").exists()
    assert all(
        job["id"] != "deleted-book-review-job"
        for job in client.get("/api/v1/translations/notifications", headers=auth_headers).json()["items"]
    )


def test_notifications_hide_legacy_translation_draft_for_deleted_book(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    from app.modules.books.models import BookRecord
    from app.modules.users.models import UserRecord

    with client.app.state.db_session_factory() as session:
        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        now = datetime.now(timezone.utc)
        book = session.get(BookRecord, "b2")
        book.status = "deleted"
        session.add(WholeBookTranslationJobRecord(
            id="legacy-orphan-review-job",
            user_id=user_id,
            book_id="b2",
            job_kind="source_update",
            source_url="https://kakuyomu.jp/works/legacy-orphan",
            source_provider="kakuyomu",
            title="旧版遗留通知",
            author="作者",
            status="review",
            stage="review",
            progress=100,
            total_chapters=1,
            completed_chapters=1,
            current_chapter_index=None,
            message="等待确认",
            error_message=None,
            model="literary-model",
            provider_base_url="https://provider.example.com/v1",
            provider_api_key_encrypted="encrypted",
            metadata_json={},
            translated_metadata_json={},
            catalog_json=[],
            memory_json={},
            quality_report_json={},
            acknowledged=False,
            retry_count=0,
            created_at=now,
            updated_at=now,
            started_at=now,
            finished_at=now,
        ))
        session.commit()

    notifications = client.get("/api/v1/translations/notifications", headers=auth_headers).json()

    assert all(job["id"] != "legacy-orphan-review-job" for job in notifications["items"])
    with client.app.state.db_session_factory() as session:
        assert session.get(WholeBookTranslationJobRecord, "legacy-orphan-review-job") is not None


@pytest.mark.parametrize(
    ("failed_kind", "successful_kind", "failed_has_book", "success_is_newer", "hidden"),
    [
        ("source_update", "source_update", True, True, True),
        ("whole_book", "whole_book", False, True, True),
        ("whole_book", "whole_book", True, True, True),
        ("source_update", "whole_book", True, True, False),
        ("whole_book", "source_update", True, True, False),
        ("source_update", "source_update", True, False, False),
        ("whole_book", "whole_book", True, False, False),
    ],
)
def test_notifications_match_failed_attempt_to_newer_successful_work(
    client: TestClient,
    auth_headers: dict[str, str],
    failed_kind: str,
    successful_kind: str,
    failed_has_book: bool,
    success_is_newer: bool,
    hidden: bool,
) -> None:
    from app.modules.books.models import BookRecord
    from app.modules.users.models import UserRecord

    with client.app.state.db_session_factory() as session:
        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        book_id = session.query(BookRecord.id).filter(BookRecord.owner_id == user_id).first()[0]
        older = datetime(2026, 10, 18, 16, 31, tzinfo=timezone.utc)
        newer = datetime(2026, 10, 18, 22, 2, tzinfo=timezone.utc)
        common = {
            "user_id": user_id,
            "source_url": "https://kakuyomu.jp/works/superseded",
            "source_provider": "kakuyomu",
            "title": "被替代任务",
            "author": "作者",
            "progress": 100,
            "total_chapters": 1,
            "current_chapter_index": None,
            "model": "gemini-3-flash",
            "provider_base_url": "https://provider.example.com/v1",
            "provider_api_key_encrypted": "encrypted",
            "metadata_json": {},
            "translated_metadata_json": {},
            "catalog_json": [],
            "memory_json": {},
            "quality_report_json": {},
            "acknowledged": False,
            "retry_count": 0,
            "created_at": older,
            "started_at": older,
        }
        session.add(WholeBookTranslationJobRecord(
            **common,
            book_id=book_id if failed_has_book else None,
            job_kind=failed_kind,
            id="superseded-failed-job",
            status="failed",
            stage="failed",
            completed_chapters=0,
            message="失败",
            error_message="provider_rejected",
            updated_at=older if success_is_newer else newer,
            finished_at=older if success_is_newer else newer,
        ))
        session.add(WholeBookTranslationJobRecord(
            **common,
            book_id=book_id,
            job_kind=successful_kind,
            id="newer-success-job",
            status="ready" if successful_kind == "whole_book" else "review",
            stage="ready" if successful_kind == "whole_book" else "review",
            completed_chapters=1,
            message="等待审核",
            error_message=None,
            updated_at=newer if success_is_newer else older,
            finished_at=None,
        ))
        session.commit()

    notifications = client.get("/api/v1/translations/notifications", headers=auth_headers).json()

    ids = {job["id"] for job in notifications["items"]}
    assert "newer-success-job" in ids
    assert ("superseded-failed-job" not in ids) == hidden

    acknowledged = client.post("/api/v1/translations/newer-success-job/acknowledge", headers=auth_headers)
    assert acknowledged.status_code == 200
    success = next(job for job in notifications["items"] if job["id"] == "newer-success-job")
    assert acknowledged.json()["updated_at"] == success["updated_at"]
    after = client.get("/api/v1/translations/notifications", headers=auth_headers).json()
    assert ("superseded-failed-job" not in {job["id"] for job in after["items"]}) == hidden


def test_abandons_paused_translation_and_preserves_partial_book(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    from app.modules.books.models import BookRecord
    from app.modules.users.models import UserRecord

    with client.app.state.db_session_factory() as session:
        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        book_id = session.query(BookRecord.id).filter(BookRecord.owner_id == user_id).first()[0]
        now = datetime.now(timezone.utc)
        session.add(WholeBookTranslationJobRecord(
            id="paused-job-delete-one",
            user_id=user_id,
            book_id=book_id,
            source_url="https://kakuyomu.jp/works/paused-delete",
            source_provider="kakuyomu",
            title="不再继续翻译的作品",
            author="作者",
            status="paused",
            stage="paused",
            progress=64,
            total_chapters=142,
            completed_chapters=92,
            current_chapter_index=None,
            message="已暂停，可从第 93 话继续",
            error_message=None,
            model="literary-model",
            provider_base_url="https://provider.example.com/v1",
            provider_api_key_encrypted="encrypted",
            metadata_json={},
            catalog_json=[],
            memory_json={},
            quality_report_json={},
            acknowledged=False,
            retry_count=0,
            created_at=now,
            updated_at=now,
            started_at=now,
            finished_at=None,
        ))
        session.commit()

    checkpoint = translation_service._job_root(client.app.state.settings, user_id, "paused-job-delete-one") / "translated" / "00092.json"
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.write_text("{}", encoding="utf-8")
    notifications = client.get("/api/v1/translations/notifications", headers=auth_headers).json()
    assert any(job["id"] == "paused-job-delete-one" for job in notifications["items"])

    deleted = client.delete("/api/v1/translations/paused-job-delete-one", headers=auth_headers)

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": 1}
    assert not translation_service._job_root_path(client.app.state.settings, user_id, "paused-job-delete-one").exists()
    assert all(job["id"] != "paused-job-delete-one" for job in client.get("/api/v1/translations", headers=auth_headers).json())
    assert all(job["id"] != "paused-job-delete-one" for job in client.get("/api/v1/translations/notifications", headers=auth_headers).json()["items"])
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).status_code == 200


def test_refuses_to_delete_active_translation_record(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    deleted = client.delete(f"/api/v1/translations/{created['id']}", headers=auth_headers)

    assert deleted.status_code == 409
    assert "正在运行的任务不能直接删除" in deleted.json()["detail"]


def test_translation_job_runs_to_epub_and_enters_library(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    source_metadata = make_source_metadata()

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return source_metadata

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": source_metadata.source_url, "model": "literary-model"},
    ).json()

    source_chapter = SourceChapter(
        index=1,
        title="第一話",
        paragraphs=["彼女は笑った。", "私は頷いた。"],
        url=source_metadata.episodes[0].url,
    )

    async def fake_download(*_args: object, **_kwargs: object) -> list[SourceChapter]:
        return [source_chapter]

    async def fake_metadata_translation(
        metadata: WorkSourceMetadata,
        _settings: object,
        **_kwargs: object,
    ) -> WorkSourceMetadata:
        return metadata.model_copy(update={"title": "译名", "author": "作者", "description": "译文简介"})

    async def fake_titles(*_args: object, **_kwargs: object) -> list[str]:
        return ["第一话"]

    async def fake_memory(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {"characters": [], "glossary": [], "previous_summary": ""}

    async def fake_translate(*_args: object, **_kwargs: object) -> tuple[list[str], dict[str, object]]:
        return ["她笑了。", "我点了点头。"], {"chunks": [], "paragraph_count": 2}

    monkeypatch.setattr(translation_service, "_download_source_chapters", fake_download)
    monkeypatch.setattr(translation_service, "translate_source_metadata", fake_metadata_translation)
    monkeypatch.setattr(translation_service, "_translate_chapter_titles", fake_titles)
    monkeypatch.setattr(translation_service, "_build_series_memory", fake_memory)
    monkeypatch.setattr(translation_service, "_translate_chapter", fake_translate)
    monkeypatch.setattr(translation_service, "_update_series_memory", fake_memory)
    cleanup_observations: list[tuple[str | None, bool]] = []
    remove_translation_job_storage = translation_service._remove_translation_job_storage

    def observe_checkpoint_cleanup(settings: object, user_id: str, job_id: str) -> None:
        with client.app.state.db_session_factory() as session:
            record = session.get(WholeBookTranslationJobRecord, job_id)
            cleanup_observations.append(
                (
                    record.status if record else None,
                    translation_service._job_root_path(settings, user_id, job_id).is_dir(),
                )
            )
        remove_translation_job_storage(settings, user_id, job_id)

    monkeypatch.setattr(translation_service, "_remove_translation_job_storage", observe_checkpoint_cleanup)

    asyncio.run(
        translation_service.process_translation_job(
            job_id=created["id"],
            settings=client.app.state.settings,
            session_factory=client.app.state.db_session_factory,
        )
    )

    job = client.get("/api/v1/translations", headers=auth_headers).json()[0]
    assert job["status"] == "ready"
    assert job["book_id"] == created["id"]
    book = client.get(f"/api/v1/books/{job['book_id']}", headers=auth_headers)
    assert book.status_code == 200
    assert book.json()["title"] == "译名"
    chapter = client.get(f"/api/v1/books/{job['book_id']}/reader/chapters/1", headers=auth_headers)
    assert "我点了点头" in chapter.json()["content"]
    with client.app.state.db_session_factory() as session:
        from app.modules.users.models import UserRecord

        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
    project = translation_service._translation_project_path(client.app.state.settings, user_id, job["book_id"])
    assert (project / "project.json").is_file()
    assert (project / "translated" / "00001.json").is_file()
    assert cleanup_observations == [("ready", True)]
    assert not translation_service._job_root_path(client.app.state.settings, user_id, created["id"]).exists()


def test_source_update_translation_stays_draft_until_user_accepts_it(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    user_id, book_id, original_epub, source_metadata = prepare_translated_serial_project(client, auth_headers)
    with client.app.state.db_session_factory() as session:
        from app.modules.books.repository import SqlAlchemyBookRepository

        book = SqlAlchemyBookRepository(session).get_owned(user_id, book_id)
        assert book is not None
        queued = translation_service.queue_source_update_translation(
            book=book,
            metadata=source_metadata,
            previous_episode_count=1,
            settings=client.app.state.settings,
            session=session,
        )
        assert queued is not None
        job_id = queued.id

    source_chapter = SourceChapter(
        index=2,
        title="第二話",
        paragraphs=["新しい章です。"],
        url=source_metadata.episodes[1].url,
    )

    async def fake_download(*_args: object, **_kwargs: object) -> list[SourceChapter]:
        return [source_chapter]

    async def fake_metadata_translation(metadata: WorkSourceMetadata, *_args: object, **_kwargs: object) -> WorkSourceMetadata:
        return metadata.model_copy(update={"title": "连载译本", "author": "译者", "description": "简介"})

    async def fake_titles(*_args: object, **_kwargs: object) -> list[str]:
        return ["第二话"]

    async def fake_memory(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {"characters": [], "glossary": [], "previous_summary": ""}

    async def fake_translate(*_args: object, **_kwargs: object) -> tuple[list[str], dict[str, object]]:
        return ["这是新增章节。"], {"chunks": [], "paragraph_count": 1}

    monkeypatch.setattr(translation_service, "_download_source_chapters", fake_download)
    monkeypatch.setattr(translation_service, "translate_source_metadata", fake_metadata_translation)
    monkeypatch.setattr(translation_service, "_translate_chapter_titles", fake_titles)
    monkeypatch.setattr(translation_service, "_build_series_memory", fake_memory)
    monkeypatch.setattr(translation_service, "_translate_chapter", fake_translate)
    monkeypatch.setattr(translation_service, "_update_series_memory", fake_memory)

    asyncio.run(
        translation_service.process_translation_job(
            job_id=job_id,
            settings=client.app.state.settings,
            session_factory=client.app.state.db_session_factory,
        )
    )

    pending = next(job for job in client.get("/api/v1/translations", headers=auth_headers).json() if job["id"] == job_id)
    assert pending["status"] == "review"
    assert pending["job_kind"] == "source_update"
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == original_epub
    assert client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()["chapter_count"] == 1
    review = client.get(f"/api/v1/translations/{job_id}/review", headers=auth_headers)
    assert review.status_code == 200
    assert review.json()["chapters"][0]["content"] == "这是新增章节。"

    appended = client.post(
        f"/api/v1/books/{book_id}/chapters",
        headers=auth_headers,
        json={"title": "幕间 已有人工译文", "content": "这是接受 AI 更新前已经追加的正文。"},
    )
    assert appended.status_code == 200
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == original_epub
    before = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    saved = client.put(f"/api/v1/books/{book_id}/progress", headers=auth_headers, json={
        "reader_type": "epub", "chapter_index": 2, "epub_cfi": "aisu-scroll:0.5",
        "position_key": before["toc"][1]["position_key"], "progress_percent": 100})
    assert saved.status_code == 200

    accepted = client.post(f"/api/v1/translations/{job_id}/accept", headers=auth_headers)

    assert accepted.status_code == 200
    assert accepted.json()["status"] == "ready"
    reader = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert reader.json()["chapter_count"] == 3
    from math import floor
    weights = [item["progress_weight"] for item in reader.json()["toc"]]
    progress = client.get(f"/api/v1/books/{book_id}/progress", headers=auth_headers).json()
    assert progress["progress_percent"] == floor((weights[0] + weights[1] * .5) / sum(weights) * 100 + .5)
    assert progress["chapter_index"] == 2 and progress["epub_cfi"] == "aisu-scroll:0.5"
    manual_chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers)
    assert "已经追加的正文" in manual_chapter.json()["content"]
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/3", headers=auth_headers)
    assert "这是新增章节" in chapter.json()["content"]
    downloaded = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content
    with ZipFile(BytesIO(downloaded)) as archive:
        appended_documents = "\n".join(
            archive.read(name).decode("utf-8")
            for name in archive.namelist()
            if name.startswith("OEBPS/aisu-updates/")
        )
        assert "已经追加的正文" in appended_documents
        assert "这是新增章节" in appended_documents
    project = translation_service._translation_project_path(client.app.state.settings, user_id, book_id)
    assert (project / "translated" / "00002.json").is_file()
    assert not translation_service._job_root_path(client.app.state.settings, user_id, job_id).exists()
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["source_update_count"] == 0


def test_automatic_source_update_waits_for_owner_acceptance_after_quality_checkpoint(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    user_id, book_id, original_epub, source_metadata = prepare_translated_serial_project(
        client,
        auth_headers,
        auto_translate_updates=True,
    )
    with client.app.state.db_session_factory() as session:
        from app.modules.books.repository import SqlAlchemyBookRepository

        book = SqlAlchemyBookRepository(session).get_owned(user_id, book_id)
        assert book is not None
        queued = translation_service.queue_source_update_translation(
            book=book,
            metadata=source_metadata,
            previous_episode_count=1,
            settings=client.app.state.settings,
            session=session,
        )
        assert queued is not None
        job_id = queued.id
        record = session.get(WholeBookTranslationJobRecord, job_id)
        assert record is not None
        record.translated_metadata_json = record.metadata_json
        record.catalog_translation_version = translation_service.CATALOG_TRANSLATION_VERSION
        record.memory_json = {
            "characters": [],
            "relationships": [],
            "addressing": [],
            "glossary": [],
            "voices": [],
            "timeline": [],
            "motifs": [],
            "open_questions": [],
            "previous_summary": "",
            "_terminology_version": translation_service.TERMINOLOGY_PREFLIGHT_VERSION,
        }
        session.commit()

    source_chapter = SourceChapter(
        index=2,
        title="第二話",
        paragraphs=["新しい章です。"],
        url=source_metadata.episodes[1].url,
    )
    translation_service._write_json_atomic(
        translation_service._translated_chapter_path(client.app.state.settings, user_id, job_id, 2),
        {
            "index": 2,
            "title": "第二话",
            "source_title": "第二話",
            "source_url": source_chapter.url,
            "paragraphs": ["这是新增章节。"],
            "memory_after": {
                "characters": [],
                "glossary": [],
                "previous_summary": "",
                "_terminology_version": translation_service.TERMINOLOGY_PREFLIGHT_VERSION,
            },
        },
    )

    async def fake_download(*_args: object, **_kwargs: object) -> list[SourceChapter]:
        return [source_chapter]

    monkeypatch.setattr(translation_service, "_download_source_chapters", fake_download)
    asyncio.run(
        translation_service.process_translation_job(
            job_id=job_id,
            settings=client.app.state.settings,
            session_factory=client.app.state.db_session_factory,
        )
    )

    finished = next(job for job in client.get("/api/v1/translations", headers=auth_headers).json() if job["id"] == job_id)
    assert finished["status"] == "review"
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == original_epub
    assert client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()["chapter_count"] == 1
    notifications = client.get('/api/v1/translations/notifications', headers=auth_headers).json()
    assert any(j['id'] == job_id and j['status'] == 'review' for j in notifications['items'])
    with client.app.state.db_session_factory() as session:
        accepted = translation_service.accept_source_update_translation(user_id, job_id, session, client.app.state.settings)
        assert accepted.status == 'ready'
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content != original_epub
    reader = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    assert reader["chapter_count"] == 2
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers)
    assert "这是新增章节" in chapter.json()["content"]
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["source_update_count"] == 0


def test_txt_source_update_translation_rebuilds_original_and_reader_catalog(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    configure_translation_provider(client, auth_headers)
    source_metadata = make_source_metadata().model_copy(
        update={
            "episode_count": 2,
            "publication_status": "ongoing",
            "episodes": [
                make_source_metadata().episodes[0],
                WorkSourceEpisode(
                    index=2,
                    title="第二話",
                    url="https://kakuyomu.jp/works/16800000000000000000/episodes/16800000000000000002",
                ),
            ],
        }
    )
    original_txt = build_translation_txt(
        chapters=[{"index": 1, "title": "第一话", "paragraphs": ["既有 TXT 译文。"]}]
    )
    uploaded = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("serial-translation.txt", original_txt, "text/plain")},
        data={
            "title": "TXT 连载译本",
            "author": "译者",
            "publication_status": "ongoing",
            "source_url": source_metadata.source_url,
        },
    )
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]

    with client.app.state.db_session_factory() as session:
        from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
        from app.modules.books.repository import SqlAlchemyBookRepository
        from app.modules.reader.service import filter_readable_text_assets
        from app.modules.users.models import UserRecord

        user = session.query(UserRecord).filter(UserRecord.email == "admin@aisu.local").one()
        book_repository = SqlAlchemyBookRepository(session)
        asset_repository = SqlAlchemyBookAssetRepository(session)
        book = book_repository.get_owned(user.id, book_id)
        assert book is not None
        book = book_repository.save(
            book.with_changes(
                source_episode_count=2,
                source_pending_episode_indexes=(2,),
                source_update_count=1,
            )
        )
        chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
        translation_service.prepare_source_update_translation_project(
            book=book,
            chapters=chapters,
            has_chapter_images=False,
            metadata=source_metadata,
            settings=client.app.state.settings,
        )
        project = translation_service._translation_project_path(client.app.state.settings, user.id, book.id)
        assert translation_service._read_json(project / "project.json")["bootstrap_kind"] == "uploaded_txt"
        queued = translation_service.queue_source_update_translation(
            book=book,
            metadata=source_metadata,
            previous_episode_count=1,
            covered_episode_indexes={1},
            requested_episode_indexes={2},
            settings=client.app.state.settings,
            session=session,
        )
        assert queued is not None
        record = session.get(WholeBookTranslationJobRecord, queued.id)
        assert record is not None
        record.status = "review"
        record.stage = "review"
        record.completed_chapters = 1
        record.progress = 100
        session.commit()
        translation_service._write_json_atomic(
            translation_service._translated_chapter_path(client.app.state.settings, user.id, queued.id, 2),
            {
                "index": 2,
                "title": "第二话",
                "source_title": "第二話",
                "source_url": source_metadata.episodes[1].url,
                "paragraphs": ["这是新增的 TXT 章节。"],
            },
        )
        job_id = queued.id

    accepted = client.post(f"/api/v1/translations/{job_id}/accept", headers=auth_headers)

    assert accepted.status_code == 200
    assert accepted.json()["message"] == "已确认并加入 1 话，原文件与目录已更新"
    reader = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    assert reader["chapter_count"] == 2
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers).json()
    assert "这是新增的 TXT 章节" in chapter["content"]
    downloaded = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content.decode("utf-8")
    assert "第二话" in downloaded
    assert "这是新增的 TXT 章节。" in downloaded
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["source_update_count"] == 0


def test_rejecting_source_update_draft_preserves_original_and_marks_episode_handled(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    user_id, book_id, original_epub, source_metadata = prepare_translated_serial_project(client, auth_headers)
    with client.app.state.db_session_factory() as session:
        from app.modules.books.repository import SqlAlchemyBookRepository

        book = SqlAlchemyBookRepository(session).get_owned(user_id, book_id)
        assert book is not None
        queued = translation_service.queue_source_update_translation(
            book=book,
            metadata=source_metadata,
            previous_episode_count=1,
            settings=client.app.state.settings,
            session=session,
        )
        assert queued is not None
        record = session.get(WholeBookTranslationJobRecord, queued.id)
        assert record is not None
        record.status = "review"
        record.stage = "review"
        record.completed_chapters = 1
        record.progress = 100
        session.commit()
        translation_service._write_json_atomic(
            translation_service._translated_chapter_path(client.app.state.settings, user_id, queued.id, 2),
            {
                "index": 2,
                "title": "第二话",
                "source_title": "第二話",
                "source_url": source_metadata.episodes[1].url,
                "paragraphs": ["不会被加入原书。"],
            },
        )
        job_id = queued.id

    rejected = client.post(f"/api/v1/translations/{job_id}/reject", headers=auth_headers)

    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers).content == original_epub
    assert client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()["chapter_count"] == 1
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["source_update_count"] == 0
    project = translation_service._translation_project_path(client.app.state.settings, user_id, book_id)
    assert translation_service._read_json(project / "project.json")["dismissed_episode_indexes"] == [2]
    assert not translation_service._job_root_path(client.app.state.settings, user_id, job_id).exists()


def test_failed_job_keeps_completed_chapters_readable(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    first_episode = make_source_metadata().episodes[0]
    second_episode = WorkSourceEpisode(
        index=2,
        title="第二話",
        url="https://kakuyomu.jp/works/16800000000000000000/episodes/16800000000000000002",
    )
    source_metadata = make_source_metadata().model_copy(
        update={"episode_count": 2, "episodes": [first_episode, second_episode]}
    )

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return source_metadata

    async def fake_download(*_args: object, **_kwargs: object) -> list[SourceChapter]:
        return [
            SourceChapter(index=1, title="第一話", paragraphs=["彼女は笑った。"], url=first_episode.url),
            SourceChapter(index=2, title="第二話", paragraphs=["翌日になった。"], url=second_episode.url),
        ]

    async def fake_metadata_translation(metadata: WorkSourceMetadata, *_args: object, **_kwargs: object) -> WorkSourceMetadata:
        return metadata.model_copy(update={"title": "连载精翻", "author": "作者", "description": "简介"})

    async def fake_titles(*_args: object, **_kwargs: object) -> list[str]:
        return ["第一话", "第二话"]

    async def fake_memory(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {"characters": [], "glossary": [], "previous_summary": ""}

    calls = 0

    async def fake_translate(*_args: object, **_kwargs: object) -> tuple[list[str], dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("第二话渠道暂时不可用")
        return ["她笑了。"], {"chunks": [], "paragraph_count": 1}

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    monkeypatch.setattr(translation_service, "_download_source_chapters", fake_download)
    monkeypatch.setattr(translation_service, "translate_source_metadata", fake_metadata_translation)
    monkeypatch.setattr(translation_service, "_translate_chapter_titles", fake_titles)
    monkeypatch.setattr(translation_service, "_build_series_memory", fake_memory)
    monkeypatch.setattr(translation_service, "_translate_chapter", fake_translate)
    monkeypatch.setattr(translation_service, "_update_series_memory", fake_memory)

    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": source_metadata.source_url, "model": "literary-model"},
    ).json()
    asyncio.run(
        translation_service.process_translation_job(
            job_id=created["id"],
            settings=client.app.state.settings,
            session_factory=client.app.state.db_session_factory,
        )
    )

    job = client.get("/api/v1/translations", headers=auth_headers).json()[0]
    assert job["status"] == "failed"
    assert job["completed_chapters"] == 1
    assert job["book_id"] == created["id"]
    book = client.get(f"/api/v1/books/{job['book_id']}", headers=auth_headers)
    assert book.status_code == 200
    chapter = client.get(f"/api/v1/books/{job['book_id']}/reader/chapters/1", headers=auth_headers)
    assert chapter.status_code == 200
    assert "她笑了" in chapter.json()["content"]


@pytest.mark.parametrize(
    "transient_error",
    [
        ProviderUnavailableError("AI 渠道连续返回空白或无效 JSON，已用尽重试"),
        json.JSONDecodeError("Expecting value", "", 0),
        ValueError("Expecting value: line 1 column 1 (char 0)"),
        ValueError("AI translation response has no choices"),
        ValueError("AI translation response has no content"),
        ValueError("AI translation response count does not match request"),
        # The catalog and series-memory passes surface an exhausted channel as a
        # raw httpx status error rather than ProviderUnavailableError. Treating
        # that as permanent used to kill a whole book after a few seconds of
        # provider flapping, and manual retries could never get past it.
        httpx.HTTPStatusError(
            "Server error '503 Service Unavailable' for url 'https://gateway.example/v1/chat/completions'",
            request=httpx.Request("POST", "https://gateway.example/v1/chat/completions"),
            response=httpx.Response(503),
        ),
        httpx.HTTPStatusError(
            "Client error '429 Too Many Requests' for url 'https://gateway.example/v1/chat/completions'",
            request=httpx.Request("POST", "https://gateway.example/v1/chat/completions"),
            response=httpx.Response(429),
        ),
        httpx.ReadTimeout("timed out"),
    ],
)
def test_provider_failure_waits_and_retries_automatically(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
    transient_error: Exception,
) -> None:
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    async def unavailable(*_args: object, **_kwargs: object) -> list[SourceChapter]:
        raise transient_error

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    monkeypatch.setattr(translation_service, "_download_source_chapters", unavailable)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    asyncio.run(
        translation_service.process_translation_job(
            job_id=created["id"],
            settings=client.app.state.settings,
            session_factory=client.app.state.db_session_factory,
        )
    )

    job = client.get("/api/v1/translations", headers=auth_headers).json()[0]
    is_quota = translation_service._is_quota_translation_error(transient_error)
    assert job["status"] == ("waiting_quota" if is_quota else "queued")
    if is_quota:
        assert "额度" in job["message"]
    else:
        assert "30 秒后自动" in job["message"]
        assert "第 1 话重试" in job["message"]
    assert job["error_message"]
    assert translation_service.claim_next_translation_job(client.app.state.db_session_factory, "too-early") is None

    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        assert record.lease_owner.startswith("quota-wait:" if is_quota else "retry-backoff:")
        assert record.lease_expires_at is not None
        record.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.commit()

    assert translation_service.claim_next_translation_job(client.app.state.db_session_factory, "after-backoff") == created["id"]


def test_repeated_gateway_failures_back_off_without_false_quota_state(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    """Repeated 503s back off but must not disable the model as out of quota."""
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    async def unavailable(*_args: object, **_kwargs: object) -> list[SourceChapter]:
        raise httpx.HTTPStatusError(
            "Server error '503 Service Unavailable'",
            request=httpx.Request("POST", "https://provider.example.com/v1/chat/completions"),
            response=httpx.Response(503),
        )

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    monkeypatch.setattr(translation_service, "_download_source_chapters", unavailable)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    statuses: list[str] = []
    for _ in range(3):
        asyncio.run(
            translation_service.process_translation_job(
                job_id=created["id"],
                settings=client.app.state.settings,
                session_factory=client.app.state.db_session_factory,
            )
        )
        with client.app.state.db_session_factory() as session:
            record = session.get(WholeBookTranslationJobRecord, created["id"])
            statuses.append(record.status)
            # Let the next attempt run without waiting out the real backoff.
            record.status = "queued"
            record.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            session.commit()

    assert statuses == ["queued", "queued", "queued"]

    job = next(
        item
        for item in client.get("/api/v1/translations", headers=auth_headers).json()
        if item["id"] == created["id"]
    )
    assert job["quota_resume_at"] is None
    assert "HTTP 503" in job["message"]

    # A gateway outage is not evidence that the user's quota is exhausted.
    options = client.get("/api/v1/ai-channels/translation-models", headers=auth_headers).json()
    literary = next(option for option in options if option["model"] == "literary-model")
    assert literary["available"] is True
    assert not literary["unavailable_reason"]


def test_parked_job_can_be_moved_to_another_channel_and_keeps_progress(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    channel = client.get("/api/v1/ai-channels", headers=auth_headers).json()[0]
    client.patch(
        f"/api/v1/ai-channels/{channel['id']}",
        headers=auth_headers,
        json={"models": [{"model": "literary-model"}, {"model": "backup-model", "max_concurrency": 2}]},
    )

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        record.status = "paused"
        record.stage = "paused"
        record.completed_chapters = 7
        record.request_concurrency = 4
        session.commit()

    switched = client.patch(
        f"/api/v1/translations/{created['id']}/model",
        headers=auth_headers,
        json={"model": "backup-model"},
    )

    assert switched.status_code == 200
    body = switched.json()
    assert body["model"] == "backup-model"
    # Progress survives the switch, and the new lane's own ceiling applies.
    assert body["completed_chapters"] == 7
    assert body["request_concurrency"] == 2
    assert "第 8 话" in body["message"]


def test_explicit_model_change_clears_old_refusal_and_retry_uses_selected_model(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    channel = client.get("/api/v1/ai-channels", headers=auth_headers).json()[0]
    client.patch(
        f"/api/v1/ai-channels/{channel['id']}", headers=auth_headers,
        json={"models": [{"model": "literary-model"}, {"model": "backup-model"}, {"model": "gemini-backup"}]},
    )

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post("/api/v1/translations", headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"}).json()
    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        record.status = record.stage = "failed"
        record.completed_chapters = 1
        record.quality_report_json = {
            "1": {"chunks": []},
            "_v2_failure": {"code": "provider_rejected", "stage": "draft"},
        }
        session.commit()

    switched = client.patch(f"/api/v1/translations/{created['id']}/model", headers=auth_headers,
        json={"model": "backup-model"})
    assert switched.status_code == 200
    retried = client.post(f"/api/v1/translations/{created['id']}/retry", headers=auth_headers)
    assert retried.status_code == 200
    assert retried.json()["model"] == "backup-model"
    assert switched.json()["error_message"] is None
    assert retried.json()["completed_chapters"] == 1
    with client.app.state.db_session_factory() as session:
        assert session.get(WholeBookTranslationJobRecord, created["id"]).quality_report_json == {"1": {"chunks": []}}


@pytest.mark.parametrize("available_channel", ["selected", "original", "none"])
def test_retry_preserves_selected_channel_with_the_same_model(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
    available_channel: str,
) -> None:
    configure_translation_provider(client, auth_headers)
    original = client.get("/api/v1/ai-channels", headers=auth_headers).json()[0]
    response = client.post("/api/v1/ai-channels", headers=auth_headers, json={
        "name": "手动选择的渠道", "base_url": "https://selected.example.com/v1", "api_key": "selected-key",
        "models": [{"model": "literary-model"}],
    })
    assert response.status_code == 201
    selected = response.json()

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post("/api/v1/translations", headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model", "channel_id": original["id"]}).json()
    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        record.status = record.stage = "failed"
        record.completed_chapters = 1
        session.commit()

    switched = client.patch(f"/api/v1/translations/{created['id']}/model", headers=auth_headers,
        json={"model": "literary-model", "channel_id": selected["id"]})
    assert switched.status_code == 200
    assert switched.json()["channel_id"] == selected["id"]
    if available_channel != "selected":
        assert client.patch(f"/api/v1/ai-channels/{selected['id']}", headers=auth_headers,
            json={"enabled": False}).status_code == 200
    if available_channel == "none":
        assert client.patch(f"/api/v1/ai-channels/{original['id']}", headers=auth_headers,
            json={"enabled": False}).status_code == 200

    retried = client.post(f"/api/v1/translations/{created['id']}/retry", headers=auth_headers)
    if available_channel == "none":
        assert retried.status_code == 422
        assert "Gemini" not in retried.json()["detail"]
    else:
        assert retried.status_code == 200
        assert retried.json()["channel_id"] == (selected if available_channel == "selected" else original)["id"]
        assert retried.json()["completed_chapters"] == 1


def test_running_job_refuses_a_model_change_until_paused(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    channel = client.get("/api/v1/ai-channels", headers=auth_headers).json()[0]
    client.patch(
        f"/api/v1/ai-channels/{channel['id']}",
        headers=auth_headers,
        json={"models": [{"model": "literary-model"}, {"model": "backup-model"}]},
    )

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        record.status = "processing"
        session.commit()

    response = client.patch(
        f"/api/v1/translations/{created['id']}/model",
        headers=auth_headers,
        json={"model": "backup-model"},
    )

    assert response.status_code == 409
    assert "暂停" in response.json()["detail"]


def test_failed_translation_can_retry_from_checkpoint(client: TestClient, auth_headers: dict[str, str]) -> None:
    configure_translation_provider(client, auth_headers)
    with client.app.state.db_session_factory() as session:
        # Reuse an API-created task shape without making a source network request.
        from datetime import datetime, timezone
        from app.modules.users.models import UserRecord

        user_id = session.query(UserRecord.id).filter(UserRecord.email == "admin@aisu.local").scalar()
        now = datetime.now(timezone.utc)
        record = WholeBookTranslationJobRecord(
            id="failed-job",
            user_id=user_id,
            book_id=None,
            source_url="https://kakuyomu.jp/works/16800000000000000002",
            source_provider="kakuyomu",
            title="失败作品",
            author="作者",
            status="failed",
            stage="failed",
            progress=55,
            total_chapters=4,
            completed_chapters=2,
            current_chapter_index=3,
            message="暂停",
            error_message="供应商暂时不可用",
            model="literary-model",
            provider_base_url="https://provider.example.com/v1",
            provider_api_key_encrypted="encrypted",
            metadata_json={},
            catalog_json=[],
            memory_json={},
            quality_report_json={},
            acknowledged=False,
            retry_count=0,
            created_at=now,
            updated_at=now,
            started_at=now,
            finished_at=now,
        )
        session.add(record)
        session.commit()

    retried = client.post("/api/v1/translations/failed-job/retry", headers=auth_headers)
    assert retried.status_code == 200
    assert retried.json()["status"] == "queued"
    assert retried.json()["completed_chapters"] == 2
    assert "第 3 话继续" in retried.json()["message"]


def test_translation_job_lease_prevents_duplicate_worker_claim(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    created = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "literary-model"},
    ).json()

    assert translation_service.claim_next_translation_job(client.app.state.db_session_factory, "worker-one") == created["id"]
    assert translation_service.claim_next_translation_job(client.app.state.db_session_factory, "worker-two") is None

    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        record.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.commit()

    assert translation_service.claim_next_translation_job(client.app.state.db_session_factory, "worker-two") == created["id"]
    assert not translation_service.renew_translation_job_lease(created["id"], "worker-one", client.app.state.db_session_factory)
    assert translation_service.renew_translation_job_lease(created["id"], "worker-two", client.app.state.db_session_factory)

    lease_token = translation_service.current_translation_lease_owner.set("worker-one")
    try:
        updated = translation_service._update_job(
            created["id"], client.app.state.db_session_factory, message="stale worker update"
        )
    finally:
        translation_service.current_translation_lease_owner.reset(lease_token)
    assert not updated
    with client.app.state.db_session_factory() as session:
        record = session.get(WholeBookTranslationJobRecord, created["id"])
        assert record.message != "stale worker update"


def test_new_translation_requires_an_explicit_model(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    """Auto-assignment is gone: it used to route books to a retired model."""
    configure_translation_provider(client, auth_headers)

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    without_model = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url},
    )

    assert without_model.status_code == 422

    unknown_model = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "deepseek-v4-flash"},
    )

    assert unknown_model.status_code == 422
    assert "deepseek-v4-flash" in unknown_model.json()["detail"]


def test_translation_job_accepts_a_model_configured_on_a_channel(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: object,
) -> None:
    configure_translation_provider(client, auth_headers)
    channel = client.get("/api/v1/ai-channels", headers=auth_headers).json()[0]
    client.patch(
        f"/api/v1/ai-channels/{channel['id']}",
        headers=auth_headers,
        json={"models": [{"model": "literary-model"}, {"model": "second-model"}]},
    )

    async def fake_metadata(_url: str) -> WorkSourceMetadata:
        return make_source_metadata()

    monkeypatch.setattr(translation_service, "fetch_work_source_metadata", fake_metadata)
    response = client.post(
        "/api/v1/translations",
        headers=auth_headers,
        json={"source_url": make_source_metadata().source_url, "model": "second-model"},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["model"] == "second-model"
    assert body["channel_id"] == channel["id"]
    assert body["channel_name"] == channel["name"]


def test_translation_uses_pretranslation_interpretation_in_both_passes(monkeypatch: object) -> None:
    calls: list[dict[str, object]] = []
    responses = iter(
        [
            {
                "interpretations": [
                    {
                        "paragraph": 1,
                        "speaker": "女主角",
                        "addressee": "友人",
                        "hidden_subject": "女主角",
                        "register": "克制",
                        "intent": "试探",
                        "ambiguity": "",
                        "risk": "medium",
                    }
                ],
                "open_questions": [],
            },
            {"translations": ["她小声问道。"]},
            {
                "translations": ["她低声问道。"],
                "issues": [],
                "scores": {"accuracy": 96, "naturalness": 94, "voice": 95, "continuity": 97},
            },
        ]
    )

    async def fake_ai(_settings: object, **kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(translation_service, "request_structured_ai", fake_ai)
    chapter = SourceChapter(index=1, title="第一話", paragraphs=["彼女は小さな声で尋ねた。"], url="https://example.com/1")
    translated, report = asyncio.run(
        translation_service._translate_chapter(
            chapter=chapter,
            memory={"characters": [], "glossary": [], "voices": []},
            next_preview="",
            settings=object(),
            translation_preferences="雪乃固定译为雪乃。",
        )
    )

    assert translated == ["她低声问道。"]
    assert len(calls) == 3
    assert calls[1]["user_payload"]["interpretation"]["interpretations"][0]["intent"] == "试探"
    assert calls[1]["user_payload"]["user_translation_preferences"] == "雪乃固定译为雪乃。"
    assert calls[2]["user_payload"]["interpretation"]["interpretations"][0]["speaker"] == "女主角"
    assert report["chunks"][0]["scores"]["accuracy"] == 96


def test_chapter_translation_honors_four_way_concurrency_and_preserves_order(monkeypatch: object) -> None:
    active = 0
    peak = 0
    seen_context: dict[int, tuple[list[str], list[str]]] = {}

    async def fake_pipeline(**kwargs: object) -> translation_service.ChunkTranslationResult:
        nonlocal active, peak
        index = int(kwargs["chunk_index"])
        active += 1
        peak = max(peak, active)
        seen_context[index] = (
            list(kwargs["previous_source_tail"]),
            list(kwargs["next_source_head"]),
        )
        await asyncio.sleep(0.01 * (5 - index))
        active -= 1
        return translation_service.ChunkTranslationResult(
            index=index,
            translated=[f"译文 {index}"],
            report={"chunk": index},
        )

    monkeypatch.setattr(translation_service, "_translate_chunk_pipeline", fake_pipeline)

    async def keep_parallel_results(**kwargs: object) -> list[translation_service.ChunkTranslationResult]:
        return list(kwargs["results"])

    monkeypatch.setattr(translation_service, "_stitch_translated_chunks", keep_parallel_results)
    monkeypatch.setattr(
        translation_service,
        "_chunk_paragraphs",
        lambda paragraphs, **_kwargs: [[paragraph] for paragraph in paragraphs],
    )
    translated, report = asyncio.run(
        translation_service._translate_chapter(
            chapter=SourceChapter(
                index=1,
                title="第一話",
                paragraphs=["原文一", "原文二", "原文三", "原文四"],
                url="https://example.com/1",
            ),
            memory={},
            next_preview="下一话",
            settings=object(),
            request_concurrency=4,
        )
    )

    assert peak == 4
    assert translated == ["译文 1", "译文 2", "译文 3", "译文 4"]
    assert [chunk["chunk"] for chunk in report["chunks"]] == [1, 2, 3, 4]
    assert seen_context[2] == (["原文一"], ["原文三", "原文四"])


def test_a_typical_chapter_is_translated_as_a_single_chunk() -> None:
    # Japanese web-novel prose runs ~20-25 characters per paragraph, so a
    # paragraph cap is what used to bind, not the character budget: 160 short
    # paragraphs fit in ~3.5k characters yet were split into nine chunks, each
    # paying the provider's fixed per-call floor and triggering the serial
    # stitch pass. A whole chapter must now be one request.
    paragraphs = ["「おはよう」と彼女は言った。" for _ in range(160)]
    assert sum(len(p) for p in paragraphs) < translation_service.MAX_CHUNK_CHARACTERS

    chunks = translation_service._chunk_paragraphs(paragraphs)

    assert len(chunks) == 1
    assert chunks[0] == paragraphs


def test_chunk_count_no_longer_depends_on_the_concurrency_setting(monkeypatch: object) -> None:
    # Concurrency used to halve the chunk limits to manufacture parallelism,
    # which cost more in per-call floor than the parallelism returned.
    paragraphs = ["「おはよう」と彼女は言った。" for _ in range(160)]

    async def fake_pipeline(**kwargs: object) -> translation_service.ChunkTranslationResult:
        return translation_service.ChunkTranslationResult(
            index=int(kwargs["chunk_index"]),
            translated=list(kwargs["source_chunk"]),
            report={"chunk": int(kwargs["chunk_index"])},
        )

    async def keep_results(**kwargs: object) -> list[translation_service.ChunkTranslationResult]:
        return list(kwargs["results"])

    monkeypatch.setattr(translation_service, "_translate_chunk_pipeline", fake_pipeline)
    monkeypatch.setattr(translation_service, "_stitch_translated_chunks", keep_results)

    chunk_counts = []
    for concurrency in (1, 4):
        _, report = asyncio.run(
            translation_service._translate_chapter(
                chapter=SourceChapter(
                    index=1,
                    title="第一話",
                    paragraphs=paragraphs,
                    url="https://example.com/1",
                ),
                memory={},
                next_preview="",
                settings=object(),
                request_concurrency=concurrency,
            )
        )
        chunk_counts.append(len(report["chunks"]))

    assert chunk_counts == [1, 1]


def test_chapter_translation_applies_the_selected_models_chunk_tuning(monkeypatch: object) -> None:
    captured: dict[str, int] = {}

    def capture_limits(paragraphs: list[str], **kwargs: int) -> list[list[str]]:
        captured.update(kwargs)
        return [paragraphs]

    async def fake_pipeline(**kwargs: object) -> translation_service.ChunkTranslationResult:
        return translation_service.ChunkTranslationResult(
            index=int(kwargs["chunk_index"]),
            translated=list(kwargs["source_chunk"]),
            report={"chunk": int(kwargs["chunk_index"])},
        )

    monkeypatch.setattr(translation_service, "_chunk_paragraphs", capture_limits)
    monkeypatch.setattr(translation_service, "_translate_chunk_pipeline", fake_pipeline)

    asyncio.run(
        translation_service._translate_chapter(
            chapter=SourceChapter(index=1, title="第一話", paragraphs=["原文"], url="https://example.com/1"),
            memory={},
            next_preview="",
            settings=translation_service.Settings(
                ai_translation_model="configured-model",
                ai_translation_chunk_characters=2600,
                ai_translation_chunk_paragraphs=96,
            ),
        )
    )

    assert captured == {"max_characters": 2600, "max_paragraphs": 96}


def test_oversized_chapters_still_split_below_the_provider_timeout() -> None:
    # 9000 characters in one request timed out on the live channel 3 times out
    # of 3, so anything that large must still be broken up.
    paragraphs = ["あ" * 100 for _ in range(120)]  # 12000 characters

    chunks = translation_service._chunk_paragraphs(paragraphs)

    assert len(chunks) > 1
    assert sum(len(chunk) for chunk in chunks) == len(paragraphs)
    for chunk in chunks:
        assert sum(len(p) for p in chunk) <= translation_service.MAX_CHUNK_CHARACTERS
        assert len(chunk) <= translation_service.MAX_CHUNK_PARAGRAPHS


def test_extra_translation_commentary_is_a_hard_quality_issue() -> None:
    issues = translation_service._deterministic_quality_issues(
        ["彼女は笑った。"],
        ["以下是译文：她笑了。"],
        {},
    )

    assert any(issue.severity == "hard" and "非正文内容" in issue.message for issue in issues)
    appended_note = translation_service._deterministic_quality_issues(
        ["彼女は笑った。"],
        ["她笑了。\n译者注：这里采用意译。"],
        {},
    )
    assert any("非正文内容" in issue.message for issue in appended_note)
    legitimate = translation_service._deterministic_quality_issues(
        ["彼女は翻訳科の宿題だと答えた。"],
        ["“当然，这是译文系的作业。”她回答。"],
        {},
    )
    assert not any("非正文内容" in issue.message for issue in legitimate)


def test_translation_list_masks_and_reinserts_scene_breaks(monkeypatch: object) -> None:
    captured: dict[str, object] = {}

    async def fake_request(
        _settings: object,
        *,
        user_payload: dict[str, object],
        **_kwargs: object,
    ) -> dict[str, object]:
        captured.update(user_payload)
        return {"translations": ["她笑了。"]}

    monkeypatch.setattr(translation_service, "request_structured_ai", fake_request)
    response, translated = asyncio.run(
        translation_service._request_translation_list(
            settings=object(),
            system_prompt="translate",
            user_payload={"paragraphs": ["＊＊＊", "彼女は笑った。", "──"]},
            expected_count=3,
            temperature=0.1,
        )
    )

    assert captured["paragraphs"] == ["彼女は笑った。"]
    assert translated == ["＊＊＊", "她笑了。", "──"]
    assert response["translations"] == translated


def test_translation_list_splits_immediately_when_provider_omits_items(monkeypatch: object) -> None:
    calls: list[list[str]] = []

    async def fake_request(
        _settings: object,
        *,
        user_payload: dict[str, object],
        **_kwargs: object,
    ) -> dict[str, object]:
        paragraphs = [str(item) for item in user_payload["paragraphs"]]
        calls.append(paragraphs)
        if len(paragraphs) == 4:
            return {"translations": [f"漏项译文 {index}" for index in range(3)]}
        return {"translations": [f"译：{paragraph}" for paragraph in paragraphs]}

    monkeypatch.setattr(translation_service, "request_structured_ai", fake_request)
    source = [f"原文第 {index} 段。" for index in range(4)]

    response, translated = asyncio.run(
        translation_service._request_translation_list(
            settings=object(),
            system_prompt="translate",
            user_payload={"paragraphs": source},
            expected_count=4,
            temperature=0.1,
        )
    )

    assert calls[0] == source
    assert sorted(len(call) for call in calls[1:]) == [2, 2]
    assert translated == [f"译：{paragraph}" for paragraph in source]
    assert response["translations"] == translated


def test_extra_translation_commentary_is_repaired_before_output(monkeypatch: object) -> None:
    translated, report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=["彼女は笑った。"],
        responses=[
            EMPTY_INTERPRETATION,
            {"translations": ["她笑了。"]},
            {"translations": ["以下是译文：她笑了。"], "issues": [], "scores": {}},
            {"translations": ["她笑了。"]},
        ],
    )

    assert translated == ["她笑了。"]
    assert len(calls) == 4
    assert report["chunks"][0]["repair_attempts"] == 1


def test_translation_retries_when_the_provider_returns_a_short_array(monkeypatch: object) -> None:
    translated, _report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=JAPANESE_PAIR,
        responses=[
            EMPTY_INTERPRETATION,
            {"translations": ["她笑了。"]},
            {"translations": CHINESE_PAIR},
            {"translations": ["她笑了。", "我点头。"], "issues": [], "scores": {}},
        ],
    )

    assert translated == ["她笑了。", "我点头。"]
    assert len(calls) == 4
    assert "previous_attempt_error" in calls[2]["user_payload"]


def test_editor_pass_falls_back_to_the_draft_instead_of_failing_the_book(monkeypatch: object) -> None:
    translated, report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=JAPANESE_PAIR,
        responses=[
            EMPTY_INTERPRETATION,
            {"translations": CHINESE_PAIR},
            {"translations": ["她笑了。"], "issues": [], "scores": {}},
            {"translations": ["她笑了。", ""], "issues": [], "scores": {}},
            {"translations": [], "issues": [], "scores": {}},
        ],
    )

    assert translated == CHINESE_PAIR
    assert len(calls) == 5
    assert report["chunks"][0]["degraded"]


def test_draft_splits_the_block_when_the_array_shape_keeps_failing(monkeypatch: object) -> None:
    merged = {"translations": ["她笑了。我点了点头。"]}
    translated, _report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=JAPANESE_PAIR,
        responses=[
            EMPTY_INTERPRETATION,
            merged,
            merged,
            merged,
            {"translations": ["她笑了。"]},
            {"translations": ["我点了点头。"]},
            {"translations": CHINESE_PAIR, "issues": [], "scores": {}},
        ],
    )

    assert translated == CHINESE_PAIR
    assert len(calls) == 7


def test_unresolved_soft_issues_do_not_fail_the_chapter(monkeypatch: object) -> None:
    clean = {"translations": CHINESE_PAIR}
    translated, report, _calls = run_chapter_translation(
        monkeypatch,
        paragraphs=JAPANESE_PAIR,
        responses=[EMPTY_INTERPRETATION, clean, {**clean, "issues": [], "scores": {}}, clean, clean],
        memory={"glossary": [{"source": "彼女", "target": "雪乃"}]},
    )

    assert translated == CHINESE_PAIR
    assert report["chunks"][0]["repair_attempts"] == 2
    assert report["chunks"][0]["unresolved_hard"] == []
    assert any("雪乃" in message for message in report["chunks"][0]["remaining"])


def test_a_block_returned_untranslated_is_repaired_by_focused_fallback(monkeypatch: object) -> None:
    echoed = {"translations": JAPANESE_PAIR}
    translated, report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=JAPANESE_PAIR,
        responses=[
            EMPTY_INTERPRETATION,
            echoed,
            {**echoed, "issues": [], "scores": {}},
            echoed,
            echoed,
            {"translations": CHINESE_PAIR},
        ],
    )

    assert translated == CHINESE_PAIR
    assert report["chunks"][0]["unresolved_hard"] == []
    assert calls[-1]["user_payload"]["paragraph_numbers"] == [1, 2]


def test_one_untranslated_paragraph_is_repaired_without_rewriting_clean_neighbors(monkeypatch: object) -> None:
    source = ["彼女は笑った。", "私は頷いた。", "扉を閉じた。"]
    mixed = {"translations": ["她笑了。", "我点了点头。", "扉を閉じた。"]}
    translated, report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=source,
        responses=[
            EMPTY_INTERPRETATION,
            mixed,
            {**mixed, "issues": [], "scores": {}},
            mixed,
            mixed,
            {"translations": ["关上了门。"]},
        ],
    )

    assert translated == ["她笑了。", "我点了点头。", "关上了门。"]
    assert report["chunks"][0]["unresolved_hard"] == []
    assert calls[-1]["user_payload"]["paragraph_numbers"] == [3]


def test_concurrent_chunks_receive_sequential_translation_context(monkeypatch: object) -> None:
    captured_previous: list[list[str]] = []
    responses = iter(
        [
            {"translations": ["第一块终稿。"]},
            {"translations": ["第二块终稿。"]},
        ]
    )

    async def fake_request(**kwargs: object) -> tuple[dict[str, object], list[str]]:
        payload = kwargs["user_payload"]
        captured_previous.append(list(payload["previous_translated_tail"]))
        response = next(responses)
        return response, list(response["translations"])

    monkeypatch.setattr(translation_service, "_request_translation_list", fake_request)
    results = asyncio.run(
        translation_service._stitch_translated_chunks(
            chapter=SourceChapter(index=1, title="第一话", paragraphs=["原文一", "原文二"], url="https://example.com/1"),
            chunks=[["原文一"], ["原文二"]],
            results=[
                translation_service.ChunkTranslationResult(index=1, translated=["第一块初稿。"], report={}),
                translation_service.ChunkTranslationResult(index=2, translated=["第二块初稿。"], report={}),
            ],
            memory={},
            settings=object(),
            translation_preferences="",
        )
    )

    assert captured_previous == [[], ["第一块终稿。"]]
    assert [item.translated for item in results] == [["第一块终稿。"], ["第二块终稿。"]]


def test_stitch_retranslates_only_paragraphs_with_hard_quality_failures(monkeypatch: object) -> None:
    calls: list[dict[str, object]] = []
    responses = iter(
        [
            {"translations": ["她笑了。", "私は頷いた。"]},
            {"translations": ["我点了点头。"]},
        ]
    )

    async def fake_request(**kwargs: object) -> tuple[dict[str, object], list[str]]:
        calls.append(kwargs)
        response = next(responses)
        return response, list(response["translations"])

    monkeypatch.setattr(translation_service, "_request_translation_list", fake_request)
    results = asyncio.run(
        translation_service._stitch_translated_chunks(
            chapter=SourceChapter(index=4, title="第四话", paragraphs=JAPANESE_PAIR, url="https://example.com/4"),
            chunks=[JAPANESE_PAIR],
            results=[translation_service.ChunkTranslationResult(index=1, translated=CHINESE_PAIR, report={})],
            memory={},
            settings=object(),
            translation_preferences="",
        )
    )

    assert results[0].translated == CHINESE_PAIR
    assert calls[1]["expected_count"] == 1
    assert calls[1]["user_payload"]["paragraph_numbers"] == [2]
    assert results[0].report["stitch"]["repair_attempts"] == 1


def test_stitch_falls_back_to_reviewed_text_when_focused_repair_cannot_converge(monkeypatch: object) -> None:
    bad = {"translations": ["她笑了。", "私は頷いた。"]}
    responses = iter([bad, {"translations": ["私は頷いた。"]}, {"translations": ["私は頷いた。"]}, {"translations": ["私は頷いた。"]}])

    async def fake_request(**_kwargs: object) -> tuple[dict[str, object], list[str]]:
        response = next(responses)
        return response, list(response["translations"])

    monkeypatch.setattr(translation_service, "_request_translation_list", fake_request)
    results = asyncio.run(
        translation_service._stitch_translated_chunks(
            chapter=SourceChapter(index=4, title="第四话", paragraphs=JAPANESE_PAIR, url="https://example.com/4"),
            chunks=[JAPANESE_PAIR],
            results=[translation_service.ChunkTranslationResult(index=1, translated=CHINESE_PAIR, report={})],
            memory={},
            settings=object(),
            translation_preferences="",
        )
    )

    assert results[0].translated == CHINESE_PAIR
    assert results[0].report["stitch"]["repair_attempts"] == 3
    assert any("回退到审校稿" in message for message in results[0].report["stitch"]["degraded"])


def test_scene_break_block_is_kept_without_asking_for_a_draft(monkeypatch: object) -> None:
    translated, _report, calls = run_chapter_translation(
        monkeypatch,
        paragraphs=["＊＊＊"],
        responses=[EMPTY_INTERPRETATION, {"translations": ["＊＊＊"], "issues": [], "scores": {}}],
    )

    assert translated == ["＊＊＊"]
    # Only the semantic preparse remains; draft/review/stitch calls mask the
    # immutable separator and reinsert it without asking the model to echo it.
    assert len(calls) == 1


def test_translation_worker_loop_survives_a_failing_iteration(monkeypatch: object, tmp_path: Path) -> None:
    attempts: list[str] = []

    async def flaky(**_kwargs: object) -> bool:
        attempts.append("call")
        if len(attempts) == 1:
            raise RuntimeError("database is locked")
        raise StopWorkerLoop

    monkeypatch.setattr(worker, "process_next_translation_job", flaky)
    monkeypatch.setattr(worker.time, "sleep", lambda _seconds: None)

    with pytest.raises(StopWorkerLoop):
        worker.run_translation_worker_loop(interval_seconds=0.01, settings=Settings(storage_root=str(tmp_path)), session_factory=object)

    assert len(attempts) == 2


def test_starts_two_independent_translation_worker_threads(monkeypatch: object) -> None:
    created: list[object] = []
    started: list[str] = []

    class FakeThread:
        def __init__(
            self,
            *,
            target: object,
            kwargs: dict[str, object],
            name: str,
            daemon: bool,
        ) -> None:
            self.target = target
            self.kwargs = kwargs
            self.name = name
            self.daemon = daemon
            created.append(self)

        def start(self) -> None:
            started.append(self.name)

    monkeypatch.setattr(worker.threading, "Thread", FakeThread)

    threads = worker.start_translation_worker_threads(
        worker_count=worker.DEFAULT_TRANSLATION_WORKER_COUNT,
        interval_seconds=1.0,
        settings=object(),
        session_factory=object(),
    )

    assert len(threads) == 2
    assert started == ["whole-book-translation-worker-1", "whole-book-translation-worker-2"]
    assert all(thread.target is worker.run_translation_worker_loop for thread in created)
    assert all(thread.daemon is True for thread in created)


def test_gateway_timeout_codes_count_as_transient() -> None:
    # 524 is what the channel returns when the upstream model runs long; it used
    # to escape the retry set and fail the book on the first slow generation.
    assert is_transient_status(524)
    assert is_transient_status(502)
    assert is_transient_status(429)
    assert not is_transient_status(401)
    assert not is_transient_status(404)


def test_selected_fallback_model_keeps_its_configured_daily_allowance() -> None:
    settings = Settings(
        ai_translation_model="gemini-3.7-flash-high",
        ai_translation_secondary_model="gemini-3.6-flash-high",
        ai_translation_rescue_model="rescue-model",
        ai_platform_builtin_api_key="platform-key",
        ai_translation_daily_call_budget=200,
        ai_translation_secondary_daily_call_budget=3000,
        ai_translation_rescue_daily_call_budget=800,
    )

    assert translation_service._job_primary_daily_call_budget("gemini-3.7-flash-high", settings, credential_key="platform-key") == 200
    assert translation_service._job_primary_daily_call_budget("gemini-3.6-flash-high", settings, credential_key="platform-key") == 3000
    assert translation_service._job_primary_daily_call_budget("rescue-model", settings, credential_key="platform-key") == 800


def test_saved_channel_does_not_inherit_legacy_gateway_daily_allowance() -> None:
    settings = Settings(
        ai_translation_model="gemini-3.8-flash-high",
        ai_translation_daily_call_budget=200,
    )

    assert (
        translation_service._job_primary_daily_call_budget(
            "gemini-3.8-flash-high", settings, credential_key="personal-key"
        )
        == 0
    )


def test_draft_splits_the_block_when_the_channel_times_out(monkeypatch: object) -> None:
    requested_sizes: list[int] = []

    def responder(kwargs: dict[str, object]) -> dict[str, object]:
        payload = kwargs["user_payload"]
        if "draft" in payload:
            return {"translations": CHINESE_PAIR, "issues": [], "scores": {}}
        if "interpretation" in payload and "paragraphs" in payload:
            paragraphs = payload["paragraphs"]
            requested_sizes.append(len(paragraphs))
            if len(paragraphs) > 1:
                raise ProviderUnavailableError("AI 渠道连续返回 524，已用尽重试")
            return {"translations": ["她笑了。" if "笑" in paragraphs[0] else "我点了点头。"]}
        return EMPTY_INTERPRETATION

    translated, _report, _calls = run_chapter_translation(
        monkeypatch, paragraphs=JAPANESE_PAIR, responder=responder
    )

    assert translated == CHINESE_PAIR
    assert requested_sizes == [2, 1, 1]


def test_editor_pass_falls_back_when_the_channel_is_unavailable(monkeypatch: object) -> None:
    def responder(kwargs: dict[str, object]) -> dict[str, object]:
        payload = kwargs["user_payload"]
        if "draft" in payload:
            raise ProviderUnavailableError("AI 渠道连续返回 524，已用尽重试")
        if "interpretation" in payload and "paragraphs" in payload:
            return {"translations": CHINESE_PAIR}
        return EMPTY_INTERPRETATION

    translated, report, _calls = run_chapter_translation(
        monkeypatch, paragraphs=JAPANESE_PAIR, responder=responder
    )

    assert translated == CHINESE_PAIR
    assert any("渠道不可用" in note for note in report["chunks"][0]["degraded"])
