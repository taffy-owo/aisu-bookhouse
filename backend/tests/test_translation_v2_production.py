import asyncio
from dataclasses import replace
import json
from pathlib import Path

import pytest
from sqlalchemy import select

from app.modules.translation_v2 import runner, publication
from app.modules.translation_v2.pilot import TrialError, digest
from app.modules.translation_v2.context import ContextPlan, merge_terms, group_blocks
from app.modules.translations import service
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.translations.source_text import SourceChapter
from app.modules.books.models import BookRecord
from app.modules.book_assets.models import BookAssetRecord
from test_whole_book_translation import configure_translation_provider, make_source_metadata


class FakeStageClient:
    whole_chapter = True
    direct_translation = True
    calls = []
    fail_stage = None

    def __init__(self, endpoint, key, model, root, *, guard, report, **kwargs):
        self.root, self.events, self.guard, self.report = root, [], guard, report

    async def call(self, stage, payload, schema):
        self.guard()
        self.report(stage, '阶段测试')
        self.calls.append(stage)
        if stage == self.fail_stage:
            raise TrialError('truncated_output')
        self.events.append({'stage': stage})
        blocks = payload.get('source_blocks', [])
        if stage == 'metadata':
            data = {'title': '测试译本', 'author': '原作者', 'description': '', 'tags': ['百合']}
        elif stage == 'context':
            data = {'checked_block_ids': [b['block_id'] for b in blocks], 'terms': [],
                    'summary': '她笑了，我点头。', 'voice_notes': [], 'uncertainties': []}
        elif stage == 'analysis':
            data = {'blocks': [{'block_id': b['block_id'], 'speaker': None, 'implied_subject': None,
                               'facts': [], 'uncertainties': []} for b in blocks]}
        elif stage == 'draft':
            data = {'blocks': [{'block_id': b['block_id'], 'segments': [{'text':
                {'第一話': '第一话', '彼女は笑った。': '她笑了。', '私は頷いた。': '我点了点头。'}[b['text']],
                'break_after': 'none'}]} for b in blocks]}
        elif stage in ('edit', 'proofread'):
            data = payload['candidate']
        elif stage == 'repair':
            data = {'patches': []}
        else:
            data = {'checked_block_ids': [b['block_id'] for b in blocks], 'findings': []}
        return schema.model_validate(data)


def prepare(client, auth_headers, monkeypatch):
    configure_translation_provider(client, auth_headers)
    async def metadata(*args, **kwargs):
        return make_source_metadata()
    async def source(episode, provider, **kwargs):
        return SourceChapter(index=episode.index, title=episode.title,
                             paragraphs=['彼女は笑った。', '私は頷いた。'], url=episode.url)
    monkeypatch.setattr(service, 'fetch_work_source_metadata', metadata)
    monkeypatch.setattr(runner, 'fetch_source_chapter', source)
    monkeypatch.setattr(runner, 'StageClient', FakeStageClient)
    FakeStageClient.calls, FakeStageClient.fail_stage = [], None
    response = client.post('/api/v1/translations', headers=auth_headers, json={
        'source_url': make_source_metadata().source_url, 'model': 'literary-model'})
    assert response.status_code == 202
    job_id = response.json()['id']
    sessions = client.app.state.db_session_factory
    assert service.claim_next_translation_job(sessions, 'v2-test-lease') == job_id
    return job_id, sessions, replace(client.app.state.settings, translation_engine='v2')


