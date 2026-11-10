"""Recover V2 task state even when private diagnostic files cannot be saved."""
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path

from app.core.storage import get_storage_root
from app.modules.ai_channels.model_availability import ProviderLaneSnapshot, mark_model_unavailable
from app.modules.translations.model_health import job_model_availability_guard
from sqlalchemy.exc import SQLAlchemyError
from .pilot import TrialError
from .runtime import error_message, retry_delay, MAX_INPUT_RETRIES

logger = logging.getLogger(__name__)


def _save_failure(root, details, control, save):
    try:
        save(root / 'failure.json', details)
    except OSError as error:
        logger.warning('Could not save V2 diagnostic for task %s (%s); continuing task recovery',
            control.job_id, type(error).__name__)


def recover_failure(error, *, root, control, settings, save):
    if isinstance(error, TrialError):
        _recover_trial(error, root, control, save)
    else:
        _recover_execution(error, root, control, settings, save)


def _recover_trial(error, root, control, save):
    if error.code == 'lease_lost':
        return
    message = error_message(error)
    job = control.read()
    _mark_stale_model_unavailable(error, job, control)
    _save_failure(root, {'code': error.code, 'details': error.details,
        'stage': job.stage if job else None}, control, save)
    try:
        if error.code != 'paused':
            control.guard()
        if error.code in {'rate_or_quota_limited', 'channel_cooling_down', 'platform_budget_exhausted'}:
            now = datetime.now(timezone.utc)
            reset_at = None
            if error.code == 'platform_budget_exhausted':
                local_day = now + timedelta(hours=8)
                reset_at = (local_day.replace(hour=0, minute=0, second=0, microsecond=0)
                            + timedelta(days=1, hours=-8))
                delay = max(30, int((reset_at - now).total_seconds()))
            else:
                delay = max(30, int(error.details.get('retry_after_seconds') or 30))
            control.update(status='waiting_quota',
                message=(f'{message}；额度重置后重试，已完成章节不会重译' if reset_at else
                         f'{message}；{delay} 秒后探测，已完成章节不会重译'), error_message=None,
                lease_owner='v2-backoff', lease_expires_at=now + timedelta(seconds=delay),
                quota_resume_at=reset_at, acknowledged=False)
            return
        delay = retry_delay(error, root)
        if delay is not None:
            control.update(status='queued',
                message=f'{message}；{delay} 秒后从检查点重试（同一输入最多 {MAX_INPUT_RETRIES} 次）', error_message=None,
                lease_owner='v2-backoff', lease_expires_at=datetime.now(timezone.utc) + timedelta(seconds=delay),
                quota_resume_at=None, acknowledged=False)
            return
        job = control.read()
        control.update(status='paused' if error.code == 'paused' else 'failed',
            message=message + '；已保留检查点', error_message=None if error.code == 'paused' else message,
            pause_requested=False, lease_owner=None, lease_expires_at=None,
            quality_report_json={**((job.quality_report_json or {}) if job else {}),
                '_v2_failure': {'code': error.code, 'stage': job.stage if job else None}})
    except TrialError:
        # A committed pause or newer owner determines the authoritative state.
        pass


def _mark_stale_model_unavailable(error: TrialError, job, control) -> None:
    """Remember explicit provider responses that mean a model alias is gone."""
    if error.code != 'http_error' or error.details.get('http_status') not in {404, 410}:
        return
    if not job or not job.channel_id:
        return
    try:
        with control.sessions() as session:
            mark_model_unavailable(
                channel_id=job.channel_id,
                model=job.model,
                until=datetime.now(timezone.utc) + timedelta(hours=6),
                reason=f"提供方返回 HTTP {error.details['http_status']}，模型可能已下线",
                session=session,
                provider=ProviderLaneSnapshot(job.user_id, job.provider_base_url, job.provider_api_key_encrypted),
                guard=job_model_availability_guard(job),
            )
    except SQLAlchemyError:
        # The checkpoint and task state remain authoritative if this secondary
        # availability hint cannot be written.
        logger.warning('Could not mark stale V2 model unavailable for task %s', control.job_id)


def _recover_execution(error, root, control, settings, save):
    job = control.read()
    details = {'code': 'execution_error', 'error_type': type(error).__name__,
               'stage': job.stage if job else None}
    message = f'V2 execution_error: {type(error).__name__}'
    if isinstance(error, OSError):
        details['errno'] = error.errno
        if error.filename:
            try:
                relative = Path(error.filename).resolve().relative_to(get_storage_root(settings))
            except ValueError:
                pass  # Keep arbitrary server paths and exception text private.
            else:
                details['storage_path'] = relative.as_posix()
        if isinstance(error, PermissionError):
            message = '存储文件权限不足，请检查文件属主与服务账号 [PermissionError]'
            if details.get('storage_path'):
                message += ' · ' + details['storage_path']
    _save_failure(root, details, control, save)
    try:
        control.update(status='failed', message=f'V2 执行失败 [{type(error).__name__}]；已保留原书和检查点',
                       error_message=message, lease_owner=None, lease_expires_at=None)
    except TrialError:
        pass
