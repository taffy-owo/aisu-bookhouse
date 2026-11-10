from __future__ import annotations

import asyncio
import contextlib
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import re
import sqlite3
from hashlib import sha256
import time
import threading
from typing import Any

import httpx

from app.core.config import Settings
from app.core.ai_credentials import is_platform_ai_credential
from app.core.safe_outbound import public_https_client
from app.modules.translations.provider_observations import begin_provider_attempt, record_provider_success, attach_provider_failure


AI_JOB_TIMEOUT_SECONDS = 240.0
AI_JOB_RETRY_DELAYS_SECONDS = (2.0, 6.0, 15.0, 40.0)
# A malformed 2xx body gets one cheap re-ask.  Repeating the identical prompt
# five times cost 63 seconds before the caller could halve the paragraph block,
# which is the recovery that actually fixes reproducible malformed generations.
UNUSABLE_PAYLOAD_MAX_ATTEMPTS = 2
STREAMING_MODELS = {"deepseek-v4-flash", "假流式-gemini-3-flash-preview"}
# The gateway prefixes its pseudo-streaming aliases with 假流式; every one of
# them has to be asked with stream=true or the proxy's ~90s idle timeout cuts
# long generations off. Matching the prefix means a newly added alias (the pro
# rescue lane, for one) behaves correctly without editing the set above.
STREAMING_MODEL_PREFIXES = ("假流式",)


def is_gemini_model(model: str) -> bool:
    """Return whether a model belongs to the Gemini fallback family.

    Automatic translation recovery is intentionally limited to Gemini lanes.
    Keep the check case-insensitive because saved CPA model aliases vary in
    casing (and some use an internal prefix such as ``agy-``).
    """
    return bool(re.search(r"gemini", model, re.IGNORECASE))


# Any 5xx from an LLM gateway is worth another attempt: besides the usual 502/503
# the channel also surfaces upstream read timeouts as 52x, which used to escape
# raise_for_status and fail a whole book on one slow generation.
TRANSIENT_STATUS_CODES = {408, 409, 425, 429}
# The gateway rolls its per-model daily allowance at UTC+8 midnight, the same
# boundary ``next_quota_reset`` reports to the user.
QUOTA_RESET_OFFSET_HOURS = 8
logger = logging.getLogger(__name__)


class ProviderUnavailableError(RuntimeError):
    """The channel kept failing after every transport-level retry."""


class ResponseTruncatedError(ProviderUnavailableError):
    """The provider stopped mid-answer because it ran out of output budget.

    Worth its own type because re-sending the identical request is *guaranteed*
    to fail again: gemini-3-flash reproduces the same runaway reasoning budget
    every time (measured 4/4 on one recorded payload, ~62.9k reasoning tokens
    against a ~65.5k ceiling, leaving too little room for the answer). The old
    code saw only the resulting ``JSONDecodeError``, treated it as a flaky
    gateway, and burned four more identical calls plus ~18 minutes per hit.
    Callers must shrink the request or escalate to another model instead.

    Subclasses ``ProviderUnavailableError`` so the existing halve-and-retry and
    transient-failure paths in the service layer keep handling it; only the
    pointless identical retries inside ``_post_with_retries`` are skipped.
    """


class ContentFilteredError(RuntimeError):
    """An explicit provider refusal is terminal, not a transport retry/split signal."""

    def __init__(self, message: str, *, diagnostics: dict | None = None):
        super().__init__(message)
        self.diagnostics = {**translation_diagnostic_context.get(), **(diagnostics or {})}

    def __str__(self) -> str:
        details = '，'.join(f'{key}={value}' for key, value in self.diagnostics.items())
        return super().__str__() + (f'（{details}）' if details else '')


translation_diagnostic_context: ContextVar[dict] = ContextVar('translation_diagnostic_context', default={})


@contextlib.asynccontextmanager
async def translation_diagnostics_scope(**details):
    token = translation_diagnostic_context.set(details)
    try:
        yield
    finally:
        translation_diagnostic_context.reset(token)


def set_translation_diagnostic_phase(phase: str) -> None:
    translation_diagnostic_context.set({**translation_diagnostic_context.get(), 'phase': phase})


FILTER_REASONS = {
    'content_filter': '兼容接口内容过滤（未说明具体类别）',
    'safety': '安全过滤', 'recitation': '复述/引用限制',
    'prohibited_content': '禁止内容限制', 'blocklist': '屏蔽词表限制',
    'spii': '敏感个人信息限制', 'image_safety': '图像安全限制',
    'content_policy_violation': '内容政策限制',
}


