from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.ai_credentials import is_platform_ai_credential
from app.modules.ai_channels.models import AiChannelModelRecord, AiChannelRecord
from app.modules.ai_channels.model_availability import mark_model_unavailable, clear_model_unavailable  # noqa: F401 - shared service exports
from app.modules.ai_channels.schemas import (
    AiChannelModelInput,
    AiChannelModelPublic,
    AiChannelPublic,
    TranslationModelOption,
)
from app.modules.users.ai_settings import (
    encrypt_ai_api_key,
    decrypt_ai_api_key,
    fetch_provider_ai_models,
    normalize_ai_provider_base_url,
)
from app.modules.users.repository import SqlAlchemyUserRepository


DEFAULT_CHANNEL_NAME = "默认渠道"
DEFAULT_MAX_CONCURRENCY = 4
DEFAULT_CHUNK_CHARACTERS = 4500
DEFAULT_CHUNK_PARAGRAPHS = 220
MAX_CHANNELS_PER_USER = 20
MAX_MODELS_PER_CHANNEL = 60


def list_channels(user_id: str, session: Session, settings: Settings | None = None) -> list[AiChannelPublic]:
    records = session.scalars(
        select(AiChannelRecord)
        .where(AiChannelRecord.user_id == user_id)
        .order_by(AiChannelRecord.sort_order.asc(), AiChannelRecord.created_at.asc())
    ).all()
    return [_to_public(record, session, settings) for record in records]


def get_channel(user_id: str, channel_id: str, session: Session, settings: Settings | None = None) -> AiChannelPublic | None:
    record = _owned_channel(user_id, channel_id, session)
    return _to_public(record, session, settings) if record else None


def create_channel(
    *,
    user_id: str,
    name: str,
    base_url: str,
    api_key: str,
    enabled: bool,
    models: list[AiChannelModelInput],
    session: Session,
    settings: Settings,
) -> AiChannelPublic:
    existing = session.scalar(
        select(func.count(AiChannelRecord.id)).where(AiChannelRecord.user_id == user_id)
    )
    if (existing or 0) >= MAX_CHANNELS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"最多只能保存 {MAX_CHANNELS_PER_USER} 个渠道",
        )
    now = datetime.now(timezone.utc)
    record = AiChannelRecord(
        id=str(uuid4()),
        user_id=user_id,
        name=name.strip(),
        base_url=_normalized_base_url(base_url),
        api_key_encrypted=encrypt_ai_api_key(api_key, settings),
        enabled=enabled,
        sort_order=(existing or 0),
        created_at=now,
        updated_at=now,
    )
    session.add(record)
    # No ORM relationship establishes insert ordering for these two records.
    # Persist the parent inside this transaction before inserting model rows.
    session.flush()
    _replace_models(record.id, models, session)
    session.commit()
    session.refresh(record)
    return _to_public(record, session, settings)


def update_channel(
    *,
    user_id: str,
    channel_id: str,
    name: str | None,
    base_url: str | None,
    api_key: str | None,
    enabled: bool | None,
    sort_order: int | None,
    models: list[AiChannelModelInput] | None,
    expected_updated_at: datetime | None,
    session: Session,
    settings: Settings,
) -> AiChannelPublic | None:
    record = _owned_channel(user_id, channel_id, session)
    if not record:
        return None
    if expected_updated_at is not None:
        expected = expected_updated_at.astimezone(timezone.utc) if expected_updated_at.tzinfo else expected_updated_at.replace(tzinfo=timezone.utc)
        actual = record.updated_at.astimezone(timezone.utc) if record.updated_at.tzinfo else record.updated_at.replace(tzinfo=timezone.utc)
        if expected != actual:
            raise HTTPException(status_code=409, detail="渠道已被其他页面更新，请重新读取后再保存")
    if name is not None:
        record.name = name.strip()
    if base_url is not None:
        record.base_url = _normalized_base_url(base_url)
    if api_key is not None:
        record.api_key_encrypted = encrypt_ai_api_key(api_key, settings)
    if enabled is not None:
        record.enabled = enabled
    if sort_order is not None:
        record.sort_order = sort_order
    if models is not None:
        _replace_models(record.id, models, session)
    if record.is_provider_default and (base_url is not None or api_key is not None):
        SqlAlchemyUserRepository(session).update_fields(user_id, {
            "ai_provider_base_url": record.base_url,
            "ai_provider_api_key_encrypted": record.api_key_encrypted,
            "updated_at": datetime.now(timezone.utc),
        }, commit=False)
    record.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(record)
    return _to_public(record, session, settings)


