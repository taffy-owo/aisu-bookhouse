import base64
from dataclasses import replace
from hashlib import sha256
import ipaddress
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from cryptography.fernet import Fernet, InvalidToken
from app.core.config import Settings
from app.core.safe_outbound import public_https_client
from app.modules.users.domain import User


AI_MODEL_LIST_TIMEOUT_SECONDS = 12.0
MAX_PROVIDER_MODELS = 400


def apply_user_ai_models(settings: Settings, user: User) -> Settings:
    if not user.ai_provider_base_url or not user.ai_provider_api_key_encrypted:
        return settings
    return replace(
        settings,
        ai_translation_base_url=user.ai_provider_base_url,
        ai_translation_api_key=decrypt_ai_api_key(user.ai_provider_api_key_encrypted, settings),
        ai_translation_model=user.ai_translation_model or "",
    )


def apply_user_audiobook_settings(settings: Settings, user: User) -> Settings:
    if not (
        user.audiobook_provider_base_url
        and user.audiobook_provider_api_key_encrypted
        and user.audiobook_tts_model
    ):
        return settings
    return replace(
        settings,
        ai_translation_base_url=user.audiobook_provider_base_url,
        ai_translation_api_key=decrypt_ai_api_key(user.audiobook_provider_api_key_encrypted, settings),
        audiobook_tts_model=user.audiobook_tts_model,
        audiobook_tts_voice=user.audiobook_tts_voice or settings.audiobook_tts_voice,
    )


def normalize_ai_provider_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ValueError("Base URL 必须是完整的 HTTPS 地址")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Base URL 不能包含账号、查询参数或片段")
    if parsed.port not in (None, 443):
        raise ValueError("Base URL 仅允许 HTTPS 443 端口")
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        raise ValueError("Base URL 不能指向本机或内网地址")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise ValueError("Base URL 不能指向本机或内网地址")
    netloc = f"[{hostname}]" if ":" in hostname else hostname
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urlunsplit(("https", netloc, parsed.path.rstrip("/"), "", ""))


def encrypt_ai_api_key(api_key: str, settings: Settings) -> str:
    normalized = api_key.strip()
    if not normalized:
        raise ValueError("API Key 不能为空")
    return _credential_cipher(settings).encrypt(normalized.encode("utf-8")).decode("ascii")


def decrypt_ai_api_key(encrypted_api_key: str, settings: Settings) -> str:
    try:
        return _credential_cipher(settings).decrypt(encrypted_api_key.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError) as error:
        raise ValueError("保存的 AI 凭据无法读取，请重新填写 API Key") from error


def _credential_cipher(settings: Settings) -> Fernet:
    return credential_cipher(settings.encryption_key or settings.jwt_secret)


def credential_cipher(secret: str) -> Fernet:
    if len(secret) < 32:
        raise ValueError("Credential encryption secret must have at least 32 characters")
    key = base64.urlsafe_b64encode(sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


async def fetch_provider_ai_models(settings: Settings) -> list[str]:
    if not settings.ai_translation_api_key or not settings.ai_translation_base_url:
        return []

    async with public_https_client(timeout=AI_MODEL_LIST_TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{settings.ai_translation_base_url}/models",
            headers={"Authorization": f"Bearer {settings.ai_translation_api_key}"},
        )
        response.raise_for_status()
        return parse_provider_ai_models(response.json())


def parse_provider_ai_models(payload: Any) -> list[str]:
    records = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        return []

    models: list[str] = []
    for record in records:
        model_id = record.get("id") if isinstance(record, dict) else None
        if not isinstance(model_id, str):
            continue
        normalized = model_id.strip()
        if not normalized or len(normalized) > 128 or any(character.isspace() for character in normalized):
            continue
        if normalized not in models:
            models.append(normalized)
        if len(models) >= MAX_PROVIDER_MODELS:
            break
    return sorted(models, key=str.casefold)
