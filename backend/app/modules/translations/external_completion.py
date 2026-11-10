"""Export immutable source checkpoints and reconcile externally published work."""
from collections import Counter
from datetime import datetime, timezone
import json
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import update

from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment
from app.core.database_revisions import datetime_revision_matches
from app.modules.auth.api_token_service import utc
from app.modules.books.continuation import fingerprint, read_receipt, save_receipt
from app.modules.books.publication_check import inspect_publication, file_digest
from app.modules.books.source_episode_matching import extract_episode_number, normalize_episode_title
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.books.source_identity import source_url_identity
from app.modules.translations.checkpoints import _job_root_path, _source_chapter_from_json
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.uploads.replacement_publication import claim_book_revision
from app.modules.uploads.replacement_storage import upload_book_processing_lock
from app.modules.uploads.schemas import WorkSourceEpisode


class SourceCheckpoint(BaseModel):
    index: int
    title: str
    url: str
    paragraphs: list[str]
    source_hash: str


class ExternalSourceEpisode(BaseModel):
    index: int
    title: str
    url: str
    cached: bool


class ExternalSourceManifest(BaseModel):
    job_id: str
    status: str
    updated_at: datetime
    source_url: str
    episodes: list[ExternalSourceEpisode]


class ReconcileRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    book_id: UUID
    expected_book_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    expected_job_updated_at: datetime
    acknowledge: bool = False


class ChapterEvidence(BaseModel):
    source_index: int
    reader_index: int
    method: str
    content_hash: str


class ReconcileResult(BaseModel):
    job_id: str
    book_id: str
    status: str
    evidence: list[ChapterEvidence]
    original_sha256: str


def owned_job(session, user_id, job_id):
    record = session.get(Job, job_id)
    if not record or record.user_id != user_id:
        raise HTTPException(404, 'Translation job not found')
    return record


def catalog(record):
    try:
        entries = [WorkSourceEpisode.model_validate(item) for item in record.catalog_json]
    except (TypeError, ValueError) as error:
        raise HTTPException(409, 'Translation source catalog is invalid') from error
    if not entries or len({e.index for e in entries}) != len(entries) or len({e.url for e in entries}) != len(entries):
        raise HTTPException(409, 'Translation source catalog is incomplete or ambiguous')
    return entries


def checkpoint_path(record, episode, settings):
    if (record.quality_report_json or {}).get('_workflow_version') == 2:
        entries = (record.metadata_json or {}).get('episodes', [])
        position = next((i for i, e in enumerate(entries, 1)
            if isinstance(e, dict) and e.get('index') == episode.index and e.get('url') == episode.url), None)
        if position is None:
            raise HTTPException(409, 'Source snapshot does not match the task catalog')
        return resolve_storage_path(get_storage_root(settings),
            f'translation-v2/{safe_storage_segment(record.user_id)}/{safe_storage_segment(record.id)}/source/{position:05d}.json')
    return _job_root_path(settings, record.user_id, record.id) / 'source' / f'{episode.index:05d}.json'


def external_manifest(session, user_id, job_id, settings):
    record = owned_job(session, user_id, job_id)
    return ExternalSourceManifest(job_id=record.id, status=record.status, updated_at=record.updated_at,
        source_url=record.source_url, episodes=[ExternalSourceEpisode(index=e.index, title=e.title, url=e.url,
            cached=checkpoint_path(record, e, settings).is_file()) for e in catalog(record)])


def export_source(session, user_id, job_id, index, settings):
    record = owned_job(session, user_id, job_id)
    episode = next((e for e in catalog(record) if e.index == index), None)
    if episode is None:
        raise HTTPException(404, 'Source chapter not in task catalog')
    path = checkpoint_path(record, episode, settings)
    if not path.is_file():
        raise HTTPException(409, 'This source checkpoint has not been downloaded')
    if path.stat().st_size > 16 * 1024 * 1024:
        raise HTTPException(413, 'Source checkpoint exceeds the export size limit')
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError('snapshot must be an object')
        if (record.quality_report_json or {}).get('_workflow_version') == 2:
            from app.modules.translation_v2.pilot import digest
            if value.get('hash') != digest(value.get('value')):
                raise ValueError('snapshot digest mismatch')
            value = value['value']
        if not isinstance(value, dict):
            raise ValueError('source chapter must be an object')
        chapter = _source_chapter_from_json(value)
        if chapter.index != episode.index or chapter.url != episode.url or not chapter.paragraphs:
            raise ValueError('snapshot identity mismatch')
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(409, 'Source checkpoint is invalid; it has been preserved') from error
    return SourceCheckpoint(index=chapter.index, title=chapter.title, url=chapter.url,
        paragraphs=chapter.paragraphs, source_hash=fingerprint(value))


