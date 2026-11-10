"""User controls that cannot overwrite a worker's newer task state."""
from collections.abc import Callable, Mapping
import logging
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.core.database_revisions import datetime_revision_matches

from app.modules.translations.idempotency import is_identity_conflict
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.translations.schemas import WholeBookTranslationJobPublic
from app.modules.translations.ai import is_gemini_model
from app.modules.ai_channels.service import default_translation_model

PublicView = Callable[[Job, Session], WholeBookTranslationJobPublic]
Changes = Callable[[Job], dict[str, object]]
logger = logging.getLogger(__name__)


def _change_job(user_id: str, job_id: str, session: Session, changes: Changes,
    public_view: PublicView, *, retry_identity: bool = False, touch_empty: bool = True,
) -> WholeBookTranslationJobPublic | None:
    for attempt in range(3):
        record = session.get(Job, job_id, populate_existing=attempt > 0)
        if record is None or record.user_id != user_id:
            return None
        # Do not dirty the ORM object before this conditional write. A flush of
        # the old snapshot would defeat the guard and could release a new lease.
        condition = _snapshot_condition(record, session.get_bind().dialect.name)
        requested_changes = changes(record)
        values = {**requested_changes, 'updated_at': datetime.now(timezone.utc)
            if requested_changes or touch_empty else record.updated_at}
        try:
            result = session.execute(update(Job).where(*condition).values(**values)
                .execution_options(synchronize_session=False))
            if result.rowcount != 1:
                # Release the old transaction and identity-map snapshot before
                # deciding what this action means for the latest worker state.
                session.rollback()
                continue
            session.commit()
        except IntegrityError as error:
            session.rollback()
            if retry_identity and is_identity_conflict(error):
                raise HTTPException(status_code=409,
                    detail='同一作品已有未完成任务，请继续现有任务；本任务检查点已保留') from error
            raise
        # Another request can delete the task after our commit as well. A fresh
        # lookup returns absence; refresh() would raise an unhandled error.
        current = session.get(Job, job_id, populate_existing=True)
        return public_view(current, session) if current is not None and current.user_id == user_id else None
    raise HTTPException(status_code=409, detail='翻译任务状态正在变化，请刷新后重试')


def retry(user_id: str, job_id: str, session: Session, public_view: PublicView) -> WholeBookTranslationJobPublic | None:
    def changes(record: Job) -> dict[str, object]:
        if record.status not in {'failed', 'waiting_quota'}:
            raise HTTPException(status_code=409, detail='只有失败或等待额度的翻译任务可以重试')
        from app.modules.translations.overlap import require_worker_target
        require_worker_target(session, record)
        values: dict[str, object] = {
            'status': 'queued', 'stage': 'queued', 'message': f'从第 {record.completed_chapters + 1} 话继续',
            'error_message': None,
            'quality_report_json': {key: value for key, value in (record.quality_report_json or {}).items()
                if key not in {'_failure', '_provider_failure', '_v2_failure'}},
            'acknowledged': False, 'retry_count': record.retry_count + 1,
            'provider_failure_streak': 0, 'quota_resume_at': None,
            'lease_owner': None, 'lease_expires_at': None, 'finished_at': None, 'pause_requested': False,
        }
        # A saved job may outlive a model that was removed from its channel.
        # Re-resolve the lane on explicit retry so a stale 410/404 model does
        # not get queued forever while completed checkpoints remain reusable.
        rejected_content = _is_policy_rejected(record)
        lane = default_translation_model(
            user_id=user_id,
            preferred_model=None if rejected_content else record.model,
            excluded_models={record.model} if rejected_content else None,
            model_filter=is_gemini_model if rejected_content else None,
            channel_id=record.channel_id if rejected_content else None,
            preferred_channel_id=record.channel_id,
            session=session,
        )
        if lane is None:
            detail = ('当前没有可用的翻译模型，请先在渠道设置中恢复一个 Gemini 模型' if rejected_content
                else '当前没有可用的翻译模型，请先在渠道设置中启用或恢复模型')
            raise HTTPException(status_code=422, detail=detail)
        channel, model = lane
        if channel.id != record.channel_id or model.model != record.model:
            values.update(
                model=model.model,
                channel_id=channel.id,
                provider_base_url=channel.base_url,
                provider_api_key_encrypted=channel.api_key_encrypted,
                request_concurrency=min(record.request_concurrency, model.max_concurrency),
            )
            if rejected_content:
                values['message'] = f'已切换到 {channel.name} · {model.display_name or model.model}，从第 {record.completed_chapters + 1} 话继续'
        return values
    return _change_job(user_id, job_id, session, changes, public_view, retry_identity=True)


