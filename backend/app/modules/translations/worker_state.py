"""Conditional worker writes and pause decisions for the current task owner."""
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
import logging

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.modules.translations.models import WholeBookTranslationJobRecord as Job

SessionFactory = Callable[[], Session]


def update_job(job_id: str, sessions: SessionFactory, expected_owner: str | None,
    lease_duration: timedelta, logger: logging.Logger, changes: Mapping[str, object],
) -> bool:
    with sessions() as session:
        record = session.get(Job, job_id)
        if record is None:
            return False
        if expected_owner is not None and record.lease_owner != expected_owner:
            logger.warning('Translation job %s lease changed; ignoring stale worker update', job_id)
            return False
        owner = expected_owner if expected_owner is not None else record.lease_owner
        now = datetime.now(timezone.utc)
        values = {**changes, 'updated_at': now}
        if changes.get('lease_owner', record.lease_owner) and changes.get('status', record.status) == 'processing':
            values['lease_expires_at'] = now + lease_duration
        conditions = [Job.id == job_id, Job.user_id == record.user_id,
            Job.lease_owner == owner, Job.status == record.status]
        if changes.get('status') in {'queued', 'waiting_quota'}:
            # Deferring a failed provider call must not override a pause that
            # arrived after the worker's checkpoint read.
            if record.status == 'paused' or record.pause_requested:
                return False
            conditions.append(Job.pause_requested.is_(False))
        # A caller without an explicit lease may only change the exact snapshot
        # it read. Owned writes remain valid across that owner's heartbeats.
        if expected_owner is None:
            conditions.append(Job.updated_at == record.updated_at)
        result = session.execute(update(Job).where(*conditions).values(**values)
            .execution_options(synchronize_session=False))
        if result.rowcount != 1:
            session.rollback()
            logger.warning('Translation job %s state changed; ignoring stale worker update', job_id)
            return False
        session.commit()
        return True


def check_pause(job_id: str, sessions: SessionFactory, expected_owner: str | None,
    read_job: Callable[[str, SessionFactory], Job | None],
    paused: type[Exception], lease_lost: type[Exception],
) -> None:
    owner = expected_owner
    owner_captured = expected_owner is not None
    for _ in range(3):
        record = read_job(job_id, sessions)
        if record is None:
            raise lease_lost
        if not owner_captured:
            owner = record.lease_owner
            owner_captured = True
        if record.lease_owner != owner:
            raise lease_lost
        if expected_owner is not None and record.status != 'processing':
            raise lease_lost
        if record.status == 'paused':
            raise paused
        if not record.pause_requested:
            return
        conditions = [Job.id == job_id, Job.user_id == record.user_id,
            Job.lease_owner == owner, Job.status == record.status, Job.pause_requested.is_(True)]
        if expected_owner is None:
            conditions.append(Job.updated_at == record.updated_at)
        with sessions() as session:
            result = session.execute(update(Job).where(*conditions).values(
                status='paused', stage='paused', pause_requested=False,
                message=f'已暂停，将从第 {record.completed_chapters + 1} 话继续',
                current_chapter_index=None, lease_owner=None, lease_expires_at=None,
                updated_at=datetime.now(timezone.utc),
            ).execution_options(synchronize_session=False))
            if result.rowcount == 1:
                session.commit()
                raise paused
            session.rollback()
        # A cancellation or handoff can win after the read. Re-evaluate the
        # current request rather than announcing a pause that was not committed.
    raise lease_lost
