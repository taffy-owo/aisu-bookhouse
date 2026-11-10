"""Load channel display data once per job page, rather than once per job."""
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.ai_channels.models import AiChannelModelRecord, AiChannelRecord
from app.modules.ai_channels.service import DEFAULT_MAX_CONCURRENCY
from app.modules.translations.models import WholeBookTranslationJobRecord


def job_channel_views(records: Sequence[WholeBookTranslationJobRecord], session: Session) -> dict[str, tuple[str, int]]:
    if not records:
        return {}
    channel_ids = {record.channel_id for record in records if record.channel_id}
    channels = dict(session.execute(select(AiChannelRecord.id, AiChannelRecord.name)
                                    .where(AiChannelRecord.id.in_(channel_ids))).all()) if channel_ids else {}
    models = session.execute(select(AiChannelModelRecord.channel_id, AiChannelModelRecord.model,
                                    AiChannelModelRecord.max_concurrency)
                             .where(AiChannelModelRecord.channel_id.in_(channel_ids),
                                    AiChannelModelRecord.model.in_({record.model for record in records}))).all() if channel_ids else []
    tuning = {(channel_id, model): limit for channel_id, model, limit in models}
    return {record.id: (channels.get(record.channel_id, ''),
                        tuning.get((record.channel_id, record.model), DEFAULT_MAX_CONCURRENCY))
            for record in records}
