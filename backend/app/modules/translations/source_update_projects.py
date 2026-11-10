"""Source-update project files, chapter mappings, draft views and archival."""
from __future__ import annotations

from contextlib import suppress
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
from typing import Any, Callable
from uuid import uuid4

from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
from app.modules.books.domain import Book
from app.modules.books.source_episode_matching import extract_episode_number, match_source_episode_assets
from app.modules.reader.service import get_asset_title, split_paragraphs, strip_leading_chapter_title
from app.modules.translations.checkpoints import (
    _translation_project_path, _job_root_path, _translated_chapter_path,
    _source_chapter_path, _read_json, _write_json_atomic,
)
from app.modules.translations.errors import SourceUpdateNotReady
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.translations.quality import align_translated_outer_brackets
from app.modules.translations.schemas import SourceUpdateTranslationDraftChapter
from app.modules.translations.worker_state import SessionFactory
from app.modules.uploads.schemas import WorkSourceMetadata


_PROJECT_INDEX_ERROR = "这本书的原作章节对应记录有误，暂时不能继续处理更新"


def _project_index_error() -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_PROJECT_INDEX_ERROR)


def _project_episode_index(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    if isinstance(value, str):
        numeric = value.strip()
        digits = numeric[1:] if numeric.startswith("+") else numeric
        if digits.isdecimal():
            try:
                index = int(numeric)
            except ValueError:
                raise _project_index_error() from None
            if index > 0:
                return index
    raise _project_index_error()


def _project_episode_indexes(value: object) -> set[int]:
    if value is None:
        return set()
    if not isinstance(value, list):
        raise _project_index_error()
    return {_project_episode_index(item) for item in value}


def _read_project_mapping(path: Path) -> dict[str, Any]:
    try:
        return _read_json(path)
    except (OSError, ValueError):
        raise _project_index_error() from None


def prepare_source_update_translation_project(
    *,
    book: Book,
    chapters: list[BookAsset],
    has_chapter_images: bool,
    handled_episode_indexes: set[int] | None = None,
    metadata: WorkSourceMetadata,
    settings: Settings,
) -> None:
    project_path = _translation_project_path(settings, book.owner_id, book.id)
    manifest_path = project_path / "project.json"
    if manifest_path.is_file():
        return
    original_suffix = Path(book.original_file_path or "").suffix.lower()
    rebuild_format = (
        "epub"
        if book.reader_type == "epub" and original_suffix == ".epub"
        else "txt"
        if book.reader_type == "text" and original_suffix == ".txt"
        else None
    )
    if not rebuild_format:
        raise SourceUpdateNotReady("这本书不是可安全重建的 EPUB 或 TXT，暂时不能翻译更新")
    matches = match_source_episode_assets(chapters, metadata.episodes)
    matched_indexes = [episode.index for _asset, episode in matches]
    expected_indexes = list(range(1, len(chapters) + 1))
    is_one_to_one = len(matches) == len(chapters) and matched_indexes == expected_indexes
    if not is_one_to_one and not handled_episode_indexes:
        raise SourceUpdateNotReady("现有中文目录无法判断已收录到原作哪一话，请先同步原作目录后再翻译更新")

    translated_path = project_path / "translated"
    translated_path.mkdir(parents=True, exist_ok=True)
    context_fragments: list[str] = []
    baseline: list[tuple[BookAsset, int, str, str, str]] = []
    if is_one_to_one:
        baseline = [
            (asset, episode.index, episode.title, episode.url, f"{episode.index:05d}.json")
            for asset, episode in matches
        ]
    else:
        baseline = [
            (
                asset,
                position,
                get_asset_title(asset, position),
                book.source_url or metadata.source_url,
                f"local-{position:05d}.json",
            )
            for position, asset in enumerate(chapters, start=1)
        ]

    for asset, checkpoint_index, source_title, source_url, checkpoint_name in baseline:
        path = resolve_storage_path(get_storage_root(settings), asset.path)
        if not path.is_file():
            raise SourceUpdateNotReady(f"本地章节“{source_title}”的正文不存在，不能建立翻译基线")
        title = get_asset_title(asset, checkpoint_index)
        content = strip_leading_chapter_title(path.read_text(encoding="utf-8"), title, content_is_body=asset.metadata.get("content_is_body") is True).strip()
        paragraphs = split_paragraphs(content)
        if not paragraphs:
            raise SourceUpdateNotReady(f"本地章节“{title}”没有可读取的正文，不能建立翻译基线")
        _write_json_atomic(
            translated_path / checkpoint_name,
            {
                "index": checkpoint_index,
                "title": title,
                "source_title": source_title,
                "source_url": source_url,
                "paragraphs": paragraphs,
            },
        )
        context_fragments.append(f"【{title}】\n" + "\n".join(paragraphs))

    context = ""
    for fragment in reversed(context_fragments):
        candidate = f"{fragment}\n\n{context}".strip()
        if len(candidate) > 7600:
            if not context:
                context = fragment[-7600:]
            break
        context = candidate
    _write_json_atomic(
        manifest_path,
        {
            "bootstrap_kind": (
                f"uploaded_{rebuild_format}" if is_one_to_one else f"compiled_uploaded_{rebuild_format}"
            ),
            "completed_chapters": len(baseline),
            "total_chapters": len(baseline),
            "handled_episode_indexes": sorted(handled_episode_indexes or set(matched_indexes)),
            "memory": {
                "characters": [],
                "relationships": [],
                "addressing": [],
                "glossary": [],
                "voices": [],
                "timeline": [],
                "motifs": [],
                "open_questions": [],
                "previous_summary": "以下是原书末尾已定稿中文译文，用于延续人物译名、称呼和文风：\n" + context,
            },
            "quality_report": {},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )



def _read_source_update_draft_chapters(
    record: WholeBookTranslationJobRecord,
    settings: Settings,
) -> list[SourceUpdateTranslationDraftChapter]:
    if (record.quality_report_json or {}).get('_workflow_version') == 2:
        from app.modules.translation_v2.runner import read_snapshot
        path = get_storage_root(settings) / 'translation-v2' / record.user_id / record.id / 'publication-candidate.json'
        if not path.is_file():
            return []
        value = read_snapshot(path)
        return [SourceUpdateTranslationDraftChapter(index=c['index'], title=c['title'],
            source_title=c['source_title'], source_url=c['source_url'], content='\n\n'.join(c['paragraphs']))
            for c in value['chapters']]
    chapters: list[SourceUpdateTranslationDraftChapter] = []
    for item in record.catalog_json or []:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item["index"])
        except (KeyError, TypeError, ValueError):
            continue
        path = _translated_chapter_path(settings, record.user_id, record.id, index)
        if not path.is_file():
            continue
        checkpoint = _read_json(path)
        source_path = _source_chapter_path(settings, record.user_id, record.id, index)
        if source_path.is_file():
            checkpoint = _normalize_translated_checkpoint(_read_json(source_path), checkpoint)
        paragraphs = checkpoint.get("paragraphs")
        if not isinstance(paragraphs, list) or not all(isinstance(paragraph, str) for paragraph in paragraphs):
            continue
        chapters.append(
            SourceUpdateTranslationDraftChapter(
                index=index,
                title=str(checkpoint.get("title") or item.get("title") or f"第 {index} 话"),
                source_title=str(checkpoint.get("source_title") or item.get("title") or ""),
                source_url=str(checkpoint.get("source_url") or item.get("url") or ""),
                content="\n\n".join(paragraphs),
            )
        )
    return chapters



def _normalize_translated_checkpoint(
    source_checkpoint: dict[str, Any],
    translated_checkpoint: dict[str, Any],
) -> dict[str, Any]:
    source_paragraphs = source_checkpoint.get("paragraphs")
    translated_paragraphs = translated_checkpoint.get("paragraphs")
    if (
        not isinstance(source_paragraphs, list)
        or not isinstance(translated_paragraphs, list)
        or len(source_paragraphs) != len(translated_paragraphs)
        or not all(isinstance(paragraph, str) for paragraph in source_paragraphs)
        or not all(isinstance(paragraph, str) for paragraph in translated_paragraphs)
    ):
        return translated_checkpoint
    return {
        **translated_checkpoint,
        "paragraphs": [
            align_translated_outer_brackets(source, translated)
            for source, translated in zip(source_paragraphs, translated_paragraphs, strict=True)
        ],
    }



def _merge_source_update_project(
    project_path: Path,
    record: WholeBookTranslationJobRecord,
    settings: Settings,
) -> None:
    job_path = _job_root_path(settings, record.user_id, record.id)
    if not project_path.is_dir() or not job_path.is_dir():
        raise ValueError("翻译项目检查点不存在")
    for directory_name in ("source", "translated"):
        source_directory = job_path / directory_name
        target_directory = project_path / directory_name
        target_directory.mkdir(parents=True, exist_ok=True)
        if not source_directory.is_dir():
            continue
        for source_path in source_directory.glob("*.json"):
            temporary = target_directory / f".{source_path.name}.{uuid4().hex}.tmp"
            if directory_name == "translated":
                matching_source_path = job_path / "source" / source_path.name
                if matching_source_path.is_file():
                    normalized = _normalize_translated_checkpoint(_read_json(matching_source_path), _read_json(source_path))
                    temporary.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
                else:
                    shutil.copy2(source_path, temporary)
            else:
                shutil.copy2(source_path, temporary)
            temporary.replace(target_directory / source_path.name)
    manifest_path = project_path / "project.json"
    manifest = _read_json(manifest_path)
    previous_quality = manifest.get("quality_report") if isinstance(manifest.get("quality_report"), dict) else {}
    manifest.update(
        {
            "memory": record.memory_json,
            "quality_report": {**previous_quality, **(record.quality_report_json or {})},
            "completed_chapters": len(list((project_path / "translated").glob("*.json"))),
            "total_chapters": len(list((project_path / "translated").glob("*.json"))),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    _write_json_atomic(manifest_path, manifest)



def _source_update_project_handled_indexes(project_path: Path) -> set[int]:
    handled: set[int] = set()
    translated_path = project_path / "translated"
    if translated_path.is_dir():
        for checkpoint_path in translated_path.glob("*.json"):
            # Local positions are deliberately unrelated to source episodes.
            if checkpoint_path.stem.startswith("local-"):
                continue
            checkpoint = _read_project_mapping(checkpoint_path)
            handled.add(_project_episode_index(checkpoint.get("index", checkpoint_path.stem)))
    manifest_path = project_path / "project.json"
    if manifest_path.is_file():
        manifest = _read_project_mapping(manifest_path)
        for field in ("handled_episode_indexes", "dismissed_episode_indexes"):
            handled.update(_project_episode_indexes(manifest.get(field)))
    return handled


def _manual_epub_sidecar_chapters(
    *,
    book: Book,
    asset_repository: SqlAlchemyBookAssetRepository,
    draft_chapters: list[dict[str, object]],
    settings: Settings,
) -> list[dict[str, object]]:
    manual_assets = [
        asset
        for asset in asset_repository.list_by_book(book.id, "text_chapter")
        if asset.metadata.get("source") == "manual_append"
    ]
    if not manual_assets:
        return []

    used_indexes = {
        int(chapter.get("index", 0))
        for chapter in draft_chapters
        if int(chapter.get("index", 0)) > 0
    }
    fallback_index = max(
        [*used_indexes, *(asset.index or 0 for asset in manual_assets)],
        default=0,
    )
    chapters: list[dict[str, object]] = []
    for position, asset in enumerate(manual_assets, start=1):
        title = get_asset_title(asset, position)
        episode_index = extract_episode_number(title)
        if episode_index is None or episode_index in used_indexes:
            fallback_index += 1
            episode_index = fallback_index
        used_indexes.add(episode_index)
        path = resolve_storage_path(get_storage_root(settings), asset.path)
        if not path.is_file():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"追加章节文件不存在，无法安全合并：{title}",
            )
        content = path.read_text(encoding="utf-8")
        paragraphs = split_paragraphs(content)
        chapters.append(
            {
                "index": episode_index,
                "title": title,
                "source_title": title,
                "source_url": asset.metadata.get('source_episode_url'),
                "source_id": asset.metadata.get('external_source_id'),
                "paragraphs": paragraphs,
            }
        )
    return chapters



def _book_after_resolving_source_episodes(book: Book, resolved_indexes: set[int]) -> Book:
    if book.source_pending_episode_indexes:
        pending_indexes = tuple(
            index for index in book.source_pending_episode_indexes if index not in resolved_indexes
        )
        return book.with_changes(
            source_pending_episode_indexes=pending_indexes,
            source_update_count=len(pending_indexes),
        )
    return book.with_changes(
        source_update_count=max(0, book.source_update_count - len(resolved_indexes)),
    )



def _mark_source_update_episodes_dismissed(project_path: Path, record: WholeBookTranslationJobRecord) -> None:
    manifest_path = project_path / "project.json"
    if not manifest_path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="这本书缺少链接精翻项目，不能记录放弃决定")
    manifest = _read_project_mapping(manifest_path)
    dismissed_indexes = _project_episode_indexes(manifest.get("dismissed_episode_indexes"))
    catalog = record.catalog_json if record.catalog_json is not None else []
    if not isinstance(catalog, list):
        raise _project_index_error()
    for item in catalog:
        if not isinstance(item, dict):
            raise _project_index_error()
        dismissed_indexes.add(_project_episode_index(item.get("index")))
    manifest["dismissed_episode_indexes"] = sorted(dismissed_indexes)
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_json_atomic(manifest_path, manifest)


def _archive_translation_project(
    *,
    job_id: str,
    book_id: str,
    settings: Settings,
    session_factory: SessionFactory,
    read_job: Callable[[str, SessionFactory], WholeBookTranslationJobRecord | None],
) -> Path:
    job = read_job(job_id, session_factory)
    if not job:
        raise ValueError("翻译任务不存在，无法归档项目")
    source = _job_root_path(settings, job.user_id, job.id)
    if not source.is_dir():
        raise ValueError("翻译项目检查点不存在")
    manifest = {
        "version": 1,
        "book_id": book_id,
        "source_url": job.source_url,
        "source_provider": job.source_provider,
        "model": job.model,
        "custom_instructions": job.custom_instructions,
        "metadata": job.metadata_json,
        "translated_metadata": job.translated_metadata_json,
        "memory": job.memory_json,
        "quality_report": job.quality_report_json,
        "completed_chapters": job.completed_chapters,
        "total_chapters": job.total_chapters,
        "archived_at": datetime.now(timezone.utc).isoformat(),
    }
    target = _translation_project_path(settings, job.user_id, book_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{target.name}.{uuid4().hex}.tmp"
    backup: Path | None = None
    try:
        shutil.copytree(source, temporary)
        _write_json_atomic(temporary / "project.json", manifest)
        if target.exists():
            backup = target.parent / f".{target.name}.{uuid4().hex}.old"
            target.replace(backup)
        try:
            temporary.replace(target)
        except Exception:
            if backup is not None and backup.exists() and not target.exists():
                backup.replace(target)
            raise
        if backup is not None:
            with suppress(OSError):
                shutil.rmtree(backup)
    finally:
        if temporary.exists():
            with suppress(OSError):
                shutil.rmtree(temporary)
    return target

