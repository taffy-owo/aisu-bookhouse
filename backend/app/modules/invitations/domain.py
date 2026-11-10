from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Literal

InvitationStatus = Literal["available", "used", "revoked"]


@dataclass(frozen=True)
class Invitation:
    id: str
    code: str
    inviter_user_id: str
    status: InvitationStatus
    created_at: datetime
    updated_at: datetime
    invitee_user_id: str | None = None
    used_at: datetime | None = None

    def with_changes(self, **changes: object) -> "Invitation":
        if "updated_at" not in changes:
            changes["updated_at"] = datetime.now(timezone.utc)
        return replace(self, **changes)
