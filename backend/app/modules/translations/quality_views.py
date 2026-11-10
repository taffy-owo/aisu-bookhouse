"""Quality labels backed by complete reports, with readable unknown data."""

from collections.abc import Callable, Mapping
from typing import Any


def _list_size(value: object) -> int:
    return len(value) if isinstance(value, list) else 0


def _chapters(report: Mapping[str, Any]) -> list[object]:
    return [
        value
        for key, value in report.items()
        if isinstance(key, str) and key.isascii() and key.isdigit() and key.strip("0")
    ]


def _v2_summary(record: Any, report: Mapping[str, Any]) -> tuple[str, int]:
    failure = report.get("_v2_failure")
    if isinstance(failure, Mapping) and failure.get("code") in {"quality_blocked", "term_conflict"}:
        return "warning", 1

    if record.completed_chapters <= 0:
        return "pending", 0

    chapters = _chapters(report)
    unknown = len(chapters) < record.completed_chapters
    issues = 0
    for chapter in chapters:
        if not isinstance(chapter, Mapping) or chapter.get("status") != "completed":
            unknown = True
            continue
        units = chapter.get("units")
        if not isinstance(units, list) or not units:
            unknown = True
            continue
        for unit in units:
            if not isinstance(unit, Mapping):
                unknown = True
                continue
            remaining = unit.get("remaining")
            review = unit.get("review")
            findings = review.get("findings") if isinstance(review, Mapping) else None
            if not isinstance(remaining, list) or not isinstance(findings, list):
                unknown = True
            issues += _list_size(remaining) + _list_size(findings)

    if issues:
        return "warning", issues
    return ("pending", 0) if unknown else ("passed", 0)


def _legacy_evidence(chapter: object) -> bool:
    if not isinstance(chapter, Mapping):
        return False

    chunks = chapter.get("chunks")
    if isinstance(chunks, list) and chunks:
        for chunk in chunks:
            if not isinstance(chunk, Mapping):
                return False
            final = chunk.get("stitch") if isinstance(chunk.get("stitch"), Mapping) else chunk
            if not isinstance(final.get("remaining"), list):
                return False
        return True

    # Older whole-chapter receipts store their final checks directly.
    return isinstance(chapter.get("remaining"), list)


def summary(record: Any, validate_glossary_entry: Callable[[Mapping[str, Any]], Mapping[str, Any]]) -> tuple[str, int]:
    report = record.quality_report_json if isinstance(record.quality_report_json, Mapping) else {}
    if report.get("_workflow_version") == 2:
        return _v2_summary(record, report)

    error = record.error_message or ""
    if record.status == "failed" and any(
        marker in error for marker in ("质检不通过", "一致性修复失败", "一致性检查不通过")
    ):
        failure = report.get("_failure")
        remaining = failure.get("remaining") if isinstance(failure, Mapping) else None
        return "warning", max(1, _list_size(remaining), min(30, error.count("；") + 1))

    if record.completed_chapters <= 0:
        return "pending", 0

    issues = 0
    for chapter in report.values():
        if not isinstance(chapter, Mapping):
            continue
        issues += _list_size(chapter.get("remaining"))
        consistency = chapter.get("post_window_consistency")
        if isinstance(consistency, Mapping):
            issues += _list_size(consistency.get("remaining")) + _list_size(consistency.get("degraded"))
        chunks = chapter.get("chunks")
        if not isinstance(chunks, list):
            continue
        for chunk in chunks:
            if not isinstance(chunk, Mapping):
                continue
            final = chunk.get("stitch") if isinstance(chunk.get("stitch"), Mapping) else chunk
            issues += _list_size(final.get("remaining")) + _list_size(chunk.get("degraded"))
            if final is not chunk:
                issues += _list_size(final.get("degraded"))

    memory = record.memory_json if isinstance(record.memory_json, Mapping) else {}
    glossary = memory.get("glossary")
    unknown = False
    if isinstance(glossary, list):
        for entry in glossary:
            if not isinstance(entry, Mapping):
                continue
            try:
                issues += bool(validate_glossary_entry(entry).get("needs_resolution"))
            except (TypeError, ValueError, AttributeError):
                unknown = True

    if issues:
        return "warning", issues
    chapters = _chapters(report)
    if unknown or len(chapters) < record.completed_chapters or not all(_legacy_evidence(chapter) for chapter in chapters):
        return "pending", 0
    return "passed", 0
