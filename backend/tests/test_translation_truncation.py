from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3

import httpx
import pytest

from app.core.config import Settings
from app.modules.translations import ai as translation_ai
from app.modules.translations.ai import (
    CallBudgetExhaustedError,
    ContentFilteredError,
    EmptyGenerationError,
    ResponseTruncatedError,
    parse_structured_http_response,
    request_structured_ai,
    uses_streaming,
)


PRIMARY = "假流式-gemini-3-flash-preview"
SECONDARY = "gemini-3-flash"
RESCUE = "假流式-gemini-3.1-pro-preview"


def sse(*events: dict) -> httpx.Response:
    """Build a response shaped like the gateway's pseudo-streaming answers."""
    body = "".join(f"data: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events)
    return httpx.Response(
        200,
        text=body + "data: [DONE]\n\n",
        headers={"content-type": "text/event-stream"},
        request=httpx.Request("POST", "https://ai.example/v1/chat/completions"),
    )


def delta(content: str | None = None, finish: str | None = None, *, role: bool = False) -> dict:
    body: dict = {}
    if role:
        body["role"] = "assistant"
    if content is not None:
        body["content"] = content
    return {"choices": [{"index": 0, "delta": body, "finish_reason": finish}]}


# --- finish_reason handling ------------------------------------------------
#
# The channel answers 200 even when the model never got to finish. Reading only
# the body made a cut-off answer indistinguishable from a flaky gateway, so it
# was retried four more times with the identical payload -- which reproduces the
# same runaway reasoning budget every time.


def test_truncated_json_is_reported_as_truncation_not_bad_json() -> None:
    with pytest.raises(ResponseTruncatedError):
        parse_structured_http_response(sse(delta('{"translations": ["半截', finish="length")), streaming=True)


def test_truncation_before_any_content_is_reported_as_truncation() -> None:
    with pytest.raises(ResponseTruncatedError):
        parse_structured_http_response(sse(delta(role=True, finish="length")), streaming=True)


def test_content_filter_is_reported_instead_of_a_json_error() -> None:
    with pytest.raises(ContentFilteredError):
        parse_structured_http_response(sse(delta(role=True, finish="content_filter")), streaming=True)


def test_success_shaped_stream_with_no_answer_is_reported_as_an_empty_generation() -> None:
    # Exactly what the gateway sent on 2026-08-14: finish_reason "stop", every
    # token count zero, and not a single content frame. Upstream never ran it.
    empty = {
        "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
    with pytest.raises(EmptyGenerationError) as caught:
        parse_structured_http_response(sse(empty), streaming=True)
    # The message has to carry the evidence; reading only the exception type is
    # what made this take a full investigation to identify.
    assert "total_tokens=0" in str(caught.value)


def test_empty_generation_escalates_instead_of_being_re_asked(channel, tmp_path: Path) -> None:
    calls, _streamed, behaviour = channel
    behaviour[PRIMARY] = ("", "stop")
    behaviour[RESCUE] = ('{"translations": ["完整"]}', "stop")

    assert ask(settings_for(tmp_path, ai_translation_rescue_model=RESCUE)) == {"translations": ["完整"]}
    # One call each. Before this, the identical payload went out five times to
    # the primary alone, three times over.
    assert calls == [PRIMARY, RESCUE]


def test_truncation_is_detected_on_non_streaming_answers_too() -> None:
    response = httpx.Response(
        200,
        json={"choices": [{"message": {"content": '{"translations": ["半'}, "finish_reason": "length"}]},
        request=httpx.Request("POST", "https://ai.example/v1/chat/completions"),
    )
    with pytest.raises(ResponseTruncatedError):
        parse_structured_http_response(response, streaming=False)


def test_malformed_but_complete_answer_stays_a_plain_value_error() -> None:
    with pytest.raises(ValueError) as caught:
        parse_structured_http_response(sse(delta("not json at all", finish="stop")), streaming=True)
    assert not isinstance(caught.value, ResponseTruncatedError)


def test_answer_that_hit_the_cap_but_closed_its_json_is_kept() -> None:
    # The count check downstream decides whether it is short; throwing it away
    # here would discard a usable generation.
    parsed = parse_structured_http_response(sse(delta('{"translations": ["一段"]}', finish="length")), streaming=True)
    assert parsed == {"translations": ["一段"]}


def test_fenced_json_still_parses() -> None:
    parsed = parse_structured_http_response(
        sse(delta('```json\n{"translations": ["甲", "乙"]}\n```', finish="stop")), streaming=True
    )
    assert parsed == {"translations": ["甲", "乙"]}


def test_gateway_that_ignores_stream_true_still_parses() -> None:
    response = httpx.Response(
        200,
        json={"choices": [{"message": {"content": '{"translations": ["丙"]}'}, "finish_reason": "stop"}]},
        request=httpx.Request("POST", "https://ai.example/v1/chat/completions"),
    )
    assert parse_structured_http_response(response, streaming=True) == {"translations": ["丙"]}


def test_pseudo_streaming_aliases_are_recognized_by_prefix() -> None:
    assert uses_streaming(PRIMARY)
    assert uses_streaming(RESCUE)
    assert not uses_streaming("gpt-5.5")


# --- escalation and daily call budget --------------------------------------


class _RecordingClient:
    """Stands in for httpx.AsyncClient, recording the model of every call."""

    def __init__(self, calls: list[str], streamed: list[bool], behaviour: dict[str, tuple[str, str]]) -> None:
        self._calls = calls
        self._streamed = streamed
        self._behaviour = behaviour

    async def __aenter__(self) -> "_RecordingClient":
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False

    async def post(self, url: str, *, headers: dict, json: dict) -> httpx.Response:  # noqa: A002
        model = json["model"]
        self._calls.append(model)
        self._streamed.append(bool(json.get("stream")))
        content, finish = self._behaviour.get(model, ('{"translations": ["ok"]}', "stop"))
        if content == "__429__":
            return httpx.Response(
                429,
                json={"error": {"message": "daily quota exhausted"}},
                request=httpx.Request("POST", url),
            )
        if content == "__RPM429__":
            return httpx.Response(
                429,
                json={"error": {"message": "rate limit exceeded; retry later"}},
                request=httpx.Request("POST", url),
            )
        if content == "":
            # The gateway's "success with nothing in it": no content frame at
            # all, every token count zero.
            return sse(
                {
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                }
            )
        if json.get("stream"):
            return sse(delta(content, finish=finish))
        import json as json_module

        return httpx.Response(
            200,
            content=json_module.dumps({"choices": [{"message": {"content": content}, "finish_reason": finish}]}).encode(),
            headers={"content-type": "application/json"},
            request=httpx.Request("POST", url),
        )


@pytest.fixture()
def channel(monkeypatch: pytest.MonkeyPatch):
    calls: list[str] = []
    streamed: list[bool] = []
    behaviour: dict[str, tuple[str, str]] = {}

    monkeypatch.setattr(
        translation_ai.httpx, "AsyncClient", lambda *a, **k: _RecordingClient(calls, streamed, behaviour)
    )
    monkeypatch.setattr(translation_ai, "AI_JOB_RETRY_DELAYS_SECONDS", (0.0, 0.0, 0.0, 0.0))
    monkeypatch.setattr(translation_ai, "_call_budgets", {})
    return calls, streamed, behaviour


def settings_for(tmp_path: Path, **overrides) -> Settings:
    from dataclasses import replace

    base = Settings(
        storage_root=str(tmp_path),
        ai_translation_api_key="key",
        ai_platform_builtin_api_key="key",
        ai_translation_base_url="https://ai.example/v1",
        ai_translation_model=PRIMARY,
    )
    return replace(base, **overrides)


def ask(settings: Settings) -> dict:
    return asyncio.run(request_structured_ai(settings, system_prompt="s", user_payload={"a": 1}))


def test_truncation_costs_one_call_instead_of_five(channel, tmp_path: Path) -> None:
    calls, _streamed, behaviour = channel
    behaviour[PRIMARY] = ('{"translations": ["半截', "length")

    with pytest.raises(ResponseTruncatedError):
        ask(settings_for(tmp_path))

    assert calls == [PRIMARY]


def test_truncation_escalates_to_the_rescue_model(channel, tmp_path: Path) -> None:
    calls, streamed, behaviour = channel
    behaviour[PRIMARY] = ('{"translations": ["半截', "length")
    behaviour[RESCUE] = ('{"translations": ["完整"]}', "stop")

    assert ask(settings_for(tmp_path, ai_translation_rescue_model=RESCUE)) == {"translations": ["完整"]}
    assert calls == [PRIMARY, RESCUE]
    assert streamed == [True, True]


def test_a_healthy_primary_is_never_escalated(channel, tmp_path: Path) -> None:
    calls, _streamed, _behaviour = channel

    ask(settings_for(tmp_path, ai_translation_rescue_model=RESCUE))

    assert calls == [PRIMARY]


def test_daily_budget_blocks_further_calls_and_persists(channel, tmp_path: Path) -> None:
    calls, _streamed, _behaviour = channel

    for _ in range(3):
        ask(settings_for(tmp_path, ai_translation_daily_call_budget=3))
    with pytest.raises(CallBudgetExhaustedError) as caught:
        # A fresh Settings object: the count has to come off disk, because the
        # worker restarts far more often than the allowance resets.
        ask(settings_for(tmp_path, ai_translation_daily_call_budget=3))

    assert calls == [PRIMARY, PRIMARY, PRIMARY]
    assert PRIMARY in str(caught.value)


def test_rescue_lane_takes_the_overflow_once_the_primary_is_spent(channel, tmp_path: Path) -> None:
    calls, _streamed, _behaviour = channel
    settings = settings_for(
        tmp_path,
        ai_translation_daily_call_budget=1,
        ai_translation_rescue_model=RESCUE,
        ai_translation_rescue_daily_call_budget=2,
    )

    for _ in range(3):
        ask(settings)
    with pytest.raises(CallBudgetExhaustedError):
        ask(settings)

    assert calls == [PRIMARY, RESCUE, RESCUE]
    budget = translation_ai.call_budget_for(settings)
    assert (budget.spent(PRIMARY), budget.spent(RESCUE)) == (1, 2)


def test_three_tier_budget_falls_from_high_to_flash_then_pro(channel, tmp_path: Path) -> None:
    calls, _streamed, _behaviour = channel
    settings = settings_for(
        tmp_path,
        ai_translation_daily_call_budget=1,
        ai_translation_secondary_model=SECONDARY,
        ai_translation_secondary_daily_call_budget=2,
        ai_translation_rescue_model=RESCUE,
        ai_translation_rescue_daily_call_budget=1,
    )

    for _ in range(4):
        ask(settings)
    with pytest.raises(CallBudgetExhaustedError):
        ask(settings)

    assert calls == [PRIMARY, SECONDARY, SECONDARY, RESCUE]
    budget = translation_ai.call_budget_for(settings)
    assert (budget.spent(PRIMARY), budget.spent(SECONDARY), budget.spent(RESCUE)) == (1, 2, 1)


def test_provider_429_falls_back_and_exhausts_primary_counter(channel, tmp_path: Path) -> None:
    calls, _streamed, behaviour = channel
    behaviour[PRIMARY] = ("__429__", "stop")
    settings = settings_for(
        tmp_path,
        ai_translation_daily_call_budget=200,
        ai_translation_secondary_model=SECONDARY,
        ai_translation_secondary_daily_call_budget=3000,
    )

    assert ask(settings) == {"translations": ["ok"]}
    assert ask(settings) == {"translations": ["ok"]}

    # Only the first request probes High. Persisting its provider-side 429 as a
    # spent daily allowance prevents every later chunk from wasting a failed
    # call before falling through to standard Flash.
    assert calls == [PRIMARY, SECONDARY, SECONDARY]
    budget = translation_ai.call_budget_for(settings)
    assert (budget.spent(PRIMARY), budget.spent(SECONDARY)) == (200, 2)


def test_temporary_429_retries_without_exhausting_daily_counter(channel, tmp_path: Path) -> None:
    calls, _streamed, behaviour = channel
    behaviour[PRIMARY] = ("__RPM429__", "stop")
    settings = settings_for(
        tmp_path,
        ai_translation_daily_call_budget=200,
        ai_translation_secondary_model=SECONDARY,
        ai_translation_secondary_daily_call_budget=3000,
    )

    assert ask(settings) == {"translations": ["ok"]}

    assert calls == [PRIMARY, PRIMARY, PRIMARY, PRIMARY, PRIMARY, SECONDARY]
    budget = translation_ai.call_budget_for(settings)
    assert (budget.spent(PRIMARY), budget.spent(SECONDARY)) == (5, 1)


def test_zero_budget_means_unlimited(channel, tmp_path: Path) -> None:
    calls, _streamed, _behaviour = channel

    for _ in range(6):
        ask(settings_for(tmp_path))

    assert len(calls) == 6


def test_budget_reservations_are_atomic_across_workers(tmp_path: Path) -> None:
    path = tmp_path / "ai-call-usage.sqlite3"

    def reserve(_: int) -> bool:
        budget = translation_ai.DailyCallBudget(path, "channel-a")
        return asyncio.run(budget.reserve(PRIMARY, 7))

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(reserve, range(40)))
    assert sum(results) == 7
    assert translation_ai.DailyCallBudget(path, "channel-a").spent(PRIMARY) == 7
    other_channel = translation_ai.DailyCallBudget(path, "channel-b")
    assert asyncio.run(other_channel.reserve(PRIMARY, 7))
    assert other_channel.spent(PRIMARY) == 1


def test_global_budget_is_shared_across_channels_atomically(tmp_path: Path) -> None:
    path = tmp_path / "ai-call-usage.sqlite3"

    def reserve(index: int) -> bool:
        channel = f"channel-{index % 3}"
        return asyncio.run(translation_ai.DailyCallBudget(path, channel).reserve(PRIMARY, 10, global_allowance=5))

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(reserve, range(24)))
    assert sum(results) == 5
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT count FROM calls WHERE channel='__global__'").fetchone()[0] == 5