def delete_channel(user_id: str, channel_id: str, session: Session, *, commit: bool = True) -> bool | None:
    record = _owned_channel(user_id, channel_id, session)
    if not record:
        return None
    in_flight = _active_job_counts(user_id, session)
    if any(key[0] == channel_id for key in in_flight):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该渠道还有进行中的翻译任务，请先改用其它渠道或结束任务",
        )
    for model_record in _channel_models(channel_id, session):
        session.delete(model_record)
    if record.is_provider_default:
        SqlAlchemyUserRepository(session).update_fields(user_id, {
            "ai_provider_base_url": None, "ai_provider_api_key_encrypted": None,
            "ai_translation_model": None, "updated_at": datetime.now(timezone.utc),
        }, commit=False)
    session.delete(record)
    if commit:
        session.commit()
    else:
        session.flush()
    return True


async def probe_channel_models(
    *, user_id: str, channel_id: str, session: Session, settings: Settings
) -> list[str]:
    """Ask the channel which models it currently serves."""
    from app.modules.users.ai_settings import decrypt_ai_api_key

    record = _owned_channel(user_id, channel_id, session)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="渠道不存在")
    from dataclasses import replace as dataclass_replace

    probe_settings = dataclass_replace(
        settings,
        ai_translation_base_url=record.base_url,
        ai_translation_api_key=decrypt_ai_api_key(record.api_key_encrypted, settings),
    )
    return await fetch_provider_ai_models(probe_settings)


def resolve_translation_model(
    *, user_id: str, channel_id: str | None, model: str, session: Session
) -> tuple[AiChannelRecord, AiChannelModelRecord]:
    """Find the channel/model pair a job should run on, or explain why it cannot."""
    candidates = session.execute(
        select(AiChannelRecord, AiChannelModelRecord)
        .join(AiChannelModelRecord, AiChannelModelRecord.channel_id == AiChannelRecord.id)
        .where(
            AiChannelRecord.user_id == user_id,
            AiChannelModelRecord.model == model,
        )
        .order_by(AiChannelRecord.sort_order.asc(), AiChannelRecord.created_at.asc())
    ).all()
    if channel_id:
        candidates = [pair for pair in candidates if pair[0].id == channel_id]
    if not candidates:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"模型 {model} 不在任何已保存的渠道中，请先在设置里添加",
        )
    enabled = [pair for pair in candidates if pair[0].enabled and pair[1].enabled]
    if not enabled:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"模型 {model} 所在的渠道已停用",
        )
    now = datetime.now(timezone.utc)
    available = [pair for pair in enabled if _is_available(pair[1], now)]
    if not available:
        reason = next(
            (pair[1].unavailable_reason for pair in enabled if pair[1].unavailable_reason),
            "提供方暂时不可用",
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"模型 {model} 当前不可用：{reason}，请改用其他已启用模型",
        )
    return available[0]


def list_translation_model_options(user_id: str, session: Session) -> list[TranslationModelOption]:
    """Every model a new job may pick, newest availability first."""
    rows = session.execute(
        select(AiChannelRecord, AiChannelModelRecord)
        .join(AiChannelModelRecord, AiChannelModelRecord.channel_id == AiChannelRecord.id)
        .where(AiChannelRecord.user_id == user_id, AiChannelRecord.enabled.is_(True))
        .order_by(
            AiChannelRecord.sort_order.asc(),
            AiChannelRecord.created_at.asc(),
            AiChannelModelRecord.sort_order.asc(),
        )
    ).all()
    counts = _active_job_counts(user_id, session)
    now = datetime.now(timezone.utc)
    options: list[TranslationModelOption] = []
    for channel, model_record in rows:
        if not model_record.enabled:
            continue
        available = _is_available(model_record, now)
        options.append(
            TranslationModelOption(
                channel_id=channel.id,
                channel_name=channel.name,
                model=model_record.model,
                display_name=model_record.display_name or model_record.model,
                label=f"{channel.name} · {model_record.display_name or model_record.model}",
                max_concurrency=model_record.max_concurrency,
                available=available,
                unavailable_until=model_record.unavailable_until if not available else None,
                unavailable_reason=(model_record.unavailable_reason or "") if not available else "",
                active_job_count=counts.get((channel.id, model_record.model), 0),
            )
        )
    return options