def _diagnostic_code(value: object) -> str:
    # Persist codes only, never upstream prose, credentials or echoed prompts.
    if not isinstance(value, (str, int)):
        return ''
    text = str(value)
    if re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', text) and not re.match(r'(?:sk-|gg-gcli-|Bearer)', text, re.I):
        return text
    return 'unrecognized'


def _provider_filter_error(payload: dict, *, signal: str, reason: str) -> ContentFilteredError:
    details = {'signal': signal, 'reason': _diagnostic_code(reason)}
    if payload.get('id'):
        details['response_id'] = _diagnostic_code(payload['id'])
    choices = payload.get('choices')
    first = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
    for key in ('finish_reason', 'native_finish_reason'):
        if first.get(key) is not None:
            details[key] = _diagnostic_code(first[key])
    provider_error = payload.get('error')
    if isinstance(provider_error, dict):
        for key in ('code', 'type'):
            if provider_error.get(key) is not None:
                details['provider_error_' + key] = _diagnostic_code(provider_error[key])
    label = FILTER_REASONS.get(reason.lower(), '上游明确阻止请求（原因未分类）')
    return ContentFilteredError(f'AI 返回{label}；已停止自动重试', diagnostics=details)


def _attach_response_diagnostics(error: ContentFilteredError, response: httpx.Response) -> None:
    error.diagnostics.update(http_status=response.status_code, response_bytes=len(response.content))
    request_id = response.headers.get('x-request-id') or response.headers.get('request-id') or response.headers.get('x-goog-request-id')
    if request_id:
        error.diagnostics['request_id'] = _diagnostic_code(request_id)


class EmptyGenerationError(ProviderUnavailableError):
    """A 200 stream that reports success but contains no answer at all.

    The gateway sends ``finish_reason: "stop"`` with every token count at zero:
    upstream never ran the request, yet nothing about the response says so.
    Measured on 2026-08-14, one 22kB interpretation request produced this on
    eleven consecutive attempts, so re-asking the same model is not a recovery
    strategy -- it is how a single poisoned request burned three outer attempts
    times five transport retries and then parked the whole book as
    ``waiting_quota``. Escalate or shrink instead.
    """


class StructuredListError(ValueError):
    """The provider answered, but the array it returned does not match the request.

    Kept distinct from the transport/HTTP failures handled inside
    ``_post_with_retries`` so callers can decide between re-asking, splitting the
    request into smaller pieces, and falling back to an earlier pass.
    """

    def __init__(self, message: str, *, reason: str, expected_count: int, received_count: int) -> None:
        super().__init__(message)
        self.reason = reason
        self.expected_count = expected_count
        self.received_count = received_count


def is_transient_status(status_code: int) -> bool:
    return status_code >= 500 or status_code in TRANSIENT_STATUS_CODES


def uses_streaming(model: str) -> bool:
    return model in STREAMING_MODELS or model.startswith(STREAMING_MODEL_PREFIXES) or bool(
        re.search(r"(?:^|[/:-])gemini-", model, re.IGNORECASE)
    )


class _ThreadRequestGate:
    """Cancellation-safe async gate shared by the worker's separate loop threads."""

    def __init__(self, limit: int):
        self._slots = threading.BoundedSemaphore(limit)

    async def __aenter__(self):
        while not self._slots.acquire(blocking=False):
            await asyncio.sleep(0.05)
        return self

    async def __aexit__(self, *_args):
        self._slots.release()


_request_limiters: dict[str, _ThreadRequestGate] = {}
_request_limiters_lock = threading.Lock()


def _request_limiter(settings: Settings) -> _ThreadRequestGate:
    # All chapter windows, recursive shape repairs and memory calls share the
    # actual HTTP gate. Separate credentials/endpoints never block each other.
    key = sha256((settings.ai_translation_base_url.rstrip('/') + '\0' + settings.ai_translation_api_key).encode()).hexdigest()
    with _request_limiters_lock:
        if key not in _request_limiters:
            _request_limiters[key] = _ThreadRequestGate(max(1, settings.ai_translation_max_concurrency))
        return _request_limiters[key]


class CallBudgetExhaustedError(ProviderUnavailableError):
    """Every model configured for this channel has spent its daily allowance.

    Subclasses ``ProviderUnavailableError`` on purpose so the existing
    retry-backoff and ``waiting_quota`` parking keep working unchanged; only the
    message the user sees is more precise.
    """


