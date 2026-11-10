"""Legacy job phases with injected persistence, provider and checkpoint operations."""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Any, Awaitable, Callable, TYPE_CHECKING

from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata
from app.modules.translations.provider_observations import has_recovery_probe

if TYPE_CHECKING:
    from app.core.config import Settings
    from .models import WholeBookTranslationJobRecord
    from .quality import QualityIssue
    from .source_text import SourceChapter

SessionFactory = Callable[[], Any]
TranslatedChapters = list[dict[str, object]]
ChapterDraft = tuple[list[str], dict[str, object]]


@dataclass(frozen=True)
class PreparedTranslationJob:
    job: WholeBookTranslationJobRecord
    ai_settings: Settings
    chapters: list[SourceChapter]
    translated_metadata: WorkSourceMetadata
    translated_titles: list[str]
    memory: dict[str, object]
    translation_preferences: str


@dataclass(frozen=True)
class TranslationJobDependencies:
    model_tuning: Callable[..., tuple[int, int, int]]
    decrypt_key: Callable[..., str]
    platform_credential: Callable[..., bool]
    primary_call_budget: Callable[..., int]
    update_job: Callable[..., bool]
    download_chapters: Callable[..., Awaitable[list[SourceChapter]]]
    check_pause: Callable[..., None]
    read_job: Callable[..., WholeBookTranslationJobRecord | None]
    translate_metadata: Callable[..., Awaitable[WorkSourceMetadata]]
    coerce_memory: Callable[..., dict[str, object]]
    build_memory: Callable[..., Awaitable[dict[str, object]]]
    enrich_terminology: Callable[..., Awaitable[dict[str, object]]]
    translate_titles: Callable[..., Awaitable[list[str]]]
    rewrite_checkpoint_titles: Callable[..., list[dict[str, object]]]
    publish: Callable[..., str]
    chapter_path: Callable[..., Path]
    load_checkpoint: Callable[..., dict[str, object] | None]
    repair_names: Callable[..., list[str] | None]
    quality_issues: Callable[..., list[QualityIssue]]
    write_checkpoint: Callable[..., None]
    clamp_concurrency: Callable[..., int]
    load_draft: Callable[..., ChapterDraft | None]
    translate_window: Callable[..., Awaitable[list[ChapterDraft | BaseException]]]
    save_draft: Callable[..., None]
    repair_hard_quality: Callable[..., Awaitable[tuple[list[str], list[QualityIssue], int, list[str]]]]
    update_memory: Callable[..., Awaitable[dict[str, object]]]
    draft_fingerprint: Callable[..., str]
    clear_model_unavailable: Callable[..., None]
    archive_project: Callable[..., Path]
    remove_job_storage: Callable[..., None]
    terminology_version: int
    catalog_version: int
    lease_lost: type[Exception]
    logger: logging.Logger


@dataclass(frozen=True)
class TranslationJobExecutor:
    prepare: Callable[..., Awaitable[PreparedTranslationJob | None]]
    translate_chapters: Callable[..., Awaitable[TranslatedChapters | None]]
    finalize: Callable[..., Awaitable[None]]

    async def run(
        self, *, job_id: str, job: WholeBookTranslationJobRecord,
        settings: Settings, session_factory: SessionFactory,
    ) -> None:
        prepared = await self.prepare(
            job_id=job_id, job=job, settings=settings, session_factory=session_factory,
        )
        if prepared is None:
            return
        translated = await self.translate_chapters(
            job_id=job_id, prepared=prepared, settings=settings, session_factory=session_factory,
        )
        if translated is None:
            return
        await self.finalize(
            job_id=job_id, prepared=prepared, translated_chapters=translated,
            settings=settings, session_factory=session_factory,
        )


