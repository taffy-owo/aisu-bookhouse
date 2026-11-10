"""Database-enforced identity for unfinished translation work.

No content, model, or channel participates in this identity: changing a lane
must not create a second writer for the same pending work.
"""
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .models import WholeBookTranslationJobRecord as Job

OPEN_STATUSES = ('queued', 'processing', 'paused', 'waiting_quota', 'review')
INDEXES = {
    'uq_translation_open_work': "(user_id, source_url) WHERE job_kind = 'whole_book'",
    'uq_translation_open_update': "(user_id, book_id) WHERE job_kind = 'source_update' AND book_id IS NOT NULL",
}


def install_unique_indexes(connection):
    """Fail safely on pre-existing duplicates; never delete or merge jobs here."""
    if connection.dialect.name not in {'sqlite', 'postgresql'}:
        raise RuntimeError('Translation idempotency requires SQLite or PostgreSQL partial indexes')
    statuses = ', '.join("'" + status + "'" for status in OPEN_STATUSES)
    for name, expression in INDEXES.items():
        connection.exec_driver_sql(f'CREATE UNIQUE INDEX IF NOT EXISTS {name} '
                                  f'ON whole_book_translation_jobs {expression} AND status IN ({statuses})')


def same_open_job(session, *, user_id, job_kind, source_url, book_id):
    identity = Job.book_id == book_id if job_kind == 'source_update' else Job.source_url == source_url
    return session.scalar(select(Job).where(Job.user_id == user_id, Job.job_kind == job_kind,
                                           identity, Job.status.in_(OPEN_STATUSES)))


def is_identity_conflict(error):
    # Do not turn foreign-key/not-null/primary-key failures into silent reuse.
    diagnostic = getattr(error.orig, 'diag', None)
    if diagnostic is not None:
        return getattr(diagnostic, 'constraint_name', None) in INDEXES
    message = str(error.orig)
    return message in {
        'UNIQUE constraint failed: whole_book_translation_jobs.user_id, whole_book_translation_jobs.source_url',
        'UNIQUE constraint failed: whole_book_translation_jobs.user_id, whole_book_translation_jobs.book_id',
    }


def persist_or_reuse_job(record, session):
    identity = {key: getattr(record, key) for key in ('user_id', 'job_kind', 'source_url', 'book_id')}
    session.add(record)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        if not is_identity_conflict(error):
            raise
        winner = same_open_job(session, **identity)
        if winner is None:
            raise  # Winner changed state; no unsafe second insertion here.
        return winner
    session.refresh(record)
    return record