class RateLimitedError(ProviderUnavailableError):
    """The current model returned 429 and should yield to the next lane.

    Providers use the same status for a short RPM burst and an exhausted daily
    allowance. Only the latter may fast-forward the persisted daily counter.
    """

    def __init__(self, message: str, *, quota_exhausted: bool = False) -> None:
        super().__init__(message)
        self.quota_exhausted = quota_exhausted


def quota_day(now: datetime) -> str:
    """The gateway's allowance day that ``now`` falls in, as a plain date key."""
    return now.astimezone(timezone(timedelta(hours=QUOTA_RESET_OFFSET_HOURS))).strftime("%Y-%m-%d")


class DailyCallBudget:
    """Atomically reserve each provider call in a durable, per-channel ledger."""

    def __init__(self, path: Path, channel: str = "default") -> None:
        self._path = path
        self._channel = channel

    def _connect(self) -> sqlite3.Connection:
        connection: sqlite3.Connection | None = None
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self._path, timeout=30, isolation_level=None)
            connection.execute("PRAGMA busy_timeout=30000")
            connection.execute("CREATE TABLE IF NOT EXISTS calls (day TEXT NOT NULL, channel TEXT NOT NULL, model TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, channel, model))")
            return connection
        except (OSError, sqlite3.Error) as error:
            if connection is not None:
                connection.close()
            raise ProviderUnavailableError("AI 调用计数无法持久化，已停止发送请求") from error

    def _legacy_counts(self, day: str) -> dict[str, int]:
        legacy_path = self._path.with_name("ai-call-usage.json")
        try:
            with legacy_path.open(encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            raise ProviderUnavailableError("旧版 AI 调用计数无法读取，已停止发送请求") from error
        if not isinstance(data, dict):
            raise ProviderUnavailableError("旧版 AI 调用计数格式错误，已停止发送请求")
        counts = data.get(day, {})
        if not isinstance(counts, dict):
            raise ProviderUnavailableError("旧版 AI 调用计数格式错误，已停止发送请求")
        if any(not isinstance(model, str) or not isinstance(value, int) or value < 0 for model, value in counts.items()):
            raise ProviderUnavailableError("旧版 AI 调用计数格式错误，已停止发送请求")
        return counts

    def _legacy_count(self, day: str, model: str) -> int:
        return self._legacy_counts(day).get(model, 0)

    def _unmigrated_legacy_calls(self, connection: sqlite3.Connection, day: str) -> int:
        """Include every old model when the platform-wide cap is first enabled."""
        legacy = self._legacy_counts(day)
        if not legacy:
            return 0
        rows = connection.execute(
            "SELECT model, SUM(count) FROM calls WHERE day=? AND channel!='__global__' GROUP BY model", (day,)
        ).fetchall()
        imported = {model: int(count) for model, count in rows}
        return sum(max(0, count - imported.get(model, 0)) for model, count in legacy.items())

    def spent(self, model: str, *, now: datetime | None = None) -> int:
        day = quota_day(now or datetime.now(timezone.utc))
        try:
            with contextlib.closing(self._connect()) as connection:
                row = connection.execute("SELECT count FROM calls WHERE day=? AND channel=? AND model=?", (day, self._channel, model)).fetchone()
                return int(row[0]) if row else self._legacy_count(day, model)
        except sqlite3.Error as error:
            raise ProviderUnavailableError("AI 调用计数无法读取，已停止发送请求") from error

    async def reserve(self, model: str, allowance: int, *, global_allowance: int = 0, now: datetime | None = None) -> bool:
        """Reserve a call before sending; false means the hard cap is reached."""
        day = quota_day(now or datetime.now(timezone.utc))
        try:
            with contextlib.closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT count FROM calls WHERE day=? AND channel=? AND model=?", (day, self._channel, model)).fetchone()
                current = int(row[0]) if row else self._legacy_count(day, model)
                if allowance > 0 and current >= allowance:
                    connection.execute("ROLLBACK")
                    return False
                global_current = 0
                if global_allowance > 0:
                    global_row = connection.execute(
                        "SELECT count FROM calls WHERE day=? AND channel='__global__' AND model='*'", (day,)
                    ).fetchone()
                    # Historical JSON predates credential ownership. Do not
                    # import SQLite BYOK rows into the site's public pool.
                    global_current = int(global_row[0]) if global_row else sum(self._legacy_counts(day).values())
                    if global_current >= global_allowance:
                        connection.execute("ROLLBACK")
                        return False
                connection.execute(
                    "INSERT INTO calls(day, channel, model, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, channel, model) DO UPDATE SET count=excluded.count",
                    (day, self._channel, model, current + 1),
                )
                if global_allowance > 0:
                    connection.execute(
                        "INSERT INTO calls(day, channel, model, count) VALUES (?, '__global__', '*', ?) ON CONFLICT(day, channel, model) DO UPDATE SET count=excluded.count",
                        (day, global_current + 1),
                    )
                connection.execute("COMMIT")
                return True
        except (OSError, sqlite3.Error) as error:
            raise ProviderUnavailableError("AI 调用计数无法持久化，已停止发送请求") from error

    async def charge(self, model: str, *, now: datetime | None = None) -> int:
        await self.reserve(model, 0, now=now)
        return self.spent(model, now=now)

    async def exhaust(self, model: str, allowance: int, *, now: datetime | None = None) -> None:
        """Fast-forward a model counter after its provider reports exhausted quota."""
        if allowance <= 0:
            return
        day = quota_day(now or datetime.now(timezone.utc))
        try:
            with contextlib.closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT count FROM calls WHERE day=? AND channel=? AND model=?", (day, self._channel, model)).fetchone()
                current = int(row[0]) if row else self._legacy_count(day, model)
                connection.execute(
                    "INSERT INTO calls(day, channel, model, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, channel, model) DO UPDATE SET count=excluded.count",
                    (day, self._channel, model, max(current, allowance)),
                )
                connection.execute("COMMIT")
        except (OSError, sqlite3.Error) as error:
            raise ProviderUnavailableError("AI 调用计数无法持久化，已停止发送请求") from error


_call_budgets: dict[str, DailyCallBudget] = {}


def call_budget_for(settings: Settings) -> DailyCallBudget:
    path = Path(settings.storage_root) / "ai-call-usage.sqlite3"
    channel = sha256((settings.ai_translation_base_url.rstrip("/").lower() + "\0" + settings.ai_translation_api_key).encode()).hexdigest()
    key = f"{path.resolve()}:{channel}"
    budget = _call_budgets.get(key)
    if budget is None:
        budget = DailyCallBudget(path, channel)
        _call_budgets[key] = budget
    return budget


def model_call_budgets(settings: Settings) -> list[tuple[str, int]]:
    """The models this channel may spend on, most preferred first.

    A budget of 0 means "no client-side cap"; the gateway's own limit is then the
    only thing holding the pace back, which is how this ran before the cap
    existed.
    """
    candidates = (
        (settings.ai_translation_model.strip(), max(0, settings.ai_translation_daily_call_budget)),
        (
            settings.ai_translation_secondary_model.strip(),
            max(0, settings.ai_translation_secondary_daily_call_budget),
        ),
        (settings.ai_translation_rescue_model.strip(), max(0, settings.ai_translation_rescue_daily_call_budget)),
    )
    lanes: list[tuple[str, int]] = []
    seen: set[str] = set()
    for model, allowance in candidates:
        if not model or model in seen:
            continue
        lanes.append((model, allowance))
        seen.add(model)
    return lanes


def platform_model_allowance(model: str, settings: Settings, *, credential_key: str | None = None) -> int:
    """Apply configured model caps only when the actual credential is site-paid."""
    if not is_platform_ai_credential(credential_key if credential_key is not None else settings.ai_translation_api_key, settings):
        return 0
    if model and model == settings.ai_translation_secondary_model:
        return settings.ai_translation_secondary_daily_call_budget
    if model and model == settings.ai_translation_rescue_model:
        return settings.ai_translation_rescue_daily_call_budget
    if model and model == settings.ai_translation_model:
        return settings.ai_translation_daily_call_budget
    return 0


async def request_structured_ai(
    settings: Settings,
    *,
    system_prompt: str,
    user_payload: dict[str, object],
    temperature: float = 0.15,
) -> dict[str, Any]:
    if not settings.ai_translation_api_key or not settings.ai_translation_base_url or not settings.ai_translation_model:
        raise RuntimeError("未配置可用的 AI 翻译渠道")
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]
    budget = call_budget_for(settings)
    platform_credential = is_platform_ai_credential(settings.ai_translation_api_key, settings)
    lanes = model_call_budgets(settings) if platform_credential else [(settings.ai_translation_model, 0)]
    exhausted: list[str] = []
    unusable: ProviderUnavailableError | None = None

    async with public_https_client(timeout=AI_JOB_TIMEOUT_SECONDS) as client:
        for model, allowance in lanes:
            if allowance and budget.spent(model) >= allowance:
                exhausted.append(f"{model}（{allowance} 次/天已用尽）")
                continue
            payload: dict[str, object] = {
                "model": model,
                "messages": messages,
                "response_format": {"type": "json_object"},
                # DeepSeek generations can exceed the compatibility proxy's
                # 90-second idle timeout. Streaming keeps bytes moving; this
                # service still buffers and validates the complete JSON before
                # exposing anything downstream.
                "stream": uses_streaming(model),
                "temperature": temperature,
            }
            # No max_tokens on purpose. The ceiling is shared with the model's
            # reasoning budget, and 8% of *successful* calls measured here spent
            # over 16k output tokens getting to a good answer, so any cap low
            # enough to stop the runaways also destroys those.
            try:
                return await _post_with_retries(client, settings, payload, budget=budget, allowance=allowance)
            except ProviderUnavailableError as error:
                # Output-shape failures, exhausted quota and repeated gateway
                # faults all get one useful recovery: continue on the next
                # configured lane. A 429 also fast-forwards the persisted local
                # counter so every following chunk does not waste another call
                # rediscovering that the model's daily pool is empty.
                unusable = error
                if isinstance(error, RateLimitedError) and error.quota_exhausted:
                    await budget.exhaust(model, allowance)
                    exhausted.append(f"{model}（提供方返回 429）")
                if model != lanes[-1][0]:
                    logger.warning(
                        "%s could not finish this request (%s); falling back to the next model", model, error
                    )
                continue

    if unusable is not None:
        raise unusable
    error = CallBudgetExhaustedError(f"AI 渠道当日调用额度已用尽：{'、'.join(exhausted)}")
    attach_provider_failure(error, begin_provider_attempt(settings.ai_translation_base_url, settings.ai_translation_model))
    raise error