def test_visible_task_to_verified_book(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    assert client.get('/api/v1/translations', headers=auth_headers).json()[0]['status'] == 'processing'
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    jobs = client.get('/api/v1/translations', headers=auth_headers).json()
    assert jobs[0]['status'] == 'ready', jobs[0]
    assert jobs[0]['completed_chapters'] == 1
    assert jobs[0]['quality_status'] == 'passed'
    with sessions() as session:
        book = session.get(BookRecord, job_id)
        assert book.status == 'ready'
        assert book.current_chapter == '第一话'
        assert Path(settings.storage_root, book.original_file_path).is_file()
        assets = list(session.scalars(select(BookAssetRecord).where(BookAssetRecord.book_id == book.id)))
        chapter = next(a for a in assets if a.asset_type == 'text_chapter')
        blocks = json.loads(Path(settings.storage_root, chapter.metadata_json['blocks_path']).read_text(encoding='utf-8'))
        assert [b['text'] for b in blocks['blocks'] if b['type'] == 'paragraph'] == ['她笑了。', '我点了点头。']
    assert FakeStageClient.calls == ['metadata', 'context', 'draft', 'review']


def test_stage_failure_has_real_error_and_does_not_publish(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    FakeStageClient.fail_stage = 'review'
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        job = session.get(Job, job_id)
        assert job.status == 'failed'
        assert 'truncated_output' in job.error_message
        assert job.stage == 'review'
        assert job.completed_chapters == 0
        assert session.get(BookRecord, job_id) is None


@pytest.mark.parametrize('internal', [True, False])
def test_permission_failure_identifies_storage_without_leaking_external_paths(client, auth_headers, monkeypatch, internal):
    import errno
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    denied = (Path(settings.storage_root) / 'translation-v2-artifacts/book/translation-context.json'
              if internal else Path(settings.storage_root).parent / 'private-key.txt')
    async def unreadable(*args, **kwargs):
        raise PermissionError(errno.EACCES, 'sensitive exception text', str(denied))
    monkeypatch.setattr(runner, 'fetch_source_chapter', unreadable)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        job = session.get(Job, job_id)
        assert job.status == 'failed' and job.completed_chapters == 0
        assert '文件属主' in job.error_message
        assert session.get(BookRecord, job_id) is None
        failure = json.loads((Path(settings.storage_root) / 'translation-v2' / job.user_id / job.id / 'failure.json').read_text())
        assert failure['stage'] == 'downloading' and failure['errno'] == errno.EACCES
        assert ('storage_path' in failure) == internal
        assert 'sensitive exception text' not in json.dumps(failure) + job.error_message
        assert 'private-key.txt' not in json.dumps(failure) + job.error_message


def test_stale_worker_cannot_publish(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    def change_lease(*args, **kwargs):
        with sessions() as session:
            job = session.get(Job, job_id)
            job.lease_owner = 'new-lease'
            session.commit()
        return original(*args, **kwargs)
    original = publication.verify_epub
    monkeypatch.setattr(publication, 'verify_epub', change_lease)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        assert session.get(BookRecord, job_id) is None
        assert session.get(Job, job_id).lease_owner == 'new-lease'


def test_maintenance_reason_does_not_claim_translated(tmp_path):
    from types import SimpleNamespace
    from app.core.config import Settings
    marker = tmp_path / 'translation-maintenance' / 'account.json'
    marker.parent.mkdir()
    marker.write_text('{}')
    result = service.source_update_translation_unavailable_reason(book=SimpleNamespace(owner_id='account'),
        settings=Settings(storage_root=str(tmp_path)), session=None)
    assert '停用' in result and '已经翻译' not in result


def test_context_conflict_is_not_silent_renaming():
    from app.modules.translation_v2.pilot import SourceBlock
    source = [SourceBlock(block_id='p1', text='シルヴィアは帰った。')]
    plan = ContextPlan(checked_block_ids=['p1'], terms=[{'source': 'シルヴィア', 'target': '希尔维娅',
        'evidence_block_id': 'p1', 'evidence_quote': source[0].text, 'note': ''}], summary='', voice_notes=[], uncertainties=[])
    with pytest.raises(TrialError, match='term_conflict'):
        merge_terms([{'source': 'シルヴィア', 'target': '西尔维娅'}], plan, source)


def test_source_tamper_not_accepted(tmp_path):
    path = tmp_path / 'source.json'
    runner.snapshot(path, {'text': '原文'})
    with pytest.raises(TrialError, match='source_changed'):
        runner.snapshot(path, {'text': '改写'})
    value = json.loads(path.read_text(encoding='utf-8'))
    value['value']['text'] = '坏数据'
    path.write_text(json.dumps(value), encoding='utf-8')
    with pytest.raises(TrialError, match='source_snapshot_corrupt'):
        runner.read_snapshot(path)


@pytest.mark.parametrize('automatic', [True, False])
def test_append_keeps_original_file_and_existing_reader_ids(client, auth_headers, monkeypatch, automatic):
    from uuid import uuid4
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        original_job = session.get(Job, job_id)
        book = session.get(BookRecord, job_id)
        old_path = book.original_file_path
        old_bytes = Path(settings.storage_root, old_path).read_bytes()
        context_path = Path(settings.storage_root, old_path).parent / 'translation-context.json'
        assert runner.read_snapshot(context_path)['glossary'] == []
        retained_terms = [{'source': '未登场姓名', 'target': '固定译名', 'evidence_block_id': 'old:p1',
                           'evidence_quote': '未登场姓名', 'note': ''}]
        context_value = {'glossary': retained_terms, 'workflow_version': 2}
        runner.save_json(context_path, {'value': context_value, 'hash': digest(context_value)})
        old_ids = list(session.scalars(select(BookAssetRecord.id).where(BookAssetRecord.book_id == job_id)))
        values = {c.name: getattr(original_job, c.name) for c in Job.__table__.columns}
        update_id = str(uuid4())
        metadata = make_source_metadata().model_dump(mode='json')
        metadata['episodes'][0]['index'] = 2
        metadata['episodes'][0]['url'] += '2'
        values.update(id=update_id, job_kind='source_update', book_id=job_id, status='processing', stage='queued',
            metadata_json=metadata, catalog_json=metadata['episodes'], quality_report_json={}, memory_json={},
            progress=0, completed_chapters=0, lease_owner='update-lease', finished_at=None)
        session.add(Job(**values))
        session.delete(original_job)  # Cleared task history must not erase book terminology.
        book.source_pending_episode_indexes = [2]
        book.source_update_count = 1
        book.auto_translate_updates = automatic
        session.commit()
    asyncio.run(service.process_translation_job(job_id=update_id, settings=settings,
        session_factory=sessions, lease_owner='update-lease'))
    with sessions() as session:
        job = session.get(Job, update_id)
        assert job.status == 'review' and not job.acknowledged
        assert session.get(BookRecord, job_id).original_file_path == old_path
        assert Path(settings.storage_root, old_path).read_bytes() == old_bytes
        review = service.get_source_update_translation_review(job.user_id, update_id, session, settings)
        assert len(review.chapters) == 1 and review.chapters[0].index == 2
        assert review.chapters[0].content == '她笑了。\n\n我点了点头。'
        from fastapi import HTTPException
        with pytest.raises(HTTPException, match='确认接受'):
            service.accept_source_update_translation(job.user_id, update_id, session, settings, automatic=True)
    notifications = client.get('/api/v1/translations/notifications', headers=auth_headers).json()
    assert any(j['id'] == update_id and j['status'] == 'review' for j in notifications['items'])
    with pytest.raises(TrialError, match='publication_approval_required'):
        publication.publish(job_id=update_id, lease_owner=None, chapters=[], metadata=None,
            settings=settings, session_factory=sessions, guard=lambda: None)
    with sessions() as session:
        job = session.get(Job, update_id)
        accepted = service.accept_source_update_translation(job.user_id, update_id, session, settings)
        assert accepted.status == 'queued'
    assert service.claim_next_translation_job(sessions, 'accept-lease') == update_id
    FakeStageClient.calls = []
    asyncio.run(service.process_translation_job(job_id=update_id, settings=settings,
        session_factory=sessions, lease_owner='accept-lease'))
    assert FakeStageClient.calls == []
    with sessions() as session:
        job = session.get(Job, update_id)
        assert job.status == 'ready', job.error_message
        book = session.get(BookRecord, job_id)
        assert book.original_file_path != old_path
        persisted = runner.read_snapshot(Path(settings.storage_root, book.original_file_path).parent / 'translation-context.json')
        assert persisted['glossary'] == retained_terms
        assert Path(settings.storage_root, old_path).read_bytes() == old_bytes
        assert all(session.get(BookAssetRecord, asset_id) is not None for asset_id in old_ids)
        assert book.source_update_count == 0
        chapters = list(session.scalars(select(BookAssetRecord).where(BookAssetRecord.book_id == job_id,
                                                BookAssetRecord.asset_type == 'text_chapter')))
        assert sorted(c.index for c in chapters) == [1, 2]


def test_failed_publication_resume_keeps_completed_chapter(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    original = runner.publish
    monkeypatch.setattr(runner, 'publish', lambda **kwargs: (_ for _ in ()).throw(TrialError('publication_conflict')))
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        job = session.get(Job, job_id)
        assert job.status == 'failed' and job.completed_chapters == 1
        job.status, job.lease_owner = 'processing', 'new-lease'
        session.commit()
    FakeStageClient.calls = []
    monkeypatch.setattr(runner, 'publish', original)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='new-lease'))
    assert FakeStageClient.calls == ['metadata']  # Real metadata client also restores its checkpoint.
    with sessions() as session:
        assert session.get(Job, job_id).status == 'ready'


def test_first_chapter_readable_during_second_failure_and_resume_appends(client, auth_headers, monkeypatch):
    from datetime import datetime, timezone
    from app.modules.reading_progress.models import ReadingProgressRecord
    from app.modules.books.source_updates import find_next_due_source_book
    from app.modules.books.mappers import record_to_book
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    metadata = make_source_metadata()
    metadata = metadata.model_copy(update={'episode_count': 2, 'episodes': [metadata.episodes[0],
        metadata.episodes[0].model_copy(update={'index': 2, 'url': metadata.episodes[0].url + '2'})]})
    with sessions() as session:
        job = session.get(Job, job_id)
        job.total_chapters = 2
        job.metadata_json = metadata.model_dump(mode='json')
        job.catalog_json = job.metadata_json['episodes']
        session.commit()
    original_ids, old_path = [], []
    class FailSecond(FakeStageClient):
        async def call(self, stage, payload, schema):
            if stage == 'draft' and payload['source_blocks'][0]['block_id'].startswith('c2:'):
                with sessions() as session:
                    job = session.get(Job, job_id)
                    book = session.get(BookRecord, job_id)
                    assert job.status == 'processing' and job.completed_chapters == 1 and job.book_id == book.id
                    assert book.status == 'ready' and book.publication_status == 'ongoing'
                    assets = list(session.scalars(select(BookAssetRecord).where(BookAssetRecord.book_id == book.id)))
                    assert sum(a.asset_type == 'text_chapter' for a in assets) == 1
                    original_ids.extend((a.id, a.path, a.metadata_json) for a in assets)
                    old_path.append(book.original_file_path)
                    session.add(ReadingProgressRecord(user_id=job.user_id, book_id=book.id,
                        reader_type='epub', chapter_index=1, progress_percent=35, epub_cfi='saved-position',
                        updated_at=datetime.now(timezone.utc)))
                    session.commit()
                raise TrialError('truncated_output')
            return await super().call(stage, payload, schema)
    monkeypatch.setattr(runner, 'StageClient', FailSecond)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        job = session.get(Job, job_id)
        assert job.status == 'failed' and job.completed_chapters == 1, job.error_message
        book = record_to_book(session.get(BookRecord, job_id))
        assert '整本翻译尚未完成' in service.source_update_translation_unavailable_reason(book=book, session=session, settings=settings)
        existing = service.queue_source_update_translation(book=book, metadata=metadata,
            previous_episode_count=1, settings=settings, session=session)
        assert existing.id == job.id
        job.status, job.lease_owner = 'processing', 'resume-lease'
        session.commit()
    assert find_next_due_source_book(sessions, now=datetime.now(timezone.utc)) is None
    assert client.get(f'/api/v1/books/{job_id}/reader/chapters/1', headers=auth_headers).status_code == 200
    assert client.get(f'/api/v1/books/{job_id}/reader/chapters/2', headers=auth_headers).status_code == 404
    monkeypatch.setattr(runner, 'StageClient', FakeStageClient)
    FakeStageClient.calls = []
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='resume-lease'))
    assert FakeStageClient.calls == ['metadata', 'draft', 'review']
    with sessions() as session:
        job = session.get(Job, job_id)
        assert job.status == 'ready' and job.completed_chapters == 2, job.error_message
        book = session.get(BookRecord, job_id)
        assert book.publication_status == 'completed' and book.original_file_path != old_path[0]
        for asset_id, path, metadata_json in original_ids:
            asset = session.get(BookAssetRecord, asset_id)
            assert (asset.path, asset.metadata_json) == (path, metadata_json)
        progress = session.scalar(select(ReadingProgressRecord).where(ReadingProgressRecord.book_id == job_id))
        assert (progress.chapter_index, progress.epub_cfi) == (1, 'saved-position')
        assert 0 < progress.progress_percent < 35
        assets = list(session.scalars(select(BookAssetRecord).where(BookAssetRecord.book_id == job_id,
            BookAssetRecord.asset_type == 'text_chapter')))
        assert sorted(a.index for a in assets) == [1, 2]
    assert client.get(f'/api/v1/books/{job_id}/reader/chapters/2', headers=auth_headers).status_code == 200