def test_budget_storage_failure_stops_calls(tmp_path: Path) -> None:
    path = tmp_path / "ai-call-usage.sqlite3"
    path.mkdir()
    budget = translation_ai.DailyCallBudget(path)
    with pytest.raises(translation_ai.ProviderUnavailableError, match="停止发送请求"):
        asyncio.run(budget.reserve(PRIMARY, 1))


def test_budget_imports_existing_json_count_without_reset(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    day = translation_ai.quota_day(translation_ai.datetime.now(translation_ai.timezone.utc))
    (tmp_path / "ai-call-usage.json").write_text(json.dumps({day: {PRIMARY: 3}}), encoding="utf-8")
    budget = translation_ai.call_budget_for(settings)
    assert not asyncio.run(budget.reserve(PRIMARY, 3))
    assert asyncio.run(budget.reserve(PRIMARY, 4))
    assert budget.spent(PRIMARY) == 4


def test_global_budget_includes_old_json_calls_from_other_models(tmp_path: Path) -> None:
    day = translation_ai.quota_day(translation_ai.datetime.now(translation_ai.timezone.utc))
    (tmp_path / "ai-call-usage.json").write_text(
        json.dumps({day: {PRIMARY: 2, "another-model": 3}}), encoding="utf-8"
    )
    budget = translation_ai.DailyCallBudget(tmp_path / "ai-call-usage.sqlite3", "new-channel")
    assert not asyncio.run(budget.reserve(PRIMARY, 10, global_allowance=5))
    assert asyncio.run(budget.reserve(PRIMARY, 10, global_allowance=6))
    with sqlite3.connect(tmp_path / "ai-call-usage.sqlite3") as connection:
        assert connection.execute("SELECT count FROM calls WHERE channel='__global__'").fetchone()[0] == 6
