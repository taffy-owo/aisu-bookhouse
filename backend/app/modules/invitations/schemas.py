from datetime import datetime

from pydantic import BaseModel


class InvitationPublic(BaseModel):
    id: str
    code: str
    inviter_user_id: str
    invitee_user_id: str | None = None
    status: str
    created_at: datetime
    used_at: datetime | None = None


class InvitationQuotaPublic(BaseModel):
    can_create: bool
    invitation: InvitationPublic | None = None
    remaining: int | None = None
