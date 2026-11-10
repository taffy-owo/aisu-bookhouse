from __future__ import annotations

import asyncio

import pytest

from app.core.config import Settings
from app.modules.translations import service as translation_service
from app.modules.translations.ai import ResponseTruncatedError, StructuredListError
from app.modules.translations.source_text import SourceChapter


def chapter_of(paragraph_count: int) -> SourceChapter:
    return SourceChapter(
        index=76,
        title="春を想う 8",
        paragraphs=[f"第{n}段落の本文。" for n in range(paragraph_count)],
        url="https://example.com/76",
    )


def draft(source: list[str], degraded: list[str] | None = None) -> list[str]:
    return asyncio.run(
        translation_service._translate_chunk_draft(
            chapter=chapter_of(len(source)),
            chunk_index=1,
            chunk_count=1,
            source_chunk=source,
            memory={},
            interpretation={},
            context_tail=[],
            previous_source_tail=[],
            next_source_head=[],
            next_preview="",
            settings=Settings(),
            translation_preferences="",
            degraded=degraded,
        )
    )


def test_truncation_splits_far_enough_to_converge(monkeypatch: pytest.MonkeyPatch) -> None:
    """A block that only succeeds once it is small must be reachable by halving.

    Chapter 76 of one book had 106 paragraphs and needed to get below ~30 before
    the model stopped blowing its output budget. The old provider split depth of
    2 stopped at 26/27 and then re-raised, so the chapter restarted from the top
    and oscillated 53+53 -> 26+27 for four hours.
    """
    sizes_seen: list[int] = []

    async def fake_request(*, expected_count: int, **_kwargs: object):
        sizes_seen.append(expected_count)
        if expected_count > 20:
            raise ResponseTruncatedError("AI 渠道输出超长被截断，返回的 JSON 不完整")
        return {}, [f"译文{n}" for n in range(expected_count)]

    monkeypatch.setattr(translation_service, "_request_translation_list", fake_request)
    source = [f"第{n}段落の本文。" for n in range(106)]

    translated = draft(source)

    assert len(translated) == 106
    assert min(sizes_seen) <= 20, f"never split small enough; tried {sorted(set(sizes_seen))}"


def test_a_single_paragraph_that_keeps_failing_is_kept_as_source(monkeypatch: pytest.MonkeyPatch) -> None:
    """Termination matters more than translating every last line.

    Raising here aborted the chapter, which aborted the whole parallel window,
    which discarded every sibling chapter translated next to it -- so one bad
    paragraph could stall a book indefinitely.
    """

    async def always_truncates(*, expected_count: int, **_kwargs: object):
        raise ResponseTruncatedError("AI 渠道输出超长被截断，返回的 JSON 不完整")

    monkeypatch.setattr(translation_service, "_request_translation_list", always_truncates)
    source = ["第0段落の本文。", "第1段落の本文。"]
    degraded: list[str] = []

    translated = draft(source, degraded)

    assert translated == source, "the source line should survive so the chapter stays complete"
    assert len(degraded) == 2
    assert all("保留原文" in note for note in degraded)


def test_a_channel_that_is_simply_down_still_stops_early(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deeper budget is for truncation only; a dead channel must not fan out."""
    attempts = 0

    async def channel_down(*, expected_count: int, **_kwargs: object):
        nonlocal attempts
        attempts += 1
        raise translation_service.ProviderUnavailableError("AI 渠道连接失败")

    monkeypatch.setattr(translation_service, "_request_translation_list", channel_down)
    source = [f"第{n}段落の本文。" for n in range(64)]

    with pytest.raises(translation_service.ProviderUnavailableError):
        draft(source)

    # depth 2 => at most 1 + 2 + 4 requests before giving up.
    assert attempts <= 7, f"a down channel fanned out into {attempts} requests"


def test_shape_errors_keep_their_own_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    sizes_seen: list[int] = []

    async def merges_short_paragraphs(*, expected_count: int, **_kwargs: object):
        sizes_seen.append(expected_count)
        if expected_count > 8:
            raise StructuredListError(
                f"AI 返回的 translations 数量不正确（需要 {expected_count} 项，实际 {expected_count - 1} 项）",
                reason="count",
                expected_count=expected_count,
                received_count=expected_count - 1,
            )
        return {}, [f"译文{n}" for n in range(expected_count)]

    monkeypatch.setattr(translation_service, "_request_translation_list", merges_short_paragraphs)
    source = [f"第{n}段落の本文。" for n in range(106)]

    translated = draft(source)

    assert len(translated) == 106
    assert min(sizes_seen) <= 8
