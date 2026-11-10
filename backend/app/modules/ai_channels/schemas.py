from datetime import datetime

from pydantic import BaseModel, Field


MAX_MODEL_CONCURRENCY = 16
MAX_CHUNK_CHARACTERS = 20000
MAX_CHUNK_PARAGRAPHS = 800


class AiChannelModelPublic(BaseModel):
    id: str
    model: str
    display_name: str
    enabled: bool
    sort_order: int
    max_concurrency: int
    chunk_characters: int
    chunk_paragraphs: int
    available: bool
    unavailable_until: datetime | None
    unavailable_reason: str


class AiChannelPublic(BaseModel):
    id: str
    name: str
    base_url: str
    api_key_configured: bool
    credential_scope: str = "personal"
    is_provider_default: bool = False
    enabled: bool
    sort_order: int
    updated_at: datetime
    models: list[AiChannelModelPublic]


class AiChannelModelInput(BaseModel):
    model: str = Field(min_length=1, max_length=128)
    display_name: str | None = Field(default=None, max_length=160)
    enabled: bool = True
    max_concurrency: int = Field(default=4, ge=1, le=MAX_MODEL_CONCURRENCY)
    chunk_characters: int = Field(default=4500, ge=500, le=MAX_CHUNK_CHARACTERS)
    chunk_paragraphs: int = Field(default=220, ge=10, le=MAX_CHUNK_PARAGRAPHS)


class CreateAiChannelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(min_length=1, max_length=4096)
    enabled: bool = True
    models: list[AiChannelModelInput] = Field(default_factory=list)


class UpdateAiChannelRequest(BaseModel):
    expected_updated_at: datetime | None = None
    name: str | None = Field(default=None, min_length=1, max_length=100)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    api_key: str | None = Field(default=None, min_length=1, max_length=4096)
    enabled: bool | None = None
    sort_order: int | None = Field(default=None, ge=0, le=999)
    # Omit to leave the model list untouched; send a list to replace it wholesale.
    models: list[AiChannelModelInput] | None = None


class AiChannelProbeResult(BaseModel):
    channel_id: str
    ok: bool
    detail: str
    models: list[str]


class TranslationModelOption(BaseModel):
    """A model a translation job can actually be assigned to, across channels."""

    channel_id: str
    channel_name: str
    model: str
    display_name: str
    label: str
    max_concurrency: int
    available: bool
    unavailable_until: datetime | None
    unavailable_reason: str
    active_job_count: int
