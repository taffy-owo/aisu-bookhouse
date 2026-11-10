import json
from pathlib import Path

import pytest
import httpx
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.modules.japanese.schemas import JapaneseAiTranslationResponse
from app.modules.japanese.service import _post_ai_translation, annotate_japanese_texts, parse_ai_translation_payload, parse_jotoba_payload, parse_responses_ai_translation_payload, translate_japanese_catalog_titles, translate_japanese_metadata, translate_japanese_texts
from app.modules.translations.ai import ContentFilteredError, ProviderUnavailableError


def test_parses_jotoba_reading_and_glosses() -> None:
    result = parse_jotoba_payload(
        {
            "words": [
                {
                    "reading": {"kana": "よむ", "kanji": "読む"},
                    "senses": [{"glosses": ["to read", "to recite"]}],
                }
            ]
        },
        "読む",
    )

    assert result == {
        "dictionary_form": "読む",
        "english_glosses": ["to read", "to recite"],
        "reading": "よむ",
    }


def test_invalid_dictionary_payload_degrades_to_empty_result() -> None:
    assert parse_jotoba_payload({"words": []}, "読む") == {}


def test_generates_ruby_only_for_text_containing_kanji() -> None:
    result = annotate_japanese_texts(["私は本を読む。カタカナもそのまま。"])

    annotation = result.annotations[0]
    assert annotation.text == "私は本を読む。カタカナもそのまま。"
    assert "".join(span.text for span in annotation.spans) == annotation.text
    assert any(span.ruby for span in annotation.spans if "私" in span.text)
    assert all(span.ruby is None for span in annotation.spans if "カタカナ" in span.text)


def test_preserves_empty_text_alignment() -> None:
    result = annotate_japanese_texts(["", "距離"])

    assert len(result.annotations) == 2
    assert result.annotations[0].spans[0].text == ""
    assert result.annotations[0].spans[0].ruby is None
    assert result.annotations[1].spans[0].ruby == "きょり"


def test_uses_sentence_context_for_ambiguous_kanji() -> None:
    result = annotate_japanese_texts(["二年生の人懐っこい一面"])
    readings = {span.text: span.ruby for span in result.annotations[0].spans if span.ruby}

    assert readings["生"] == "せい"
    assert readings["人"] == "ひと"
    assert readings["懐っこい"] == "なつっこい"


def test_preserves_whitespace_exactly() -> None:
    text = " 私 は\n本を読む。  "
    result = annotate_japanese_texts([text]).annotations[0]

    assert "".join(span.text for span in result.spans) == text


def test_parses_ordered_ai_translation_json() -> None:
    result = parse_ai_translation_payload(
        {"choices": [{"message": {"content": '{"translations":["第一段","第二段"]}'}}]},
        2,
    )

    assert result == ["第一段", "第二段"]


def test_parses_responses_api_output_text() -> None:
    result = parse_responses_ai_translation_payload(
        {"output": [{"type": "message", "content": [{"type": "output_text", "text": '{"translations":["译文"]}'}]}]},
        1,
    )

    assert result == ["译文"]


def test_rejects_misaligned_ai_translation_json() -> None:
    with pytest.raises(ValueError, match="count"):
        parse_ai_translation_payload(
            {"choices": [{"message": {"content": '{"translations":["只有一段"]}'}}]},
            2,
        )


@pytest.mark.parametrize(
    "content",
    [
        '```json\n{"translations":["译文"]}\n```',
        '结果如下：\n{"translations":["译文"]}',
    ],
)
def test_parses_ai_translation_json_wrappers(content: str) -> None:
    result = parse_ai_translation_payload({"choices": [{"message": {"content": content}}]}, 1)

    assert result == ["译文"]


