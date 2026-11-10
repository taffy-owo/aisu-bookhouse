"""Provider failure classification and checkpoint-preserving retry decisions."""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

from fastapi import HTTPException
import httpx
from sqlalchemy.orm import Session

from app.modules.ai_channels.service import next_quota_reset
from app.modules.translations.ai import (CallBudgetExhaustedError, ContentFilteredError,
    ProviderUnavailableError, RateLimitedError, is_transient_status)

SessionFactory = Callable[[], Session]


def defer_provider_retry(
    job_id: str,
    error: Exception,
    session_factory: SessionFactory,
    *, read_job: Callable, update_job: Callable, check_pause: Callable,
    mark_unavailable: Callable, backoff: tuple[timedelta, ...],
    quota_failure: Callable[[Exception], bool], error_message: Callable[[Exception], str],
) -> None:
    """Keep a transient provider failure alive at its latest checkpoint.

    The delay escalates with the failure streak. A brief gateway blip resolves on
    the first 30-second retry, while an exhausted daily quota settles into the
    30-minute probe instead of re-failing every 30 seconds for the rest of the
    day. The job keeps its model either way: switching lanes mid-book would break
    the series-memory chain the translation quality depends on.
    """
    check_pause(job_id, session_factory)
    job = read_job(job_id, session_factory)
    if not job:
        return
    streak = (job.provider_failure_streak or 0) + 1
    delay = backoff[min(streak, len(backoff)) - 1]
    now = datetime.now(timezone.utc)
    retry_at = now + delay
    quota_exhausted = quota_failure(error)
    quota_resume_at = next_quota_reset(now) if quota_exhausted else None

    if quota_exhausted:
        # Park it: out of the worker rotation, but still claimable once the probe
        # window opens, so a channel that recovers early resumes on its own.
        wait_owner = f"quota-wait:{uuid4()}"
        changed = update_job(
            job_id,
            session_factory,
            status="waiting_quota",
            stage="waiting_quota",
            message=(
                f"AI 渠道额度可能已用尽，将每 {int(delay.total_seconds() // 60)} 分钟自动探测，"
                f"恢复后从第 {job.completed_chapters + 1} 话继续"
            ),
            error_message=error_message(error),
            acknowledged=False,
            lease_owner=wait_owner,
            lease_expires_at=retry_at,
            provider_failure_streak=streak,
            quota_resume_at=quota_resume_at,
            finished_at=None,
        )
        if not changed:
            check_pause(job_id, session_factory)
            return
        waiting = read_job(job_id, session_factory)
        if waiting and waiting.status == 'waiting_quota' and waiting.lease_owner == wait_owner:
            if hasattr(error, '_provider_availability_version'):
                version = error._provider_availability_version
                if version is not None:
                    mark_unavailable(waiting, quota_resume_at, session_factory, expected_version=version)
            else:
                mark_unavailable(waiting, quota_resume_at, session_factory)
        return

    delay_seconds = int(delay.total_seconds())
    changed = update_job(
        job_id,
        session_factory,
        status="queued",
        stage="queued",
        message=(
            f"{error_message(error)[:150]}；{delay_seconds} 秒后自动从第 {job.completed_chapters + 1} 话重试"
        ),
        error_message=error_message(error),
        acknowledged=False,
        lease_owner=f"retry-backoff:{uuid4()}",
        lease_expires_at=retry_at,
        provider_failure_streak=streak,
        quota_resume_at=None,
        finished_at=None,
    )
    if not changed:
        check_pause(job_id, session_factory)


def _is_transient_translation_error(error: Exception) -> bool:
    """Recognize provider JSON failures across compatible client libraries."""
    if isinstance(error, ContentFilteredError):
        return False
    if isinstance(error, (ProviderUnavailableError, json.JSONDecodeError)):
        return True
    # A gateway 5xx/429 that escaped a nested retry loop is still a transient
    # channel fault. Without this branch an ``httpx.HTTPStatusError`` raised by
    # the catalog/series-memory passes fell through to the permanent-failure
    # branch, so a few seconds of provider flapping killed a whole book and no
    # amount of manual retrying could get past it while the channel stayed down.
    if isinstance(error, httpx.HTTPStatusError) and is_transient_status(error.response.status_code):
        return True
    if isinstance(error, httpx.TimeoutException):
        return True
    if isinstance(error, HTTPException) and error.status_code in {408, 425, 429, 500, 502, 503, 504}:
        return True
    error_name = type(error).__name__.lower()
    message = str(error).strip().lower()
    return (
        "jsondecode" in error_name
        or message.startswith("expecting value:")
        or "invalid json" in message
        or "无效 json" in message
        or "空白或无效 json" in message
        # Compatibility gateways sometimes encode an upstream refusal/quota
        # miss as HTTP 200 with an empty OpenAI envelope.  It is no more
        # permanent than a blank body and must never strand an unattended book.
        or "response has no choices" in message
        or "response has no content" in message
        or "response count does not match" in message
        or "response contains an empty item" in message
        or "没有返回翻译内容" in message
        or "没有返回文本内容" in message
    )


def _is_quota_translation_error(error: Exception) -> bool:
    """Only classify an explicit 429/call budget as quota exhaustion.

    Blank JSON and gateway errors are transient provider faults, not evidence that
    the user's model has exhausted its quota. Conflating them used to park every
    job using the model and made a recoverable response-shape error look fatal.
    """
    if isinstance(error, CallBudgetExhaustedError):
        return True
    if isinstance(error, RateLimitedError):
        return error.quota_exhausted
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code == 429
    return isinstance(error, HTTPException) and error.status_code == 429


def _user_error_message(error: Exception) -> str:
    if isinstance(error, HTTPException):
        return str(error.detail)[:500]
    if isinstance(error, httpx.TimeoutException):
        return "AI 服务响应超时，已保留全部完成章节，请稍后重试"
    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code in {408, 504, 524}:
        return "AI 服务网关超时，已保留全部完成章节，请稍后重试"
    if isinstance(error, httpx.HTTPStatusError):
        return f"AI 服务返回 HTTP {error.response.status_code}，已保留完成章节"
    if _is_transient_translation_error(error) and not isinstance(error, ProviderUnavailableError):
        return "AI 或任务缓存暂时返回了不完整数据，系统将自动重试"
    message = str(error).strip()
    if not message:
        return "后台翻译发生未知错误，请稍后重试"
    return message[:500]

