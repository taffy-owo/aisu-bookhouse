"""Build and verify immutable assets before a single database publication commit."""
from datetime import datetime, timezone
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4
from zipfile import ZipFile

from sqlalchemy import select, update
from fastapi import HTTPException

from app.core.storage import get_storage_root, resolve_storage_path, write_bytes_file
from app.modules.books.factory import create_uploaded_book
from app.modules.books.models import BookRecord
from app.modules.books.mappers import record_to_book, book_to_record
from app.modules.book_assets.models import BookAssetRecord
from app.modules.book_assets.repository import record_to_asset
from app.modules.reader.service import filter_readable_text_assets
from app.modules.reading_progress.chapter_calculation import appended_progress_percent, rebase_appended_progress
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from app.modules.processing.processors.epub_processor import process_epub
from app.modules.processing.processors.epub_richtext import extract_chapter_blocks
from app.modules.processing.service import validate_processing_result_files
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.translations.epub import build_translation_epub, append_translation_epub, normalize_epub_container
from .pilot import TrialError, digest, save_json


def assets_signature(assets):
    return digest([{'id': a.id, 'path': a.path, 'index': a.index, 'metadata': a.metadata_json}
                   for a in sorted(assets, key=lambda a: a.id)])


def verify_epub(data: bytes, added: list[dict], original: bytes | None = None):
    from xml.etree import ElementTree as ET
    with ZipFile(BytesIO(data)) as archive:
        if archive.testzip() or len(set(archive.namelist())) != len(archive.namelist()):
            raise TrialError('epub_zip_integrity')
        info = archive.infolist()[0]
        if info.filename != 'mimetype' or info.compress_type != 0:
            raise TrialError('epub_mimetype')
        for name in archive.namelist():
            if name.endswith(('.xhtml', '.opf', '.ncx')):
                ET.fromstring(archive.read(name))
        # Appending must preserve image/font/audio bytes, not merely filenames.
        if original:
            with ZipFile(BytesIO(original)) as before:
                for name in before.namelist():
                    if not name.endswith(('.opf', '.ncx', '.xhtml')) and name != 'mimetype':
                        expected = before.read(name)
                        if name == 'META-INF/container.xml':
                            # Container namespace repair is the sole allowed
                            # change here; OPF pointers and all binary assets
                            # remain protected by the original-byte comparison.
                            expected = normalize_epub_container(expected)
                        if archive.read(name) != expected:
                            raise TrialError('epub_original_asset_changed')
        expected = [c['paragraphs'] for c in added]
        seen = []
        for name in archive.namelist():
            if not name.endswith('.xhtml'):
                continue
            paragraphs = [b['text'] for b in extract_chapter_blocks(archive.read(name)) if b['type'] == 'paragraph']
            if paragraphs in expected:
                seen.append(paragraphs)
        if any(seen.count(p) < expected.count(p) for p in expected):
            raise TrialError('epub_reader_roundtrip')


def finish_publication(record, book, report, metadata, chapter_count):
    record.status, record.stage, record.progress = 'ready', 'ready', 100
    record.completed_chapters = chapter_count
    record.message = f'V2 已完成并验证 {chapter_count} 话，EPUB 和在线章节均已发布'
    record.error_message, record.lease_owner, record.lease_expires_at = None, None, None
    record.finished_at, record.acknowledged = datetime.now(timezone.utc), False
    if record.job_kind == 'whole_book':
        book.publication_status = metadata.publication_status
    record.quality_report_json = {**(record.quality_report_json or {}), '_publication': report}


