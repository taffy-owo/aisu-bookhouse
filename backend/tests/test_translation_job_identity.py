import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError

from app.modules.translations.idempotency import persist_or_reuse_job, same_open_job
from app.modules.translations.job_controls import _is_policy_rejected
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.translations import service
from test_translation_v2_production import prepare


def test_retry_detects_structured_policy_rejection_receipt():
    record = SimpleNamespace(error_message=None, quality_report_json={
        '_v2_failure': {'code': 'provider_rejected', 'stage': 'draft'},
    })
    assert _is_policy_rejected(record) is True


def test_public_view_exposes_structured_policy_rejection():
    record = SimpleNamespace(error_message=None, quality_report_json={
        '_v2_failure': {'code': 'provider_rejected', 'stage': 'draft'},
    })
    assert service._public_error_message(record) == '模型因内容政策拒绝了本次请求 [provider_rejected]'


def template(client, auth_headers, monkeypatch):
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        record = session.get(Job, job_id)
        assert record.status == 'ready', record.error_message
        return sessions, {c.name: getattr(record, c.name) for c in Job.__table__.columns}


@pytest.mark.parametrize('kind', ['whole_book', 'source_update'])
def test_simultaneous_submit_returns_one_durable_task(client, auth_headers, monkeypatch, kind):
    sessions, values = template(client, auth_headers, monkeypatch)
    values.update(job_kind=kind, status='queued', stage='queued', lease_owner=None)
    if kind == 'whole_book':
        values['book_id'] = None
    barrier = Barrier(2)
    def submit(n):
        with sessions() as session:
            identity = {key: values[key] for key in ('user_id', 'job_kind', 'source_url', 'book_id')}
            assert same_open_job(session, **identity) is None
            barrier.wait(timeout=10)  # Both requests passed the old check-then-insert guard.
            record = Job(**{**values, 'id': str(uuid4()), 'model': 'channel-model-' + str(n)})
            return persist_or_reuse_job(record, session).id
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, [1, 2]))
    assert results[0] == results[1]
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(Job).where(Job.status == 'queued')) == 1


def test_database_itself_rejects_duplicate_even_without_service_guard(client, auth_headers, monkeypatch):
    sessions, values = template(client, auth_headers, monkeypatch)
    values.update(status='paused', book_id=None)
    with sessions() as session:
        session.add(Job(**{**values, 'id': str(uuid4())}))
        session.commit()
        session.add(Job(**{**values, 'id': str(uuid4()), 'model': 'different-model'}))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


def test_retry_conflict_preserves_failed_task_and_completed_work(client, auth_headers, monkeypatch):
    sessions, values = template(client, auth_headers, monkeypatch)
    failed_id, active_id = str(uuid4()), str(uuid4())
    with sessions() as session:
        session.add_all([Job(**{**values, 'id': failed_id, 'status': 'failed', 'book_id': None}),
                         Job(**{**values, 'id': active_id, 'status': 'queued', 'book_id': None})])
        session.commit()
        with pytest.raises(HTTPException) as caught:
            service.retry_translation_job(values['user_id'], failed_id, session)
        assert caught.value.status_code == 409
        failed = session.get(Job, failed_id)
        assert failed.status == 'failed' and failed.completed_chapters == 1
        assert session.get(Job, active_id).status == 'queued'


def test_unrelated_constraints_are_not_disguised_as_deduplication(client, auth_headers, monkeypatch):
    sessions, values = template(client, auth_headers, monkeypatch)
    with sessions() as session:
        with pytest.raises(IntegrityError):
            persist_or_reuse_job(Job(**{**values, 'id': str(uuid4()), 'user_id': 'nonexistent', 'status': 'queued'}), session)
