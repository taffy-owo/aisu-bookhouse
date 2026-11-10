from __future__ import annotations

import re

from app.modules.processing.processors.txt_processor import CHAPTER_PATTERN


def build_translation_txt(*, chapters: list[dict[str, object]]) -> bytes:
    serialized: list[str] = []
    for position, chapter in enumerate(chapters, start=1):
        title = _single_line(str(chapter.get("title") or f"第{position}话"))
        if not CHAPTER_PATTERN.fullmatch(title):
            title = f"第{position}话 {title}"
        paragraphs = chapter.get("paragraphs")
        body = "\n\n".join(
            str(paragraph).strip()
            for paragraph in (paragraphs if isinstance(paragraphs, list) else [])
            if str(paragraph).strip()
        )
        serialized.append(f"{title}\n\n{body}".rstrip())
    return ("\n\n".join(serialized).rstrip() + "\n").encode("utf-8")


def _single_line(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()
