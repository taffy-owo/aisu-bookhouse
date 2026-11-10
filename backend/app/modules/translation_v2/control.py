"""V2 task ownership, conditional pause commits, and progress reporting."""
from datetime import datetime,timezone
from sqlalchemy import update
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.translations.maintenance import translation_is_suspended
from app.modules.translation_v2.pilot import TrialError


class Control:
    def __init__(self, job_id, lease_owner, session_factory, settings):
        self.job_id, self.lease, self.sessions, self.settings = job_id, lease_owner, session_factory, settings
        self._lease_captured = lease_owner is not None
        self.position, self.total = 0, 1
        self.unit_position, self.unit_total = 0, 1

    def read(self):
        with self.sessions() as session:
            return session.get(Job, self.job_id)

    def _owned(self, job):
        if job is None:
            raise TrialError('lease_lost')
        if not self._lease_captured:
            self.lease, self._lease_captured = job.lease_owner, True
        if job.lease_owner != self.lease:
            raise TrialError('lease_lost')

    def guard(self):
        for _ in range(3):
            job = self.read()
            self._owned(job)
            if job.status == 'paused':
                raise TrialError('paused')
            if job.status != 'processing':
                raise TrialError('lease_lost')
            suspended = translation_is_suspended(self.settings, job.user_id)
            if not job.pause_requested and not suspended:
                return
            conditions = [Job.id == self.job_id, Job.user_id == job.user_id,
                Job.lease_owner == self.lease, Job.status == 'processing']
            if not suspended:
                conditions.append(Job.pause_requested.is_(True))
            with self.sessions() as session:
                result = session.execute(update(Job).where(*conditions).values(
                    status='paused', message='任务已暂停；已保留检查点', error_message=None,
                    pause_requested=False, lease_owner=None, lease_expires_at=None,
                    quality_report_json={**(job.quality_report_json or {}),
                        '_v2_failure': {'code': 'paused', 'stage': job.stage}},
                    updated_at=datetime.now(timezone.utc),
                ).execution_options(synchronize_session=False))
                if result.rowcount == 1:
                    session.commit()
                    raise TrialError('paused')
                session.rollback()
            # A cancellation or handoff won. The next read decides whether
            # this same worker may continue, rather than restoring an old pause.
        raise TrialError('lease_lost')

    def update(self, **changes):
        terminal = changes.get('status') not in {None, 'processing', 'paused'}
        if terminal:
            self.guard()
        job = self.read()
        self._owned(job)
        if job.status != 'processing':
            raise TrialError('lease_lost')
        conditions = [Job.id == self.job_id, Job.user_id == job.user_id,
            Job.lease_owner == self.lease, Job.status == 'processing']
        if terminal:
            conditions.append(Job.pause_requested.is_(False))
        if self.lease is None:
            conditions.append(Job.updated_at == job.updated_at)
        with self.sessions() as session:
            result = session.execute(update(Job).where(*conditions).values(
                **{**changes, 'updated_at': datetime.now(timezone.utc)}
            ).execution_options(synchronize_session=False))
            if result.rowcount != 1:
                session.rollback()
                # Commit a newly arrived pause, or reject an actual handoff.
                # A stale error/review/backoff must not replace that decision.
                self.guard()
                raise TrialError('lease_lost')
            session.commit()

    def report(self, stage, message):
        self.guard()
        # Stage progress is an estimate, not an invented translated word count.
        if stage in ('downloading', 'metadata', 'context'):
            if stage == 'context':
                proposed = 5 + int((self.position + self.unit_position / self.unit_total) / self.total * 5)
            else:
                proposed = {'downloading': 2, 'metadata': 4}[stage]
        elif stage == 'packaging':
            proposed = 94
        else:
            fraction = {'analysis': .05, 'draft': .18, 'edit': .48,
                        'proofread': .65, 'review': .80, 'repair': .85}.get(stage, 0)
            proposed = 10 + int((self.position + (self.unit_position + fraction) / self.unit_total) / self.total * 80)
        unit_label = f' · 分段 {self.unit_position+1}/{self.unit_total}' if self.unit_total > 1 and stage != 'packaging' else ''
        self.update(stage=stage,
                    message=f'V2 · 第 {self.position+1}/{self.total} 话{unit_label} · {message}（整话处理，通道并发上限 {self.read().request_concurrency or 1}）',
                    progress=min(94, max(self.read().progress or 0, proposed)))