def _is_policy_rejected(record: Job) -> bool:
    """Recognize both legacy text errors and structured v2 failure receipts."""
    error_text = (record.error_message or '').lower()
    if 'provider_rejected' in error_text or 'prohibited_content' in error_text or 'content_filtered' in error_text:
        return True
    report = record.quality_report_json if isinstance(record.quality_report_json, Mapping) else {}
    for key in ('_failure', '_provider_failure', '_v2_failure'):
        failure = report.get(key)
        if isinstance(failure, Mapping):
            details = ' '.join(str(value).lower() for value in failure.values())
            if any(marker in details for marker in ('provider_rejected', 'prohibited_content', 'content_filtered')):
                return True
    return False


def pause(user_id: str, job_id: str, session: Session, public_view: PublicView) -> WholeBookTranslationJobPublic | None:
    def changes(record: Job) -> dict[str, object]:
        if record.status in {'queued', 'waiting_quota'}:
            return {'status': 'paused', 'stage': 'paused',
                'message': f'已暂停，将从第 {record.completed_chapters + 1} 话继续',
                'pause_requested': False, 'lease_owner': None, 'lease_expires_at': None}
        if record.status == 'processing':
            return {'pause_requested': True, 'message': '暂停请求已提交，已完成的进度会保留'}
        if record.status == 'paused':
            return {}
        raise HTTPException(status_code=409, detail='当前翻译任务不能暂停')
    return _change_job(user_id, job_id, session, changes, public_view)


def resume(user_id: str, job_id: str, session: Session, public_view: PublicView) -> WholeBookTranslationJobPublic | None:
    def changes(record: Job) -> dict[str, object]:
        from app.modules.translations.overlap import require_worker_target
        require_worker_target(session, record)
        if record.status == 'processing' and record.pause_requested:
            return {'pause_requested': False,
                'message': f'继续精翻第 {record.current_chapter_index or record.completed_chapters + 1} 话'}
        if record.status in {'paused', 'waiting_quota'}:
            return {'status': 'queued', 'stage': 'queued', 'pause_requested': False,
                'message': f'从第 {record.completed_chapters + 1} 话继续，等待后台处理',
                'error_message': None, 'provider_failure_streak': 0, 'quota_resume_at': None,
                'lease_owner': None, 'lease_expires_at': None, 'finished_at': None}
        raise HTTPException(status_code=409, detail='当前翻译任务不需要继续')
    return _change_job(user_id, job_id, session, changes, public_view)


def set_concurrency(user_id: str, job_id: str, requested: int, session: Session,
    public_view: PublicView, model_tuning: Callable[..., tuple[int, int, int]],
) -> WholeBookTranslationJobPublic | None:
    def changes(record: Job) -> dict[str, object]:
        if record.status in {'ready', 'completed'}:
            raise HTTPException(status_code=409, detail='已完成的翻译任务不需要调整并发')
        limit, _, _ = model_tuning(channel_id=record.channel_id, model=record.model, session=session)
        concurrency = max(1, min(limit, requested))
        values: dict[str, object] = {'request_concurrency': concurrency}
        if record.status == 'processing':
            values['message'] = f'并发已调整为 {concurrency}，下一话开始生效'
        elif record.status == 'paused':
            values['message'] = f'已暂停；继续后使用并发 {concurrency}'
        return values
    return _change_job(user_id, job_id, session, changes, public_view)


def _snapshot_condition(record: Job, dialect_name: str) -> tuple:
    return (
        Job.id == record.id, Job.user_id == record.user_id,
        datetime_revision_matches(Job.updated_at, record.updated_at, dialect_name), Job.status == record.status,
        Job.lease_owner == record.lease_owner, Job.pause_requested == record.pause_requested,
        Job.model == record.model, Job.channel_id == record.channel_id,
        Job.request_concurrency == record.request_concurrency, Job.retry_count == record.retry_count,
    )


