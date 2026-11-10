"""Resolve metadata translation from the same saved channel catalog as jobs."""
from dataclasses import replace
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.modules.ai_channels.models import AiChannelRecord, AiChannelModelRecord
from app.modules.users.ai_settings import apply_user_ai_models, decrypt_ai_api_key
from app.modules.users.domain import User
from app.modules.translations.ai import is_gemini_model
from app.modules.translations.maintenance import MAINTENANCE_MESSAGE, translation_is_suspended


class MetadataProviderConfigurationError(RuntimeError):
    def __init__(self, message: str, code: str = 'no_available_model'):
        super().__init__(message)
        self.code = code


def metadata_translation_settings(settings: Settings, user: User, session: Session) -> tuple[Settings, str]:
    """Return the preferred saved lane plus up to two same-channel fallbacks.

    Saved channels are authoritative, but a retired, temporarily unhealthy, or
    policy-refusing model should not make the whole metadata/reader path fail
    when the same CPA channel has other enabled Gemini lanes. The transport
    advances through those lanes and keeps the refusal terminal only when all
    available lanes reject the request.
    """
    candidates = metadata_translation_candidates(settings, user, session)
    return candidates[0]


def metadata_translation_candidates(settings: Settings, user: User, session: Session) -> list[tuple[Settings, str]]:
    if translation_is_suspended(settings, user.id):
        raise MetadataProviderConfigurationError(MAINTENANCE_MESSAGE, 'translation_maintenance')
    channels = session.scalars(select(AiChannelRecord).where(AiChannelRecord.user_id == user.id)
        .order_by(AiChannelRecord.sort_order, AiChannelRecord.created_at, AiChannelRecord.id)).all()
    if not channels:
        try:
            return [(apply_user_ai_models(settings, user), '默认渠道')]
        except ValueError as error:
            raise MetadataProviderConfigurationError('保存的 AI 密钥无法读取，请重新保存渠道密钥', 'invalid_credentials') from error
    now = datetime.now(timezone.utc)
    for channel in channels:
        if not channel.enabled:
            continue
        models = session.scalars(select(AiChannelModelRecord).where(
            AiChannelModelRecord.channel_id == channel.id, AiChannelModelRecord.enabled.is_(True))
            .order_by(AiChannelModelRecord.sort_order, AiChannelModelRecord.created_at, AiChannelModelRecord.id)).all()
        available_models = [
            model for model in models
            if is_gemini_model(model.model)
            if not model.unavailable_until
            or (model.unavailable_until if model.unavailable_until.tzinfo else model.unavailable_until.replace(tzinfo=timezone.utc)) <= now
        ]
        if not available_models:
            continue
        try:
            key = decrypt_ai_api_key(channel.api_key_encrypted, settings)
        except ValueError as error:
            raise MetadataProviderConfigurationError('保存的 AI 密钥无法读取，请重新保存渠道密钥', 'invalid_credentials') from error
        primary, *fallbacks = available_models
        effective = replace(settings,
            ai_translation_base_url=channel.base_url,
            ai_translation_api_key=key,
            ai_translation_model=primary.model,
            ai_translation_secondary_model=fallbacks[0].model if fallbacks else '',
            ai_translation_rescue_model=fallbacks[1].model if len(fallbacks) > 1 else '',
            ai_translation_daily_call_budget=0,
            ai_translation_secondary_daily_call_budget=0,
            ai_translation_rescue_daily_call_budget=0,
            ai_translation_max_concurrency=primary.max_concurrency)
        return [(effective, channel.name)]
    # Saved channels are authoritative. Never resurrect a deleted/disabled
    # legacy provider or try another provider after a request is rejected.
    raise MetadataProviderConfigurationError('已保存渠道中没有已启用且当前可用的模型，请检查渠道设置或额度状态')
