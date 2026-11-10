"""Prepare bounded context and paragraph plans independently of job execution."""
from __future__ import annotations

import re

from app.core.config import Settings
from app.modules.translations.source_text import SourceChapter
from app.modules.translations.memory import (
    _bounded_json_value, _bounded_memory_value, _head_tail_excerpt, _merge_locked_glossary,
)


# Chunk size is bound by what the provider finishes inside its 125s upstream
# timeout -- not by the context window, and not by a parallelism target.
# Measured against the live channel with real chapter text, median of 3 runs:
#   4000 chars / 158 paras ->  65s, 0x524
#   5500 chars / 225 paras ->  75s, 0x524
#   7000 chars / 311 paras -> 103s, 0x524 but the array came back short once
#   9000 chars / 391 paras -> 125s, 3/3 x 524   <- the old MAX_CHUNK_CHARACTERS
# The proofread pass regenerates the same output from a doubled prompt, so it
# costs ~1.3x the draft; 4500 keeps that worst case near 85s with headroom.
# Splitting finer only multiplies the ~11s fixed per-call floor and forces the
# serial stitch pass, so a typical chapter is deliberately a single chunk.
MAX_CHUNK_CHARACTERS = 4500
MAX_CHUNK_PARAGRAPHS = 220
# A channel whose upstream cuts generation short needs smaller chunks. That used
# to be detected by matching one hardcoded model name; it is now per-model
# configuration, and these values are only the fallback for an unconfigured lane.
COMPACT_CHUNK_CHARACTERS = 1800
COMPACT_MEMORY_THRESHOLD_CHARACTERS = 2500
COMPACT_REQUEST_MEMORY_LIMITS = {
    "characters": 3500,
    "relationships": 2500,
    "addressing": 2500,
    "glossary": 4000,
    "voices": 2500,
    "timeline": 1500,
    "motifs": 1000,
    "open_questions": 1500,
    "previous_summary": 5000,
}
CATALOG_TITLE_EXCERPT_CHARACTERS = 900
SERIES_MEMORY_SAMPLE_BUDGET = 28000
SERIES_MEMORY_MAX_SAMPLES = 24
KATAKANA_TERM_RE = re.compile(r"[ァ-ヴー][ァ-ヴー・]{1,23}")


def _catalog_title_contexts(chapters: list[SourceChapter]) -> list[dict[str, object]]:
    contexts: list[dict[str, object]] = []
    for position, chapter in enumerate(chapters):
        contexts.append(
            {
                "index": chapter.index,
                "section_title": chapter.section_title,
                "previous_title": chapters[position - 1].title if position > 0 else None,
                "next_title": chapters[position + 1].title if position + 1 < len(chapters) else None,
                "opening_excerpt": "\n".join(chapter.paragraphs[:8])[:CATALOG_TITLE_EXCERPT_CHARACTERS],
            }
        )
    return contexts



def _normalize_catalog_title(source_title: str, translated_title: str) -> str:
    normalized = translated_title.strip()
    normalized = re.sub(r"^if\s*[:：]\s*", "if：", normalized, flags=re.IGNORECASE)

    def normalize_ex_prefix(match: re.Match[str]) -> str:
        prefix = match.group(1).translate(str.maketrans("０１２３４５６７８９", "0123456789"))
        return f"{prefix}："

    normalized = re.sub(r"^(EX[0-9０-９×xX-]+)\s*[:：]\s*", normalize_ex_prefix, normalized, flags=re.IGNORECASE)

    def normalize_parenthesized_number(match: re.Match[str]) -> str:
        number = match.group(1).translate(str.maketrans("０１２３４５６７８９", "0123456789"))
        return f"（{number}）"

    normalized = re.sub(r"[（(]([0-9０-９]+)[）)]", normalize_parenthesized_number, normalized)
    normalized = normalized.replace("＿＿", "——")
    if source_title.rstrip().endswith("、") and normalized.endswith("、"):
        normalized = f"{normalized[:-1]}……"
    return normalized



def _catalog_title_memory(memory: dict[str, object]) -> dict[str, object]:
    compact: dict[str, object] = {}
    limits = {
        "characters": 1200,
        "relationships": 800,
        "addressing": 800,
        "glossary": 1200,
        "voices": 600,
    }
    for key, limit in limits.items():
        value = memory.get(key)
        if isinstance(value, list):
            compact[key] = _bounded_json_value(value[:20], limit)
    summary = memory.get("previous_summary")
    if isinstance(summary, str) and summary.strip():
        compact["previous_summary"] = summary[:500]
    return compact



