"""Model health is a secondary effect of confirmed task and provider evidence."""
import logging

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.modules.ai_channels.model_availability import ProviderLaneSnapshot, read_model_availability_version
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.translations.provider_observations import current_provider_probe

logger = logging.getLogger(__name__)


def job_model_availability_guard(job: Job, *, status: str | None = None):
    return select(Job.id).where(Job.id == job.id, Job.user_id == job.user_id,
        Job.status == (status or job.status), Job.lease_owner == job.lease_owner,
        Job.model == job.model, Job.channel_id == job.channel_id).exists()


def _provider(job: Job) -> ProviderLaneSnapshot:
    return ProviderLaneSnapshot(job.user_id, job.provider_base_url, job.provider_api_key_encrypted)


def capture_job_model_availability(job: Job, sessions):
    if not job.channel_id:
        return None
    try:
        with sessions() as session:
            return read_model_availability_version(channel_id=job.channel_id, model=job.model, session=session,
                provider=_provider(job), guard=job_model_availability_guard(job, status='processing'))
    except SQLAlchemyError:
        logger.warning('Could not observe model availability for task %s; retaining existing state', job.id)
        return None


def mark_job_model_unavailable(job: Job, until, sessions, mark, *, expected_version=None):
    if not until or not job.channel_id:
        return
    try:
        with sessions() as session:
            mark(channel_id=job.channel_id, model=job.model, until=until,
                reason='额度可能已用尽，正在自动探测', session=session, provider=_provider(job),
                guard=job_model_availability_guard(job), expected_version=expected_version)
    except SQLAlchemyError:
        # The task's backoff was already committed. A secondary indicator cannot
        # revoke that decision or discard its recoverable checkpoints.
        logger.warning('Model availability update deferred for task %s; task state remains confirmed', job.id)


def clear_job_model_unavailable(job: Job, sessions, clear):
    probe = current_provider_probe.get()
    versions = probe.take_versions() if probe is not None else None
    if versions == () or not job.channel_id:
        return
    try:
        with sessions() as session:
            clear(channel_id=job.channel_id, model=job.model, session=session, provider=_provider(job),
                guard=job_model_availability_guard(job), expected_versions=versions)
    except SQLAlchemyError:
        logger.warning('Model availability recovery deferred for task %s; task state remains confirmed', job.id)