def create_translation_job_executor(dependencies: TranslationJobDependencies) -> TranslationJobExecutor:
    _job_model_tuning = dependencies.model_tuning
    decrypt_ai_api_key = dependencies.decrypt_key
    is_platform_ai_credential = dependencies.platform_credential
    _job_primary_daily_call_budget = dependencies.primary_call_budget
    update_job = dependencies.update_job
    _download_source_chapters = dependencies.download_chapters
    _raise_if_translation_pause_requested = dependencies.check_pause
    _read_job = dependencies.read_job
    translate_source_metadata = dependencies.translate_metadata
    _coerce_memory = dependencies.coerce_memory
    _build_series_memory = dependencies.build_memory
    _enrich_series_terminology = dependencies.enrich_terminology
    _translate_chapter_titles = dependencies.translate_titles
    _rewrite_translated_checkpoint_titles = dependencies.rewrite_checkpoint_titles
    _publish_translation = dependencies.publish
    _translated_chapter_path = dependencies.chapter_path
    _load_completed_translation_checkpoint = dependencies.load_checkpoint
    _repair_name_only_locked_terms = dependencies.repair_names
    _deterministic_quality_issues = dependencies.quality_issues
    _write_json_atomic = dependencies.write_checkpoint
    clamp_translation_concurrency = dependencies.clamp_concurrency
    _load_translation_draft = dependencies.load_draft
    _translate_chapter_window = dependencies.translate_window
    _save_translation_draft = dependencies.save_draft
    _repair_hard_quality_paragraphs = dependencies.repair_hard_quality
    _update_series_memory = dependencies.update_memory
    _translation_draft_fingerprint = dependencies.draft_fingerprint
    _clear_job_model_unavailable = dependencies.clear_model_unavailable
    _archive_translation_project = dependencies.archive_project
    _remove_translation_job_storage = dependencies.remove_job_storage
    TERMINOLOGY_PREFLIGHT_VERSION = dependencies.terminology_version
    CATALOG_TRANSLATION_VERSION = dependencies.catalog_version
    TranslationLeaseLost = dependencies.lease_lost
    logger = dependencies.logger

    def _update_job(*args, **changes):
        updated = update_job(*args, **changes)
        if updated is False:
            raise TranslationLeaseLost
        return updated


    async def prepare(
        *, job_id: str, job: WholeBookTranslationJobRecord,
        settings: Settings, session_factory: SessionFactory,
    ) -> PreparedTranslationJob | None:
        max_concurrency, chunk_characters, chunk_paragraphs = _job_model_tuning(job, session_factory)
        job_api_key = decrypt_ai_api_key(job.provider_api_key_encrypted, settings)
        platform_credential = is_platform_ai_credential(job_api_key, settings)
        ai_settings = replace(
            settings,
            ai_translation_base_url=job.provider_base_url,
            ai_translation_api_key=job_api_key,
            ai_translation_model=job.model,
            # Saved channels are independent provider lanes.  The server-level
            # secondary/rescue names and daily allowances describe the legacy
            # built-in gateway and must never leak into a user-selected channel
            # merely because both endpoints expose a model with the same name.
            # The selected channel already reports real 429s, which remain the
            # authority for its availability.
            ai_translation_secondary_model=("" if job.channel_id else settings.ai_translation_secondary_model),
            ai_translation_rescue_model=("" if job.channel_id else settings.ai_translation_rescue_model),
            # A model selected explicitly for a job becomes the first request
            # lane, but it must keep the allowance assigned to that model in
            # server configuration. Previously selecting the secondary Flash
            # model promoted it into the 200-call High slot and parked a healthy
            # job after 200 calls instead of using its 3,000-call allowance.
            ai_translation_daily_call_budget=_job_primary_daily_call_budget(
                job.model, settings, credential_key=job_api_key
            ),
            ai_translation_global_daily_call_budget=(
                settings.ai_translation_global_daily_call_budget if platform_credential else 0
            ),
            ai_translation_secondary_daily_call_budget=(
                0 if job.channel_id else settings.ai_translation_secondary_daily_call_budget
            ),
            ai_translation_rescue_daily_call_budget=(
                0 if job.channel_id else settings.ai_translation_rescue_daily_call_budget
            ),
            ai_translation_max_concurrency=max_concurrency,
            ai_translation_chunk_characters=chunk_characters,
            ai_translation_chunk_paragraphs=chunk_paragraphs,
        )
        translation_preferences = job.custom_instructions or ""
        _update_job(
            job_id,
            session_factory,
            status="processing",
            stage="downloading",
            started_at=job.started_at or datetime.now(timezone.utc),
            message="正在固定原文目录并下载章节",
        )
        chapters = await _download_source_chapters(job_id, settings, session_factory)
        _raise_if_translation_pause_requested(job_id, session_factory)
        job = _read_job(job_id, session_factory)
        if not job:
            return
        source_metadata = WorkSourceMetadata.model_validate(job.metadata_json)
        source_metadata = source_metadata.model_copy(
            update={
                "episodes": [
                    WorkSourceEpisode(
                        index=chapter.index,
                        title=chapter.title,
                        url=chapter.url,
                        section_title=chapter.section_title,
                        section_level=chapter.section_level,
                    )
                    for chapter in chapters
                ]
            }
        )
        # A stored "unavailable" metadata means the channel was down when the
        # work title/description/tags were translated. The old code kept that
        # result forever, so the book was published with fully Japanese metadata
        # and nothing ever retried it. Treat it as unfinished instead.
        stored_metadata_usable = bool(job.translated_metadata_json) and (
            (job.translated_metadata_json or {}).get("translation_status") != "unavailable"
        )
        if stored_metadata_usable:
            translated_metadata = WorkSourceMetadata.model_validate(job.translated_metadata_json)
            translated_titles = [episode.title for episode in translated_metadata.episodes]
            if len(translated_titles) != len(source_metadata.episodes):
                raise ValueError("翻译任务保存的目录与原作目录数量不一致")
        else:
            translated_metadata = await translate_source_metadata(
                source_metadata,
                ai_settings,
                translation_preferences=translation_preferences,
                strict=True,
            )

        memory = _coerce_memory(job.memory_json) if job.memory_json else {}
        if not memory:
            _update_job(job_id, session_factory, stage="analyzing", progress=19, message="正在建立人物、称呼和术语设定表")
            memory = await _build_series_memory(
                translated_metadata,
                chapters,
                ai_settings,
                translation_preferences=translation_preferences,
            )
            _update_job(job_id, session_factory, memory_json=memory)

        if int(memory.get("_terminology_version") or 0) < TERMINOLOGY_PREFLIGHT_VERSION:
            _update_job(
                job_id,
                session_factory,
                stage="analyzing",
                progress=max(job.progress, 19),
                message="正在扫描全书专名并锁定统一译名",
            )
            memory = await _enrich_series_terminology(
                memory=memory,
                chapters=chapters,
                settings=ai_settings,
                translation_preferences=translation_preferences,
            )
            _update_job(job_id, session_factory, memory_json=memory)

        if not stored_metadata_usable or job.catalog_translation_version < CATALOG_TRANSLATION_VERSION:
            _update_job(
                job_id,
                session_factory,
                stage="analyzing",
                progress=max(job.progress, 19),
                message="正在结合正文与人物设定精修目录",
            )
            translated_titles = await _translate_chapter_titles(
                source_metadata,
                translated_metadata,
                chapters,
                memory,
                ai_settings,
                translation_preferences=translation_preferences,
                request_concurrency=job.request_concurrency,
            )
            translated_metadata = translated_metadata.model_copy(
                update={
                    "episodes": [
                        episode.model_copy(update={"title": translated_titles[index]})
                        for index, episode in enumerate(source_metadata.episodes)
                    ]
                }
            )
            _update_job(
                job_id,
                session_factory,
                title=(job.title if job.job_kind == "source_update" else translated_metadata.title[:255]),
                author=(job.author if job.job_kind == "source_update" else translated_metadata.author[:255]),
                translated_metadata_json=translated_metadata.model_dump(mode="json"),
                catalog_translation_version=CATALOG_TRANSLATION_VERSION,
            )
            rewritten_chapters = _rewrite_translated_checkpoint_titles(
                settings=settings,
                user_id=job.user_id,
                job_id=job.id,
                chapters=chapters,
                translated_titles=translated_titles,
            )
            if rewritten_chapters and job.job_kind != "source_update":
                partial_book_id = _publish_translation(
                    job_id=job_id,
                    chapters=rewritten_chapters,
                    metadata=translated_metadata,
                    settings=settings,
                    session_factory=session_factory,
                )
                _update_job(job_id, session_factory, book_id=partial_book_id)
        _raise_if_translation_pause_requested(job_id, session_factory)

        job = _read_job(job_id, session_factory)
        if not job:
            return
        _raise_if_translation_pause_requested(job_id, session_factory)

        return PreparedTranslationJob(
            job=job,
            ai_settings=ai_settings,
            chapters=chapters,
            translated_metadata=translated_metadata,
            translated_titles=translated_titles,
            memory=memory,
            translation_preferences=translation_preferences,
        )

    async def translate_chapters(
        *, job_id: str, prepared: PreparedTranslationJob,
        settings: Settings, session_factory: SessionFactory,
    ) -> TranslatedChapters | None:
        job = prepared.job
        ai_settings = prepared.ai_settings
        chapters = prepared.chapters
        translated_metadata = prepared.translated_metadata
        translated_titles = prepared.translated_titles
        memory = prepared.memory
        translation_preferences = prepared.translation_preferences
        translated_chapters: list[dict[str, object]] = []
        quality_report = dict(job.quality_report_json or {})
        position = 0
        while position < len(chapters):
            chapter = chapters[position]
            _raise_if_translation_pause_requested(job_id, session_factory)
            output_path = _translated_chapter_path(settings, job.user_id, job.id, chapter.index)
            checkpoint = _load_completed_translation_checkpoint(output_path, chapter)
            if checkpoint is not None:
                checkpoint_paragraphs = checkpoint.get("paragraphs")
                if isinstance(checkpoint_paragraphs, list) and all(
                    isinstance(item, str) for item in checkpoint_paragraphs
                ) and len(checkpoint_paragraphs) == len(chapter.paragraphs):
                    # Resuming a long-running job must not re-send every durable
                    # historical chapter to the provider. Besides being slow,
                    # one malformed repair response used to block all remaining
                    # chapters before the worker even reached the next checkpoint.
                    # Apply only the safe, deterministic name-only migration here;
                    # record anything else for a separate editorial pass. Newly
                    # drafted chapters still face the strict barrier below.
                    deterministic = _repair_name_only_locked_terms(
                        chapter.paragraphs,
                        checkpoint_paragraphs,
                        memory,
                    )
                    if deterministic is not None:
                        checkpoint["paragraphs"] = deterministic
                        checkpoint_paragraphs = deterministic
                    checkpoint_issues = _deterministic_quality_issues(
                        chapter.paragraphs,
                        checkpoint_paragraphs,
                        memory,
                    )
                    unresolved_history = [issue.message for issue in checkpoint_issues if issue.severity == "hard"]
                    if unresolved_history:
                        quality_report[f"history:{chapter.index}"] = {
                            "remaining": unresolved_history,
                            "deferred_editorial_repair": True,
                        }
                    else:
                        quality_report.pop(f"history:{chapter.index}", None)
                translated_chapters.append(checkpoint)
                checkpoint_memory = checkpoint.get("memory_after")
                if isinstance(checkpoint_memory, dict):
                    memory = _coerce_memory(checkpoint_memory, fallback=memory)
                    checkpoint["memory_after"] = memory
                _write_json_atomic(output_path, checkpoint)
                position += 1
                continue
            live_job = _read_job(job_id, session_factory)
            if not live_job:
                return
            concurrency = clamp_translation_concurrency(live_job.model, live_job.request_concurrency)
            batch_positions: list[int] = []
            candidate_position = position
            while candidate_position < len(chapters) and len(batch_positions) < concurrency:
                candidate = chapters[candidate_position]
                candidate_path = _translated_chapter_path(settings, job.user_id, job.id, candidate.index)
                if candidate_path.is_file():
                    break
                batch_positions.append(candidate_position)
                candidate_position += 1

            progress = 20 + int((position / max(1, len(chapters))) * 70)
            batch_last_position = batch_positions[-1]
            batch_first_chapter = chapters[position]
            batch_last_chapter = chapters[batch_last_position]
            batch_range = (
                str(batch_first_chapter.index)
                if len(batch_positions) == 1
                else f"{batch_first_chapter.index}-{batch_last_chapter.index}"
            )
            _update_job(
                job_id,
                session_factory,
                stage="translating",
                progress=progress,
                current_chapter_index=chapter.index,
                message=(
                    f"正在并行精翻新增第 {position + 1}-{batch_last_position + 1}/{len(chapters)} 话"
                    if live_job.job_kind == "source_update"
                    else f"正在并行精翻第 {batch_range}/{len(chapters)} 话"
                ),
            )
            # Keep successful siblings even if an earlier chapter or the memory
            # update fails. Drafts are not published until the ordered checks pass.
            cached_results = {
                item: _load_translation_draft(ai_settings, job.user_id, job.id, chapters[item], translation_preferences)
                for item in batch_positions
            }
            missing_positions = [item for item in batch_positions if cached_results[item] is None]
            new_results = await _translate_chapter_window(
                positions=missing_positions,
                chapters=chapters,
                memory=memory,
                settings=ai_settings,
                translation_preferences=translation_preferences,
                request_concurrency=concurrency,
                on_chapter_complete=lambda item, result: _save_translation_draft(
                    ai_settings, job.user_id, job.id, chapters[item], result, translation_preferences
                ),
            ) if missing_positions else []
            for item, result in zip(missing_positions, new_results, strict=True):
                cached_results[item] = result
                if not isinstance(result, BaseException):
                    _save_translation_draft(ai_settings, job.user_id, job.id, chapters[item], result, translation_preferences)
            batch_results = [cached_results[item] for item in batch_positions]

            for batch_position, batch_result in zip(batch_positions, batch_results, strict=True):
                if isinstance(batch_result, BaseException):
                    raise batch_result
                batch_chapter = chapters[batch_position]
                translated_paragraphs, chapter_qa = batch_result
                translated_title = translated_titles[batch_position]

                # Chapters in one window are drafted concurrently from the same
                # memory snapshot. Before each one is committed, re-check it
                # against the memory updated by the preceding chapter. This keeps
                # parallel throughput without allowing a newly established name
                # or form of address to drift in a sibling chapter.
                consistency_issues = _deterministic_quality_issues(
                    batch_chapter.paragraphs,
                    translated_paragraphs,
                    memory,
                )
                consistency_hard = [issue for issue in consistency_issues if issue.severity == "hard"]
                if consistency_hard:
                    (
                        translated_paragraphs,
                        consistency_issues,
                        consistency_attempts,
                        consistency_degraded,
                    ) = await _repair_hard_quality_paragraphs(
                        chapter=batch_chapter,
                        source=batch_chapter.paragraphs,
                        translated=translated_paragraphs,
                        memory=memory,
                        settings=ai_settings,
                        translation_preferences=translation_preferences,
                    )
                    remaining_hard = [issue for issue in consistency_issues if issue.severity == "hard"]
                    chapter_qa = {
                        **chapter_qa,
                        "post_window_consistency": {
                            "repair_attempts": consistency_attempts,
                            "remaining": [issue.message for issue in consistency_issues],
                            "degraded": consistency_degraded,
                        },
                    }
                    if remaining_hard:
                        raise ValueError(
                            f"第 {batch_chapter.index} 话全书译名一致性检查不通过："
                            + "；".join(issue.message for issue in remaining_hard[:5])
                        )
                quality_report[str(batch_chapter.index)] = chapter_qa
                memory = await _update_series_memory(
                    memory=memory,
                    chapter=batch_chapter,
                    translated_paragraphs=translated_paragraphs,
                    settings=ai_settings,
                    translation_preferences=translation_preferences,
                )
                translated_chapter = {
                    "index": batch_chapter.index,
                    "source_hash": _translation_draft_fingerprint(batch_chapter),
                    "title": translated_title,
                    "source_title": batch_chapter.title,
                    "source_url": batch_chapter.url,
                    "paragraphs": translated_paragraphs,
                    "memory_after": memory,
                }
                batch_output_path = _translated_chapter_path(
                    settings, job.user_id, job.id, batch_chapter.index
                )
                _write_json_atomic(batch_output_path, translated_chapter)
                translated_chapters.append(translated_chapter)
                partial_book_id = live_job.book_id
                if live_job.job_kind != "source_update":
                    partial_book_id = _publish_translation(
                        job_id=job_id,
                        chapters=translated_chapters,
                        metadata=translated_metadata,
                        settings=settings,
                        session_factory=session_factory,
                    )
                _update_job(
                    job_id,
                    session_factory,
                    book_id=partial_book_id,
                    completed_chapters=batch_position + 1,
                    memory_json=memory,
                    quality_report_json=quality_report,
                    # A finished chapter proves the lane is healthy again, so the
                    # escalating backoff starts over rather than carrying an old
                    # streak into the next hiccup.
                    provider_failure_streak=0,
                    quota_resume_at=None,
                    message=(
                        f"已完成新增第 {batch_position + 1}/{len(chapters)} 话，正在继续处理"
                        if live_job.job_kind == "source_update"
                        else f"已完成第 {batch_chapter.index}/{len(chapters)} 话，可先打开阅读"
                    ),
                )
                if has_recovery_probe():
                    _clear_job_model_unavailable(live_job, session_factory)
                _raise_if_translation_pause_requested(job_id, session_factory)
            position = candidate_position

        return translated_chapters

    async def finalize(
        *, job_id: str, prepared: PreparedTranslationJob, translated_chapters: TranslatedChapters,
        settings: Settings, session_factory: SessionFactory,
    ) -> None:
        chapters = prepared.chapters
        translated_metadata = prepared.translated_metadata
        _raise_if_translation_pause_requested(job_id, session_factory)
        published_job = _read_job(job_id, session_factory)
        if published_job is not None and has_recovery_probe():
            _clear_job_model_unavailable(published_job, session_factory)
        if published_job and published_job.job_kind == "source_update":
            _update_job(
                job_id,
                session_factory,
                status="review",
                stage="review",
                progress=100,
                completed_chapters=len(chapters),
                current_chapter_index=None,
                message=f"{len(chapters)} 话更新译稿已完成，等待你查看并决定是否加入原书",
                error_message=None,
                acknowledged=False,
                lease_owner=None,
                lease_expires_at=None,
                finished_at=datetime.now(timezone.utc),
            )
            return
        _update_job(job_id, session_factory, stage="packaging", progress=94, message="正在生成 EPUB 并加入书架")
        published_job = _read_job(job_id, session_factory)
        if not published_job:
            raise ValueError("翻译任务不存在")
        book_id = _publish_translation(
            job_id=job_id,
            chapters=translated_chapters,
            metadata=translated_metadata,
            settings=settings,
            session_factory=session_factory,
        )
        _archive_translation_project(
            job_id=job_id,
            book_id=book_id,
            settings=settings,
            session_factory=session_factory,
        )
        job_updated = _update_job(
            job_id,
            session_factory,
            book_id=book_id,
            status="ready",
            stage="ready",
            progress=100,
            completed_chapters=len(chapters),
            current_chapter_index=None,
            message="整本精翻已完成并加入书架",
            error_message=None,
            acknowledged=False,
            lease_owner=None,
            lease_expires_at=None,
            finished_at=datetime.now(timezone.utc),
        )
        if not job_updated:
            raise TranslationLeaseLost
        try:
            _remove_translation_job_storage(settings, published_job.user_id, job_id)
        except OSError:
            logger.exception("Could not remove completed translation checkpoints for job %s", job_id)


    return TranslationJobExecutor(prepare=prepare, translate_chapters=translate_chapters, finalize=finalize)
