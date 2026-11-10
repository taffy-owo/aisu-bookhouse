import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


MODEL_NAME_PATTERN = re.compile(r"^[^\s\x00-\x1f\x7f]{1,128}$")


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    account_number: int | None = None
    email: str
    nickname: str
    role: str
    status: str
    avatar: str | None = None


class AiModelSettingsPublic(BaseModel):
    api_key_configured: bool
    audiobook_api_key_configured: bool
    audiobook_provider_base_url: str
    audiobook_tts_model: str
    audiobook_tts_voice: str
    provider_base_url: str
    translation_model: str
    translation_secondary_model: str
    translation_prompt: str
    translation_concurrency: int = Field(ge=1, le=4)


class AiModelSettingsUpdate(BaseModel):
    api_key: str | None = Field(default=None, max_length=4096)
    audiobook_api_key: str | None = Field(default=None, max_length=4096)
    audiobook_provider_base_url: str | None = Field(default=None, max_length=500)
    audiobook_tts_model: str | None = Field(default=None, max_length=128)
    audiobook_tts_voice: str | None = Field(default=None, max_length=128)
    clear_api_key: bool = False
    clear_audiobook_api_key: bool = False
    provider_base_url: str | None = Field(default=None, max_length=500)
    translation_model: str | None = Field(default=None, max_length=128)
    translation_prompt: str | None = Field(default=None, max_length=6000)
    translation_concurrency: int | None = Field(default=None, ge=1, le=4)

    @field_validator("audiobook_tts_model", "audiobook_tts_voice", "translation_model")
    @classmethod
    def validate_model_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if not MODEL_NAME_PATTERN.fullmatch(normalized):
            raise ValueError("Model name contains unsupported characters")
        return normalized

    @field_validator("api_key", "audiobook_api_key")
    @classmethod
    def normalize_api_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("translation_prompt")
    @classmethod
    def normalize_translation_prompt(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class AiModelListRequest(BaseModel):
    api_key: str | None = Field(default=None, max_length=4096)
    credential_scope: Literal["translation", "audiobook"] = "translation"
    provider_base_url: str = Field(max_length=500)

    @field_validator("api_key")
    @classmethod
    def normalize_api_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class AiModelListPublic(BaseModel):
    available: bool
    models: list[str] = Field(default_factory=list)
