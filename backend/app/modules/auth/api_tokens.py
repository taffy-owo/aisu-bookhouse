from datetime import datetime, timedelta, timezone
import secrets
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, Request, Header
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, get_db_session
from app.modules.auth.api_token_service import TOKEN_PREFIX, PERMISSION_ROUTES, token_digest, utc
from app.modules.auth.models import ApiTokenRecord
from app.modules.users.domain import User

router = APIRouter(tags=["api-credentials"])


class ApiCapabilities(BaseModel):
    credential_type: Literal["personal_api", "account_session"]
    permissions: list[str]
    book_id: str | None
    expires_at: datetime | None
    workflows: list[str]


@router.get("/api-capabilities", response_model=ApiCapabilities)
def capabilities(response: Response, request: Request, authorization: str | None = Header(default=None),
    user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    response.headers["Cache-Control"] = "no-store"
    token = authorization.split(" ", 1)[1].strip()
    personal = token.startswith(TOKEN_PREFIX)
    record = session.scalar(select(ApiTokenRecord).where(ApiTokenRecord.token_hash == token_digest(token))) if personal else None
    permissions = record.permissions if personal else list(PERMISSION_ROUTES)
    workflows = []
    if "book_import" in permissions:
        workflows.extend(["epub_import", "chapter_project"])
    if "book_read" in permissions:
        workflows.extend(["book_read", "publication_verification", "translation_source_export"])
    if "book_append" in permissions and "book_read" in permissions:
        workflows.extend(["book_continuation", "translation_context_update"])
    if "book_manage" in permissions:
        workflows.extend(["library_management", "translation_maintenance", "book_reprocess", "external_translation_reconciliation"])
    if "book_delete" in permissions:
        workflows.extend(["book_deletion", "original_replacement"])
    if "book_share" in permissions:
        workflows.append("public_share_request")
    return ApiCapabilities(credential_type="personal_api" if personal else "account_session", permissions=permissions,
        book_id=record.book_id if personal else None, expires_at=utc(record.expires_at) if personal else None, workflows=workflows)


class TokenCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    expires_days: Literal[7, 30, 90] = 30
    permissions: list[Literal["book_import", "book_read", "book_append", "book_manage", "book_delete", "book_share"]] = Field(default_factory=lambda: ["book_import"], min_length=1, max_length=6)
    book_id: UUID | None = None

    @model_validator(mode="after")
    def validate_permissions(self):
        if len(set(self.permissions)) != len(self.permissions):
            raise ValueError("权限不得重复")
        if "book_append" in self.permissions and "book_read" not in self.permissions:
            raise ValueError("追加章节需要同时授予书籍读取权限")
        if any(p in self.permissions for p in ("book_manage", "book_delete", "book_share")) and "book_read" not in self.permissions:
            raise ValueError("管理、删除或分享书籍需要同时授予书籍读取权限")
        if self.book_id and "book_import" in self.permissions:
            raise ValueError("限定书籍的凭据不能授予新书导入权限")
        return self

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("凭据名称不能为空")
        return value.strip()


class TokenPublic(BaseModel):
    id: str
    name: str
    token_prefix: str
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    scope: Literal["book_import", "custom"] = "book_import"
    permissions: list[str]
    book_id: str | None


class TokenIssued(TokenPublic):
    token: str


def public(record: ApiTokenRecord) -> TokenPublic:
    return TokenPublic(id=record.id, name=record.name, token_prefix=record.token_prefix,
        created_at=utc(record.created_at), expires_at=utc(record.expires_at),
        revoked_at=utc(record.revoked_at) if record.revoked_at else None,
        permissions=record.permissions, book_id=record.book_id,
        scope="book_import" if record.permissions == ["book_import"] else "custom")


@router.get("/api-tokens", response_model=list[TokenPublic])
def list_tokens(response: Response, user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    response.headers["Cache-Control"] = "no-store"
    return [public(record) for record in session.scalars(select(ApiTokenRecord)
        .where(ApiTokenRecord.user_id == user.id).order_by(ApiTokenRecord.created_at.desc()).limit(100))]


@router.post("/api-tokens", response_model=TokenIssued, status_code=201)
def create_token(payload: TokenCreate, response: Response, user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    now = datetime.now(timezone.utc)
    if payload.book_id:
        from app.modules.books.models import BookRecord
        book = session.get(BookRecord, str(payload.book_id))
        if not book or book.owner_id != user.id or book.status == "deleted":
            raise HTTPException(404, "Book not found")
    active = session.scalar(select(func.count()).select_from(ApiTokenRecord).where(
        ApiTokenRecord.user_id == user.id, ApiTokenRecord.revoked_at.is_(None), ApiTokenRecord.expires_at > now))
    if active >= 20:
        raise HTTPException(409, "最多保留 20 个有效 API 凭据，请先撤销不再使用的凭据")
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    record = ApiTokenRecord(id=str(uuid4()), user_id=user.id, name=payload.name,
        token_hash=token_digest(token), token_prefix=token[:18], created_at=now,
        expires_at=now + timedelta(days=payload.expires_days),
        permissions=payload.permissions, book_id=str(payload.book_id) if payload.book_id else None)
    session.add(record)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return TokenIssued(**public(record).model_dump(), token=token)


@router.delete("/api-tokens/{token_id}", status_code=204)
def revoke_token(token_id: UUID, response: Response, user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    record = session.get(ApiTokenRecord, str(token_id))
    if not record or record.user_id != user.id:
        raise HTTPException(404, "API credential not found")
    if record.revoked_at is None:
        record.revoked_at = datetime.now(timezone.utc)
        session.commit()
    response.headers["Cache-Control"] = "no-store"
