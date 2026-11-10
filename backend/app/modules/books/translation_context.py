"""Account-owned translation context with its own optimistic revision."""
import json

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from app.modules.agent.models import AgentProjectRecord
from app.modules.agent.schemas import Prompt
from app.modules.books.models import BookRecord, BookTranslationContextRecord


class TranslationContextState(BaseModel):
    book_id: str
    project_id: str | None = None
    revision: int
    prompt: str | None = None
    context: dict


class TranslationContextEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    expected_revision: int = Field(ge=0)
    prompt: Prompt | None = None
    context: dict

    @field_validator("context")
    @classmethod
    def bounded_context(cls, value):
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        encoded.encode("utf-8")
        if len(encoded) > 64_000:
            raise ValueError("上下文最多 64000 字符")
        return value


def translation_context_state(session, owner_id, book_id):
    book = session.get(BookRecord, book_id, populate_existing=True)
    if not book or book.owner_id != owner_id or book.status == "deleted":
        raise HTTPException(404, "Book not found")
    project = session.scalar(select(AgentProjectRecord).where(AgentProjectRecord.book_id == book_id,
        AgentProjectRecord.owner_id == owner_id, AgentProjectRecord.status == "published").order_by(AgentProjectRecord.id).limit(1))
    saved = session.get(BookTranslationContextRecord, book_id, populate_existing=True)
    return TranslationContextState(book_id=book_id, project_id=project.id if project else None,
        revision=saved.revision if saved else 0,
        prompt=saved.prompt if saved else project.prompt if project else None,
        context=saved.context_json if saved else project.context_json if project else {})


def edit_translation_context(session, owner_id, book_id, payload):
    from app.modules.books.continuation import lock_owned_book
    lock_owned_book(session, owner_id, book_id)
    current = translation_context_state(session, owner_id, book_id)
    if current.revision != payload.expected_revision:
        raise HTTPException(409, "Translation context changed; read the latest context")
    prompt = payload.prompt if "prompt" in payload.model_fields_set else current.prompt
    record = session.get(BookTranslationContextRecord, book_id)
    if not record:
        record = BookTranslationContextRecord(book_id=book_id)
        session.add(record)
    record.revision = current.revision + 1
    record.prompt = prompt
    record.context_json = payload.context
    session.commit()
    return translation_context_state(session, owner_id, book_id)