def test_progressive_receipt_rejects_changed_prefix_and_repeated_publish_is_noop(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    metadata = make_source_metadata()
    chapter = {'index': 1, 'title': '第一话', 'paragraphs': ['她笑了。'], 'source_url': metadata.episodes[0].url}
    kwargs = dict(job_id=job_id, lease_owner='v2-test-lease', chapters=[chapter], metadata=metadata,
        settings=settings, session_factory=sessions, guard=lambda: None, finalize=False)
    publication.publish(**kwargs)
    with sessions() as session:
        path = session.get(BookRecord, job_id).original_file_path
    publication.publish(**kwargs)
    with sessions() as session:
        assert session.get(BookRecord, job_id).original_file_path == path
        assert session.get(Job, job_id).status == 'processing'
    with pytest.raises(TrialError, match='publication_conflict'):
        publication.publish(**{**kwargs, 'chapters': [{**chapter, 'paragraphs': ['被改动了。']}]})
    publication.publish(**{**kwargs, 'finalize': True})
    with sessions() as session:
        assert session.get(Job, job_id).status == 'ready'
        assert session.get(BookRecord, job_id).original_file_path == path


def test_stage_progress_is_monotonic_and_public_concurrency_is_real(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    control = runner.Control(job_id, 'v2-test-lease', sessions, settings)
    control.update(quality_report_json={'_workflow_version': 2}, request_concurrency=8)
    progress = []
    for stage in ['analysis', 'draft', 'edit', 'proofread', 'review', 'repair', 'review', 'packaging']:
        control.report(stage, stage)
        progress.append(control.read().progress)
    assert progress == sorted(progress) and len(set(progress)) > 4 and progress[-1] == 94
    with sessions() as session:
        public = service.to_public(session.get(Job, job_id))
        assert public.request_concurrency == public.max_concurrency == 8


def test_retry_budget_is_bounded_and_never_retries_rejection(tmp_path):
    from app.modules.translation_v2.runtime import retry_delay
    error = TrialError('empty_response', fingerprint='sample')
    assert [retry_delay(error, tmp_path) for _ in range(6)] == [30, 60, 90, 120, 150, None]
    assert retry_delay(TrialError('provider_rejected', fingerprint='other'), tmp_path) is None


def test_v2_concurrency_setting_is_not_silently_clamped_to_one(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    control = runner.Control(job_id, 'v2-test-lease', sessions, settings)
    control.update(quality_report_json={'_workflow_version': 2})
    with sessions() as session:
        job = session.get(Job, job_id)
        public = service.update_translation_job_concurrency(job.user_id, job_id, 4, session)
        assert public.request_concurrency == 4 and public.max_concurrency >= 4
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    assert control.read().request_concurrency == 4


def test_rollout_pause_preserves_automatic_book_preferences(client):
    from app.modules.books.source_updates import _queue_detected_source_update_translation
    settings = replace(client.app.state.settings, translation_auto_updates_enabled=False)
    assert _queue_detected_source_update_translation(book=None, chapters=[], covered_indexes=set(),
        metadata=None, previous_episode_count=0, asset_repository=None, session=None, settings=settings) is None


def test_multi_unit_progress_does_not_jump_to_end_on_first_unit(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    control = runner.Control(job_id, 'v2-test-lease', sessions, settings)
    control.unit_total = 2
    control.report('review', 'review')
    first = control.read().progress
    control.unit_position = 1
    control.report('analysis', 'analysis')
    second = control.read().progress
    assert first < second < 90
    assert '分段 2/2' in control.read().message


def test_rate_limit_waits_without_discarding_checkpoints(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    class RateLimitedClient(FakeStageClient):
        async def call(self, stage, payload, schema):
            if stage == 'draft':
                raise TrialError('rate_or_quota_limited', retry_after_seconds=120)
            return await super().call(stage, payload, schema)
    monkeypatch.setattr(runner, 'StageClient', RateLimitedClient)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        job = session.get(Job, job_id)
        assert job.status == 'waiting_quota' and job.error_message is None
        assert job.lease_owner == 'v2-backoff' and '120 秒' in job.message
        assert job.quota_resume_at is None  # No invented provider daily reset time.
    assert service.claim_next_translation_job(sessions, 'too-early') is None
