"""Bounded series context and immutable terminology, independent of job execution."""
from __future__ import annotations

import json
import re
from typing import Any

MEMORY_FIELD_LIMITS = {
    "characters": 10000,
    "relationships": 7000,
    "addressing": 7000,
    "glossary": 10000,
    "voices": 7000,
    "timeline": 4000,
    "motifs": 2500,
    "open_questions": 2500,
    "previous_summary": 8000,
}


def _coerce_memory(payload: dict[str, Any], fallback: dict[str, object] | None = None) -> dict[str, object]:
    memory: dict[str, object] = {}
    for key, limit in MEMORY_FIELD_LIMITS.items():
        value = payload.get(key, (fallback or {}).get(key, [] if key != "previous_summary" else ""))
        memory[key] = _bounded_memory_value(value, limit)
    # Model-authored memory updates may omit private metadata or rewrite a
    # glossary entry. Preserve the highest completed preflight version and merge
    # immutable mappings from the previously committed memory deterministically.
    versions: list[int] = []
    for candidate in (payload.get("_terminology_version"), (fallback or {}).get("_terminology_version")):
        try:
            versions.append(int(candidate or 0))
        except (TypeError, ValueError):
            continue
    if versions and max(versions) > 0:
        memory["_terminology_version"] = max(versions)
    memory["glossary"] = _merge_locked_glossary(
        _merge_locked_glossary(memory.get('glossary'), payload.get('glossary')),
        (fallback or {}).get("glossary"),
    )
    return memory


def _merge_locked_glossary(current: object, committed: object) -> list[object]:
    """Merge glossary lists while making an established locked mapping immutable."""
    current_items = [_validate_glossary_entry(item) for item in current] if isinstance(current, list) else []
    committed_items = [_validate_glossary_entry(item) for item in committed] if isinstance(committed, list) else []
    locked: dict[str, dict[str, object]] = {}
    for item in [*committed_items, *current_items]:
        if not isinstance(item, dict) or item.get("locked") is not True:
            continue
        source_term = str(item.get("source") or "").strip()
        target_term = str(item.get("target") or "").strip()
        if source_term and target_term and source_term not in locked:
            locked[source_term] = {**item, "source": source_term, "target": target_term, "locked": True}

    merged: list[object] = list(locked.values())
    seen_sources = set(locked)
    for item in current_items:
        if isinstance(item, dict):
            source_term = str(item.get("source") or "").strip()
            if source_term and source_term in seen_sources:
                continue
            if source_term:
                seen_sources.add(source_term)
        if item not in merged:
            merged.append(item)
    return merged


def _glossary_target_candidates(target: str) -> list[str]:
    # Restrict this migration to explicit CJK alternatives, never split lexical
    # names such as AC/DC or dates. Do not invent a canonical spelling.
    if re.search(r"[\u3400-\u9fff]", target) and re.search(r"\s[/／|｜]\s", target):
        return [part.strip() for part in re.split(r"\s+[/／|｜]\s+", target) if part.strip()]
    return [target]


def _validate_glossary_entry(item: object) -> object:
    if not isinstance(item, dict):
        return item
    target = item.get("target")
    if not isinstance(target, str):
        return {**item, "locked": False}
    candidates = _glossary_target_candidates(target)
    if len(candidates) > 1:
        return {**item, "locked": False, "needs_resolution": True, "target_candidates": candidates}
    return item


def _bounded_memory_value(value: object, limit: int) -> object:
    if not isinstance(value, list) or len(json.dumps(value, ensure_ascii=False)) <= limit:
        return _bounded_json_value(value, limit)

    selected: set[int] = set()
    left, right = 0, len(value) - 1
    take_front = True
    while left <= right:
        index = left if take_front else right
        if take_front:
            left += 1
        else:
            right -= 1
        candidate_indexes = sorted({*selected, index})
        candidate = [value[item_index] for item_index in candidate_indexes]
        if len(json.dumps(candidate, ensure_ascii=False)) <= limit:
            selected.add(index)
        take_front = not take_front
    return [value[index] for index in sorted(selected)]


def _bounded_json_value(value: object, limit: int) -> object:
    encoded = json.dumps(value, ensure_ascii=False)
    if len(encoded) <= limit:
        return value
    if isinstance(value, list):
        bounded: list[object] = []
        for item in value:
            candidate = [*bounded, item]
            if len(json.dumps(candidate, ensure_ascii=False)) > limit:
                break
            bounded.append(item)
        return bounded
    if isinstance(value, dict):
        bounded_dict: dict[str, object] = {}
        for key, item in value.items():
            candidate = {**bounded_dict, str(key): item}
            if len(json.dumps(candidate, ensure_ascii=False)) > limit:
                break
            bounded_dict[str(key)] = item
        return bounded_dict
    return str(value)[: max(0, limit - 2)]


def _head_tail_excerpt(paragraphs: list[str], limit: int) -> str:
    if limit <= 0:
        return ""
    combined = "\n".join(paragraphs)
    if len(combined) <= limit:
        return combined
    separator = "\n……\n"
    if limit <= len(separator):
        return combined[:limit]
    available = limit - len(separator)
    head = (available + 1) // 2
    tail = available // 2
    return f"{combined[:head]}{separator}{combined[-tail:] if tail else ''}"