def publication_evidence(record, chapters, *, allow_partial=False):
    required = [e.model_copy(update={'url': source_url_identity(e.url)}) for e in catalog(record)]
    if len({e.url for e in required}) != len(required):
        raise HTTPException(409, 'Translation source catalog contains duplicate source URLs')
    chapters = [c.model_copy(update={'source_url': source_url_identity(c.source_url)}) for c in chapters]
    # Use the complete source catalog when available. A numbering reset outside
    # this particular job must not make a guessed episode appear unique.
    try:
        complete = [WorkSourceEpisode.model_validate(e) for e in (record.metadata_json or {}).get('episodes', [])]
    except (ValueError, TypeError):
        complete = []
    complete_by_index = {e.index: e for e in complete}
    complete_by_index.update({e.index: e for e in required})
    complete = list(complete_by_index.values())
    source_numbers = Counter(extract_episode_number(e.title) for e in complete)
    reader_numbers = Counter(extract_episode_number(c.title) for c in chapters)
    source_titles = Counter(normalize_episode_title(e.title) for e in complete)
    reader_titles = Counter(normalize_episode_title(c.title) for c in chapters)
    evidence, used = [], set()
    for episode in required:
        candidates = [(c, 'source_url') for c in chapters if c.source_url == episode.url]
        if not candidates:
            candidates = [(c, 'source_index') for c in chapters if c.source_index == episode.index and not c.source_url]
        number = extract_episode_number(episode.title)
        if not candidates and number is not None and source_numbers[number] == reader_numbers[number] == 1:
            candidates = [(c, 'unique_episode_number') for c in chapters
                if extract_episode_number(c.title) == number and not c.source_url and c.source_index is None]
        title = normalize_episode_title(episode.title)
        if not candidates and title and source_titles[title] == reader_titles[title] == 1:
            candidates = [(c, 'unique_source_title') for c in chapters
                if normalize_episode_title(c.title) == title and not c.source_url and c.source_index is None]
        if len(candidates) != 1 or candidates[0][0].index in used:
            if allow_partial:
                if candidates and candidates[0][1] in {'source_url', 'source_index'}:
                    chapter, method = candidates[0]
                    evidence.append(ChapterEvidence(source_index=episode.index, reader_index=chapter.index,
                        method=method, content_hash=chapter.content_hash))
                continue
            raise HTTPException(409, {'error_code': 'publication_coverage_unproven', 'source_index': episode.index,
                'message': 'Cannot uniquely verify this source chapter in the published book'})
        chapter, method = candidates[0]
        used.add(chapter.index)
        evidence.append(ChapterEvidence(source_index=episode.index, reader_index=chapter.index,
            method=method, content_hash=chapter.content_hash))
    return evidence


def reconcile_external(session, user_id, job_id, payload, settings):
    record = owned_job(session, user_id, job_id)
    book_id = str(payload.book_id)
    book = SqlAlchemyBookRepository(session).get_owned(user_id, book_id)
    if not book:
        raise HTTPException(404, 'Book not found')
    digest = fingerprint({'operation': 'external_completion', 'job_id': job_id,
        'payload': payload.model_dump(mode='json')})
    if previous := read_receipt(session, user_id, payload.request_id, digest):
        return ReconcileResult(**previous)
    if record.status not in {'failed', 'paused', 'review', 'ready', 'completed'}:
        raise HTTPException(409, 'Pause the task and wait for its worker to stop before reconciling')
    if record.lease_owner or record.lease_expires_at:
        raise HTTPException(409, 'Task still has a worker lease')
    if utc(record.updated_at) != utc(payload.expected_job_updated_at):
        raise HTTPException(409, 'Task changed; read its current state')
    if record.job_kind == 'source_update' and record.book_id != book_id:
        raise HTTPException(409, 'Source updates must reconcile against their original book')
    if not book.source_url or source_url_identity(book.source_url) != source_url_identity(record.source_url):
        raise HTTPException(409, 'Book and translation task have different sources')
    with upload_book_processing_lock(settings=settings, book_id=book_id):
        check = inspect_publication(session, user_id, book_id, settings)
        if check.revision != payload.expected_book_revision:
            raise HTTPException(409, 'Book changed; run publication-check again')
        if not check.in_sync:
            raise HTTPException(409, {'error_code': 'publication_out_of_sync', 'issues': check.issues,
                'message': 'Reprocess the original and verify the online catalog before reconciling'})
        evidence = publication_evidence(record, check.chapters)
        try:
            claim_book_revision(session=session, book=book, owner_id=user_id)
        except ValueError as error:
            raise HTTPException(409, 'Book changed during verification') from error
        claimed = session.execute(update(Job).where(Job.id == job_id, Job.user_id == user_id,
            datetime_revision_matches(Job.updated_at, record.updated_at, session.get_bind().dialect.name),
            Job.status == record.status,
            Job.lease_owner.is_(None), Job.lease_expires_at.is_(None))
            .values(updated_at=Job.updated_at).execution_options(synchronize_session=False))
        if claimed.rowcount != 1:
            session.rollback()
            raise HTTPException(409, 'Task changed during verification')
        if file_digest(resolve_storage_path(get_storage_root(settings), book.original_file_path)) != check.original_sha256:
            session.rollback()
            raise HTTPException(409, 'Original changed during verification')
        result = ReconcileResult(job_id=job_id, book_id=book_id, status='ready',
            evidence=evidence, original_sha256=check.original_sha256)
        now = datetime.now(timezone.utc)
        report = dict(record.quality_report_json or {})
        report['_external_completion'] = {**result.model_dump(), 'verified_at': now.isoformat(),
            'previous_status': record.status, 'previous_stage': record.stage,
            'previous_error': record.error_message, 'book_revision': check.revision,
            'quality_review': 'external'}
        record.quality_report_json = report
        record.book_id, record.status, record.stage = book_id, 'ready', 'external_completed'
        record.completed_chapters = record.total_chapters = len(evidence)
        record.progress, record.error_message = 100, None
        record.message = f'已核验外部成果，原文件与在线阅读一致，共 {len(evidence)} 话'
        record.acknowledged, record.finished_at, record.updated_at = payload.acknowledge, now, now
        # Evidence applies to this edition only. Other books may share its source
        # URL without containing the same published chapters. Legacy count-only
        # notifications cannot be safely reduced without source identities.
        if book.source_pending_episode_indexes:
            resolved = {e.source_index for e in evidence}
            remaining = tuple(i for i in book.source_pending_episode_indexes if i not in resolved)
            SqlAlchemyBookRepository(session, autocommit=False).save(book.with_changes(
                source_pending_episode_indexes=remaining, source_update_count=len(remaining)))
        save_receipt(session, user_id, payload.request_id, digest, result.model_dump())
        session.commit()
        return result
