"""Availability belongs to one channel and its current provider credentials."""
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.modules.ai_channels.models import AiChannelModelRecord, AiChannelRecord


@dataclass(frozen=True)
class ProviderLaneSnapshot:
    user_id: str
    base_url: str
    api_key_encrypted: str = field(repr=False)


@dataclass(frozen=True)
class AvailabilityVersion:
    model_id: str
    revision: int
    unavailable: bool


def read_model_availability_version(*, channel_id: str | None, model: str, session: Session,
    provider: ProviderLaneSnapshot, guard: ColumnElement[bool],
) -> AvailabilityVersion | None:
    if not channel_id:
        return None
    row = session.execute(select(AiChannelModelRecord.id, AiChannelModelRecord.availability_revision,
        AiChannelModelRecord.unavailable_until, AiChannelModelRecord.unavailable_reason)
        .where(*_model_conditions(channel_id, model, provider, guard))).first()
    if row is None:
        return None
    return AvailabilityVersion(row[0], row[1], row[2] is not None or bool(row[3]))


def _version_condition(versions: tuple[AvailabilityVersion, ...]):
    return or_(*(and_(AiChannelModelRecord.id == version.model_id,
        AiChannelModelRecord.availability_revision == version.revision) for version in versions))


def _model_conditions(channel_id: str, model: str, provider: ProviderLaneSnapshot | None,
    guard: ColumnElement[bool] | None,
) -> list:
    conditions = [AiChannelModelRecord.channel_id == channel_id, AiChannelModelRecord.model == model]
    if provider is not None:
        # Evaluate the provider snapshot in the write itself. A settings change
        # between reading a job and updating this model must also invalidate it.
        current_lane = select(AiChannelRecord.id).where(
            AiChannelRecord.id == channel_id,
            AiChannelRecord.user_id == provider.user_id,
            AiChannelRecord.base_url == provider.base_url,
            AiChannelRecord.api_key_encrypted == provider.api_key_encrypted,
        )
        conditions.append(AiChannelModelRecord.channel_id.in_(current_lane))
    if guard is not None:
        conditions.append(guard)
    return conditions


def mark_model_unavailable(*, channel_id: str | None, model: str, until: datetime,
    reason: str, session: Session, provider: ProviderLaneSnapshot | None = None,
    guard: ColumnElement[bool] | None = None,
    expected_version: AvailabilityVersion | None = None,
) -> None:
    # A legacy job with no channel has no authority to change any saved lane.
    if not channel_id:
        return
    conditions = _model_conditions(channel_id, model, provider, guard)
    if expected_version is not None:
        conditions.append(_version_condition((expected_version,)))
    session.execute(update(AiChannelModelRecord).where(*conditions)
        .values(unavailable_until=until, unavailable_reason=reason[:200], updated_at=datetime.now(timezone.utc),
            availability_revision=AiChannelModelRecord.availability_revision + 1)
        .execution_options(synchronize_session='fetch'))
    session.commit()


def clear_model_unavailable(*, channel_id: str | None, model: str, session: Session,
    provider: ProviderLaneSnapshot | None = None,
    guard: ColumnElement[bool] | None = None,
    expected_versions: tuple[AvailabilityVersion, ...] | None = None,
) -> None:
    if not channel_id:
        return
    if expected_versions == ():
        return
    conditions = _model_conditions(channel_id, model, provider, guard)
    if expected_versions is not None:
        conditions.append(_version_condition(expected_versions))
    session.execute(update(AiChannelModelRecord).where(*conditions,
        or_(AiChannelModelRecord.unavailable_until.is_not(None), AiChannelModelRecord.unavailable_reason != ''))
        .values(unavailable_until=None, unavailable_reason=None, updated_at=datetime.now(timezone.utc),
            availability_revision=AiChannelModelRecord.availability_revision + 1)
        .execution_options(synchronize_session='fetch'))
    session.commit()
