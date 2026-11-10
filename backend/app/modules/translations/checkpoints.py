"""Translation paths and durable checkpoints shared by orchestration and maintenance.

This module preserves existing filenames, JSON fields and request fingerprints.
Database leases and publication/archival decisions remain in the service.
"""
from __future__ import annotations

from contextlib import suppress
from hashlib import sha256
import json
import logging
from pathlib import Path
import re
import shutil
from typing import Any
from uuid import uuid4

from app.core.config import Settings
from app.modules.translations.source_text import SourceChapter

logger = logging.getLogger(__name__)


def _translation_jobs_root(settings: Settings) -> Path:
    return Path(settings.storage_root).expanduser().resolve() / "translation-jobs"


def _translation_projects_root(settings: Settings) -> Path:
    return Path(settings.storage_root).expanduser().resolve() / "translation-projects"


def _job_root_path(settings: Settings, user_id: str, job_id: str) -> Path:
    if not re.fullmatch(r"[0-9A-Za-z-]+", user_id) or not re.fullmatch(r"[0-9A-Za-z-]+", job_id):
        raise ValueError("翻译任务存储路径无效")
    root = _translation_jobs_root(settings)
    path = (root / user_id / job_id).resolve()
    if path.parent.parent != root:
        raise ValueError("翻译任务存储路径无效")
    return path


def _job_root(settings: Settings, user_id: str, job_id: str) -> Path:
    root = _job_root_path(settings, user_id, job_id)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _translation_project_path(settings: Settings, user_id: str, book_id: str) -> Path:
    if not re.fullmatch(r"[0-9A-Za-z-]+", user_id) or not re.fullmatch(r"[0-9A-Za-z-]+", book_id):
        raise ValueError("翻译项目存储路径无效")
    projects_root = _translation_projects_root(settings)
    path = (projects_root / user_id / book_id).resolve()
    if path.parent.parent != projects_root:
        raise ValueError("翻译项目存储路径无效")
    return path


def _remove_translation_job_storage(settings: Settings, user_id: str, job_id: str) -> None:
    root = _job_root_path(settings, user_id, job_id)
    if root.is_symlink():
        root.unlink(missing_ok=True)
    elif root.exists():
        shutil.rmtree(root)
    with suppress(OSError):
        root.parent.rmdir()


def _source_chapter_path(settings: Settings, user_id: str, job_id: str, index: int) -> Path:
    return _job_root(settings, user_id, job_id) / "source" / f"{index:05d}.json"


def _translated_chapter_path(settings: Settings, user_id: str, job_id: str, index: int) -> Path:
    return _job_root(settings, user_id, job_id) / "translated" / f"{index:05d}.json"


def _write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    decoded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError(f"任务检查点格式无效：{path.name}")
    return decoded


def _source_chapter_to_json(chapter: SourceChapter) -> dict[str, object]:
    return {
        "index": chapter.index,
        "title": chapter.title,
        "paragraphs": chapter.paragraphs,
        "url": chapter.url,
        "section_title": chapter.section_title,
        "section_level": chapter.section_level,
    }


def _source_chapter_from_json(value: dict[str, Any]) -> SourceChapter:
    paragraphs = value.get("paragraphs")
    if not isinstance(paragraphs, list) or not all(isinstance(item, str) for item in paragraphs):
        raise ValueError("原文章节检查点格式无效")
    return SourceChapter(
        index=int(value["index"]),
        title=str(value["title"]),
        paragraphs=paragraphs,
        url=str(value["url"]),
        section_title=str(value["section_title"]) if value.get("section_title") else None,
        section_level=int(value.get("section_level") or 1),
    )


def _translation_draft_fingerprint(chapter: SourceChapter) -> str:
    return sha256(json.dumps([chapter.url, chapter.paragraphs], ensure_ascii=False).encode()).hexdigest()


def _load_completed_translation_checkpoint(path: Path, chapter: SourceChapter) -> dict | None:
    if not path.is_file():
        return None
    try:
        value = _read_json(path)
        paragraphs = value.get("paragraphs")
        if (value.get("index") == chapter.index
            and isinstance(paragraphs, list) and len(paragraphs) == len(chapter.paragraphs)
            and all(isinstance(item, str) and item.strip() for item in paragraphs)
            and value.get("source_url", chapter.url) == chapter.url
            and value.get("source_hash", _translation_draft_fingerprint(chapter)) == _translation_draft_fingerprint(chapter)):
            return value
    except (ValueError, UnicodeError):
        pass
    quarantine = path.parent.parent / "invalid-checkpoints"
    quarantine.mkdir(parents=True, exist_ok=True)
    path.replace(quarantine / f"{path.stem}-{uuid4().hex}.json")
    logger.warning("Invalid completed checkpoint for chapter %s preserved in quarantine; recovering from source/draft", chapter.index)
    return None


def _translation_draft_request_fingerprint(settings: Settings, translation_preferences: str) -> str:
    return sha256(json.dumps([2, settings.ai_translation_base_url, settings.ai_translation_model, translation_preferences],ensure_ascii=False).encode()).hexdigest()


def _save_translation_draft(settings: Settings, user_id: str, job_id: str, chapter: SourceChapter, result: tuple, translation_preferences: str = "") -> None:
    paragraphs, report = result
    output = _translated_chapter_path(settings, user_id, job_id, chapter.index)
    path = output.parent.parent / "drafts" / output.name
    _write_json_atomic(path, {"source_hash": _translation_draft_fingerprint(chapter), "request_hash":_translation_draft_request_fingerprint(settings, translation_preferences), "paragraphs": paragraphs, "report": report})


def _load_translation_draft(settings: Settings, user_id: str, job_id: str, chapter: SourceChapter, translation_preferences: str = "") -> tuple | None:
    output = _translated_chapter_path(settings, user_id, job_id, chapter.index)
    path = output.parent.parent / "drafts" / output.name
    if not path.is_file():
        return None
    try:
        value = _read_json(path)
    except (ValueError, OSError):
        return None
    paragraphs = value.get("paragraphs")
    if (value.get("source_hash") == _translation_draft_fingerprint(chapter)
        and value.get("request_hash") == _translation_draft_request_fingerprint(settings, translation_preferences)
        and isinstance(paragraphs, list) and len(paragraphs) == len(chapter.paragraphs)
        and all(isinstance(item, str) and item.strip() for item in paragraphs)
        and isinstance(value.get("report"), dict)):
        return paragraphs, value["report"]
    return None
