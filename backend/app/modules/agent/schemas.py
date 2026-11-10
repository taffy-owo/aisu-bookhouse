import json
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.modules.uploads.schemas import WorkSourceMetadata


DEFAULT_PROMPT = "将原文翻译成自然、准确的简体中文，保留段落顺序、含义和人物称呼的一致性。只在译文中放入正文。"
def xml_text(value: str) -> str:
    if any(not (c in "\t\n\r" or 0x20 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF) for c in value):
        raise ValueError("文本含不能写入 EPUB 的控制字符或无效 Unicode")
    return value


NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100_000), AfterValidator(xml_text)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255), AfterValidator(xml_text)]
Hash = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]


def prompt_text(value: str) -> str:
    xml_text(value)
    if not value.strip():
        raise ValueError("提示词不能为空白")
    return value


Prompt = Annotated[str, StringConstraints(min_length=1, max_length=20_000), AfterValidator(prompt_text)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ProjectCreate(StrictModel):
    request_id: UUID
    source_url: str = Field(min_length=1, max_length=1000)
    prompt: Prompt | None = None


class ProjectEdit(StrictModel):
    expected_revision: int = Field(ge=0)
    title: Title | None = None
    author: Title | None = None
    description: Annotated[str, AfterValidator(xml_text)] | None = Field(default=None, max_length=5000)
    tags: list[Title] | None = Field(default=None, max_length=64)
    prompt: Prompt | None = None
    context: dict | None = None

    @field_validator("context")
    @classmethod
    def bounded_context(cls, value):
        if value is not None:
            encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
            encoded.encode("utf-8")
            if len(encoded) > 64_000:
                raise ValueError("上下文最多 64000 字符")
        return value


class TranslationSubmit(StrictModel):
    source_hash: Hash
    title: Title
    paragraphs: list[NonEmptyText] = Field(min_length=1, max_length=10_000)
    expected_translation_hash: Hash | None = None

    @field_validator("paragraphs")
    @classmethod
    def bounded_text(cls, value):
        if sum(map(len, value)) > 1_000_000:
            raise ValueError("单章译文最多 1000000 字符")
        return value


class ChapterProgress(BaseModel):
    index: int
    source_hash: str
    translation_hash: str | None


class ProjectPublic(BaseModel):
    id: str
    status: Literal["draft", "paused", "published"]
    revision: int
    metadata: WorkSourceMetadata
    prompt: str
    context: dict
    chapters: list[ChapterProgress]
    book_id: str | None
    created_at: datetime
    updated_at: datetime


class ProjectSummary(BaseModel):
    id: str
    status: Literal["draft", "paused", "published"]
    title: str
    source_url: str
    book_id: str | None
    created_at: datetime
    updated_at: datetime


class ChapterPublic(BaseModel):
    index: int
    source: dict
    source_hash: str
    translation: dict | None
    translation_hash: str | None


class ProjectToken(BaseModel):
    token: str
    expires_at: datetime


class VerificationResult(BaseModel):
    verified: bool
    book_id: str | None
    book_path: str | None
    expected_chapters: int
    actual_chapters: int
    issues: list[str]


class PublicationMetadata(BaseModel):
    title: str
    author: str
    description: str
    source_url: str
    tags: list[str] = Field(default_factory=list)


class PublicationCheck(BaseModel):
    project_id: str
    revision: int
    metadata_digest: str
    metadata: PublicationMetadata
    expected_chapters: int
    translated_chapters: int
    ready: bool
    issues: list[str]
    notices: list[str]
    context_saved: bool


class PublishRequest(StrictModel):
    expected_revision: int = Field(ge=0)
    metadata_digest: Hash