def publish(*, job_id, lease_owner, chapters, metadata, settings, session_factory, guard, finalize=True):
    guard()
    root = get_storage_root(settings)
    with session_factory() as session:
        job = session.get(WholeBookTranslationJobRecord, job_id)
        if not job:
            raise TrialError('lease_lost')
        if job.status == 'ready':
            return job.book_id
        owner, update_book = job.user_id, job.job_kind == 'source_update'
        if update_book:
            from app.modules.translations.overlap import require_worker_target
            try:
                require_worker_target(session, job)
            except HTTPException as error:
                raise TrialError('source_publication_conflict', conflict=error.detail) from error
        if update_book and not (job.quality_report_json or {}).get('_v2_publication_approved'):
            raise TrialError('publication_approval_required')
        if not chapters or (not finalize and update_book):
            raise TrialError('publication_conflict')
        if not update_book and (len(chapters) > job.total_chapters or (finalize and len(chapters) != job.total_chapters)):
            raise TrialError('publication_chapter_count')
        book_id = job.book_id if update_book else job.id
        old = session.get(BookRecord, book_id)
        old_assets = list(session.scalars(select(BookAssetRecord).where(BookAssetRecord.book_id == book_id)))
        old_signature = assets_signature(old_assets)
        if old and (old.owner_id != owner or old.deleted_at or old.status == 'deleted'):
            raise TrialError('publication_conflict')
        if update_book and not old:
            raise TrialError('publication_conflict')
        manual_assets, manual_documents = [], []
        if update_book:
            from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
            from app.modules.translations.source_update_projects import _manual_epub_sidecar_chapters
            manual_assets = sorted([a for a in old_assets if a.asset_type == 'text_chapter'
                and a.metadata_json.get('source') == 'manual_append'], key=lambda a: a.index or 0)
            manual_documents = _manual_epub_sidecar_chapters(book=record_to_book(old),
                asset_repository=SqlAlchemyBookAssetRepository(session), draft_chapters=chapters, settings=settings)
        # The receipt binds published prefixes to this job. Never replace an
        # unrelated book or append the same chapters twice after a worker crash.
        chapter_hashes = [digest(c) for c in chapters]
        published_count = 0
        if old and not update_book:
            receipt = (job.quality_report_json or {}).get('_publication', {})
            if not receipt.get('progressive') or job.book_id != old.id:
                raise TrialError('publication_conflict')
            published_count = receipt['chapters']
            if (sum(a.asset_type == 'text_chapter' for a in old_assets) != published_count
                    or chapter_hashes[:published_count] != receipt['chapter_hashes'][:len(chapters)]):
                raise TrialError('publication_conflict')
            if len(chapters) <= published_count:
                if finalize:
                    if len(chapters) != published_count or len(chapters) != job.total_chapters:
                        raise TrialError('publication_chapter_count')
                    conditions = [WholeBookTranslationJobRecord.id == job_id,
                                  WholeBookTranslationJobRecord.status == 'processing',
                                  WholeBookTranslationJobRecord.pause_requested.is_(False)]
                    if lease_owner:
                        conditions.append(WholeBookTranslationJobRecord.lease_owner == lease_owner)
                    if session.execute(update(WholeBookTranslationJobRecord).where(*conditions).values(
                            updated_at=datetime.now(timezone.utc))).rowcount != 1:
                        raise TrialError('lease_lost')
                    finish_publication(job, old, receipt, metadata, len(chapters))
                    session.commit()
                return book_id
        old_path = old.original_file_path if old else None
        old_updated = old.updated_at if old else None
        book = record_to_book(old) if old else create_uploaded_book(
            owner_id=owner, book_id=book_id, title=metadata.title, author=metadata.author,
            tags=tuple(metadata.tags), kind='novel', reader_type='epub', file_label='EPUB')
    old_chapter_count = sum(a.asset_type == 'text_chapter' for a in old_assets)
    added = chapters[published_count:]
    append_book = update_book or published_count > 0
    original = None
    if append_book:
        if not old_path or not old_path.lower().endswith('.epub'):
            raise TrialError('publication_requires_epub', reason='保留原书；当前增量发布仅支持 EPUB')
        original = resolve_storage_path(root, old_path).read_bytes()
        data = append_translation_epub(original_epub=original, chapters=[*manual_documents, *added])
    else:
        data = build_translation_epub(title=metadata.title, author=metadata.author,
            description=metadata.description, source_url=metadata.source_url, chapters=chapters)
    verify_epub(data, added, original)
    artifact_id = str(uuid4())
    relative = Path('translation-v2-artifacts') / owner / book_id / artifact_id / 'book.epub'
    stored = write_bytes_file(data=data, relative_path=relative, settings=settings)
    # This sidecar is addressed by the book's versioned EPUB pointer: clearing
    # task notifications cannot erase the terminology needed by future updates.
    context = {'glossary': (job.memory_json or {}).get('glossary', []), 'workflow_version': 2}
    save_json(stored.absolute_path.parent / 'translation-context.json', {'value': context, 'hash': digest(context)})
    epubcheck = {'status': 'not_configured'}
    if settings.translation_java and settings.translation_epubcheck_jar:
        checker_path = stored.absolute_path.parent / 'epubcheck.json'
        checked = subprocess.run([settings.translation_java, '-jar', settings.translation_epubcheck_jar,
            str(stored.absolute_path), '--json', str(checker_path)], capture_output=True,
            timeout=90, text=True, encoding='utf-8', errors='replace')
        counts = json.loads(checker_path.read_text(encoding='utf-8')).get('checker', {}) if checker_path.exists() else {}
        if checked.returncode != 0 or counts.get('nFatal') != 0 or counts.get('nError') != 0:
            raise TrialError('epubcheck_failed', errors=counts.get('nError'), warnings=counts.get('nWarning'))
        epubcheck = {'status': 'passed', 'errors': counts['nError'], 'warnings': counts.get('nWarning', 0)}
    elif settings.environment == 'production':
        raise TrialError('epubcheck_not_configured')
    # The processor uses book.id for paths. A fresh staging identity keeps it
    # completely away from all currently referenced reader assets.
    staged_book = book.with_changes(id=artifact_id, original_file_path=stored.relative_path,
                                  reader_type='epub', file_ext='.epub')
    processed = process_epub(staged_book, settings)
    validate_processing_result_files(processed, settings)
    texts = sorted([a for a in processed.assets if a.asset_type == 'text_chapter'], key=lambda a: a.index or 0)
    expected_count = old_chapter_count + len(added) if append_book else len(chapters)
    if len(texts) != expected_count:
        raise TrialError('publication_chapter_count', expected=expected_count, actual=len(texts))
    # Every new paragraph is checked again in the actual reader's block files.
    new_texts = texts[-len(added):]
    appended_documents = [*manual_documents, *added]
    parsed_appended = texts[-len(appended_documents):]
    for asset, chapter in zip(parsed_appended, appended_documents, strict=True):
        blocks_path = asset.metadata.get('blocks_path')
        if not blocks_path:
            raise TrialError('publication_blocks_missing')
        blocks = json.loads(resolve_storage_path(root, blocks_path).read_text(encoding='utf-8'))['blocks']
        actual = [b['text'] for b in blocks if b['type'] == 'paragraph']
        if actual != chapter['paragraphs']:
            raise TrialError('publication_reader_mismatch', chapter=chapter['index'])
    to_insert = new_texts if append_book else processed.assets
    report = {'artifact_id': artifact_id, 'epub_sha256': hashlib.sha256(data).hexdigest(),
              'chapters': expected_count, 'reader_roundtrip': 'passed', 'old_path': old_path, 'epubcheck': epubcheck}
    if not update_book:
        report.update(progressive=True, chapter_hashes=chapter_hashes)
    save_json(stored.absolute_path.parent / 'validation.json', report)
    # Files and their containing directories must outlive the DB commit.
    files = [stored.absolute_path] + [resolve_storage_path(root, a.path) for a in to_insert]
    files += [resolve_storage_path(root, a.metadata['blocks_path']) for a in to_insert if a.metadata.get('blocks_path')]
    for path in files:
        with path.open('rb+' if os.name == 'nt' else 'rb') as handle:
            os.fsync(handle.fileno())
    if os.name == 'posix':
        for parent in {path.parent for path in files}:
            fd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    guard()
    now = datetime.now(timezone.utc)
    with session_factory() as session:
        # CAS grabs the job row for this transaction and rejects a stale worker.
        if not update_book:
            from app.modules.translations.overlap import lock_source_owner, require_new_source_available
            lock_source_owner(session, owner)
            try:
                require_new_source_available(session, owner, metadata.source_url, job_id=job_id)
            except HTTPException as error:
                raise TrialError('source_publication_conflict', conflict=error.detail) from error
        conditions = [WholeBookTranslationJobRecord.id == job_id,
                      WholeBookTranslationJobRecord.status == 'processing',
                      WholeBookTranslationJobRecord.pause_requested.is_(False)]
        if lease_owner:
            conditions.append(WholeBookTranslationJobRecord.lease_owner == lease_owner)
        changed = session.execute(update(WholeBookTranslationJobRecord).where(*conditions).values(updated_at=now))
        if changed.rowcount != 1:
            raise TrialError('lease_lost')
        current_job = session.get(WholeBookTranslationJobRecord, job_id)
        if update_book:
            try:
                require_worker_target(session, current_job)
            except HTTPException as error:
                raise TrialError('source_publication_conflict', conflict=error.detail) from error
        if update_book and not (current_job.quality_report_json or {}).get('_v2_publication_approved'):
            raise TrialError('publication_approval_required')
        live = session.get(BookRecord, book_id)
        live_assets = list(session.scalars(select(BookAssetRecord).where(BookAssetRecord.book_id == book_id)))
        if old_path:
            if not live or live.deleted_at or live.owner_id != owner or live.original_file_path != old_path or live.updated_at != old_updated or assets_signature(live_assets) != old_signature:
                raise TrialError('publication_conflict')
        elif live:
            raise TrialError('publication_conflict')
        for previous, parsed in zip(manual_assets, parsed_appended[:len(manual_assets)], strict=True):
            record = session.get(BookAssetRecord, previous.id)
            record.metadata_json = {**record.metadata_json, 'source': parsed.metadata['source']}
        if not live:
            live = book_to_record(book)
            session.add(live)
            session.flush()
        for asset in to_insert:
            session.add(BookAssetRecord(id=asset.id, book_id=book_id, asset_type=asset.asset_type,
                path=asset.path, index=asset.index, metadata_json=asset.metadata, created_at=asset.created_at))
        if append_book:
            previous = filter_readable_text_assets(sorted(
                [record_to_asset(asset) for asset in live_assets if asset.asset_type == 'text_chapter'], key=lambda asset: asset.index or 0))
            current = [*previous, *new_texts]
            live.progress_percent = appended_progress_percent(live.progress_percent, previous, current)
            rebase_appended_progress(book_id, previous, current, SqlAlchemyReadingProgressRepository(session, autocommit=False))
        live.original_file_path = stored.relative_path
        live.file_size, live.file_ext, live.mime_type = stored.size, '.epub', 'application/epub+zip'
        live.reader_type, live.status, live.language = 'epub', 'ready', 'zh'
        if processed.current_chapter:
            live.current_chapter = processed.current_chapter
        live.updated_at = now
        if not update_book:
            live.description, live.source_url = metadata.description, metadata.source_url
            live.publication_status = metadata.publication_status if finalize else 'ongoing'
            live.source_episode_count, live.source_character_count = metadata.episode_count, metadata.character_count
        else:
            resolved = {c['index'] for c in chapters}
            live.source_pending_episode_indexes = [i for i in (live.source_pending_episode_indexes or []) if i not in resolved]
            live.source_update_count = len(live.source_pending_episode_indexes)
            live.source_check_error = None
        record = session.get(WholeBookTranslationJobRecord, job_id)
        record.book_id = book_id
        record.quality_report_json = {**(record.quality_report_json or {}), '_publication': report}
        if finalize:
            finish_publication(record, live, report, metadata, len(chapters))
        else:
            record.message = f'已可阅读 {len(chapters)}/{record.total_chapters} 话，后续章节继续翻译'
        session.commit()
    return book_id
