from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CommentTargetType = Literal["book", "volume"]


class PublicCommentCreate(BaseModel):
    target_type: CommentTargetType = "book"
    target_index: int | None = Field(default=None, ge=1)
    body: str = Field(min_length=1, max_length=2000)


class PublicCommentPublic(BaseModel):
    id: str
    book_id: str
    user_id: str
    user_nickname: str
    target_type: CommentTargetType
    target_index: int | None = None
    body: str
    created_at: datetime
    updated_at: datetime


class PublicCommentListResponse(BaseModel):
    items: list[PublicCommentPublic]
    total: int
