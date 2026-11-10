"""Fixed-length translation requests and bounded recovery, independent of job/storage state."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import re
from typing import Any, Awaitable, Callable

from app.core.config import Settings
from app.modules.translations.ai import StructuredListError


@dataclass(frozen=True)
class TranslationListDependencies:
    request_ai: Callable[..., Awaitable[dict[str, Any]]]
    require_list: Callable[..., list[str]]
    select_interpretation: Callable[..., dict[str, object]]
    slice_interpretation: Callable[..., dict[str, object]]
    translatable_pattern: re.Pattern[str]
    attempts: int
    max_split_depth: int
    logger: logging.Logger


def create_translation_list_requester(dependencies: TranslationListDependencies):
    request_structured_ai = dependencies.request_ai
    require_string_list = dependencies.require_list
    _select_interpretation = dependencies.select_interpretation
    _slice_interpretation = dependencies.slice_interpretation
    TRANSLATABLE_RE = dependencies.translatable_pattern
    TRANSLATION_LIST_ATTEMPTS = dependencies.attempts
    MAX_SHAPE_SPLIT_DEPTH = dependencies.max_split_depth
    logger = dependencies.logger

    async def _request_translation_list(
        *,
        settings: Settings,
        system_prompt: str,
        user_payload: dict[str, object],
        expected_count: int,
        temperature: float,
        _allow_structural_mask: bool = True,
        _shape_split_depth: int = 0,
    ) -> tuple[dict[str, Any], list[str]]:
        """Ask for a fixed-length ``translations`` array, re-asking when the shape is wrong.

        Compatible providers routinely merge two paragraphs or drop the last one on
        long arrays. A single malformed generation used to fail the entire book, so
        every call now gets corrective attempts that quote the previous mistake back.
        """
        name_rule = "按完整专名匹配术语表。全名与昵称分别翻译；短名作为全名的一部分时，不算昵称单独出现。不得为满足术语检查添加原文没有的人名。source_context 仅供理解，只输出 source/paragraphs 对应的译文。"
        if name_rule not in system_prompt:
            system_prompt += name_rule
        # Models commonly omit scene breaks such as ``＊＊＊`` or ``──`` because
        # there is nothing to translate. Sending them anyway made a valid 26-item
        # answer fail a 30-item shape check, then waste three retries and split the
        # chapter. Mask immutable structural paragraphs for every pipeline stage and
        # reinsert them at their original indexes after the model call.
        source_key = "paragraphs" if isinstance(user_payload.get("paragraphs"), list) else "source"
        source_items = user_payload.get(source_key)
        if _allow_structural_mask and isinstance(source_items, list) and len(source_items) == expected_count:
            immutable_indexes = [
                index
                for index, item in enumerate(source_items)
                if isinstance(item, str) and not TRANSLATABLE_RE.search(item)
            ]
            if immutable_indexes:
                immutable_index_set = set(immutable_indexes)
                translatable_indexes = [index for index in range(expected_count) if index not in immutable_index_set]
                if not translatable_indexes:
                    restored = [str(item) for item in source_items]
                    return {"translations": restored}, restored
                reduced_payload = dict(user_payload)
                for key in ("paragraphs", "source", "translations", "draft", "paragraph_numbers"):
                    value = reduced_payload.get(key)
                    if isinstance(value, list) and len(value) == expected_count:
                        reduced_payload[key] = [value[index] for index in translatable_indexes]
                if isinstance(reduced_payload.get("interpretation"), dict):
                    reduced_payload["interpretation"] = _select_interpretation(reduced_payload["interpretation"], translatable_indexes)
                response, reduced = await _request_translation_list(
                    settings=settings,
                    system_prompt=system_prompt,
                    user_payload=reduced_payload,
                    expected_count=len(translatable_indexes),
                    temperature=temperature,
                    _allow_structural_mask=False,
                    _shape_split_depth=_shape_split_depth,
                )
                restored = [str(item) for item in source_items]
                for index, translated_item in zip(translatable_indexes, reduced, strict=True):
                    restored[index] = translated_item
                return {**response, "translations": restored}, restored

        last_error: StructuredListError | None = None
        for attempt in range(TRANSLATION_LIST_ATTEMPTS):
            prompt, payload = system_prompt, user_payload
            if last_error is not None:
                prompt = (
                    f"{system_prompt}上一次返回不合格：{last_error}。"
                    f"必须返回恰好 {expected_count} 个非空字符串，与输入段落逐一对应，不得合并、拆分或省略任何一段。"
                    "数组项中只能有正文，不得加入标题、说明、注释、分析、Markdown、JSON 或对话式前后语。"
                )
                payload = {**user_payload, "previous_attempt_error": str(last_error)}
            response = await request_structured_ai(
                settings,
                system_prompt=prompt,
                user_payload=payload,
                temperature=temperature if attempt == 0 else min(temperature, 0.05),
            )
            try:
                return response, require_string_list(response, "translations", expected_count)
            except StructuredListError as error:
                last_error = error
                logger.warning(
                    "AI returned an unusable translations array (%s); attempt %s/%s",
                    error,
                    attempt + 1,
                    TRANSLATION_LIST_ATTEMPTS,
                )
                # Repeating the same large request is ineffective when the model
                # merged or omitted an item.  Split on the first shape failure and
                # translate both halves independently; unlike trying to align a
                # short response, this preserves the exact paragraph mapping.  The
                # provider semaphore still enforces the configured concurrency.
                # For one-to-three items a single corrective retry is cheaper and
                # normally reliable.  The pathological production failures are the
                # larger 11-30 item arrays, which should be reduced immediately.
                if expected_count >= 4 and _shape_split_depth < MAX_SHAPE_SPLIT_DEPTH:
                    middle = expected_count // 2

                    def sliced_payload(start: int, end: int) -> dict[str, object]:
                        sliced = dict(user_payload)
                        for key in ("paragraphs", "source", "translations", "draft", "paragraph_numbers"):
                            value = sliced.get(key)
                            if isinstance(value, list) and len(value) == expected_count:
                                sliced[key] = value[start:end]
                        if isinstance(sliced.get("interpretation"), dict):
                            sliced["interpretation"] = _slice_interpretation(sliced["interpretation"], start, end)
                        sliced["shape_recovery"] = (
                            f"上一次 {expected_count} 项请求返回数量不完整；本次只处理原数组第 "
                            f"{start + 1}-{end} 项，并严格返回 {end - start} 项。"
                        )
                        return sliced

                    recovery_prompt = (
                        f"{system_prompt}这是一次数组形状恢复请求。只处理本次输入中的段落，"
                        "逐项返回，禁止合并、拆分、遗漏或补写其他段落。"
                    )
                    left_result, right_result = await asyncio.gather(
                        _request_translation_list(
                            settings=settings,
                            system_prompt=recovery_prompt,
                            user_payload=sliced_payload(0, middle),
                            expected_count=middle,
                            temperature=min(temperature, 0.05),
                            _allow_structural_mask=False,
                            _shape_split_depth=_shape_split_depth + 1,
                        ),
                        _request_translation_list(
                            settings=settings,
                            system_prompt=recovery_prompt,
                            user_payload=sliced_payload(middle, expected_count),
                            expected_count=expected_count - middle,
                            temperature=min(temperature, 0.05),
                            _allow_structural_mask=False,
                            _shape_split_depth=_shape_split_depth + 1,
                        ),
                    )
                    (left_response, left), (right_response, right) = left_result, right_result
                    combined = [*left, *right]
                    merged_response: dict[str, Any] = {**left_response, "translations": combined}
                    left_issues = left_response.get("issues")
                    right_issues = right_response.get("issues")
                    if isinstance(left_issues, list) or isinstance(right_issues, list):
                        merged_response["issues"] = [
                            *(left_issues if isinstance(left_issues, list) else []),
                            *(right_issues if isinstance(right_issues, list) else []),
                        ]
                    left_scores = left_response.get("scores")
                    right_scores = right_response.get("scores")
                    if isinstance(left_scores, dict) and isinstance(right_scores, dict):
                        score_keys = set(left_scores) & set(right_scores)
                        merged_response["scores"] = {
                            key: (float(left_scores[key]) + float(right_scores[key])) / 2
                            for key in score_keys
                            if isinstance(left_scores[key], (int, float))
                            and isinstance(right_scores[key], (int, float))
                        }
                    return merged_response, combined
        if last_error is None:
            raise RuntimeError("AI 结构化请求没有执行")
        raise last_error

    return _request_translation_list