async def _post_with_retries(
    client: httpx.AsyncClient,
    settings: Settings,
    payload: dict[str, object],
    *,
    budget: DailyCallBudget | None = None,
    allowance: int = 0,
) -> dict[str, Any]:
    attempts = len(AI_JOB_RETRY_DELAYS_SECONDS) + 1
    response_format_removed = False
    model = str(payload.get("model") or settings.ai_translation_model)
    for attempt in range(attempts):
        if budget is not None:
            # Charge before the call, not after: a request that is answered but
            # never parsed still spent an allowance slot upstream.
            global_allowance = (settings.ai_translation_global_daily_call_budget
                                if is_platform_ai_credential(settings.ai_translation_api_key, settings) else 0)
            if not await budget.reserve(model, allowance, global_allowance=global_allowance):
                error = CallBudgetExhaustedError(f"AI 模型 {model} 的当日调用额度已用尽")
                attach_provider_failure(error, begin_provider_attempt(settings.ai_translation_base_url, model))
                raise error
        try:
            async with _request_limiter(settings):
                started = time.monotonic()
                availability_attempt = begin_provider_attempt(settings.ai_translation_base_url, model)
                response = await client.post(
                    f"{settings.ai_translation_base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.ai_translation_api_key}"},
                    json=payload,
                )
        except httpx.TransportError as error:
            if attempt >= attempts - 1:
                raise ProviderUnavailableError(f"AI 渠道连接失败：{error}") from error
            await asyncio.sleep(AI_JOB_RETRY_DELAYS_SECONDS[attempt])
            continue

        if response.is_error:
            # Do not retry a structured policy response as a format/5xx error.
            try:
                error_payload = response.json()
            except ValueError:
                error_payload = None
            if isinstance(error_payload, dict):
                try:
                    _check_provider_refusal(error_payload)
                except ContentFilteredError as error:
                    _attach_response_diagnostics(error, response)
                    raise
        if response.status_code in {400, 422} and not response_format_removed and "response_format" in payload:
            payload = {key: value for key, value in payload.items() if key != "response_format"}
            response_format_removed = True
            continue
        if response.is_redirect:
            # follow_redirects stays off so the bearer token is never replayed to
            # a host the user did not configure. Without this branch a 3xx slips
            # past raise_for_status and surfaces as an opaque JSON decode error.
            raise RuntimeError("AI 渠道地址发生了跳转，请在设置中填写最终的接口地址（通常以 /v1 结尾）")
        if response.status_code == 429:
            provider_message = _provider_error_message(response)
            quota_exhausted = _is_explicit_daily_quota_message(provider_message)
            if quota_exhausted:
                error = RateLimitedError(
                    f"AI 模型 {model} 的当日调用额度已用尽（429）",
                    quota_exhausted=True,
                )
                attach_provider_failure(error, availability_attempt)
                raise error
            if attempt >= attempts - 1:
                raise RateLimitedError(
                    f"AI 模型 {model} 暂时触发速率限制（429），已用尽短时重试",
                    quota_exhausted=False,
                )
            retry_after = _retry_after_seconds(response)
            delay = retry_after if retry_after is not None else AI_JOB_RETRY_DELAYS_SECONDS[attempt]
            logger.warning(
                "Whole-book translation provider rate-limited %s; retry %s/%s after %.1fs",
                model,
                attempt + 1,
                attempts - 1,
                delay,
            )
            await asyncio.sleep(delay)
            continue
        if is_transient_status(response.status_code):
            if attempt >= attempts - 1:
                raise ProviderUnavailableError(f"AI 渠道连续返回 {response.status_code}，已用尽重试")
            logger.warning(
                "Whole-book translation provider returned %s; retry %s/%s",
                response.status_code,
                attempt + 1,
                attempts - 1,
            )
            await asyncio.sleep(AI_JOB_RETRY_DELAYS_SECONDS[attempt])
            continue
        response.raise_for_status()
        try:
            parsed = parse_structured_http_response(response, streaming=payload.get("stream") is True)
        except (ProviderUnavailableError, ContentFilteredError) as error:
            logger.warning("Translation response rejected model=%s elapsed=%.1fs bytes=%s reason=%s", model, time.monotonic() - started, len(response.content), str(error))
            raise
        except (ValueError, UnicodeError) as error:
            # Some compatible gateways occasionally answer 200 with an empty,
            # truncated, non-JSON, or otherwise unusable body. That is a
            # transient provider failure just like a 502, not a reason to stop
            # a multi-hour whole-book job and expose a JSON decoder message.
            #
            # Truncation/empty-generation errors use their own recovery paths.
            # ContentFilteredError is terminal and must never reach a fallback
            # model or the caller's split-and-retry path.
            unusable_attempt = attempt + 1
            if unusable_attempt >= min(attempts, UNUSABLE_PAYLOAD_MAX_ATTEMPTS):
                raise ProviderUnavailableError(f"AI 渠道连续返回空白或无效 JSON，已用尽重试（{str(error)[:160]}）") from error
            logger.warning(
                "Whole-book translation provider returned an unusable 2xx payload; retry %s/%s (%s) model=%s elapsed=%.1fs bytes=%s detail=%s",
                unusable_attempt,
                min(attempts, UNUSABLE_PAYLOAD_MAX_ATTEMPTS) - 1,
                type(error).__name__,
                model,
                time.monotonic() - started,
                len(response.content),
                str(error)[:180],
            )
            await asyncio.sleep(AI_JOB_RETRY_DELAYS_SECONDS[attempt])
            continue
        record_provider_success(availability_attempt)
        return parsed
    raise ProviderUnavailableError("AI 翻译重试次数已用尽")