@pytest.mark.asyncio
async def test_metadata_translation_enforces_standard_tag_glossary(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_request(
        _items: list[tuple[str, str]],
        _settings: Settings,
        **_kwargs: object,
    ) -> list[str]:
        return ["少女之恋", "浪漫喜剧"]

    monkeypatch.setattr("app.modules.japanese.service._request_ai_metadata_translations", fake_request)
    result: JapaneseAiTranslationResponse = await translate_japanese_metadata(
        [("tag", "ガールズラブ"), ("tag", "ラブコメ")],
        Settings(
            ai_translation_api_key="secret",
            ai_translation_base_url="https://ai.example.com/v1",
            ai_translation_model="translation-model",
        ),
    )

    assert result.translations == ["百合", "恋爱喜剧"]


@pytest.mark.asyncio
async def test_catalog_translation_sends_episode_context_and_series_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_post(
        _client: httpx.AsyncClient,
        *,
        payload: dict[str, object],
        settings: Settings,
        expected_count: int,
        **_kwargs: object,
    ) -> list[str]:
        captured.update(payload)
        assert settings.ai_translation_model == "translation-model"
        assert expected_count == 1
        return ["我推的人是……"]

    monkeypatch.setattr("app.modules.japanese.service._post_ai_translation", fake_post)
    result = await translate_japanese_catalog_titles(
        ["私の推しは。"],
        Settings(
            ai_translation_api_key="secret",
            ai_translation_base_url="https://ai.example.com/v1",
            ai_translation_model="translation-model",
        ),
        source_work_title="原作",
        translated_work_title="译名",
        title_contexts=[{"index": 104, "opening_excerpt": "私の推しは彼女だった。", "previous_title": "私が、貴女を"}],
        series_memory={"characters": [{"source": "クレア", "target": "克莱拉"}]},
    )

    user_payload = json.loads(captured["messages"][1]["content"])
    assert result.translations == ["我推的人是……"]
    assert user_payload["entries"][0]["title"] == "私の推しは。"
    assert user_payload["entries"][0]["opening_excerpt"] == "私の推しは彼女だった。"
    assert user_payload["series_memory"]["characters"][0]["target"] == "克莱拉"


@pytest.mark.asyncio
async def test_catalog_translation_rejects_misaligned_context() -> None:
    with pytest.raises(ValueError, match="context count"):
        await translate_japanese_catalog_titles(
            ["第一話"],
            Settings(
                ai_translation_api_key="secret",
                ai_translation_base_url="https://ai.example.com/v1",
                ai_translation_model="translation-model",
            ),
            source_work_title="原作",
            translated_work_title="译名",
            title_contexts=[],
        )


@pytest.mark.asyncio
async def test_ai_translation_requires_an_explicit_model() -> None:
    with pytest.raises(RuntimeError, match="not configured"):
        await translate_japanese_metadata(
            [("title", "作品名")],
            Settings(ai_translation_api_key="secret", ai_translation_base_url="https://ai.example.com/v1"),
        )


@pytest.mark.asyncio
async def test_ai_translation_retries_transient_provider_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, json={"error": "temporarily unavailable"})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"translations":["译文"]}'}}]})

    monkeypatch.setattr("app.modules.translations.ai.AI_JOB_RETRY_DELAYS_SECONDS", (0, 0))
    settings = Settings(ai_translation_api_key="secret", ai_translation_base_url="https://ai.example.com/v1")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _post_ai_translation(client, payload={"model": "test"}, settings=settings, expected_count=1)

    assert result == ["译文"]
    assert attempts == 2


