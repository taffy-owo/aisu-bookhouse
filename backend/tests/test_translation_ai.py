from __future__ import annotations

import asyncio

import httpx
import pytest

from app.core.config import Settings
from app.modules.translations import ai as translation_ai
from app.modules.translations.ai import ProviderUnavailableError


def test_retries_empty_success_response(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, content=b"")
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"translations":["译文"]}'}}]},
        )

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(translation_ai.asyncio, "sleep", no_sleep)
    settings = Settings(ai_translation_base_url="https://ai.example/v1", ai_translation_api_key="key")
    payload = {"model": "model", "messages": []}
    async def run() -> dict[str, object]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await translation_ai._post_with_retries(client, settings, payload)

    result = asyncio.run(run())

    assert calls == 2
    assert result == {"translations": ["译文"]}


def test_retries_invalid_model_json_inside_valid_http_json(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        content = "not-json" if calls == 1 else '{"translations":["译文"]}'
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(translation_ai.asyncio, "sleep", no_sleep)
    settings = Settings(ai_translation_base_url="https://ai.example/v1", ai_translation_api_key="key")
    async def run() -> dict[str, object]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await translation_ai._post_with_retries(client, settings, {"model": "model"})

    result = asyncio.run(run())

    assert calls == 2
    assert result == {"translations": ["译文"]}


def test_invalid_success_responses_exhaust_as_provider_error(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def invalid_response(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=b"")

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(translation_ai.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(translation_ai, "AI_JOB_RETRY_DELAYS_SECONDS", (0.0, 0.0))
    settings = Settings(ai_translation_base_url="https://ai.example/v1", ai_translation_api_key="key")
    async def run() -> dict[str, object]:
        transport = httpx.MockTransport(invalid_response)
        async with httpx.AsyncClient(transport=transport) as client:
            return await translation_ai._post_with_retries(client, settings, {"model": "model"})

    with pytest.raises(ProviderUnavailableError, match="空白或无效 JSON"):
        asyncio.run(run())
    assert calls == 2
