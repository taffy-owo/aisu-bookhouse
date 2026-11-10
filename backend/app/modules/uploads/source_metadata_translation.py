import logging
import re
import httpx

from app.core.config import Settings
from app.modules.japanese.service import MetadataTranslationKind, translate_japanese_metadata
from app.modules.uploads.schemas import WorkSourceMetadata
from app.modules.translations.ai import ContentFilteredError, RateLimitedError, CallBudgetExhaustedError, EmptyGenerationError, ResponseTruncatedError, ProviderUnavailableError


logger = logging.getLogger(__name__)
JAPANESE_OR_CJK_PATTERN = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]")


async def translate_source_metadata(
    metadata: WorkSourceMetadata,
    settings: Settings,
    *,
    translation_preferences: str = "",
    strict: bool = False,
) -> WorkSourceMetadata:
    """Translate a work's title, description and tags.

    ``strict`` decides what a provider failure means. Browsing a source link
    should still show the work when the optional translator is down, so the
    default degrades to the original Japanese. A whole-book job must not: the
    degraded result used to be stored and reused forever, publishing the book
    with a fully Japanese title, description and tags that nothing retried.
    """
    values: list[tuple[MetadataTranslationKind, str]] = [
        ("title", metadata.title),
        ("description", metadata.description),
        *(("tag", tag) for tag in metadata.tags),
    ]
    if not any(value.strip() and JAPANESE_OR_CJK_PATTERN.search(value) for _, value in values):
        return metadata

    populated_items = [(kind, value) for kind, value in values if value.strip()]

    if not settings.ai_translation_api_key or not settings.ai_translation_base_url or not settings.ai_translation_model:
        if strict:
            raise RuntimeError("未配置可用的 AI 翻译渠道")
        return metadata.model_copy(update={"translation_status": "unavailable",
            "translation_error_code": "not_configured", "translation_error_message": "未配置完整的 AI 翻译地址、密钥和模型，请检查渠道设置"})

    try:
        result = await translate_japanese_metadata(
            populated_items,
            settings,
            translation_preferences=translation_preferences,
        )
    except Exception as error:
        # Source lookup remains useful when the optional translation provider
        # is slow or unavailable.
        logger.warning("Source metadata translation failed model=%s error_type=%s", settings.ai_translation_model, type(error).__name__)
        if strict:
            raise
        code, message = metadata_translation_error(error)
        return metadata.model_copy(update={"translation_status": "unavailable",
            "translation_error_code": code, "translation_error_message": message})

    translated_by_item = {
        item: translation
        for item, translation in zip(populated_items, result.translations, strict=True)
    }
    translated_title = translated_by_item.get(("title", metadata.title), metadata.title)
    translated_description = translated_by_item.get(("description", metadata.description), metadata.description)
    translated_tags = [translated_by_item.get(("tag", tag), tag) for tag in metadata.tags]

    translated_tags = list(dict.fromkeys(tag.strip() for tag in translated_tags if tag.strip()))
    return metadata.model_copy(
        update={
            "description": translated_description,
            "original_title": metadata.title if translated_title != metadata.title else None,
            "tags": translated_tags,
            "title": translated_title,
            "translation_status": "translated",
            "translation_error_code": None,
            "translation_error_message": None,
        }
    )


def metadata_translation_error(error: Exception) -> tuple[str, str]:
    """Stable, safe UI diagnostics: never expose raw upstream bodies or keys."""
    if isinstance(error, ContentFilteredError):
        return 'refused', '已尝试同渠道的其他 Gemini 模型，但 AI 提供方仍拒绝处理本次资料'
    if isinstance(error, CallBudgetExhaustedError) or (isinstance(error, RateLimitedError) and error.quota_exhausted):
        return 'quota_exhausted', 'AI 渠道额度已用尽，请等待额度恢复'
    if isinstance(error, RateLimitedError):
        return 'rate_limited', 'AI 渠道触发速率限制，请稍后重试'
    if isinstance(error, httpx.HTTPStatusError):
        if error.response.status_code in {401, 403}:
            return 'authentication', 'AI 渠道认证或访问权限失败，请检查密钥及模型权限'
        if error.response.status_code == 429:
            return 'rate_limited', 'AI 渠道返回限流错误（429），请检查额度或稍后重试'
        return 'provider_error', f'AI 渠道请求失败（HTTP {error.response.status_code}）'
    if isinstance(error, httpx.TimeoutException):
        return 'timeout', 'AI 渠道响应超时，请稍后重试'
    if isinstance(error, httpx.TransportError):
        return 'connection', '无法连接 AI 渠道，请检查网络和接口地址'
    if isinstance(error, (EmptyGenerationError, ResponseTruncatedError, ValueError)):
        return 'invalid_response', 'AI 渠道返回的资料翻译格式不完整或无效'
    if isinstance(error, ProviderUnavailableError):
        if isinstance(error.__cause__, (httpx.TimeoutException, httpx.TransportError)):
            return metadata_translation_error(error.__cause__)
        return 'provider_unavailable', 'AI 渠道连接或响应异常，短时重试未成功'
    return 'translation_failed', '资料翻译失败，请检查服务日志；原作资料已读取'