def model_tuning(*, channel_id: str | None, model: str, session: Session) -> tuple[int, int, int]:
    """(max_concurrency, chunk_characters, chunk_paragraphs) for a job's model."""
    if not channel_id:
        return DEFAULT_MAX_CONCURRENCY, DEFAULT_CHUNK_CHARACTERS, DEFAULT_CHUNK_PARAGRAPHS
    query = select(AiChannelModelRecord).where(AiChannelModelRecord.model == model,
        AiChannelModelRecord.channel_id == channel_id)
    record = session.scalars(query.limit(1)).first()
    if not record:
        return DEFAULT_MAX_CONCURRENCY, DEFAULT_CHUNK_CHARACTERS, DEFAULT_CHUNK_PARAGRAPHS
    return record.max_concurrency, record.chunk_characters, record.chunk_paragraphs


def ensure_default_channel(
    *,
    user_id: str,
    base_url: str,
    api_key_encrypted: str,
    model: str,
    session: Session,
    provider_default: bool = False,
    commit: bool = True,
) -> AiChannelRecord | None:
    """Carry a legacy single-provider config into the channel tables."""
    if not base_url or not api_key_encrypted:
        return None
    query = select(AiChannelRecord).where(AiChannelRecord.user_id == user_id)
    if provider_default:
        query = query.where(AiChannelRecord.is_provider_default.is_(True))
    existing = session.scalars(query.limit(1)).first()
    if existing:
        return existing
    if (session.scalar(select(func.count(AiChannelRecord.id)).where(AiChannelRecord.user_id == user_id)) or 0) >= MAX_CHANNELS_PER_USER:
        raise HTTPException(409, f"最多保留 {MAX_CHANNELS_PER_USER} 个渠道，请先移除不再使用的渠道")
    now = datetime.now(timezone.utc)
    channel = AiChannelRecord(
        id=str(uuid4()),
        user_id=user_id,
        name=DEFAULT_CHANNEL_NAME,
        base_url=base_url,
        api_key_encrypted=api_key_encrypted,
        enabled=True,
        is_provider_default=True,
        sort_order=0,
        created_at=now,
        updated_at=now,
    )
    session.add(channel)
    # Flush before the model rows so the FK target exists; SQLite enforces
    # foreign keys and the two inserts would otherwise race on statement order.
    session.flush()
    if model:
        session.add(
            AiChannelModelRecord(
                id=str(uuid4()),
                channel_id=channel.id,
                model=model,
                display_name=None,
                enabled=True,
                sort_order=0,
                max_concurrency=DEFAULT_MAX_CONCURRENCY,
                chunk_characters=DEFAULT_CHUNK_CHARACTERS,
                chunk_paragraphs=DEFAULT_CHUNK_PARAGRAPHS,
                created_at=now,
                updated_at=now,
            )
        )
    if commit:
        session.commit()
    else:
        session.flush()
    return channel


def add_channel_model_if_missing(*, channel_id: str, model: str, session: Session, commit: bool = True) -> None:
    """Ensure a model is selectable on a channel without disturbing the rest."""
    name = model.strip()
    if not name:
        return
    existing = session.scalars(
        select(AiChannelModelRecord)
        .where(AiChannelModelRecord.channel_id == channel_id, AiChannelModelRecord.model == name)
        .limit(1)
    ).first()
    if existing:
        return
    enabled_count = session.scalar(select(func.count(AiChannelModelRecord.id)).where(
        AiChannelModelRecord.channel_id == channel_id, AiChannelModelRecord.enabled.is_(True))) or 0
    if enabled_count >= MAX_MODELS_PER_CHANNEL:
        raise HTTPException(409, f"默认渠道已启用 {MAX_MODELS_PER_CHANNEL} 个模型，请先停用不再使用的模型")
    now = datetime.now(timezone.utc)
    next_order = session.scalar(
        select(func.count(AiChannelModelRecord.id)).where(AiChannelModelRecord.channel_id == channel_id)
    )
    session.add(
        AiChannelModelRecord(
            id=str(uuid4()),
            channel_id=channel_id,
            model=name,
            display_name=None,
            enabled=True,
            sort_order=next_order or 0,
            max_concurrency=DEFAULT_MAX_CONCURRENCY,
            chunk_characters=DEFAULT_CHUNK_CHARACTERS,
            chunk_paragraphs=DEFAULT_CHUNK_PARAGRAPHS,
            created_at=now,
            updated_at=now,
        )
    )
    if commit:
        session.commit()
    else:
        session.flush()


