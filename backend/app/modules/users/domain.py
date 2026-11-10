from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

UserRole = Literal["admin", "user"]
UserStatus = Literal["active", "disabled"]


@dataclass(frozen=True)
class User:
    id: str
    account_number: int | None
    email: str
    password_hash: str
    nickname: str
    role: UserRole
    status: UserStatus
    created_at: datetime
    updated_at: datetime
    avatar: str | None = None
    ai_provider_base_url: str | None = None
    ai_provider_api_key_encrypted: str | None = None
    ai_translation_model: str | None = None
    ai_translation_prompt: str | None = None
    ai_translation_concurrency: int = 2
    audiobook_provider_base_url: str | None = None
    audiobook_provider_api_key_encrypted: str | None = None
    audiobook_tts_model: str | None = None
    audiobook_tts_voice: str | None = None


@dataclass(frozen=True)
class UserSummary:
    """Non-sensitive user fields used by administrative listings."""

    id: str
    account_number: int | None
    email: str
    nickname: str
    role: UserRole
    status: UserStatus
    created_at: datetime
    updated_at: datetime
    avatar: str | None = None


def create_user(
    *,
    email: str,
    id: str,
    nickname: str,
    password_hash: str,
    account_number: int | None = None,
    role: UserRole = "user",
    status: UserStatus = "active",
    avatar: str | None = None,
    ai_provider_base_url: str | None = None,
    ai_provider_api_key_encrypted: str | None = None,
    ai_translation_model: str | None = None,
    ai_translation_prompt: str | None = None,
    ai_translation_concurrency: int = 2,
    audiobook_provider_base_url: str | None = None,
    audiobook_provider_api_key_encrypted: str | None = None,
    audiobook_tts_model: str | None = None,
    audiobook_tts_voice: str | None = None,
) -> User:
    now = datetime.now(timezone.utc)
    return User(
        id=id,
        account_number=account_number,
        email=email,
        password_hash=password_hash,
        nickname=nickname,
        role=role,
        status=status,
        created_at=now,
        updated_at=now,
        avatar=avatar,
        ai_provider_base_url=ai_provider_base_url,
        ai_provider_api_key_encrypted=ai_provider_api_key_encrypted,
        ai_translation_model=ai_translation_model,
        ai_translation_prompt=ai_translation_prompt,
        ai_translation_concurrency=ai_translation_concurrency,
        audiobook_provider_base_url=audiobook_provider_base_url,
        audiobook_provider_api_key_encrypted=audiobook_provider_api_key_encrypted,
        audiobook_tts_model=audiobook_tts_model,
        audiobook_tts_voice=audiobook_tts_voice,
    )