def _terminology_candidates(chapters: list[SourceChapter]) -> list[dict[str, object]]:
    """Collect proper-name candidates from every chapter, not only samples.

    The model still decides which Katakana strings are actual names, but this
    deterministic scan guarantees that a character introduced between sampled
    chapters is visible during preflight. Only short contexts are retained, so a
    long work cannot inflate the terminology request without bound.
    """
    occurrences: dict[str, dict[str, object]] = {}
    for chapter in chapters:
        for paragraph in chapter.paragraphs:
            for match in KATAKANA_TERM_RE.finditer(paragraph):
                term = match.group(0).strip("・")
                if len(term) < 2:
                    continue
                record = occurrences.setdefault(term, {"source": term, "count": 0, "contexts": []})
                record["count"] = int(record["count"]) + 1
                contexts = record["contexts"]
                if isinstance(contexts, list) and len(contexts) < 3:
                    start = max(0, match.start() - 36)
                    end = min(len(paragraph), match.end() + 36)
                    context = paragraph[start:end].strip()
                    if context and context not in contexts:
                        contexts.append(context)
    ranked = sorted(
        occurrences.values(),
        key=lambda item: (-int(item["count"]), str(item["source"])),
    )
    return ranked



def _series_memory_excerpts(
    chapters: list[SourceChapter],
    *,
    budget: int = SERIES_MEMORY_SAMPLE_BUDGET,
    max_samples: int = SERIES_MEMORY_MAX_SAMPLES,
) -> list[dict[str, object]]:
    """Sample the entire work instead of exhausting the budget at the opening."""
    if not chapters or budget <= 0 or max_samples <= 0:
        return []
    sample_count = min(len(chapters), max_samples)
    if sample_count == 1:
        positions = [0]
    else:
        positions = sorted(
            {
                round(slot * (len(chapters) - 1) / (sample_count - 1))
                for slot in range(sample_count)
            }
        )
    per_chapter_limit = max(400, budget // max(1, len(positions)))
    excerpts: list[dict[str, object]] = []
    remaining = budget
    for position in positions:
        chapter = chapters[position]
        excerpt = _head_tail_excerpt(chapter.paragraphs, min(per_chapter_limit, remaining)).strip()
        if not excerpt:
            continue
        excerpts.append(
            {
                "index": chapter.index,
                "title": chapter.title,
                "section_title": chapter.section_title,
                "excerpt": excerpt,
            }
        )
        remaining -= len(excerpt)
        if remaining <= 0:
            break
    return excerpts



def _slice_interpretation(interpretation: dict[str, object], start: int, end: int) -> dict[str, object]:
    """Re-index the per-paragraph notes onto a sub-range so a split half stays aligned."""
    return _select_interpretation(interpretation, list(range(start, end)))



def _select_interpretation(interpretation: dict[str, object], indexes: list[int]) -> dict[str, object]:
    entries = interpretation.get("interpretations")
    positions = {index + 1: position + 1 for position, index in enumerate(indexes)}
    sliced: list[object] = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            position = entry.get("paragraph")
            if isinstance(position, int) and position in positions:
                sliced.append({**entry, "paragraph": positions[position]})
    return {"interpretations": sliced, "open_questions": interpretation.get("open_questions", [])}



def _chunk_paragraphs(
    paragraphs: list[str],
    *,
    max_characters: int = MAX_CHUNK_CHARACTERS,
    max_paragraphs: int = MAX_CHUNK_PARAGRAPHS,
) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    characters = 0
    for paragraph in paragraphs:
        if current and (len(current) >= max_paragraphs or characters + len(paragraph) > max_characters):
            chunks.append(current)
            current, characters = [], 0
        current.append(paragraph)
        characters += len(paragraph)
    if current:
        chunks.append(current)
    return chunks



def translation_chunk_limits(model: str, settings: Settings | None = None) -> tuple[int, int]:
    """Per-model chunk ceiling, resolved from the channel config for this job.

    A channel that terminates long generations needs smaller chunks; the values
    ride on the per-job settings so the pipeline never has to know model names.
    """
    if settings is None:
        return MAX_CHUNK_CHARACTERS, MAX_CHUNK_PARAGRAPHS
    return (
        getattr(settings, "ai_translation_chunk_characters", MAX_CHUNK_CHARACTERS),
        getattr(settings, "ai_translation_chunk_paragraphs", MAX_CHUNK_PARAGRAPHS),
    )



def translation_request_memory(memory: dict[str, object], settings: Settings) -> dict[str, object]:
    """Keep the durable series bible rich while bounding each request.

    Context capacity is not the constraint here: a compatibility upstream may
    terminate generation on a deadline. A compact, balanced view of every memory
    field reduces prompt-prefill latency without discarding the full memory used
    for continuity updates and deterministic terminology checks. Only lanes
    configured with small chunks get the compact view.
    """

    chunk_characters = getattr(settings, "ai_translation_chunk_characters", MAX_CHUNK_CHARACTERS)
    if chunk_characters > COMPACT_MEMORY_THRESHOLD_CHARACTERS:
        return memory
    compact = {
        key: _bounded_memory_value(memory.get(key, [] if key != "previous_summary" else ""), limit)
        for key, limit in COMPACT_REQUEST_MEMORY_LIMITS.items()
    }
    # Never demand terms in QA that were silently removed from the prompt.
    compact['glossary'] = _merge_locked_glossary(compact.get('glossary'), memory.get('glossary'))
    return compact