def ensure_lane_for_user(*, user: object, session: Session) -> tuple[AiChannelRecord, AiChannelModelRecord] | None:
    """Resolve a lane, lazily adopting a legacy single-provider config.

    Users configured before channels existed still carry their provider on the
    user row. Rather than refusing their work, adopt that config as their first
    channel the moment something needs a lane.
    """
    user_id = getattr(user, "id", "")
    preferred = getattr(user, "ai_translation_model", "") or ""
    lane = default_translation_model(user_id=user_id, preferred_model=preferred, session=session)
    if lane:
        return lane
    channel = ensure_default_channel(
        user_id=user_id,
        base_url=getattr(user, "ai_provider_base_url", "") or "",
        api_key_encrypted=getattr(user, "ai_provider_api_key_encrypted", "") or "",
        model=preferred,
        session=session,
    )
    if not channel:
        return None
    return default_translation_model(user_id=user_id, preferred_model=preferred, session=session)


def default_translation_model(
    *, user_id: str, preferred_model: str | None, session: Session,
    excluded_models: set[str] | None = None,
    model_filter: Callable[[str], bool] | None = None,
    channel_id: str | None = None,
    preferred_channel_id: str | None = None,
) -> tuple[AiChannelRecord, AiChannelModelRecord] | None:
    """Pick a lane for work the user did not explicitly route (e.g. source updates).

    Prefers the saved channel/model pair, then the same model on other channels,
    then the first available model on the highest-priority channel. Returns None
    when nothing is usable so the caller can skip work that cannot run.
    """
    conditions = [
        AiChannelRecord.user_id == user_id,
        AiChannelRecord.enabled.is_(True),
        AiChannelModelRecord.enabled.is_(True),
    ]
    if channel_id:
        conditions.append(AiChannelRecord.id == channel_id)
    rows = session.execute(
        select(AiChannelRecord, AiChannelModelRecord)
        .join(AiChannelModelRecord, AiChannelModelRecord.channel_id == AiChannelRecord.id)
        .where(*conditions)
        .order_by(
            AiChannelRecord.sort_order.asc(),
            AiChannelRecord.created_at.asc(),
            AiChannelModelRecord.sort_order.asc(),
        )
    ).all()
    if not rows:
        return None
    now = datetime.now(timezone.utc)
    excluded = excluded_models or set()
    available = [pair for pair in rows if _is_available(pair[1], now)
                 and pair[1].model not in excluded
                 and (model_filter is None or model_filter(pair[1].model))]
    # An unavailable lane is a recovery hint, not a queueable fallback. The
    # caller can explain that no model is ready and retry after the channel
    # recovers; queueing a known-unavailable model only creates a guaranteed
    # failure and obscures the real provider state.
    if not available:
        return None
    if preferred_model:
        matching = [pair for pair in available if pair[1].model == preferred_model]
        if matching:
            return next((pair for pair in matching if pair[0].id == preferred_channel_id), matching[0])
    return available[0]


def _owned_channel(user_id: str, channel_id: str, session: Session) -> AiChannelRecord | None:
    record = session.get(AiChannelRecord, channel_id)
    if not record or record.user_id != user_id:
        return None
    return record


def _channel_models(channel_id: str, session: Session) -> list[AiChannelModelRecord]:
    return list(
        session.scalars(
            select(AiChannelModelRecord)
            .where(AiChannelModelRecord.channel_id == channel_id)
            .order_by(AiChannelModelRecord.sort_order.asc())
        ).all()
    )