def _provider_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except (ValueError, UnicodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if isinstance(error, dict):
        parts = [error.get("message"), error.get("code"), error.get("type"), error.get("status")]
        return " ".join(str(part) for part in parts if part is not None)[:1000]
    return str(error)[:1000] if error is not None else ""


def _is_explicit_daily_quota_message(message: str) -> bool:
    normalized = re.sub(r"[\s_-]+", " ", message.casefold())
    compact = normalized.replace(" ", "")
    daily_signals = (
        "daily quota",
        "per day",
        "requests per day",
        "request per day",
        "insufficient quota",
        "credit balance",
        "每天",
        "当日",
        "日额度",
        "日限额",
        "余额不足",
    )
    compact_signals = ("requestsperday", "requestperday", "perday")
    return any(signal in normalized for signal in daily_signals) or any(
        signal in compact for signal in compact_signals
    )


def _retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after", "").strip()
    if not value:
        return None
    try:
        return max(0.0, min(float(value), 120.0))
    except ValueError:
        return None


def parse_structured_http_response(response: httpx.Response, *, streaming: bool) -> dict[str, Any]:
    try:
        return _parse_structured_http_response(response, streaming=streaming)
    except ContentFilteredError as error:
        _attach_response_diagnostics(error, response)
        raise


def _sse_payloads(text: str):
    """Accept comments/keepalives and multi-line data without rewriting JSON."""
    pending: list[str] = []
    for line in text.lstrip('\ufeff').splitlines():
        line = line.lstrip()
        if not line.strip():
            if pending:
                yield json.loads('\n'.join(pending))
                pending.clear()
            continue
        if not line.startswith('data:'):
            continue
        data = line[5:].lstrip(' ')
        if not data.strip():
            continue
        if data.strip() == '[DONE]':
            if pending:
                yield json.loads('\n'.join(pending))
                pending.clear()
            break
        pending.append(data)
        try:
            event = json.loads('\n'.join(pending))
        except json.JSONDecodeError:
            continue
        yield event
        pending.clear()
    if pending:
        yield json.loads('\n'.join(pending))


def _parse_structured_http_response(response: httpx.Response, *, streaming: bool) -> dict[str, Any]:
    is_sse = "text/event-stream" in response.headers.get("content-type", "") or response.text.lstrip('\ufeff \r\n\t').startswith("data:")
    if not streaming and not is_sse:
        payload = response.json()
        return parse_structured_response(payload, finish_reason=_finish_reason_of(payload))

    content_parts: list[str] = []
    finish_reason: str | None = None
    usage_total: int | None = None
    saw_event = False
    for event in _sse_payloads(response.text):
        if not isinstance(event, dict):
            continue
        _check_provider_refusal(event)
        saw_event = True
        usage = event.get("usage")
        if isinstance(usage, dict) and isinstance(usage.get("total_tokens"), int):
            usage_total = usage["total_tokens"]
        choices = event.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        first = choices[0]
        if not isinstance(first, dict):
            continue
        event_reason = _finish_reason_of({"choices": [first]})
        if event_reason:
            finish_reason = event_reason
        delta = first.get("delta")
        message = first.get("message")
        if any(isinstance(part, dict) and part.get("refusal") for part in (delta, message)):
            raise _provider_filter_error(event, signal='message.refusal', reason='explicit_refusal')
        if finish_reason in FILTER_REASONS:
            raise _provider_filter_error(event, signal='finish_reason', reason=finish_reason)
        part = delta.get("content") if isinstance(delta, dict) else None
        if part is None and isinstance(message, dict):
            part = message.get("content")
        if isinstance(part, str):
            content_parts.append(part)

    if not content_parts:
        if saw_event:
            # A well-formed stream that carried no text at all. The old code fell
            # through to response.json() here, which tried to parse the SSE body
            # as JSON and reported a bogus JSONDecodeError -- so a refusal, an
            # instant output-budget burn and a silently dropped request were all
            # indistinguishable from a flaky gateway, and each got retried four
            # more times as if it were one.
            if finish_reason == "length":
                raise ResponseTruncatedError("AI 渠道在产出任何正文前就用尽了输出预算")
            raise EmptyGenerationError(
                "AI 渠道返回了空响应（finish_reason="
                f"{finish_reason or '无'}，total_tokens="
                f"{usage_total if usage_total is not None else '未报告'}）"
            )
        # Some compatibility layers ignore stream=true and return ordinary JSON.
        payload = response.json()
        return parse_structured_response(payload, finish_reason=_finish_reason_of(payload))
    return parse_structured_response(
        {"choices": [{"message": {"content": "".join(content_parts)}}]}, finish_reason=finish_reason
    )


def _finish_reason_of(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    first = choices[0]
    # CPA preserves the Gemini reason here even when its compatibility field
    # says "stop". Ignoring this turned explicit upstream refusals into partial
    # JSON errors, triggering repair/split loops against rejected requests.
    reasons = [first.get("native_finish_reason"), first.get("finish_reason")]
    normalized = [reason.lower() for reason in reasons if isinstance(reason, str) and reason]
    for reason in normalized:
        if reason in FILTER_REASONS:
            return reason
    if any(reason in {"max_tokens", "length"} for reason in normalized):
        return "length"
    return normalized[0] if normalized else None


def parse_structured_response(payload: object, *, finish_reason: str | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("AI 返回格式无效")
    _check_provider_refusal(payload)
    finish_reason = finish_reason or _finish_reason_of(payload)
    if finish_reason and finish_reason.lower() in FILTER_REASONS:
        raise _provider_filter_error(payload, signal='finish_reason', reason=finish_reason)
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        # Log shape, not upstream text, prompts or credentials.
        usage = payload.get("usage")
        total_tokens = usage.get("total_tokens") if isinstance(usage, dict) else None
        raise ValueError(f"AI 没有返回翻译内容（choices 缺失或为空，error={bool(payload.get('error'))}，total_tokens={total_tokens if isinstance(total_tokens, int) else '无'}）")
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(message, dict) and message.get("refusal"):
        raise _provider_filter_error(payload, signal='message.refusal', reason='explicit_refusal')
    if isinstance(content, list):
        content = "".join(
            item.get("text", "") for item in content if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
    if not isinstance(content, str) or not content.strip():
        if finish_reason == "length":
            raise ResponseTruncatedError("AI 渠道在产出正文前用尽输出预算")
        raise EmptyGenerationError(f"AI 渠道返回空正文（finish_reason={finish_reason or '无'}）")
    normalized = content.strip()
    # Some CPA upstreams encode a policy rejection as ordinary assistant text,
    # with both finish reasons null. Match the provider's explicit diagnostic,
    # not generic words that could occur inside a legitimate JSON translation.
    diagnostic = " ".join(normalized.casefold().split())
    if diagnostic.startswith(
        "the prompt could not be submitted. the prompt contains sensitive words "
        "that violate google's"
    ) and "generative ai prohibited use policy" in diagnostic:
        raise _provider_filter_error(payload, signal='provider_policy_text', reason='content_policy_violation')
    if normalized.startswith("```"):
        normalized = normalized[normalized.find("\n") + 1 :] if "\n" in normalized else normalized[3:]
        if normalized.endswith("```"):
            normalized = normalized[:-3].rstrip()
    try:
        decoded = json.loads(normalized)
    except json.JSONDecodeError as error:
        start, end = normalized.find("{"), normalized.rfind("}")
        if start < 0 or end <= start:
            # A cut-off answer is not malformed JSON from a confused model, it is
            # an answer that never got to finish. Say so, so the caller escalates
            # instead of re-asking for the same thing.
            if finish_reason == "length":
                raise ResponseTruncatedError("AI 渠道输出超长被截断，返回的 JSON 不完整") from error
            raise
        try:
            decoded = json.loads(normalized[start : end + 1])
        except json.JSONDecodeError:
            if finish_reason == "length":
                raise ResponseTruncatedError("AI 渠道输出超长被截断，返回的 JSON 不完整") from error
            raise
    if not isinstance(decoded, dict):
        raise ValueError("AI 返回的 JSON 不是对象")
    return decoded


def _check_provider_refusal(payload: dict) -> None:
    feedback = payload.get("promptFeedback")
    error = payload.get("error")
    codes = [str(error.get(key) or '') for key in ('code', 'type')] if isinstance(error, dict) else []
    block = feedback.get('blockReason') if isinstance(feedback, dict) else None
    # Some gateways include the default enum even for successful responses.
    if block and str(block).upper() not in {'0', 'BLOCK_REASON_UNSPECIFIED', 'UNSPECIFIED'}:
        raise _provider_filter_error(payload, signal='promptFeedback.blockReason', reason=str(block))
    for code in codes:
        if code.lower() in FILTER_REASONS:
            raise _provider_filter_error(payload, signal='error.code/type', reason=code)


def require_string_list(payload: dict[str, Any], key: str, expected_count: int) -> list[str]:
    values = payload.get(key)
    if not isinstance(values, list) or len(values) != expected_count:
        received = len(values) if isinstance(values, list) else 0
        raise StructuredListError(
            f"AI 返回的 {key} 数量不正确（需要 {expected_count} 项，实际 {received} 项）",
            reason="count",
            expected_count=expected_count,
            received_count=received,
        )
    normalized = [value.strip() if isinstance(value, str) else "" for value in values]
    if any(not value for value in normalized):
        blank_positions = [index for index, value in enumerate(normalized, start=1) if not value]
        raise StructuredListError(
            f"AI 返回的 {key} 第 {'、'.join(str(position) for position in blank_positions[:8])} 项为空",
            reason="empty",
            expected_count=expected_count,
            received_count=expected_count,
        )
    return normalized