def set_model(user_id: str, job_id: str, model: str, channel_id: str | None,
    session: Session, public_view: PublicView, resolve_model: Callable,
    allowed_statuses: set[str],
) -> WholeBookTranslationJobPublic | None:
    def changes(record: Job) -> dict[str, object]:
        if record.status not in allowed_statuses:
            raise HTTPException(status_code=409, detail='请先暂停任务，暂停后才能更换渠道或模型')
        channel, channel_model = resolve_model(user_id=user_id, channel_id=channel_id, model=model, session=session)
        if channel_model.model == record.model and channel.id == record.channel_id:
            return {}
        values: dict[str, object] = {
            'model': channel_model.model, 'channel_id': channel.id,
            'provider_base_url': channel.base_url, 'provider_api_key_encrypted': channel.api_key_encrypted,
            'request_concurrency': max(1, min(channel_model.max_concurrency, record.request_concurrency)),
            'provider_failure_streak': 0, 'quota_resume_at': None, 'error_message': None,
            'quality_report_json': {key: value for key, value in (record.quality_report_json or {}).items()
                if key not in {'_failure', '_provider_failure', '_v2_failure'}},
            'lease_owner': None, 'lease_expires_at': None,
            'message': f'已改用 {channel.name} · {channel_model.display_name or channel_model.model}，继续后从第 {record.completed_chapters + 1} 话开始',
        }
        if record.status == 'waiting_quota':
            values.update(status='queued', stage='queued')
        return values
    return _change_job(user_id, job_id, session, changes, public_view, touch_empty=False)


def _cleanup_removed(user_id: str, job_id: str, cleanup: Callable[[str, str], None]) -> None:
    try:
        cleanup(user_id, job_id)
    except OSError:
        # The row is already removed. Untracked scratch files are safe for the
        # existing worker-start orphan cleanup; an I/O failure cannot revive it.
        logger.warning('Deferred translation task scratch cleanup for %s', job_id, exc_info=True)


def remove(user_id: str, job_id: str, session: Session,
    cleanup: Callable[[str, str], None],
) -> bool | None:
    allowed={'paused', 'waiting_quota', 'review', 'ready', 'completed', 'rejected', 'failed'}
    for attempt in range(3):
        record=session.get(Job, job_id, populate_existing=attempt > 0)
        if record is None or record.user_id != user_id:
            return None
        if record.status not in allowed:
            raise HTTPException(status_code=409, detail='请先暂停任务；正在运行的任务不能直接删除')
        try:
            result=session.execute(delete(Job).where(*_snapshot_condition(record, session.get_bind().dialect.name))
                .execution_options(synchronize_session=False))
            if result.rowcount != 1:
                session.rollback()
                continue
            session.commit()
        except Exception:
            session.rollback()
            raise
        if record in session:
            session.expunge(record)
        _cleanup_removed(user_id, job_id, cleanup)
        return True
    raise HTTPException(status_code=409, detail='翻译任务状态正在变化，请刷新后重试')


def clear_finished(user_id: str, session: Session,
    cleanup: Callable[[str, str], None],
) -> int:
    records=session.scalars(select(Job).where(Job.user_id == user_id,
        Job.status.in_({'ready', 'completed', 'rejected', 'failed'}))).all()
    removed=[]
    try:
        for record in records:
            result=session.execute(delete(Job).where(*_snapshot_condition(record, session.get_bind().dialect.name))
                .execution_options(synchronize_session=False))
            if result.rowcount == 1:
                removed.append((record, record.user_id, record.id))
        session.commit()
    except Exception:
        session.rollback()
        raise
    deleted_ids={job_id for _,_,job_id in removed}
    for record in records:
        if record not in session:
            continue
        if record.id in deleted_ids:
            session.expunge(record)
        else:
            session.expire(record)
    for _,owner,job_id in removed:
        _cleanup_removed(owner, job_id, cleanup)
    return len(removed)