def _replace_models(channel_id: str, models: list[AiChannelModelInput], session: Session) -> None:
    # Provider catalogs may contain hundreds of unchecked models. The limit
    # applies to enabled, unique selections, not the discovery response size.
    normalized: dict[str, AiChannelModelInput] = {}
    for item in models:
        name = item.model.strip()
        if name and name not in normalized:
            normalized[name] = item
    if sum(item.enabled for item in normalized.values()) > MAX_MODELS_PER_CHANNEL:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"单个渠道最多只能启用 {MAX_MODELS_PER_CHANNEL} 个模型",
        )
    now = datetime.now(timezone.utc)
    existing = {record.model: record for record in _channel_models(channel_id, session)}
    seen: set[str] = set()
    for position, (name, item) in enumerate(normalized.items()):
        # Remember previously configured disabled models (including tuning),
        # but don't persist every unchecked entry returned by discovery.
        if not item.enabled and name not in existing:
            continue
        seen.add(name)
        record = existing.get(name)
        if record is None:
            record = AiChannelModelRecord(
                id=str(uuid4()),
                channel_id=channel_id,
                model=name,
                created_at=now,
                updated_at=now,
            )
            session.add(record)
        record.display_name = (item.display_name or "").strip() or None
        record.enabled = item.enabled
        record.sort_order = position
        record.max_concurrency = item.max_concurrency
        record.chunk_characters = item.chunk_characters
        record.chunk_paragraphs = item.chunk_paragraphs
        record.updated_at = now
    for name, record in existing.items():
        if name not in seen:
            session.delete(record)


def _active_job_counts(user_id: str, session: Session) -> dict[tuple[str, str], int]:
    from app.modules.translations.models import WholeBookTranslationJobRecord
    from app.modules.translations.service import ACTIVE_STATUSES

    rows = session.execute(
        select(
            WholeBookTranslationJobRecord.channel_id,
            WholeBookTranslationJobRecord.model,
            func.count(WholeBookTranslationJobRecord.id),
        )
        .where(
            WholeBookTranslationJobRecord.user_id == user_id,
            WholeBookTranslationJobRecord.status.in_(ACTIVE_STATUSES),
        )
        .group_by(WholeBookTranslationJobRecord.channel_id, WholeBookTranslationJobRecord.model)
    ).all()
    return {(channel_id or "", model): count for channel_id, model, count in rows}


def _is_available(record: AiChannelModelRecord, now: datetime) -> bool:
    if record.unavailable_until is None:
        return True
    until = record.unavailable_until
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until <= now


def _normalized_base_url(value: str) -> str:
    try:
        return normalize_ai_provider_base_url(value)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


def _to_public(record: AiChannelRecord, session: Session, settings: Settings | None = None) -> AiChannelPublic:
    now = datetime.now(timezone.utc)
    return AiChannelPublic(
        id=record.id,
        name=record.name,
        base_url=record.base_url,
        api_key_configured=bool(record.api_key_encrypted),
        credential_scope=(
            "platform" if settings and record.api_key_encrypted
            and is_platform_ai_credential(decrypt_ai_api_key(record.api_key_encrypted, settings), settings)
            else "personal"
        ),
        enabled=record.enabled,
        is_provider_default=record.is_provider_default,
        sort_order=record.sort_order,
        updated_at=record.updated_at,
        models=[
            AiChannelModelPublic(
                id=model_record.id,
                model=model_record.model,
                display_name=model_record.display_name or model_record.model,
                enabled=model_record.enabled,
                sort_order=model_record.sort_order,
                max_concurrency=model_record.max_concurrency,
                chunk_characters=model_record.chunk_characters,
                chunk_paragraphs=model_record.chunk_paragraphs,
                available=_is_available(model_record, now),
                unavailable_until=model_record.unavailable_until,
                unavailable_reason=model_record.unavailable_reason or "",
            )
            for model_record in _channel_models(record.id, session)
        ],
    )


def next_quota_reset(now: datetime, *, offset_hours: int = 8) -> datetime:
    """Next local midnight for a channel that resets on a daily boundary.

    Defaults to UTC+8 because that is when the configured gateway rolls its
    daily allowance over; the value is only ever shown to the user, since the
    actual resume is driven by probing the channel.
    """
    local = now.astimezone(timezone(timedelta(hours=offset_hours)))
    next_midnight = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return next_midnight.astimezone(timezone.utc)