@pytest.mark.asyncio
async def test_ai_translation_empty_choices_falls_back_to_secondary_model(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    attempted_models: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        attempted_models.append(model)
        if model == "primary-model":
            return httpx.Response(200, json={"choices": []})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"translations":["译文"]}'}}]})

    monkeypatch.setattr("app.modules.translations.ai.AI_JOB_RETRY_DELAYS_SECONDS", (0, 0))
    settings = Settings(
        ai_translation_api_key="secret",
        ai_translation_base_url="https://ai.example.com/v1",
        ai_translation_model="primary-model",
        ai_translation_secondary_model="secondary-model",
        storage_root=str(tmp_path),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _post_ai_translation(
            client,
            payload={"model": "primary-model", "messages": [], "stream": False},
            settings=settings,
            expected_count=1,
        )

    assert result == ["译文"]
    assert attempted_models == ["primary-model", "primary-model", "secondary-model"]


@pytest.mark.asyncio
async def test_ai_translation_retired_model_falls_back_to_secondary_model(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    attempted_models: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        attempted_models.append(model)
        if model == "retired-model":
            return httpx.Response(410, json={"error": "model retired"})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"translations":["译文"]}'}}]})

    monkeypatch.setattr("app.modules.translations.ai.AI_JOB_RETRY_DELAYS_SECONDS", (0, 0))
    settings = Settings(
        ai_translation_api_key="secret",
        ai_translation_base_url="https://ai.example.com/v1",
        ai_translation_model="retired-model",
        ai_translation_secondary_model="secondary-model",
        storage_root=str(tmp_path),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _post_ai_translation(
            client,
            payload={"model": "retired-model", "messages": [], "stream": False},
            settings=settings,
            expected_count=1,
        )

    assert result == ["译文"]
    assert attempted_models == ["retired-model", "secondary-model"]


@pytest.mark.asyncio
async def test_ai_translation_policy_refusal_falls_back_to_secondary_model(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    attempted_models: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        attempted_models.append(model)
        if model == "blocked-model":
            return httpx.Response(200, json={
                "choices": [{
                    "finish_reason": "stop",
                    "native_finish_reason": "prohibited_content",
                    "message": {"content": "partial"},
                }],
            })
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"translations":["译文"]}'}}]})

    monkeypatch.setattr("app.modules.translations.ai.AI_JOB_RETRY_DELAYS_SECONDS", (0, 0))
    settings = Settings(
        ai_translation_api_key="secret",
        ai_translation_base_url="https://ai.example.com/v1",
        ai_translation_model="blocked-model",
        ai_translation_secondary_model="secondary-model",
        storage_root=str(tmp_path),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _post_ai_translation(
            client,
            payload={"model": "blocked-model", "messages": [], "stream": False},
            settings=settings,
            expected_count=1,
        )

    assert result == ["译文"]
    assert attempted_models == ["blocked-model", "secondary-model"]


@pytest.mark.asyncio
async def test_ai_translation_keeps_policy_error_when_all_gemini_lanes_refuse(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "choices": [{
                "finish_reason": "stop",
                "native_finish_reason": "prohibited_content",
                "message": {"content": "partial"},
            }],
        })

    monkeypatch.setattr("app.modules.translations.ai.AI_JOB_RETRY_DELAYS_SECONDS", (0, 0))
    settings = Settings(
        ai_translation_api_key="secret",
        ai_translation_base_url="https://ai.example.com/v1",
        ai_translation_model="blocked-model",
        ai_translation_secondary_model="blocked-secondary-model",
        storage_root=str(tmp_path),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ContentFilteredError):
            await _post_ai_translation(
                client,
                payload={"model": "blocked-model", "messages": [], "stream": False},
                settings=settings,
                expected_count=1,
            )


@pytest.mark.asyncio
async def test_ai_translation_falls_back_to_responses_api_when_chat_route_is_missing() -> None:
    seen_paths: list[str] = []
    seen_responses_payload: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(404)
        seen_responses_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"output": [{"content": [{"type": "output_text", "text": '{"translations":["译文"]}'}]}]},
        )

    settings = Settings(
        ai_translation_api_key="secret",
        ai_translation_base_url="https://ai.example.com/v1",
        ai_translation_model="responses-model",
    )
    payload = {
        "model": "responses-model",
        "messages": [
            {"role": "system", "content": "Return JSON."},
            {"role": "user", "content": "Translate this."},
        ],
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _post_ai_translation(client, payload=payload, settings=settings, expected_count=1)

    assert result == ["译文"]
    assert seen_paths == ["/v1/chat/completions", "/v1/responses"]
    assert seen_responses_payload["model"] == "responses-model"
    assert seen_responses_payload["instructions"] == "Return JSON."


def test_ai_translation_endpoint_requires_server_configuration(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/v1/books/reader/japanese-ai-translation",
        headers=auth_headers,
        json={"texts": ["今日はいい天気です。"]},
    )

    assert response.status_code == 503


def test_reader_ai_translation_uses_saved_channel(client: TestClient, auth_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post(
        "/api/v1/ai-channels",
        headers=auth_headers,
        json={
            "name": "CPA Gemini",
            "base_url": "https://cpa.example.com/v1",
            "api_key": "cpa-key",
            "models": [{"model": "gemini-reader"}],
        },
    )
    assert created.status_code == 201
    captured: dict[str, str] = {}

    async def fake_translate(texts: list[str], settings: Settings, **_kwargs: object) -> JapaneseAiTranslationResponse:
        captured.update({
            "base_url": settings.ai_translation_base_url,
            "api_key": settings.ai_translation_api_key,
            "model": settings.ai_translation_model,
        })
        return JapaneseAiTranslationResponse(model=settings.ai_translation_model, translations=[f"译：{text}" for text in texts])

    monkeypatch.setattr("app.modules.reader.api.translate_japanese_texts", fake_translate)
    response = client.post(
        "/api/v1/books/reader/japanese-ai-translation",
        headers=auth_headers,
        json={"texts": ["今日はいい天気です。"]},
    )

    assert response.status_code == 200
    assert response.json()["model"] == "gemini-reader"
    assert captured == {
        "base_url": "https://cpa.example.com/v1",
        "api_key": "cpa-key",
        "model": "gemini-reader",
    }


@pytest.mark.parametrize(
    "error, expected_status, expected_detail",
    [
        (ProviderUnavailableError("gateway down"), 502, "AI 翻译暂时不可用"),
        (ContentFilteredError("blocked"), 422, "内容政策拒绝"),
    ],
)
def test_reader_ai_translation_maps_provider_failures(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    expected_status: int,
    expected_detail: str,
) -> None:
    created = client.post(
        "/api/v1/ai-channels",
        headers=auth_headers,
        json={
            "name": "Failure mapping channel",
            "base_url": "https://cpa.example.com/v1",
            "api_key": "cpa-key",
            "models": [{"model": "gemini-reader"}],
        },
    )
    assert created.status_code == 201

    async def fail(*_args: object, **_kwargs: object) -> JapaneseAiTranslationResponse:
        raise error

    monkeypatch.setattr("app.modules.reader.api.translate_japanese_texts", fail)
    response = client.post(
        "/api/v1/books/reader/japanese-ai-translation",
        headers=auth_headers,
        json={"texts": ["今日はいい天気です。"]},
    )

    assert response.status_code == expected_status
    assert expected_detail in response.json()["detail"]


@pytest.mark.asyncio
async def test_reader_translation_uses_work_context_and_preferences(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_request(texts: list[str], _settings: Settings, **kwargs: object) -> list[str]:
        captured.update(kwargs)
        return [f"译：{text}" for text in texts]

    monkeypatch.setattr("app.modules.japanese.service._request_ai_translations", fake_request)
    result = await translate_japanese_texts(
        ["彼女だった。"],
        Settings(
            ai_translation_api_key="secret",
            ai_translation_base_url="https://ai.example.com/v1",
            ai_translation_model="translation-model",
        ),
        work_title="作品名",
        chapter_title="第一话",
        translation_preferences="主人公为女性。",
    )

    assert result.translations == ["译：彼女だった。"]
    assert captured == {
        "work_title": "作品名",
        "chapter_title": "第一话",
        "translation_preferences": "主人公为女性。",
    }
